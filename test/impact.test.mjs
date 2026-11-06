// S19: accepted decisions store a baseline; later digests compare before vs after.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { readEvents as readClaude } from '../lib/sources/claude.mjs';
import { readEvents as readCodex } from '../lib/sources/codex.mjs';
import { readEvents as readCursor } from '../lib/sources/cursor.mjs';
import { listAssets } from '../lib/inventory.mjs';
import { analyze } from '../lib/analyze.mjs';
import { NOW_MS as nowMs, SINCE_DAYS as sinceDays, SINCE_MS as sinceMs, eventsOf, makeHome } from './_helpers.mjs';

const FOLLOW_UP_TITLE = 'After skill "linear-comment": "shorter version"';
const { home, coachDir } = makeHome();
process.env.AGENT_COACH_HOME = coachDir;
const { buildDigest, renderMarkdown } = await import('../lib/digest.mjs');
const { recordDecision } = await import('../lib/state.mjs');

let events;
let assets;
let followUpId;
const run = (decisions) => analyze(events, assets, { minCount: 3, sinceMs, nowMs, decisions });
const pick = (row) => ({ metric: row.metric, before: row.before, after: row.after, samples: row.samples, verdict: row.verdict });
const accepted = (decidedAt, snapshot) => ({ status: 'accepted', decidedAt: Date.parse(decidedAt), snapshot });
const followUpSnapshot = (rep, value, samples = 3) => ({
  type: 'follow_up', title: `After skill "linear-comment": "${rep}"`, triggerKey: 'skill:linear-comment', rep,
  baseline: { metric: 'rate', value, samples },
});

before(async () => {
  const results = await Promise.all([readOmp, readClaude, readCodex, readCursor].map((read) => read({ home, sinceMs })));
  events = eventsOf(...results);
  assets = await listAssets({ home });
  followUpId = run({}).findings.find((f) => f.title === FOLLOW_UP_TITLE).id;
});

// ---- analyze: metrics and verdicts ----

test('impact: "shorter version" stopped after the change → rate 1 → 0 over s4–s6, improved', () => {
  const { impact } = run({ [followUpId]: accepted('2026-10-15', followUpSnapshot('shorter version', 1)) });
  assert.equal(impact.length, 1);
  assert.equal(impact[0].id, followUpId);
  assert.deepEqual(pick(impact[0]), { metric: 'rate', before: 1, after: 0, samples: 3, verdict: 'improved' });
});

test('impact: fewer than min-count trigger runs after the decision is insufficient_data', () => {
  const { impact } = run({ [followUpId]: accepted('2026-10-21', followUpSnapshot('shorter version', 1)) });
  assert.equal(impact[0].samples, 2);
  assert.equal(impact[0].verdict, 'insufficient_data');
});

test('impact: a follow-up that got more frequent is worse (after >= 1.1 × before)', () => {
  const { impact } = run({ x: accepted('2026-10-15', followUpSnapshot('post it', 0.5)) });
  assert.deepEqual(pick(impact[0]), { metric: 'rate', before: 0.5, after: 1, samples: 3, verdict: 'worse' });
});

test('impact: a rate within (0.7×, 1.1×) of the baseline is no_change', () => {
  const { impact } = run({ x: accepted('2026-10-15', followUpSnapshot('post it', 1)) });
  assert.deepEqual(pick(impact[0]), { metric: 'rate', before: 1, after: 1, samples: 3, verdict: 'no_change' });
});

test('impact: repeated_prompt perWeek needs 7 days after the decision (6 days → insufficient_data, 7 → measured)', () => {
  // s4–s6 each type "post it" on 2026-10-20..22; decided 2026-10-19.
  const snapshot = { type: 'repeated_prompt', title: 'post it', rep: 'post it', baseline: { metric: 'perWeek', value: 5, samples: 10 } };
  const at = (now) => analyze(events, assets, { minCount: 3, sinceMs, nowMs: Date.parse(now), decisions: { x: accepted('2026-10-19', snapshot) } }).impact[0];
  assert.deepEqual(pick(at('2026-10-25')), { metric: 'perWeek', before: 5, after: 3.5, samples: 3, verdict: 'insufficient_data' });
  assert.deepEqual(pick(at('2026-10-26')), { metric: 'perWeek', before: 5, after: 3, samples: 3, verdict: 'improved' });
});

