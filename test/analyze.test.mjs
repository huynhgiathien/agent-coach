// S4–S8, S13, S14, S15, S17: findings, usage, cost, memory and activity analysis over the fixture home.
//
// analyze() is fed the events of all four readers. skill "linear-comment" is read 7 times in
// main sessions (omp s1–s6 and Claude c1); "shorter version" follows it in s1–s3 only.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { readEvents as readClaude } from '../lib/sources/claude.mjs';
import { readEvents as readCodex } from '../lib/sources/codex.mjs';
import { readEvents as readCursor } from '../lib/sources/cursor.mjs';
import { listAssets } from '../lib/inventory.mjs';
import { analyze } from '../lib/analyze.mjs';
import { makeHome, NOW_MS as nowMs, SINCE_MS as sinceMs, HAS_SQLITE, eventsOf, mentions } from './_helpers.mjs';

const noSqlite = !HAS_SQLITE && 'no node:sqlite';

const FOLLOW_UP_TITLE = 'After skill "linear-comment": "shorter version"';
let events;
let assets;
const run = (opts = {}) => analyze(events, assets, { minCount: 3, sinceMs, nowMs, ...opts });
const byType = (result, type) => result.findings.filter((f) => f.type === type);
const followUp = (result) => result.findings.find((f) => f.type === 'follow_up' && f.title === FOLLOW_UP_TITLE);

before(async () => {
  const { home } = makeHome();
  const results = await Promise.all([readOmp, readClaude, readCodex, readCursor].map((read) => read({ home, sinceMs })));
  events = eventsOf(...results);
  assets = await listAssets({ home });
});

// ---- inventory ----

test('inventory: read-only roots are flagged editable: false', () => {
  const plug = assets.find((a) => a.kind === 'skill' && a.name === 'plug');
  assert.equal(plug.editable, false);
  assert.equal(plug.origin, 'plugin');
  const synced = assets.find((a) => a.name === 'design-system' && a.path.includes('/synced/'));
  assert.equal(synced.editable, false);
  assert.equal(assets.find((a) => a.name === 'linear-comment').editable, true);
});

test('inventory: memory asset p1.md has project "/a" and memoryType "feedback"', () => {
  const p1 = assets.find((a) => a.kind === 'memory' && a.path.endsWith('/p1.md'));
  assert.equal(p1.project, '/a');
  assert.equal(p1.memoryType, 'feedback');
  assert.equal(p1.editable, true);
});

test('inventory: Claude MEMORY.md indexes are not memory assets', () => {
  assert.equal(assets.some((a) => a.path.includes('/.claude/') && a.path.endsWith('/MEMORY.md')), false);
});

// ---- follow_up / repeated_prompt ----

test('follow_up: "shorter version" after skill linear-comment (3 of 7 runs across omp and Claude)', () => {
  const f = followUp(run());
  assert.ok(f, 'follow_up finding missing');
  assert.equal(f.occurrences, 3);
  assert.equal(f.triggerCount, 7);
  assert.equal(f.rate, 0.429);
  assert.equal(f.correction, true);
  assert.equal(f.hint, 'update_asset');
  assert.ok(f.target.path.endsWith('.claude/skills/linear-comment/SKILL.md'), f.target.path);
  assert.deepEqual(f.trigger, { kind: 'skill', name: 'linear-comment' });
});

test('follow_up: examples carry the prompt before the trigger as context', () => {
  const f = followUp(run());
  assert.equal(f.examples.length, 3);
  for (const ex of f.examples) assert.equal(ex.context, 'draft a comment for FRO-1');
});

test('repeated_prompt: "draft a comment for <key>" across 3 sessions', () => {
  const f = byType(run(), 'repeated_prompt').find((x) => /draft a comment for/i.test(x.title));
  assert.ok(f, 'repeated_prompt finding missing');
  assert.equal(f.count, 3);
  assert.equal(f.sessions, 3);
  assert.equal(f.id, createHash('sha1').update('repeated_prompt|draft a comment for key').digest('hex').slice(0, 10));
});

