// S4–S8, S13, S14, S15, S17: findings, usage, cost, memory and activity analysis over the fixture home.
//
// analyze() is fed the events of all four readers. skill "linear-comment" is read 7 times in
// main sessions (omp s1–s6 and Claude c1); "shorter version" follows it in s1–s3 only.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { readEvents as readClaude } from '../lib/sources/claude.mjs';
import { readEvents as readCodex } from '../lib/sources/codex.mjs';
import { readEvents as readCursor } from '../lib/sources/cursor.mjs';
import { listAssets } from '../lib/inventory.mjs';
import { analyze } from '../lib/analyze.mjs';
import { makeHome, NOW_MS as nowMs, SINCE_MS as sinceMs, HAS_SQLITE, eventsOf, mentions, tmpCoachHome, writeAsset, writeClaudeSession } from './_helpers.mjs';

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

test('COACH1-S8 findings: the best of each present type leads in type order, then the rest by type', () => {
  const ORDER = ['follow_up', 'repeated_prompt', 'costly_asset', 'memory_promotion', 'standard_violation', 'overlapping_assets', 'unused_asset'];
  const types = run({ audits: [audit('linear-comment', [check('trigger', 'major')])] }).findings.map((f) => f.type);
  assert.ok(types.every((t) => ORDER.includes(t)), 'unknown finding type');
  const present = ORDER.filter((t) => types.includes(t));
  assert.ok(present.includes('standard_violation'), 'standard_violation missing');
  assert.deepEqual(types.slice(0, present.length), present, 'heads');
  const rest = types.slice(present.length).map((t) => ORDER.indexOf(t));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b), 'rest keeps the type order');
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

// ---- COACH1: noise filtering, project assets, attribution, unused age, order ----

const DAY = 86_400_000;
const claudeAnalysis = async (sessions, assetList = [], opts = {}) => {
  const h = tmpCoachHome();
  for (const s of sessions) writeClaudeSession(h, s);
  const { events: evs } = await readClaude({ home: h, sinceMs });
  return analyze(evs, assetList, { minCount: 3, sinceMs, nowMs, ...opts });
};
const day = (d) => `2026-10-${String(d).padStart(2, '0')}T10:00:00.000Z`;

test('COACH1-S2 teammate pings repeated across sessions yield no repeated_prompt or follow_up finding', async () => {
  const ping = '<teammate-message teammate_id="lead" color="blue">Status check: report progress on the migration task</teammate-message>';
  const r = await claudeAnalysis(
    [1, 2, 3].map((d) => ({ sessionId: `team-${d}`, cwd: '/proj', start: day(d), records: [ping, 'reply with the migration status summary', ping] })),
  );
  const noisy = r.findings.filter((f) => ['repeated_prompt', 'follow_up'].includes(f.type) && mentions(f, 'teammate'));
  assert.deepEqual(noisy.map((f) => f.title), []);
});

test('COACH1-S3 inventory: project dirs and their ancestors below $HOME add project assets once', async () => {
  const h = tmpCoachHome();
  const work = path.join(h, 'work');
  const repo = path.join(work, 'repo');
  const pkg = path.join(repo, 'pkg');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-outside-'));
  const nested = path.join(outside, 'a', 'b');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  const expected = [
    writeAsset(work, '.claude/skills/shared-skill/SKILL.md', { name: 'shared-skill', description: 'Shared by every repo under work' }),
    writeAsset(repo, '.claude/agents/repo-agent.md', { name: 'repo-agent', description: 'Repo agent' }),
    writeAsset(repo, '.claude/commands/ship.md', { name: 'ship', description: 'Ship it' }),
    writeAsset(repo, '.agents/skills/agents-skill/SKILL.md', { name: 'agents-skill', description: 'Agents-standard skill' }),
    writeAsset(pkg, '.claude/skills/pkg-skill/SKILL.md', { name: 'pkg-skill', description: 'Package skill' }),
    writeAsset(outside, '.claude/skills/outside-skill/SKILL.md', { name: 'outside-skill', description: 'Outside home' }),
  ];
  const homeSkill = writeAsset(h, '.claude/skills/home-skill/SKILL.md', { name: 'home-skill', description: 'Home skill' });
  const list = await listAssets({ home: h, projectDirs: [pkg, repo, h, nested] });
  const count = (p) => list.filter((a) => a.path === p).length;
  for (const p of expected) {
    assert.equal(count(p), 1, `${path.relative(h, p)} listed ${count(p)} times`);
    const a = list.find((x) => x.path === p);
    assert.deepEqual([a.origin, a.editable], ['project', true], p);
  }
  assert.deepEqual(list.find((a) => a.path === homeSkill)?.origin, 'claude');
  assert.equal(count(homeSkill), 1, 'home-level skill listed twice');
});