test('impact: repeated_prompt perWeek counts similar prompts per week since the decision', () => {
  // 3 × "post it" between 2026-10-15 and 2026-11-01 (17 days): 3 / (17 / 7) = 1.235 per week.
  const snapshot = { type: 'repeated_prompt', title: 'post it', rep: 'post it', baseline: { metric: 'perWeek', value: 5, samples: 10 } };
  const { impact } = run({ x: accepted('2026-10-15', snapshot) });
  assert.deepEqual(pick(impact[0]), { metric: 'perWeek', before: 5, after: 1.235, samples: 3, verdict: 'improved' });
});

test('impact: costly agent costPerUse is the after-window cost per run', () => {
  const snapshot = { type: 'costly_asset', title: 'Costly agent "scout"', kind: 'agent', name: 'scout', baseline: { metric: 'costPerUse', value: 20, samples: 3 } };
  const { impact } = run({ x: accepted('2026-09-01', snapshot) });
  assert.deepEqual(pick(impact[0]), { metric: 'costPerUse', before: 20, after: 10, samples: 3, verdict: 'improved' });
});

test('impact: dismissed decisions and accepted ones without a baseline are not measured', () => {
  const { impact } = run({
    a: { status: 'dismissed', decidedAt: Date.parse('2026-10-15'), snapshot: followUpSnapshot('shorter version', 1) },
    b: accepted('2026-10-15', { type: 'unused_asset', title: 'x', baseline: null }),
    c: { status: 'accepted', decidedAt: Date.parse('2026-10-15') },
  });
  assert.deepEqual(impact, []);
});

test('impact: rows are sorted by decision date, newest first', () => {
  const { impact } = run({
    older: accepted('2026-10-15', followUpSnapshot('post it', 1)),
    newer: accepted('2026-10-21', followUpSnapshot('shorter version', 1)),
  });
  assert.deepEqual(impact.map((r) => r.id), ['newer', 'older']);
});

// ---- recordDecision → snapshot → next digest ----

test('recordDecision stores the follow-up rate as baseline and says so', async () => {
  await buildDigest({ home, sinceDays, nowMs });
  const text = await recordDecision(home, { id: followUpId, status: 'accepted' });
  assert.ok(text.startsWith(`Recorded accepted for ${followUpId}.`), text);
  assert.ok(text.includes('Baseline: rate 0.429 over 7 samples'), text);
  const stored = JSON.parse(fs.readFileSync(path.join(coachDir, 'decisions.json'), 'utf8')).decisions[followUpId];
  assert.deepEqual(stored.snapshot.baseline, { metric: 'rate', value: 0.429, samples: 7 });
  assert.deepEqual([stored.snapshot.type, stored.snapshot.triggerKey, stored.snapshot.rep], ['follow_up', 'skill:linear-comment', 'shorter version']);
});

test('recordDecision on a finding type without a metric stores a null baseline and no Baseline text', async () => {
  const digest = await buildDigest({ home, sinceDays, nowMs, includeDecided: true });
  const { id } = digest.findings.find((f) => f.type === 'unused_asset');
  const text = await recordDecision(home, { id, status: 'accepted' });
  assert.equal(text, `Recorded accepted for ${id}.`);
  const stored = JSON.parse(fs.readFileSync(path.join(coachDir, 'decisions.json'), 'utf8')).decisions[id];
  assert.equal(stored.snapshot.baseline, null);
});