test('acknowledgements ("yes") are never a finding', () => {
  const r = run();
  assert.equal(r.findings.some((f) => /"yes"|^yes$/i.test(f.title)), false);
  assert.equal(r.findings.some((f) => f.examples.length > 0 && f.examples.every((e) => e.text === 'yes')), false);
});

// ---- usage / unused / overlap ----

test('usage: subagent skill read counts (automation-testing = 1)', () => {
  const u = run().usage.find((x) => x.kind === 'skill' && x.name === 'automation-testing');
  assert.equal(u.uses, 1);
});

test('unused_asset: old editable skill reported, read-only plugin skill not', () => {
  const unused = byType(run(), 'unused_asset');
  assert.ok(unused.some((f) => mentions(f, '/old-skill/SKILL.md')), 'old-skill missing');
  assert.equal(unused.some((f) => mentions(f, '/plug/SKILL.md')), false);
  assert.ok(unused.every((f) => f.hint === 'delete_asset'));
});

test('unused_asset: never reports memory files', () => {
  const unused = byType(run(), 'unused_asset');
  assert.equal(unused.some((f) => mentions(f, '/memory/')), false);
});

test('overlapping_assets: same-name design-system skills across roots', () => {
  const f = byType(run(), 'overlapping_assets').find((x) => mentions(x, '/synced/b1/design-system/SKILL.md'));
  assert.ok(f, 'design-system overlap missing');
  assert.ok(mentions(f, '.claude/skills/design-system/SKILL.md'));
  assert.equal(f.hint, 'merge_assets');
});

test('overlapping_assets: duplicate memories within one project (d1.md|d2.md)', () => {
  const f = byType(run(), 'overlapping_assets').find((x) => mentions(x, '/memory/d1.md'));
  assert.ok(f, 'memory overlap missing');
  assert.ok(mentions(f, '/memory/d2.md'));
});

test('overlapping_assets: differently named skills with near-identical descriptions form one pair', () => {
  const skill = (name, description) => ({
    kind: 'skill', name, description, path: `/h/.claude/skills/${name}/SKILL.md`, editable: true, origin: 'claude', mtimeMs: nowMs,
  });
  const synthetic = [
    skill('release-notes', 'Draft release notes from merged pull requests grouped by component'),
    skill('changelog-writer', 'Draft release notes from merged pull requests grouped by team'),
    skill('db-migrate', 'Run database migrations against the staging cluster safely'),
  ];
  const overlaps = analyze([], synthetic, { minCount: 3, sinceMs, nowMs }).findings.filter((f) => f.type === 'overlapping_assets');
  assert.equal(overlaps.length, 1);
  assert.ok(mentions(overlaps[0], '/release-notes/SKILL.md'));
  assert.ok(mentions(overlaps[0], '/changelog-writer/SKILL.md'));
  assert.equal(mentions(overlaps[0], '/db-migrate/SKILL.md'), false);
  assert.equal(overlaps[0].hint, 'merge_assets');
});

// ---- decisions (S8) ----

test('decisions: dismissed follow_up never reappears', () => {
  const { id } = followUp(run());
  const r = run({ decisions: { [id]: { status: 'dismissed', decidedAt: Date.parse('2026-09-01') } } });
  assert.equal(r.findings.some((f) => f.id === id), false);
});

test('decisions: accepted follow_up with no newer occurrences is dropped', () => {
  const { id } = followUp(run());
  const r = run({ decisions: { [id]: { status: 'accepted', decidedAt: Date.parse('2026-10-15') } } });
  assert.equal(r.findings.some((f) => f.id === id), false);
});

test('decisions: accepted follow_up with >= minCount newer occurrences reappears', () => {
  const { id } = followUp(run());
  const r = run({ decisions: { [id]: { status: 'accepted', decidedAt: Date.parse('2026-09-01') } } });
  const f = r.findings.find((x) => x.id === id);
  assert.ok(f, 'accepted finding should reappear');
  assert.equal(f.reappeared, true);
});

