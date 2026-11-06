// S4–S8, S13, S14: findings, usage, cost and memory analysis over the fixture home.
//
// analyze() is fed omp events only: the Claude fixture also reads skill "linear-comment"
// (required by the sources test), which would add a 4th trigger (rate 0.75) and a 4th
// skill turn, contradicting the plan's `rate 1` / `uses 3` assertions.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { listAssets } from '../lib/inventory.mjs';
import { analyze } from '../lib/analyze.mjs';
import { FIXTURE_HOME as home, NOW_MS as nowMs, SINCE_MS as sinceMs, ageFixtures, mentions } from './_helpers.mjs';

const FOLLOW_UP_TITLE = 'After skill "linear-comment": "shorter version"';
let events;
let assets;
const run = (opts = {}) => analyze(events, assets, { minCount: 3, sinceMs, nowMs, ...opts });
const byType = (result, type) => result.findings.filter((f) => f.type === type);
const followUp = (result) => result.findings.find((f) => f.type === 'follow_up' && f.title === FOLLOW_UP_TITLE);

before(async () => {
  await ageFixtures();
  [events, assets] = await Promise.all([readOmp({ home, sinceMs }), listAssets({ home })]);
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

test('follow_up: "shorter version" after skill linear-comment', () => {
  const f = followUp(run());
  assert.ok(f, 'follow_up finding missing');
  assert.equal(f.occurrences, 3);
  assert.equal(f.rate, 1);
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

test('cost.bySkill: linear-comment used in 3 turns', () => {
  assert.equal(run().cost.bySkill.find((s) => s.name === 'linear-comment').uses, 3);
});

test('cost.bySource: omp cache hit rate is cacheRead / (input + cacheRead + cacheWrite)', () => {
  assert.equal(run().cost.bySource.omp.hitRate, 0.9);
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
