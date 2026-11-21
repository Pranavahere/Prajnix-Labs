'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { computeAnalytics, tokenize } = require('../analytics');

const T0 = '2026-01-01T10:00:00.000Z';
const T1 = '2026-01-01T10:02:30.000Z';

const makeSession = (slides) => ({ pin: '111111', title: 'T', status: 'LIVE', slides });

test('rating: mean, median, distribution and top-2-box', () => {
  const ratings = [5, 4, 4, 2, 1].map((rating, i) => ({ voterId: `v${i}`, rating, timestamp: T0 }));
  const result = computeAnalytics(makeSession([{ id: 's1', type: 'RATING_SLIDER', question: 'Q', responses: ratings }]));
  const slide = result.slides[0];

  assert.equal(slide.mean, 3.2);
  assert.equal(slide.median, 4);
  assert.equal(slide.top2BoxPercent, 60);
  assert.equal(slide.bottom2BoxPercent, 40);
  assert.equal(slide.distribution.find((d) => d.score === 4).count, 2);
  assert.ok(slide.takeaways.some((t) => t.includes('divided')));
});

test('rating: empty slide gives zeros, no takeaways, no NaN', () => {
  const result = computeAnalytics(makeSession([{ id: 's1', type: 'RATING_SLIDER', question: 'Q', responses: [] }]));
  const slide = result.slides[0];
  assert.equal(slide.mean, 0);
  assert.equal(slide.totalResponses, 0);
  assert.deepEqual(slide.takeaways, []);
  assert.equal(result.overview.participants, 0);
});

test('rating: out-of-range values are ignored', () => {
  const responses = [{ voterId: 'a', rating: 9 }, { voterId: 'b', rating: 3 }];
  const slide = computeAnalytics(makeSession([{ type: 'RATING_SLIDER', responses }])).slides[0];
  assert.equal(slide.totalResponses, 1);
});

test('multiple choice: percentages and quiz correct rate', () => {
  const options = [
    { id: 'o1', text: 'A', isCorrect: true },
    { id: 'o2', text: 'B', isCorrect: false }
  ];
  const responses = [
    { voterId: 'a', optionId: 'o1', isCorrect: true },
    { voterId: 'b', optionId: 'o1', isCorrect: true },
    { voterId: 'c', optionId: 'o2', isCorrect: false },
    { voterId: 'd', optionId: 'o1', isCorrect: true }
  ];
  const slide = computeAnalytics(makeSession([{ type: 'MULTIPLE_CHOICE', options, responses }])).slides[0];

  assert.equal(slide.isQuiz, true);
  assert.equal(slide.correctPercent, 75);
  assert.equal(slide.options[0].percent, 75);
});

test('multiple choice: plain poll has no correct rate', () => {
  const options = [{ id: 'o1', text: 'A' }];
  const slide = computeAnalytics(makeSession([{ type: 'MULTIPLE_CHOICE', options, responses: [] }])).slides[0];
  assert.equal(slide.isQuiz, false);
  assert.equal(slide.correctPercent, null);
});

test('word cloud: merges case and whitespace variants', () => {
  const words = [' Speed', 'speed', 'SPEED', 'cost'].map((word, i) => ({ word, voterId: `v${i}` }));
  const slide = computeAnalytics(makeSession([{ type: 'WORD_CLOUD', words }])).slides[0];
  assert.deepEqual(slide.topWords[0], { label: 'speed', count: 3 });
  assert.equal(slide.distinctWords, 2);
});

test('open ended: keywords drop stop words; sentiment is tallied', () => {
  const texts = ['The talk was great', 'great and clear', 'too slow and boring', 'ok'];
  const responses = texts.map((text, i) => ({ voterId: `v${i}`, text }));
  const slide = computeAnalytics(makeSession([{ type: 'OPEN_ENDED', responses }])).slides[0];

  assert.equal(slide.topKeywords[0].label, 'great');
  assert.ok(!slide.topKeywords.some((k) => k.label === 'the'));
  assert.deepEqual(slide.sentiment, { positive: 2, negative: 1, neutral: 1 });
});

