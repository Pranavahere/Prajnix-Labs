'use strict';

/**
 * Analytics for a PraJniX session.
 *
 * Design: everything here is a PURE function — it takes a session object
 * (the same shape stored in data/*.json) and returns plain numbers/strings.
 * No sockets, no DOM, no database. That makes it easy to test and to read.
 *
 * Privacy: output never contains voter names or voter IDs.
 */

const TOP_LIST_SIZE = 10;
// Candidate timeline bucket widths: 10s, 30s, 1m, 5m, 15m. Short sessions get
// fine buckets so the chart isn't a single block; long ones stay readable.
const TIMELINE_BUCKET_SIZES_MS = [10, 30, 60, 300, 900].map((s) => s * 1000);
const MAX_TIMELINE_BARS = 40;
const SPLIT_ROOM_STDEV = 1.2; // rating stdev above this = "divided room"
const MIN_VOTES_FOR_INSIGHT = 3; // below this, takeaways would be noise

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to',
  'of', 'in', 'on', 'for', 'with', 'it', 'this', 'that', 'i', 'we', 'you', 'my',
  'our', 'me', 'so', 'as', 'at', 'by', 'not', 'very', 'more', 'can', 'will',
  'have', 'has', 'had', 'do', 'does', 'how', 'what', 'why', 'if', 'than', 'too'
]);

// Deliberately tiny — a teaching-sized lexicon, not a real sentiment model.
const POSITIVE_WORDS = new Set([
  'good', 'great', 'love', 'like', 'nice', 'awesome', 'excellent', 'helpful',
  'clear', 'amazing', 'best', 'useful', 'easy', 'fast', 'better', 'perfect'
]);
const NEGATIVE_WORDS = new Set([
  'bad', 'poor', 'hate', 'slow', 'boring', 'confusing', 'hard', 'worst',
  'useless', 'difficult', 'unclear', 'long', 'worse', 'issue', 'problem'
]);

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const percent = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : 0);

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
}