test('recordDecision without a stored digest records a null snapshot', async () => {
  const { home: fresh, coachDir: freshState } = makeHome();
  process.env.AGENT_COACH_HOME = freshState;
  try {
    assert.equal(await recordDecision(fresh, { id: 'abc', status: 'dismissed' }), 'Recorded dismissed for abc.');
    const stored = JSON.parse(fs.readFileSync(path.join(freshState, 'decisions.json'), 'utf8')).decisions.abc;
    assert.equal(stored.snapshot, null);
  } finally {
    process.env.AGENT_COACH_HOME = coachDir;
  }
});

test('the next digest reports the accepted change in impact and in the markdown', async () => {
  // decidedAt is the real clock (after the fixture nowMs), so nothing is measured yet.
  const digest = await buildDigest({ home, sinceDays, nowMs });
  const row = digest.impact.find((r) => r.id === followUpId);
  assert.ok(row, 'impact row missing');
  assert.deepEqual([row.metric, row.before, row.verdict], ['rate', 0.429, 'insufficient_data']);
  const md = renderMarkdown(digest);
  assert.ok(md.includes('## Impact of accepted changes'));
  assert.ok(md.indexOf('## Impact of accepted changes') < md.indexOf('## Follow-up patterns'));
});

test('markdown omits the Impact section when nothing was accepted with a baseline', async () => {
  const { home: fresh, coachDir: freshState } = makeHome();
  process.env.AGENT_COACH_HOME = freshState;
  try {
    const digest = await buildDigest({ home: fresh, sinceDays, nowMs });
    assert.deepEqual(digest.impact, []);
    assert.equal(renderMarkdown(digest).includes('## Impact of accepted changes'), false);
  } finally {
    process.env.AGENT_COACH_HOME = coachDir;
  }
});

// ---- reviewer fixes: window clamp (1), snapshot kept (2), reappeared counts (3) ----

const id = (type, key) => createHash('sha1').update(`${type}|${key}`).digest('hex').slice(0, 10);
const POST_IT_SNAPSHOT = { type: 'repeated_prompt', title: 'post it', rep: 'post it', baseline: { metric: 'perWeek', value: 5, samples: 10 } };

/** Fresh home + state dir; `fn` runs with AGENT_COACH_HOME pointing at it. */
async function withFreshState(fn) {
  const fresh = makeHome();
  process.env.AGENT_COACH_HOME = fresh.coachDir;
  try {
    return await fn(fresh);
  } finally {
    process.env.AGENT_COACH_HOME = coachDir;
  }
}
const writeDecisions = (dir, decisions) =>
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ version: 1, decisions }));
const readDecision = (dir, key) => JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8')).decisions[key];

test('impact perWeek: a decision older than the window measures over the window only (90 days)', () => {
  // 3 × "post it" / (90 days / 7) = 0.233 per week; measuring from 2026-07-01 would give 0.171.
  const { impact } = run({ x: accepted('2026-07-01', POST_IT_SNAPSHOT) });
  assert.deepEqual(pick(impact[0]), { metric: 'perWeek', before: 5, after: 0.233, samples: 3, verdict: 'improved' });
});

test('impact perWeek: an old decision with a window under 7 days is insufficient_data', () => {
  const r = analyze(events, assets, {
    minCount: 3, sinceMs: Date.parse('2026-10-19'), nowMs: Date.parse('2026-10-25'), decisions: { x: accepted('2026-09-01', POST_IT_SNAPSHOT) },
  });
  assert.deepEqual(pick(r.impact[0]), { metric: 'perWeek', before: 5, after: 3.5, samples: 3, verdict: 'insufficient_data' });
});

