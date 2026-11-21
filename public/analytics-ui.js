/**
 * Host Analytics tab — renders the JSON from GET /api/sessions/:pin/analytics.
 *
 * This file only DISPLAYS numbers. All calculation lives in /analytics.js on
 * the server, so the maths can be tested without a browser.
 *
 * Public API (used by host.html):
 *   AnalyticsUI.start(pin, hostToken)  – load + auto-refresh while visible
 *   AnalyticsUI.stop()                 – stop auto-refresh
 */
(function () {
  const REFRESH_MS = 5000;
  const BODY_ID = 'analyticsBody';
  const SLIDE_LABELS = {
    RATING_SLIDER: '🎚️ Rating',
    MULTIPLE_CHOICE: '📊 Multiple Choice',
    WORD_CLOUD: '☁️ Word Cloud',
    OPEN_ENDED: '💬 Open Ended',
    RANKING: '🏆 Ranking',
    QA: '🙋 Q&A'
  };

  let timerId = null;
  let hasRenderedOnce = false;

  // Audience text is untrusted. Every string from the server goes through
  // esc() before it touches innerHTML.
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  const card = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl';

  // ---- small reusable pieces -------------------------------------------

  function bar(percent, colorClass) {
    return `<div class="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
      <div class="h-full ${colorClass}" style="width:${Math.min(100, Math.max(0, percent))}%"></div></div>`;
  }

  function labelledBar(label, valueText, percent, colorClass, extra = '') {
    return `<div class="space-y-1">
      <div class="flex justify-between text-xs">
        <span class="font-semibold text-slate-700 dark:text-slate-200 truncate pr-2">${label}${extra}</span>
        <span class="font-mono text-slate-500 dark:text-slate-400 shrink-0">${valueText}</span>
      </div>${bar(percent, colorClass)}</div>`;
  }

  function chip(text, count) {
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200">
      ${esc(text)}<span class="font-mono text-indigo-600 dark:text-indigo-400">${count}</span></span>`;
  }

  function kpi(label, value) {
    return `<div class="${card} p-4">
      <p class="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">${label}</p>
      <p class="text-3xl font-black text-slate-900 dark:text-white mt-1">${value}</p></div>`;
  }

  function takeawayList(items) {
    if (!items.length) return '';
    return `<ul class="space-y-1.5">${items.map((t) =>
      `<li class="text-sm text-slate-700 dark:text-slate-300 flex gap-2"><span>💡</span><span>${esc(t)}</span></li>`
    ).join('')}</ul>`;
  }

  // ---- per-slide bodies ------------------------------------------------

  const renderers = {
    RATING_SLIDER(s) {
      return `<div class="grid sm:grid-cols-[10rem_1fr] gap-5 items-center">
        <div class="text-center">
          <p class="text-5xl font-black text-indigo-600 dark:text-indigo-400">${s.mean.toFixed(1)}</p>
          <p class="text-xs text-slate-400">average / 5 · median ${s.median}</p>
          <p class="text-xs text-slate-500 mt-2">${s.top2BoxPercent}% rated 4–5<br>${s.bottom2BoxPercent}% rated 1–2</p>
        </div>
        <div class="space-y-2">${s.distribution.map((d) =>
          labelledBar(`${d.score} ★`, `${d.count} · ${d.percent}%`, d.percent, 'bg-amber-500')
        ).join('')}</div></div>
        ${s.recentSuggestions.length ? `<div class="mt-4"><p class="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 mb-1.5">Recent suggestions (${s.suggestionCount})</p>
          <ul class="space-y-1">${s.recentSuggestions.map((t) => `<li class="text-xs text-slate-600 dark:text-slate-300">“${esc(t)}”</li>`).join('')}</ul></div>` : ''}`;
    },

    MULTIPLE_CHOICE(s) {
      const quiz = s.isQuiz
        ? `<p class="text-xs font-bold text-emerald-600 dark:text-emerald-400 mb-3">Quiz: ${s.correctPercent}% answered correctly</p>` : '';
      return quiz + `<div class="space-y-2.5">${s.options.map((o) =>
        labelledBar(esc(o.text), `${o.votes} · ${o.percent}%`, o.percent,
          o.isCorrect ? 'bg-emerald-500' : 'bg-indigo-500',
          o.isCorrect ? ' <span class="text-emerald-600 dark:text-emerald-400">✓ correct</span>' : '')
      ).join('')}</div>`;
    },

    WORD_CLOUD(s) {
      return `<div class="flex flex-wrap gap-2">${s.topWords.map((w) => chip(w.label, w.count)).join('')}</div>
        <p class="text-xs text-slate-400 mt-3">${s.distinctWords} distinct words</p>`;
    },

    OPEN_ENDED(s) {
      const total = s.sentiment.positive + s.sentiment.negative + s.sentiment.neutral;
      const pct = (n) => (total ? (n / total) * 100 : 0);
      return `<p class="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 mb-1.5">Tone</p>
        <div class="space-y-2">
          ${labelledBar('Positive', s.sentiment.positive, pct(s.sentiment.positive), 'bg-emerald-500')}
          ${labelledBar('Neutral', s.sentiment.neutral, pct(s.sentiment.neutral), 'bg-slate-400')}
          ${labelledBar('Negative', s.sentiment.negative, pct(s.sentiment.negative), 'bg-rose-500')}
        </div>
        <p class="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 mt-4 mb-1.5">Top keywords</p>
        <div class="flex flex-wrap gap-2">${s.topKeywords.map((k) => chip(k.label, k.count)).join('')}</div>
        <p class="text-xs text-slate-400 mt-3">Average response length: ${s.averageLength} characters</p>`;
    },

    RANKING(s) {
      return `<ol class="space-y-2">${s.items.map((it, i) => `
        <li class="flex items-center justify-between gap-3 text-sm">
          <span class="flex items-center gap-2 min-w-0"><span class="font-mono font-black text-indigo-600 dark:text-indigo-400">${i + 1}</span>
            <span class="font-semibold text-slate-800 dark:text-slate-100 truncate">${esc(it.text)}</span></span>
          <span class="text-xs text-slate-500 shrink-0">avg rank ${it.averageRank ?? '–'} · ${it.firstPlaceVotes} first-place</span>
        </li>`).join('')}</ol>`;
    },

    QA(s) {
      if (!s.topQuestions.length) return '';
      return `<ul class="space-y-2">${s.topQuestions.map((q) => `
        <li class="flex items-start justify-between gap-3 text-sm">
          <span class="text-slate-800 dark:text-slate-100">${esc(q.text)}</span>
          <span class="shrink-0 font-mono text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400">▲ ${q.upvotes}</span>
        </li>`).join('')}</ul>`;
    }
  };

  function renderSlideCard(s) {
    const label = SLIDE_LABELS[s.type] || esc(s.type);
    const body = s.totalResponses > 0 && renderers[s.type]
      ? renderers[s.type](s)
      : `<p class="text-sm text-slate-400 text-center py-6">No responses yet for this slide.</p>`;
    return `<section class="${card} p-5 space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">Slide ${s.index + 1} · ${label}</span>
          <h3 class="text-base font-extrabold text-slate-900 dark:text-white break-words">${esc(s.question)}</h3>
        </div>
        <span class="text-xs font-mono px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shrink-0">${s.totalResponses} responses · ${s.participationPercent}% of participants</span>
      </div>
      ${body}
      ${takeawayList(s.takeaways)}
    </section>`;
  }

  // ---- timeline --------------------------------------------------------

  function describeBucket(seconds) {
    return seconds >= 60 ? `${seconds / 60} min` : `${seconds} sec`;
  }

  function renderTimeline(timeline) {
    if (!timeline.buckets.length) return '';
    const width = describeBucket(timeline.bucketSeconds);
    const max = Math.max(...timeline.buckets.map((b) => b.count), 1);
    const bars = timeline.buckets.map((b) => {
      const h = b.count === 0 ? 0 : Math.max(4, (b.count / max) * 100);
      return `<div class="flex-1 min-w-[4px] flex flex-col justify-end h-full" title="${b.count} responses in this ${width} window">
        <div class="bg-indigo-500 rounded-t" style="height:${h}%"></div></div>`;
    }).join('');
    return `<section class="${card} p-5">
      <h3 class="text-sm font-extrabold text-slate-900 dark:text-white">Responses over time</h3>
      <p class="text-xs text-slate-400 mb-3">One bar per ${width}, starting from the first response (busiest window: ${max})</p>
      <div class="flex items-end gap-0.5 h-28 border-b border-slate-200 dark:border-slate-800">${bars}</div></section>`;
  }

  // ---- whole page + states ---------------------------------------------

  function renderAll(data) {
    const o = data.overview;
    if (o.totalResponses === 0) {
      return `<div class="${card} p-10 text-center space-y-2">
        <p class="text-4xl">📭</p>
        <p class="text-base font-extrabold text-slate-800 dark:text-white">No responses yet</p>
        <p class="text-sm text-slate-500">Start the session and share the PIN. Analytics fill in as votes arrive.</p></div>`;
    }
    return `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        ${kpi('Participants', o.participants)}
        ${kpi('Total responses', o.totalResponses)}
        ${kpi('Slides', o.totalSlides)}
        ${kpi('Responses / person', o.averageResponsesPerParticipant)}
      </div>
      ${o.takeaways.length ? `<div class="${card} p-5">${takeawayList(o.takeaways)}</div>` : ''}
      ${renderTimeline(data.timeline)}
      ${data.slides.map(renderSlideCard).join('')}`;
  }

  function showState(html) {
    document.getElementById(BODY_ID).innerHTML = html;
  }

  function errorState(message) {
    return `<div class="${card} p-8 text-center space-y-2 border-rose-500/40">
      <p class="text-base font-extrabold text-rose-600 dark:text-rose-400">Couldn’t load analytics</p>
      <p class="text-sm text-slate-500">${esc(message)}</p></div>`;
  }

  function skeleton() {
    return `<div class="animate-pulse space-y-3">
      <div class="h-20 rounded-2xl bg-slate-200 dark:bg-slate-800"></div>
      <div class="h-40 rounded-2xl bg-slate-200 dark:bg-slate-800"></div>
      <div class="h-40 rounded-2xl bg-slate-200 dark:bg-slate-800"></div></div>`;
  }

  async function load(pin, hostToken) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(pin)}/analytics`, {
        headers: { 'x-host-token': hostToken || '' }
      });
      if (res.status === 403) throw new Error('This browser doesn’t hold the host key for this session.');
      if (!res.ok) throw new Error(`The server answered with status ${res.status}.`);
      showState(renderAll(await res.json()));
      hasRenderedOnce = true;
      const stamp = document.getElementById('analyticsUpdatedAt');
      if (stamp) stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      // Keep showing the last good numbers on a transient refresh failure.
      if (!hasRenderedOnce) showState(errorState(err.message));
    }
  }

  window.AnalyticsUI = {
    start(pin, hostToken) {
      this.stop();
      hasRenderedOnce = false;
      showState(skeleton());
      load(pin, hostToken);
      timerId = setInterval(() => load(pin, hostToken), REFRESH_MS);
    },
    stop() {
      if (timerId) clearInterval(timerId);
      timerId = null;
    }
  };
})();