/** Sort a {label: count} map into [{label, count}] descending. */
function topCounts(countMap, limit = TOP_LIST_SIZE) {
  return Object.entries(countMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Lower-case, strip punctuation, drop stop words and 1-letter tokens. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function countSentiment(texts) {
  const tally = { positive: 0, negative: 0, neutral: 0 };
  texts.forEach((text) => {
    const tokens = tokenize(text);
    const score =
      tokens.filter((t) => POSITIVE_WORDS.has(t)).length -
      tokens.filter((t) => NEGATIVE_WORDS.has(t)).length;
    if (score > 0) tally.positive += 1;
    else if (score < 0) tally.negative += 1;
    else tally.neutral += 1;
  });
  return tally;
}

// ---------------------------------------------------------------------------
// Per-slide calculators. Each returns { type, question, totalResponses,
// participants, ...type-specific fields, takeaways: [string] }.
// ---------------------------------------------------------------------------

function uniqueCount(items) {
  return new Set(items.map((i) => i.voterId).filter(Boolean)).size;
}

function analyzeRating(slide) {
  const responses = slide.responses || [];
  const ratings = responses.map((r) => Number(r.rating)).filter((n) => n >= 1 && n <= 5);
  const total = ratings.length;

  const distribution = [1, 2, 3, 4, 5].map((score) => {
    const count = ratings.filter((r) => r === score).length;
    return { score, count, percent: percent(count, total) };
  });

  const stdev = standardDeviation(ratings);
  const top2 = ratings.filter((r) => r >= 4).length;
  const bottom2 = ratings.filter((r) => r <= 2).length;
  const suggestions = responses.map((r) => r.suggestion).filter(Boolean);

  const takeaways = [];
  if (total >= MIN_VOTES_FOR_INSIGHT) {
    takeaways.push(`Average rating is ${round(mean(ratings), 1)} / 5 from ${total} votes.`);
    if (stdev >= SPLIT_ROOM_STDEV) {
      takeaways.push('The room is divided — opinions are spread across the scale.');
    } else {
      takeaways.push('The room broadly agrees — ratings are tightly clustered.');
    }
  }

  return {
    mean: round(mean(ratings)),
    median: median(ratings),
    stdev: round(stdev),
    distribution,
    top2BoxPercent: percent(top2, total),
    bottom2BoxPercent: percent(bottom2, total),
    suggestionCount: suggestions.length,
    recentSuggestions: suggestions.slice(-5).reverse(),
    totalResponses: total,
    participants: uniqueCount(responses),
    takeaways
  };
}

function analyzeMultipleChoice(slide) {
  const responses = slide.responses || [];
  const options = slide.options || [];
  const total = responses.length;
  const isQuiz = options.some((o) => o.isCorrect);

  const rows = options.map((option) => {
    const votes = responses.filter((r) => r.optionId === option.id).length;
    return {
      id: option.id,
      text: option.text,
      votes,
      percent: percent(votes, total),
      isCorrect: Boolean(option.isCorrect)
    };
  });

  const correctCount = responses.filter((r) => r.isCorrect).length;
  const leader = [...rows].sort((a, b) => b.votes - a.votes)[0];

  const takeaways = [];
  if (total >= MIN_VOTES_FOR_INSIGHT && leader && leader.votes > 0) {
    takeaways.push(`"${leader.text}" leads with ${leader.percent}% of votes.`);
  }
  if (isQuiz && total >= MIN_VOTES_FOR_INSIGHT) {
    takeaways.push(`${percent(correctCount, total)}% of the room answered correctly.`);
  }

  return {
    options: rows,
    isQuiz,
    correctPercent: isQuiz ? percent(correctCount, total) : null,
    totalResponses: total,
    participants: uniqueCount(responses),
    takeaways
  };
}

function analyzeWordCloud(slide) {
  const words = slide.words || [];
  const counts = {};
  words.forEach((w) => {
    const key = String(w.word || '').trim().toLowerCase();
    if (key) counts[key] = (counts[key] || 0) + 1;
  });

  const top = topCounts(counts);
  const takeaways = [];
  if (words.length >= MIN_VOTES_FOR_INSIGHT && top.length) {
    takeaways.push(`Most common word: "${top[0].label}" (${top[0].count} times).`);
    takeaways.push(`${Object.keys(counts).length} distinct words from ${words.length} entries.`);
  }

  return {
    topWords: top,
    distinctWords: Object.keys(counts).length,
    totalResponses: words.length,
    participants: uniqueCount(words),
    takeaways
  };
}

function analyzeOpenEnded(slide) {
  const responses = slide.responses || [];
  const texts = responses.map((r) => r.text).filter(Boolean);

  const keywordCounts = {};
  texts.forEach((text) => {
    tokenize(text).forEach((t) => {
      keywordCounts[t] = (keywordCounts[t] || 0) + 1;
    });
  });

  const sentiment = countSentiment(texts);
  const takeaways = [];
  if (texts.length >= MIN_VOTES_FOR_INSIGHT) {
    takeaways.push(
      `Tone: ${sentiment.positive} positive, ${sentiment.negative} negative, ${sentiment.neutral} neutral.`
    );
  }

  return {
    topKeywords: topCounts(keywordCounts),
    sentiment,
    averageLength: round(mean(texts.map((t) => t.length)), 0),
    totalResponses: texts.length,
    participants: uniqueCount(responses),
    takeaways
  };
}

function analyzeRanking(slide) {
  const responses = (slide.responses || []).filter((r) => Array.isArray(r.ranking));
  const items = slide.items || [];

  const rows = items.map((item) => {
    // Rank is 1-based position; items missing from a ranking are skipped.
    const positions = responses
      .map((r) => r.ranking.indexOf(item.id))
      .filter((idx) => idx >= 0)
      .map((idx) => idx + 1);
    return {
      id: item.id,
      text: item.text,
      averageRank: positions.length ? round(mean(positions)) : null,
      firstPlaceVotes: positions.filter((p) => p === 1).length
    };
  });

  // Best (lowest) average rank first; unranked items last.
  rows.sort((a, b) => (a.averageRank ?? Infinity) - (b.averageRank ?? Infinity));

  const takeaways = [];
  if (responses.length >= MIN_VOTES_FOR_INSIGHT && rows[0] && rows[0].averageRank !== null) {
    takeaways.push(`"${rows[0].text}" is the top priority (average rank ${rows[0].averageRank}).`);
  }

  return {
    items: rows,
    totalResponses: responses.length,
    participants: uniqueCount(responses),
    takeaways
  };
}

function analyzeQa(slide) {
  const questions = slide.questions || [];
  const totalUpvotes = questions.reduce((sum, q) => sum + (Number(q.upvotes) || 0), 0);
  const top = [...questions]
    .sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0))
    .slice(0, 5)
    .map((q) => ({ text: q.text, upvotes: q.upvotes || 0 }));

  const takeaways = [];
  if (top.length && top[0].upvotes > 1) {
    takeaways.push(`Most-wanted question: "${top[0].text}" (${top[0].upvotes} upvotes).`);
  }

  return {
    topQuestions: top,
    totalUpvotes,
    totalResponses: questions.length,
    participants: uniqueCount(questions),
    takeaways
  };
}