test('COACH1-S5 Task/Agent subagent_type "plugin:name" counts as a use of agent "name"', async () => {
  const reviewer = { kind: 'agent', name: 'reviewer', description: 'Reviews code', path: '/p/.claude/agents/reviewer.md', editable: true, origin: 'claude', mtimeMs: Date.parse('2020-01-01') };
  const r = await claudeAnalysis(
    [1, 2, 3].map((d) => ({ sessionId: `rev-${d}`, cwd: '/p', start: day(d), records: ['review the payment module', { agent: 'myplug:reviewer' }, 'redo the review with more detail'] })),
    [reviewer],
  );
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.title), [], 'reviewer used 3 times but reported unused');
  const f = r.findings.find((x) => x.type === 'follow_up' && x.trigger?.kind === 'agent');
  assert.ok(f, 'agent follow_up missing');
  assert.equal(f.target?.path, reviewer.path);
});

test('COACH1-S6 unused_asset: unused for the window and modified over 30 days ago; recent edits are spared', () => {
  const skill = (name, ageDays) => ({
    kind: 'skill', name, description: `${name} helper`, path: `/h/.claude/skills/${name}/SKILL.md`, editable: true, origin: 'claude', mtimeMs: nowMs - ageDays * DAY,
  });
  const synthetic = [skill('stale-40d', 40), skill('fresh-10d', 10)];
  const unusedIn = (windowDays) =>
    analyze([], synthetic, { minCount: 3, sinceMs: nowMs - windowDays * DAY, nowMs }).findings.filter((f) => f.type === 'unused_asset').map((f) => f.target.name).sort();
  assert.deepEqual(unusedIn(90), ['stale-40d'], '90-day window');
  assert.deepEqual(unusedIn(7), ['stale-40d'], '7-day window');
});

test('COACH1-S7 a slash-invoked skill is one skill trigger, not an extra command trigger', async () => {
  const slash = '<command-message>deploy-check</command-message>\n<command-name>/deploy-check</command-name>\n<command-args></command-args>';
  const r = await claudeAnalysis(
    [1, 2, 3].map((d) => ({
      sessionId: `slash-${d}`,
      cwd: '/proj',
      start: day(d),
      records: [slash, { meta: 'Base directory for this skill: /x/.claude/skills/deploy-check\n\nDEPLOY_BODY' }, 'now fix the lint errors'],
    })),
  );
  const triggers = r.findings.filter((f) => f.type === 'follow_up' && /lint errors/.test(f.title)).map((f) => `${f.trigger.kind}:${f.trigger.name}`);
  assert.deepEqual(triggers, ['skill:deploy-check']);
});

// ---- COACH1 review: symlink dedupe and identical project copies (S11) ----

const realCount = (list, file) => list.filter((a) => fs.realpathSync(a.path) === fs.realpathSync(file)).length;

test('COACH1-R1 inventory: a project skill reached through a symlinked skill dir is listed once', async () => {
  const h = tmpCoachHome();
  const repo = path.join(h, 'work', 'repo');
  const real = writeAsset(repo, '.agents/skills/linked/SKILL.md', { name: 'linked', description: 'Linked skill' });
  fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join('..', '..', '.agents', 'skills', 'linked'), path.join(repo, '.claude', 'skills', 'linked'));
  const list = await listAssets({ home: h, projectDirs: [repo] });
  assert.equal(realCount(list, real), 1);
});