test('reappeared follow_up: triggerCount and rate count only triggers after the earlier decision', () => {
  const decidedAt = Date.parse('2026-10-01T12:00:00Z');
  const r = analyze(events, assets, { minCount: 2, sinceMs, nowMs, decisions: { [followUpId]: { status: 'accepted', decidedAt } } });
  const f = r.findings.find((x) => x.id === followUpId);
  assert.ok(f, 'reappeared finding missing');
  // s2–s6 and Claude c1 read linear-comment after 12:00Z; "shorter version" follows in s2 and s3.
  assert.deepEqual(
    { reappeared: f.reappeared, decidedAt: f.decidedAt, occurrences: f.occurrences, triggerCount: f.triggerCount, rate: f.rate },
    { reappeared: true, decidedAt, occurrences: 2, triggerCount: 6, rate: 0.333 },
  );
});

test('recordDecision on a reappeared follow_up stores its post-decision rate as the baseline', async () => {
  await withFreshState(async ({ home: h, coachDir: dir }) => {
    writeDecisions(dir, { [followUpId]: { status: 'accepted', note: null, decidedAt: Date.parse('2026-10-01T12:00:00Z'), snapshot: null } });
    await buildDigest({ home: h, sinceDays, nowMs, minCount: 2 });
    const text = await recordDecision(h, { id: followUpId, status: 'accepted' });
    assert.ok(text.includes('Baseline: rate 0.333 over 6 samples'), text);
    assert.deepEqual(readDecision(dir, followUpId).snapshot.baseline, { metric: 'rate', value: 0.333, samples: 6 });
  });
});

test('recordDecision on a reappeared repeated_prompt measures perWeek from the earlier decision', async () => {
  const postIt = id('repeated_prompt', 'post it');
  await withFreshState(async ({ home: h, coachDir: dir }) => {
    // Accepted after s4's "post it": s5 and s6 remain, over 2026-10-20T12:00Z → 2026-11-01 (11.5 days).
    writeDecisions(dir, { [postIt]: { status: 'accepted', note: null, decidedAt: Date.parse('2026-10-20T12:00:00Z'), snapshot: null } });
    const digest = await buildDigest({ home: h, sinceDays, nowMs, minCount: 2 });
    assert.equal(digest.findings.find((f) => f.id === postIt)?.count, 2);
    await recordDecision(h, { id: postIt, status: 'accepted' });
    assert.deepEqual(readDecision(dir, postIt).snapshot.baseline, { metric: 'perWeek', value: 1.217, samples: 2 });
  });
});

test('recordDecision keeps the stored baseline when the finding is no longer in the last digest', async () => {
  await withFreshState(async ({ home: h, coachDir: dir }) => {
    await buildDigest({ home: h, sinceDays, nowMs });
    await recordDecision(h, { id: followUpId, status: 'accepted' });
    const first = readDecision(dir, followUpId);
    // Accepted now (after every fixture event): the next digest drops the finding.
    const next = await buildDigest({ home: h, sinceDays, nowMs });
    assert.equal(next.findings.some((f) => f.id === followUpId), false);
    await recordDecision(h, { id: followUpId, status: 'dismissed' });
    const second = readDecision(dir, followUpId);
    assert.equal(second.status, 'dismissed');
    assert.ok(second.decidedAt >= first.decidedAt);
    assert.deepEqual(second.snapshot, first.snapshot);
  });
});

test('recordDecision replaces the stored snapshot when the last digest has the finding', async () => {
  await withFreshState(async ({ home: h, coachDir: dir }) => {
    const stale = { type: 'follow_up', title: 'old', triggerKey: 'skill:linear-comment', rep: 'shorter version', baseline: { metric: 'rate', value: 0.9, samples: 9 } };
    writeDecisions(dir, { [followUpId]: { status: 'dismissed', note: null, decidedAt: Date.parse('2026-09-01'), snapshot: stale } });
    await buildDigest({ home: h, sinceDays, nowMs, includeDecided: true });
    await recordDecision(h, { id: followUpId, status: 'accepted' });
    assert.deepEqual(readDecision(dir, followUpId).snapshot.baseline, { metric: 'rate', value: 0.429, samples: 7 });
  });
});