const SLIDE_ANALYZERS = {
  RATING_SLIDER: analyzeRating,
  MULTIPLE_CHOICE: analyzeMultipleChoice,
  WORD_CLOUD: analyzeWordCloud,
  OPEN_ENDED: analyzeOpenEnded,
  RANKING: analyzeRanking,
  QA: analyzeQa
};

function analyzeSlide(slide, index) {
  const analyzer = SLIDE_ANALYZERS[slide.type];
  const base = { index, id: slide.id, type: slide.type, question: slide.question };
  if (!analyzer) {
    return { ...base, totalResponses: 0, participants: 0, takeaways: [] };
  }
  return { ...base, ...analyzer(slide) };
}

// ---------------------------------------------------------------------------
// Session-level analytics
// ---------------------------------------------------------------------------

/** Every timestamped, voter-attributed entry across all slide types. */
function collectAllEntries(session) {
  const entries = [];
  (session.slides || []).forEach((slide) => {
    [slide.responses, slide.words, slide.questions].forEach((list) => {
      (list || []).forEach((item) => entries.push(item));
    });
  });
  return entries;
}

/** Smallest "nice" bucket size that keeps the chart under MAX_TIMELINE_BARS. */
function pickBucketMs(spanMs) {
  return TIMELINE_BUCKET_SIZES_MS.find((size) => spanMs / size < MAX_TIMELINE_BARS)
    || TIMELINE_BUCKET_SIZES_MS[TIMELINE_BUCKET_SIZES_MS.length - 1];
}

function buildTimeline(entries) {
  const times = entries
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return { bucketSeconds: 0, buckets: [] };

  const start = Math.min(...times);
  const bucketMs = pickBucketMs(Math.max(...times) - start);
  const counts = {};
  times.forEach((t) => {
    const bucket = Math.floor((t - start) / bucketMs);
    counts[bucket] = (counts[bucket] || 0) + 1;
  });

  const lastBucket = Math.max(...Object.keys(counts).map(Number));
  return {
    bucketSeconds: bucketMs / 1000,
    buckets: Array.from({ length: lastBucket + 1 }, (_, i) => ({
      index: i,
      startsAt: new Date(start + i * bucketMs).toISOString(),
      count: counts[i] || 0
    }))
  };
}

function buildSessionTakeaways(slides, participants, totalResponses) {
  const takeaways = [];
  if (participants > 0) {
    const people = participants === 1 ? '1 person' : `${participants} people`;
    const responses = totalResponses === 1 ? '1 response' : `${totalResponses} responses`;
    takeaways.push(`${people} took part, giving ${responses} in total.`);
  }
  const withVotes = slides.filter((s) => s.totalResponses > 0);
  if (withVotes.length > 1) {
    const best = [...withVotes].sort((a, b) => b.participants - a.participants)[0];
    const worst = [...withVotes].sort((a, b) => a.participants - b.participants)[0];
    if (best.participants !== worst.participants) {
      takeaways.push(
        `Most engaging: slide ${best.index + 1} (${best.participants} participants). ` +
          `Least: slide ${worst.index + 1} (${worst.participants}).`
      );
    }
  }
  return takeaways;
}

/**
 * Compute full analytics for a session.
 *
 * Participation rate uses "everyone who answered anything" as the
 * denominator, because peak room size is not stored on the session yet.
 *
 * @param {object} session Session object as stored in data/*.json.
 * @returns {object} Overview, per-slide analytics, and a response timeline.
 */
function computeAnalytics(session) {
  const slides = (session.slides || []).map(analyzeSlide);
  const entries = collectAllEntries(session);
  const participants = new Set(entries.map((e) => e.voterId).filter(Boolean)).size;
  const totalResponses = slides.reduce((sum, s) => sum + s.totalResponses, 0);

  slides.forEach((s) => {
    s.participationPercent = percent(s.participants, participants);
  });

  return {
    pin: session.pin,
    title: session.title,
    status: session.status,
    generatedAt: new Date().toISOString(),
    overview: {
      totalSlides: slides.length,
      totalResponses,
      participants,
      averageResponsesPerParticipant: participants ? round(totalResponses / participants, 1) : 0,
      takeaways: buildSessionTakeaways(slides, participants, totalResponses)
    },
    slides,
    timeline: buildTimeline(entries)
  };
}

module.exports = { computeAnalytics, tokenize };