test('ranking: lower average rank wins; missing items tolerated', () => {
  const items = [{ id: 'i1', text: 'Quality' }, { id: 'i2', text: 'Speed' }, { id: 'i3', text: 'Cost' }];
  const responses = [
    { voterId: 'a', ranking: ['i2', 'i1', 'i3'] },
    { voterId: 'b', ranking: ['i2', 'i3', 'i1'] },
    { voterId: 'c', ranking: ['i2'] }
  ];
  const slide = computeAnalytics(makeSession([{ type: 'RANKING', items, responses }])).slides[0];

  assert.equal(slide.items[0].text, 'Speed');
  assert.equal(slide.items[0].averageRank, 1);
  assert.equal(slide.items[0].firstPlaceVotes, 3);
});

test('qa: sorted by upvotes', () => {
  const questions = [
    { voterId: 'a', text: 'low', upvotes: 1 },
    { voterId: 'b', text: 'high', upvotes: 5 }
  ];
  const slide = computeAnalytics(makeSession([{ type: 'QA', questions }])).slides[0];
  assert.equal(slide.topQuestions[0].text, 'high');
  assert.equal(slide.totalUpvotes, 6);
});

test('session: participation counts people once across slides', () => {
  const slides = [
    { type: 'RATING_SLIDER', responses: [{ voterId: 'a', rating: 3 }, { voterId: 'b', rating: 4 }] },
    { type: 'WORD_CLOUD', words: [{ voterId: 'a', word: 'x' }] }
  ];
  const result = computeAnalytics(makeSession(slides));
  assert.equal(result.overview.participants, 2);
  assert.equal(result.overview.totalResponses, 3);
  assert.equal(result.slides[1].participationPercent, 50);
});

test('timeline: short session uses fine buckets and fills gaps', () => {
  const responses = [
    { voterId: 'a', rating: 3, timestamp: T0 },
    { voterId: 'b', rating: 3, timestamp: T1 } // 150s later
  ];
  const { timeline } = computeAnalytics(makeSession([{ type: 'RATING_SLIDER', responses }]));
  assert.equal(timeline.bucketSeconds, 10);
  assert.equal(timeline.buckets.length, 16);
  assert.equal(timeline.buckets[0].count, 1);
  assert.equal(timeline.buckets[15].count, 1);
  assert.equal(timeline.buckets[7].count, 0);
});

test('timeline: long session widens the bucket', () => {
  const hourLater = '2026-01-01T11:00:00.000Z';
  const responses = [
    { voterId: 'a', rating: 3, timestamp: T0 },
    { voterId: 'b', rating: 3, timestamp: hourLater }
  ];
  const { timeline } = computeAnalytics(makeSession([{ type: 'RATING_SLIDER', responses }]));
  assert.equal(timeline.bucketSeconds, 300);
});

test('timeline: no timestamps gives an empty timeline', () => {
  const { timeline } = computeAnalytics(makeSession([{ type: 'RATING_SLIDER', responses: [] }]));
  assert.deepEqual(timeline.buckets, []);
});

test('privacy: output never contains voter names or ids', () => {
  const responses = [{ voterId: 'secret-id', voterName: 'Alice', rating: 3, timestamp: T0 }];
  const json = JSON.stringify(computeAnalytics(makeSession([{ type: 'RATING_SLIDER', responses }])));
  assert.ok(!json.includes('Alice'));
  assert.ok(!json.includes('secret-id'));
});

test('unknown slide type does not crash', () => {
  const result = computeAnalytics(makeSession([{ type: 'MYSTERY' }]));
  assert.equal(result.slides[0].totalResponses, 0);
});

test('real data: committed sample sessions compute without errors', () => {
  for (const file of ['WEBINAR_517614.json', 'test_790609.json']) {
    const session = require(path.join('..', 'data', file));
    const result = computeAnalytics(session);
    assert.equal(result.slides.length, session.slides.length);
    assert.ok(result.overview.participants >= 1);
  }
});

test('tokenize: strips punctuation and stop words', () => {
  assert.deepEqual(tokenize('The Speed, is great!'), ['speed', 'great']);
});