test('COACH1-R1 inventory: two cwds resolving to the same real dir list its assets once', async () => {
  const h = tmpCoachHome();
  const repo = path.join(h, 'work', 'repo');
  const real = writeAsset(repo, '.claude/agents/twice.md', { name: 'twice', description: 'Reached twice' });
  fs.symlinkSync(repo, path.join(h, 'work', 'alias'));
  const list = await listAssets({ home: h, projectDirs: [repo, path.join(h, 'work', 'alias')] });
  assert.equal(realCount(list, real), 1);
});

test('COACH1-R1 inventory: a home skill symlinked into a project keeps its home entry only', async () => {
  const h = tmpCoachHome();
  const repo = path.join(h, 'work', 'repo');
  const real = writeAsset(h, '.claude/skills/shared/SKILL.md', { name: 'shared', description: 'Home skill shared into a repo' });
  fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.dirname(real), path.join(repo, '.claude', 'skills', 'shared'));
  const list = await listAssets({ home: h, projectDirs: [repo] });
  const hits = list.filter((a) => fs.realpathSync(a.path) === fs.realpathSync(real));
  assert.deepEqual(hits.map((a) => a.origin), ['claude']);
});

test('COACH1-S11 inventory: project assets carry the sha1 of their content; identical copies are all listed', async () => {
  const h = tmpCoachHome();
  const a = writeAsset(path.join(h, 'work', 'one'), '.claude/skills/fmt/SKILL.md', { name: 'fmt', description: 'Format code' });
  const b = writeAsset(path.join(h, 'work', 'two'), '.claude/skills/fmt/SKILL.md', { name: 'fmt', description: 'Format code' });
  const list = await listAssets({ home: h, projectDirs: [path.join(h, 'work', 'one'), path.join(h, 'work', 'two')] });
  const sha1 = (p) => createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  for (const p of [a, b]) assert.equal(list.find((x) => x.path === p)?.hash, sha1(p), p);
});

const projCopy = (kind, name, root, { hash = 'h1', mtimeMs = Date.parse('2020-01-01'), description = `${name} helper for this repo`, repo } = {}) => ({
  kind,
  name,
  description,
  path: kind === 'skill' ? `${root}/.claude/skills/${name}/SKILL.md` : `${root}/.claude/${kind}s/${name}.md`,
  editable: true,
  origin: 'project',
  mtimeMs,
  hash,
  ...(repo ? { repoId: repo, repoRoot: root } : {}),
});
const REPO = 'github.com/o/fmt';
const promptEv = (sessionId, cwd, ts, text) => ({ source: 'omp', sessionId, cwd, ts, kind: 'prompt', text });

test('COACH1-S11 identical unused project copies: one unused_asset and one standard_violation on the newest copy, no overlap', () => {
  const older = projCopy('skill', 'fmt', '/w/app', { mtimeMs: Date.parse('2020-01-01') });
  const newer = projCopy('skill', 'fmt', '/w/lib', { mtimeMs: Date.parse('2021-01-01') });
  const fail = { id: 'trigger', severity: 'major', detail: 'no trigger' };
  const audits = [older, newer].map((a) => ({ path: a.path, kind: 'skill', name: 'fmt', score: 50, failed: [fail] }));
  const r = analyze([], [older, newer], { minCount: 3, sinceMs, nowMs, audits });
  assert.deepEqual(byType(r, 'overlapping_assets').map((f) => f.title), []);
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.target.path), [newer.path]);
  assert.deepEqual(byType(r, 'standard_violation').map((f) => f.target.path), [newer.path]);
});