test('decisions: includeDecided keeps dismissed findings', () => {
  const { id } = followUp(run());
  const r = run({ includeDecided: true, decisions: { [id]: { status: 'dismissed', decidedAt: Date.parse('2026-09-01') } } });
  assert.ok(r.findings.some((f) => f.id === id));
});

// ---- cost (S13) ----

test('cost.byAgent: scout 3 runs $30, sonic 4 runs', () => {
  const { byAgent } = run().cost;
  const scout = byAgent.find((a) => a.name === 'scout');
  assert.equal(scout.runs, 3);
  assert.ok(Math.abs(scout.costUsd - 30) < 1e-9, `scout cost ${scout.costUsd}`);
  assert.equal(byAgent.find((a) => a.name === 'sonic').runs, 4);
});

test('costly_asset: scout flagged against the per-run median, sonic not', () => {
  const costly = byType(run(), 'costly_asset');
  const scout = costly.find((f) => f.target?.name === 'scout');
  assert.ok(scout, 'scout costly_asset missing');
  assert.equal(scout.id, createHash('sha1').update('costly_asset|agent:scout').digest('hex').slice(0, 10));
  assert.ok(scout.target.path.endsWith('.omp/agent/agents/scout.md'), scout.target.path);
  assert.equal(costly.some((f) => mentions(f, 'sonic')), false);
});

// omp s4–s6 read the skill before their first typed prompt; those reads belong to no turn (Step 5).
test('cost.bySkill: linear-comment used in 4 turns (omp s1–s3 and Claude c1; pre-prompt reads in s4–s6 are in no turn)', () => {
  assert.equal(run().cost.bySkill.find((s) => s.name === 'linear-comment').uses, 4);
});

test('cost.bySource: omp cache hit rate is cacheRead / (input + cacheRead + cacheWrite)', () => {
  assert.equal(run().cost.bySource.omp.hitRate, 0.9);
});

test('costBasis labels each source: omp recorded, claude allocated, codex and cursor unpriced', () => {
  assert.deepEqual(run().costBasis, { omp: 'recorded', claude: 'allocated', codex: 'unpriced', cursor: 'unpriced' });
});

// ---- totals / activity (S15, S17) ----

test('totals: omp has 6 main sessions with 14 typed prompts; subagent files are not sessions', () => {
  assert.deepEqual(run().totals.omp, { sessions: 6, prompts: 14 });
});

test('totals: cursor counts the main composer only (k2 is a subagent, k3 a draft)', { skip: noSqlite }, () => {
  assert.deepEqual(run().totals.cursor, { sessions: 1, prompts: 1 });
});

test('activity.byDay: ascending days that have data, with 2026-10-01 holding s1\'s typed prompts', () => {
  const { byDay } = run().activity;
  const days = byDay.map((d) => d.day);
  assert.deepEqual(days, [...new Set(days)].sort());
  assert.ok(byDay.every((d) => d.prompts > 0 || d.costUsd > 0), JSON.stringify(byDay));
  assert.ok(byDay.find((d) => d.day === '2026-10-01').prompts >= 3);
});

test('activity.byDay: 2026-10-20 has s4\'s one prompt and its two $0.10 assistant messages', () => {
  const oct20 = run().activity.byDay.find((d) => d.day === '2026-10-20');
  assert.equal(oct20.prompts, 1);
  assert.ok(Math.abs(oct20.costUsd - 0.2) < 1e-9, `costUsd ${oct20.costUsd}`);
});

test('activity.byDay: the Cursor day counts its typed prompt and no unpriced cost', { skip: noSqlite }, () => {
  const oct10 = run().activity.byDay.find((d) => d.day === '2026-10-10');
  assert.deepEqual({ prompts: oct10.prompts, costUsd: oct10.costUsd }, { prompts: 1, costUsd: 0 });
});

// ---- standard_violation (S18) ----

const skillPath = (name) => assets.find((a) => a.kind === 'skill' && a.name === name && a.editable).path;
const audit = (name, failed) => ({ path: skillPath(name), kind: 'skill', name, score: 50, failed });
const check = (id, severity) => ({ id, severity, detail: `${id} detail` });

