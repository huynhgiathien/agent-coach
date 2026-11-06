// S3: prompt normalization and clustering.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as text from '../lib/text.mjs';

const { normalize, tokens, isAck, isCorrection, isStandingPreference, snippet, clusterTexts } = text;
// New export (S19); looked up per call so a missing export fails only the similarity tests.
const similarity = (a, b) => text.similarity(a, b);

const entries = (texts) => texts.map((text) => ({ key: normalize(text), text }));

test('normalize ignores case and punctuation', () => {
  assert.equal(normalize('Shorter version!'), normalize('shorter version'));
});

test('normalize maps ticket keys and numbers to the same key', () => {
  assert.equal(normalize('draft a comment for FRO-1'), normalize('draft a comment for FRO-22'));
});

test('normalize maps URLs and paths to placeholders', () => {
  assert.equal(normalize('open https://a.example/x?y=1 now'), normalize('open http://b.example/z now'));
  assert.equal(normalize('read ~/proj/a.ts please'), normalize('read ./other/b.ts please'));
});

test('tokens drop stopwords', () => {
  assert.deepEqual(tokens(normalize('Give me a shorter version please')), ['shorter', 'version']);
});

test('clusterTexts groups case/punctuation variants and paraphrases into one cluster', () => {
  const texts = ['shorter version', 'Give me a shorter version please', 'Shorter version!'];
  const clusters = clusterTexts(entries(texts));
  assert.equal(clusters.length, 1);
  for (const t of texts) assert.ok(JSON.stringify(clusters[0].members).includes(t), `missing member ${t}`);
});

test('clusterTexts keeps unrelated prompts apart', () => {
  const clusters = clusterTexts(entries(['shorter version', 'run the unit tests for the login form']));
  assert.equal(clusters.length, 2);
});

test('clusterTexts never merges a short prompt (<=12 tokens) with a long one', () => {
  const short = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const clusters = clusterTexts(entries([short, `${short} nu`]));
  assert.equal(clusters.length, 2);
});

test('clusterTexts skips entries whose key or tokens are empty', () => {
  assert.equal(clusterTexts(entries(['', '!!!', 'please the a'])).length, 0);
});

test('isAck recognises acknowledgements only', () => {
  assert.equal(isAck(normalize('Go ahead')), true);
  assert.equal(isAck(normalize('yes')), true);
  assert.equal(isAck(normalize('shorter version')), false);
});

test('isCorrection flags follow-up corrections', () => {
  assert.equal(isCorrection(normalize('shorter version')), true);
  assert.equal(isCorrection(normalize('draft a comment for FRO-1')), false);
});

test('isStandingPreference flags standing rules', () => {
  assert.equal(isStandingPreference(normalize('Always run the tests before committing')), true);
  assert.equal(isStandingPreference(normalize('run the tests')), false);
});

test('snippet collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(snippet('a\n\n  b   c'), 'a b c');
  const s = snippet('x'.repeat(500), 160);
  assert.ok(s.endsWith('…'));
  assert.ok(s.length <= 161);
});

// ---- similarity (S19) ----

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu';

test('similarity: short prompts compare by token-set Jaccard (stopwords ignored)', () => {
  close(similarity(normalize('Give me a shorter version please'), normalize('shorter version')), 1);
  close(similarity(normalize('shorter version'), normalize('shorter version now')), 2 / 3);
  close(similarity(normalize('shorter version'), normalize('post it')), 0);
});

test('similarity: long prompts (> 12 tokens) compare by word 3-shingle Jaccard', () => {
  close(similarity(LONG, LONG), 1);
  // 11 shingles each, 10 shared → 10 / 12
  close(similarity(LONG, LONG.replace(/ nu$/, ' xi')), 10 / 12);
});

test('similarity: a short and a long prompt never match', () => {
  close(similarity(LONG.replace(/ nu$/, ''), LONG), 0);
});

test('clusterTexts merges exactly the pairs whose similarity is >= 0.5', () => {
  const a = 'shorter version please now';
  const b = 'shorter version';
  const c = 'shorter draft';
  assert.ok(similarity(normalize(a), normalize(b)) >= 0.5);
  assert.ok(similarity(normalize(b), normalize(c)) < 0.5);
  assert.equal(clusterTexts(entries([a, b])).length, 1);
  assert.equal(clusterTexts(entries([b, c])).length, 2);
});