const failAudits = (assets) => assets.map((a) => ({ path: a.path, kind: a.kind, name: a.name, score: 50, failed: [{ id: 'trigger', severity: 'major', detail: 'no trigger' }] }));
const assetRun = (assets, decisions = {}) => analyze([], assets, { minCount: 3, sinceMs, nowMs, decisions, audits: failAudits(assets) });
const dismissAll = (r) =>
  Object.fromEntries([...byType(r, 'unused_asset'), ...byType(r, 'standard_violation')].map((f) => [f.id, { status: 'dismissed', decidedAt: nowMs - 1 }]));
const assetFindings = (r) => [...byType(r, 'unused_asset'), ...byType(r, 'standard_violation')];

test('COACH1-S11 a dismissed project finding stays dismissed when worktrees are added or removed', () => {
  const app = projCopy('skill', 'fmt', '/w/app', { repo: REPO });
  const lib = projCopy('skill', 'fmt', '/w/lib', { mtimeMs: Date.parse('2021-01-01'), repo: REPO });
  const single = assetRun([app]);
  assert.equal(assetFindings(single).length, 2);
  const decisions = dismissAll(single);
  // A second worktree forms a copy group whose kept copy is the newer /w/lib.
  const grouped = assetRun([app, lib]);
  assert.deepEqual(byType(grouped, 'unused_asset').map((f) => f.target.path), [lib.path]);
  assert.deepEqual(assetFindings(grouped).map((f) => f.id).sort(), Object.keys(decisions).sort());
  assert.deepEqual(assetFindings(assetRun([app, lib], decisions)), []);
  // The first worktree is removed: the group breaks, the id stays.
  assert.deepEqual(assetFindings(assetRun([lib], decisions)), []);
});

test('COACH1-S11 a dismissed project finding stays dismissed after the file is edited', () => {
  const app = projCopy('skill', 'fmt', '/w/app', { repo: REPO });
  const decisions = dismissAll(assetRun([app]));
  const edited = { ...app, hash: 'h2', description: 'fmt helper, rewritten' };
  assert.deepEqual(assetFindings(assetRun([edited])).map((f) => f.id).sort(), Object.keys(decisions).sort());
  assert.deepEqual(assetFindings(assetRun([edited], decisions)), []);
});

test('COACH1-S11 diverged copies at the same path of one repo: one finding per type, unique ids, other copy listed', () => {
  const app = projCopy('skill', 'fmt', '/w/app', { hash: 'h1', mtimeMs: Date.parse('2021-01-01'), repo: REPO });
  const lib = projCopy('skill', 'fmt', '/w/lib', { hash: 'h2', description: 'fmt helper, diverged', repo: REPO });
  const r = assetRun([app, lib]);
  const unused = byType(r, 'unused_asset');
  assert.equal(unused.length, 1);
  assert.equal(unused[0].target.path, app.path);
  assert.deepEqual(unused[0].examples.map((e) => e.cwd), [app.path, lib.path]);
  const sv = byType(r, 'standard_violation');
  assert.equal(sv.length, 1);
  assert.ok(sv[0].examples.some((e) => e.cwd === lib.path));
  assert.equal(byType(r, 'overlapping_assets').length, 1);
  const ids = r.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
});