test('standard_violation: >= 1 major or >= 2 minor failed checks become findings; one minor does not', () => {
  const audits = [
    audit('linear-comment', [check('trigger', 'major')]),
    audit('design-system', [check('boundary', 'minor'), check('done', 'minor')]),
    audit('old-skill', [check('claims', 'minor')]),
  ];
  const found = byType(run({ audits }), 'standard_violation').map((f) => f.target.name).sort();
  assert.deepEqual(found, ['design-system', 'linear-comment']);
});

test('standard_violation: finding names the failed checks and targets the asset', () => {
  const a = audit('linear-comment', [check('trigger', 'major'), check('links', 'major')]);
  const [f] = byType(run({ audits: [a] }), 'standard_violation');
  assert.equal(f.title, 'Standards: skill "linear-comment" fails trigger, links');
  assert.equal(f.id, createHash('sha1').update(`standard_violation|${a.path}`).digest('hex').slice(0, 10));
  assert.equal(f.hint, 'update_asset');
  assert.equal(f.target.path, a.path);
  assert.deepEqual([f.count, f.sessions], [2, 0]);
  assert.deepEqual(f.examples.map((e) => e.text), ['trigger (major): trigger detail', 'links (major): links detail']);
});

test('findings are ordered by type: follow_up … memory_promotion, standard_violation, overlapping_assets, unused_asset', () => {
  const ORDER = ['follow_up', 'repeated_prompt', 'costly_asset', 'memory_promotion', 'standard_violation', 'overlapping_assets', 'unused_asset'];
  const ranks = run({ audits: [audit('linear-comment', [check('trigger', 'major')])] }).findings.map((f) => ORDER.indexOf(f.type));
  assert.ok(!ranks.includes(-1), 'unknown finding type');
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(ranks.includes(4), 'standard_violation missing');
});

// ---- memory (S14) ----

test('memory_promotion: similar feedback memories across projects form one finding', () => {
  const promos = byType(run(), 'memory_promotion');
  const f = promos.find((x) => mentions(x, '/memory/p1.md'));
  assert.ok(f, 'p1/p2 promotion missing');
  assert.ok(mentions(f, '/memory/p2.md'));
  assert.equal(f.sessions, 2);
  assert.equal(f.hint, 'promote_memory');
});

test('memory_promotion: user-type memory is promoted on its own; project memories never', () => {
  const promos = byType(run(), 'memory_promotion');
  const u1 = promos.filter((x) => mentions(x, '/memory/u1.md'));
  assert.equal(u1.length, 1);
  assert.equal(mentions(u1[0], '/memory/p1.md'), false);
  assert.equal(promos.some((x) => mentions(x, '/memory/r1.md')), false);
  assert.equal(promos.length, 2);
});

test('memory summary: counts per project and type', () => {
  const a = run().memory.byProject.find((p) => p.project === '/a');
  assert.equal(a.count, 4);
  assert.deepEqual(a.types, { feedback: 1, project: 3 });
});

// ---- costly_asset counts priced runs/turns only (reviewer fix 6) ----

const T0 = Date.parse('2026-10-10T00:00:00Z');
const usageEv = (sessionId, ts, costUsd, extra = {}) => ({
  source: 'omp', sessionId, cwd: '/p', ts, kind: 'usage', model: 'm', input: 10, output: 10, cacheRead: 0, cacheWrite: 0, costUsd, ...extra,
});
/** One subagent run per entry of `costs` (null = unpriced), as agent `name`. */
const runs = (name, costs) =>
  costs.map((c, i) => usageEv(`${name}-run-${i}`, T0 + i * 60_000, c, { sub: true, agent: name }));
/** One main session per entry of `costs`: a typed prompt, an optional skill read, one usage event. */
const turns = (skill, costs) =>
  costs.flatMap((c, i) => {
    const sessionId = `${skill ?? 'plain'}-turn-${i}`;
    const ts = T0 + i * 60_000;
    return [
      { source: 'omp', sessionId, cwd: '/p', ts, kind: 'prompt', text: `${skill ?? 'plain'} task number ${i}` },
      ...(skill ? [{ source: 'omp', sessionId, cwd: '/p', ts: ts + 1, kind: 'skill', name: skill, how: 'model' }] : []),
      usageEv(sessionId, ts + 2, c),
    ];
  });
const PRICED_EVENTS = [
  ...runs('pricey', [10, 10, 10, null, null]), // 3 priced runs at $10, 2 unpriced
  ...runs('thin', [20, 20, null, null, null]), // only 2 priced runs
  ...runs('cheap', Array(9).fill(0.1)), // per-run median stays $0.10
  ...turns('heavy', [5, 5, 5, null, null]), // 3 priced turns at $5, 2 unpriced
  ...turns(null, Array(9).fill(0.1)), // per-turn median stays $0.10
];
const priced = () => analyze(PRICED_EVENTS, [], { minCount: 3, sinceMs, nowMs, sources: ['omp'] });

test('costly_asset agent: cost per run divides by priced runs only', () => {
  const f = priced().findings.find((x) => x.type === 'costly_asset' && x.trigger?.name === 'pricey');
  assert.ok(f, 'pricey costly_asset missing');
  assert.deepEqual({ count: f.count, perUse: f.perUse, costUsd: f.costUsd }, { count: 3, perUse: 10, costUsd: 30 });
});

test('costly_asset agent: fewer than 3 priced runs is not a candidate, however many unpriced runs it has', () => {
  assert.equal(priced().findings.some((x) => x.type === 'costly_asset' && x.trigger?.name === 'thin'), false);
});

test('costly_asset skill: cost per use divides by priced turns only', () => {
  const f = priced().findings.find((x) => x.type === 'costly_asset' && x.trigger?.name === 'heavy');
  assert.ok(f, 'heavy costly_asset missing');
  assert.deepEqual({ count: f.count, perUse: f.perUse, costUsd: f.costUsd }, { count: 3, perUse: 5, costUsd: 15 });
});

test('cost.byAgent and cost.bySkill rows expose priced runs/uses next to the totals', () => {
  const { byAgent, bySkill } = priced().cost;
  const pricey = byAgent.find((a) => a.name === 'pricey');
  const heavy = bySkill.find((s) => s.name === 'heavy');
  assert.deepEqual({ runs: pricey.runs, priced: pricey.priced }, { runs: 5, priced: 3 });
  assert.deepEqual({ uses: heavy.uses, priced: heavy.priced }, { uses: 5, priced: 3 });
});

test('impact costPerUse: samples are priced runs after the decision; unpriced runs do not dilute the cost', () => {
  const snapshot = { type: 'costly_asset', title: 'Costly agent "pricey"', kind: 'agent', name: 'pricey', baseline: { metric: 'costPerUse', value: 20, samples: 3 } };
  const r = analyze(PRICED_EVENTS, [], { minCount: 3, sinceMs, nowMs, decisions: { x: { status: 'accepted', decidedAt: T0 - 1, snapshot } } });
  const { after, samples, verdict } = r.impact[0];
  assert.deepEqual({ after, samples, verdict }, { after: 10, samples: 3, verdict: 'improved' });
});

test('impact costPerUse: no priced run after the decision is insufficient_data with after null', () => {
  const snapshot = { type: 'costly_asset', title: 'Costly agent "ghost"', kind: 'agent', name: 'ghost', baseline: { metric: 'costPerUse', value: 20, samples: 3 } };
  const events = runs('ghost', [null, null, null, null]);
  const r = analyze(events, [], { minCount: 3, sinceMs, nowMs, decisions: { x: { status: 'accepted', decidedAt: T0 - 1, snapshot } } });
  const { after, samples, verdict } = r.impact[0];
  assert.deepEqual({ after, samples, verdict }, { after: null, samples: 0, verdict: 'insufficient_data' });
});