test('COACH1-S11 the same project path in different repos gives separate findings', () => {
  const a = projCopy('command', 'new-branch', '/w/scripts', { hash: 'h1', repo: 'github.com/o/scripts' });
  const b = projCopy('command', 'new-branch', '/w/service', { hash: 'h2', repo: 'github.com/o/service' });
  const r = assetRun([a, b]);
  assert.deepEqual(byType(r, 'standard_violation').map((f) => f.target.path).sort(), [a.path, b.path].sort());
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.examples.length), [1, 1]);
  const ids = r.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('COACH1-S11 inventory: clones (https and ssh origin) and worktrees share a repo id; other repos, no remote and no git do not', async () => {
  const h = tmpCoachHome();
  const w = (...p) => path.join(h, 'work', ...p);
  const git = (dir, config) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), config);
  };
  const origin = (url) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  git(w('tools-https'), origin('https://GitHub.com/org/tools.git'));
  git(w('tools-ssh'), origin('git@github.com:org/tools.git'));
  // A worktree of tools-https: `.git` file → per-worktree dir whose commondir is the main `.git`.
  const wtDir = w('tools-https', '.git', 'worktrees', 'feature');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, 'commondir'), '../..\n');
  fs.mkdirSync(w('tools-feature'), { recursive: true });
  fs.writeFileSync(w('tools-feature', '.git'), `gitdir: ${wtDir}\n`);
  git(w('other'), origin('git@github.com:org/other.git'));
  git(w('local'), '[core]\n\tbare = false\n');
  fs.mkdirSync(w('plain'), { recursive: true });
  const dirs = ['tools-https', 'tools-ssh', 'tools-feature', 'other', 'local', 'plain'];
  dirs.forEach((d, i) => writeAsset(w(d), '.claude/commands/new-branch.md', { name: 'new-branch', description: `Create a branch, variant ${i}` }));
  const list = (await listAssets({ home: h, projectDirs: dirs.map((d) => w(d)) })).filter((a) => a.origin === 'project');
  const idOf = (d) => list.find((a) => a.path.startsWith(w(d) + path.sep))?.repoId;
  assert.deepEqual(['tools-https', 'tools-ssh', 'tools-feature'].map(idOf), ['github.com/org/tools', 'github.com/org/tools', 'github.com/org/tools']);
  assert.equal(idOf('other'), 'github.com/org/other');
  assert.equal(idOf('local'), w('local'));
  assert.equal(idOf('plain'), w('plain'));
  const r = assetRun(list);
  const sv = byType(r, 'standard_violation');
  assert.equal(sv.length, 4, sv.map((f) => f.target.path).join(', '));
  const tools = sv.find((f) => ['tools-https', 'tools-ssh', 'tools-feature'].some((d) => f.target.path.startsWith(w(d))));
  assert.equal(tools.examples.filter((e) => e.text.startsWith('also in ')).length, 2);
});

/** Project dirs under `h/work`, each with `.claude/commands/new-branch.md`, mapped to their asset's repoId. */
async function repoIds(h, dirs) {
  const w = (d) => path.join(h, 'work', d);
  dirs.forEach((d) => writeAsset(w(d), '.claude/commands/new-branch.md', { name: 'new-branch', description: `Create a branch in ${d}` }));
  const list = await listAssets({ home: h, projectDirs: dirs.map(w) });
  return dirs.map((d) => list.find((a) => a.origin === 'project' && a.path.startsWith(w(d) + path.sep))?.repoId);
}

test('COACH1-S11 inventory: worktrees of different bare repos in one folder without a remote get different repo ids', async () => {
  const h = tmpCoachHome();
  const w = (...p) => path.join(h, 'work', ...p);
  for (const bare of ['a.git', 'b.git']) {
    const wt = w('bare', bare, 'worktrees', 'main');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(w('bare', bare, 'config'), '[core]\n\tbare = true\n');
    fs.writeFileSync(path.join(wt, 'commondir'), '../..\n');
    fs.mkdirSync(w(`wt-${bare}`), { recursive: true });
    fs.writeFileSync(w(`wt-${bare}`, '.git'), `gitdir: ${wt}\n`);
  }
  assert.deepEqual(await repoIds(h, ['wt-a.git', 'wt-b.git']), [w('bare', 'a.git'), w('bare', 'b.git')]);
});

test('COACH1-S11 inventory: a relative origin is resolved against its worktree', async () => {
  const h = tmpCoachHome();
  const w = (...p) => path.join(h, 'work', ...p);
  for (const d of ['c1', 'c2', path.join('deeper', 'c3')]) {
    fs.mkdirSync(w(d, '.git'), { recursive: true });
    fs.writeFileSync(w(d, '.git', 'config'), '[remote "origin"]\n\turl = ../upstream.git\n');
  }
  assert.deepEqual(await repoIds(h, ['c1', 'c2', path.join('deeper', 'c3')]), [w('upstream'), w('upstream'), w('deeper', 'upstream')]);
});

test('COACH1-S11 home assets keep their absolute-path finding ids', () => {
  const home = { ...projCopy('skill', 'fmt', '/h'), origin: 'claude' };
  delete home.hash;
  const id = (type) => createHash('sha1').update(`${type}|${home.path}`).digest('hex').slice(0, 10);
  const r = assetRun([home]);
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.id), [id('unused_asset')]);
  assert.deepEqual(byType(r, 'standard_violation').map((f) => f.id), [id('standard_violation')]);
});

test('COACH1-S11 identical copies with equal use and mtime: the first path is kept', () => {
  const copies = [projCopy('skill', 'fmt', '/w/zeta'), projCopy('skill', 'fmt', '/w/alpha')];
  const r = analyze([], copies, { minCount: 3, sinceMs, nowMs });
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.target.path), ['/w/alpha/.claude/skills/fmt/SKILL.md']);
});

test('COACH1-S11 the copy used under its own project root is kept, even when older (no prefix match on /w/app vs /w/app-two)', () => {
  const app = projCopy('skill', 'fmt', '/w/app', { mtimeMs: Date.parse('2021-01-01') });
  const appTwo = projCopy('skill', 'fmt', '/w/app-two', { mtimeMs: Date.parse('2020-01-01') });
  const events = [];
  for (const d of [1, 2, 3]) {
    const t = Date.parse(`2026-10-0${d}T10:00:00Z`);
    events.push(
      promptEv(`fmt-${d}`, '/w/app-two/src', t, 'format the parser module'),
      { source: 'omp', sessionId: `fmt-${d}`, cwd: '/w/app-two/src', ts: t + 1000, kind: 'skill', name: 'fmt', how: 'model' },
      promptEv(`fmt-${d}`, '/w/app-two/src', t + 60_000, 'use tabs instead of spaces'),
    );
  }
  const r = analyze(events, [app, appTwo], { minCount: 3, sinceMs, nowMs });
  assert.deepEqual(byType(r, 'overlapping_assets').map((f) => f.title), []);
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.title), []);
  const f = r.findings.find((x) => x.type === 'follow_up' && x.trigger?.kind === 'skill' && x.trigger.name === 'fmt');
  assert.ok(f, 'fmt follow_up missing');
  assert.equal(f.target?.path, appTwo.path);
});

test('COACH1-S11 /name prompts count toward the keeper of identical command copies', () => {
  const one = projCopy('command', 'ship', '/w/one', { mtimeMs: Date.parse('2020-01-01') });
  const two = projCopy('command', 'ship', '/w/two', { mtimeMs: Date.parse('2021-01-01') });
  const events = [];
  for (const d of [1, 2, 3]) {
    const t = Date.parse(`2026-10-0${d}T10:00:00Z`);
    events.push(promptEv(`ship-${d}`, '/w/one', t, '/ship'), promptEv(`ship-${d}`, '/w/one', t + 60_000, 'also update the changelog'));
  }
  const r = analyze(events, [one, two], { minCount: 3, sinceMs, nowMs });
  const f = r.findings.find((x) => x.type === 'follow_up' && x.trigger?.kind === 'command' && x.trigger.name === 'ship');
  assert.ok(f, 'ship follow_up missing');
  assert.equal(f.target?.path, one.path);
  assert.deepEqual(byType(r, 'overlapping_assets').map((f) => f.title), []);
});

test('COACH1-S11 same-name project skills with different content still overlap', () => {
  const copies = [projCopy('skill', 'fmt', '/w/app', { hash: 'h1', repo: REPO }), projCopy('skill', 'fmt', '/w/lib', { hash: 'h2', repo: REPO })];
  const r = analyze([], copies, { minCount: 3, sinceMs, nowMs });
  const f = byType(r, 'overlapping_assets').find((x) => mentions(x, '/w/app/') && mentions(x, '/w/lib/'));
  assert.ok(f, 'different-content copies should overlap');
  // Both copies sit at .claude/skills/fmt/SKILL.md in one repo: one unused finding listing both.
  assert.deepEqual(byType(r, 'unused_asset').map((f) => f.examples.length), [2]);
});
