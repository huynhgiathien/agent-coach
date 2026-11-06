// S2, S8, S10: digest building, rendering, state files.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW_MS as nowMs, SINCE_DAYS as sinceDays, SECRET, makeHome, mentions, tmpCoachHome, writeAsset, writeClaudeSession } from './_helpers.mjs';
import { analyze } from '../lib/analyze.mjs';

const { home, coachDir: coachHome } = makeHome();
process.env.AGENT_COACH_HOME = coachHome;
const { buildDigest, renderMarkdown, formatAssets, formatExamples } = await import('../lib/digest.mjs');
const { recordDecision, readLastDigest } = await import('../lib/state.mjs');
const { listAssets } = await import('../lib/inventory.mjs');

const FOLLOW_UP_TITLE = 'After skill "linear-comment": "shorter version"';
const MAX = 40_000;
let digest;
let markdown;

before(async () => {
  digest = await buildDigest({ home, sinceDays, nowMs });
  markdown = renderMarkdown(digest);
});

test('markdown has the required sections and stays within 40 000 chars', () => {
  for (const heading of ['## Follow-up patterns', '## Repeated prompts', '## Cost & cache', '## Memory']) {
    assert.ok(markdown.includes(heading), `missing ${heading}`);
  }
  assert.ok(markdown.length <= MAX, `length ${markdown.length}`);
});

test('markdown shows each source cost with its basis label', () => {
  assert.match(markdown, /\$\d+\.\d\d \(recorded\)/);
  assert.ok(markdown.includes('$0.50 (allocated)'), 'claude cost without its basis');
});

test('markdown lists the linear-comment follow-up with its editable target', () => {
  assert.ok(markdown.includes(FOLLOW_UP_TITLE));
  assert.match(markdown, /\.claude\/skills\/linear-comment\/SKILL\.md \(editable\)/);
});

test('oversized digests are cut to 40 000 chars and end with the omitted-findings line', () => {
  const base = digest.findings.find((f) => f.title === FOLLOW_UP_TITLE);
  const findings = Array.from({ length: 500 }, (_, i) => ({
    ...base,
    id: `f${String(i).padStart(9, '0')}`,
    title: `Synthetic finding ${i} ${'t'.repeat(150)}`,
    examples: Array.from({ length: 50 }, (_, j) => ({
      text: `example ${j} ${'x '.repeat(1000)}`,
      ts: Date.parse('2026-10-01'),
      source: 'omp',
      cwd: '/proj',
      context: 'c'.repeat(300),
    })),
  }));
  const out = renderMarkdown({ ...digest, findings });
  assert.ok(out.length <= MAX, `length ${out.length}`);
  assert.match(out.trimEnd(), /\(\d+ findings omitted; use finding_examples or --json\)$/);
});

test('secrets never reach the markdown or last-digest.json', () => {
  assert.equal(markdown.includes(SECRET), false);
  const stored = fs.readFileSync(path.join(coachHome, 'last-digest.json'), 'utf8');
  assert.equal(stored.includes(SECRET), false);
  assert.ok(stored.includes('linear-comment'), 'last-digest.json should hold the digest');
});

test('last digest round-trips with stored examples', async () => {
  const last = await readLastDigest(home);
  assert.deepEqual(last.findings.map((f) => f.id), digest.findings.map((f) => f.id));
});

test('formatExamples prints dated lines with the trigger context', async () => {
  const { id } = digest.findings.find((f) => f.title === FOLLOW_UP_TITLE);
  const lines = formatExamples(await readLastDigest(home), id, 20).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\tomp\t\/proj\t/);
    assert.ok(line.endsWith('\tafter: draft a comment for FRO-1'), line);
  }
});

test('formatExamples rejects unknown ids and a missing digest', async () => {
  const last = await readLastDigest(home);
  assert.throws(() => formatExamples(last, 'nope'), /Unknown finding nope\. Run usage_digest again\./);
  assert.throws(() => formatExamples(null, 'nope'), /No digest yet\. Run usage_digest first\./);
});

test('formatAssets without a digest says there is no usage data', async () => {
  const out = await formatAssets(await listAssets({ home }), null);
  assert.ok(out.includes('No usage data yet; run usage_digest first.'));
  assert.ok(out.includes('linear-comment'));
});

test('recordDecision rejects statuses other than accepted/dismissed', async () => {
  await assert.rejects(async () => recordDecision(home, { id: 'abc', status: 'maybe' }), /status must be accepted or dismissed/);
});

test('a recorded dismissal hides the finding from the next digest', async () => {
  const { id } = digest.findings.find((f) => f.title === FOLLOW_UP_TITLE);
  await recordDecision(home, { id, status: 'dismissed', note: 'not useful' });
  const next = await buildDigest({ home, sinceDays, nowMs });
  assert.equal(next.findings.some((f) => f.id === id), false);
  const all = await buildDigest({ home, sinceDays, nowMs, includeDecided: true });
  assert.ok(all.findings.some((f) => f.id === id));
});

test('codex: $-mentions are taken from redacted text, so secrets never become skill names', async () => {
  const codexHome = tmpCoachHome();
  const ev = (ms, type, payload) => JSON.stringify({ timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + ms).toISOString(), type, payload });
  const rollout = path.join(codexHome, '.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-x.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, [
    ev(0, 'session_meta', { id: 'codex-x', cwd: '/proj', originator: 'codex_cli_rs', source: 'cli' }),
    ev(1000, 'event_msg', { type: 'user_message', message: 'db password: $hunter2secret99' }),
    ev(10_000, 'event_msg', { type: 'user_message', message: 'it costs $5 per run' }),
    ev(20_000, 'event_msg', { type: 'user_message', message: 'use $foo-bar for this' }),
  ].join('\n') + '\n');

  const { readEvents } = await import('../lib/sources/codex.mjs');
  const { events } = await readEvents({ home: codexHome, sinceMs: Date.parse('2026-09-01') });
  assert.deepEqual(events.filter((e) => e.kind === 'skill').map((e) => e.name), ['foo-bar']);
  assert.equal(JSON.stringify(events).includes('hunter2secret99'), false);

  const saved = process.env.AGENT_COACH_HOME;
  const stateDir = tmpCoachHome();
  process.env.AGENT_COACH_HOME = stateDir;
  try {
    const d = await buildDigest({ home: codexHome, sinceDays, nowMs, sources: ['codex'] });
    assert.equal(renderMarkdown(d).includes('hunter2secret99'), false);
    assert.equal(fs.readFileSync(path.join(stateDir, 'last-digest.json'), 'utf8').includes('hunter2secret99'), false);
  } finally {
    process.env.AGENT_COACH_HOME = saved;
  }
});

test('a selected source with no interactive sessions still gets a 0 row in totals and in the header', async () => {
  const { home: noCodex, coachDir: state } = makeHome();
  // Only an SDK run is left: it is skipped, so codex has no session at all.
  fs.rmSync(path.join(noCodex, '.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-a.jsonl'));
  const saved = process.env.AGENT_COACH_HOME;
  process.env.AGENT_COACH_HOME = state;
  try {
    const d = await buildDigest({ home: noCodex, sinceDays, nowMs, sources: ['omp', 'codex'] });
    assert.deepEqual(Object.keys(d.totals).sort(), ['codex', 'omp']);
    assert.deepEqual(d.totals.codex, { sessions: 0, prompts: 0 });
    assert.match(renderMarkdown(d), /^- codex: 0 sessions, 0 prompts\b/m);
  } finally {
    process.env.AGENT_COACH_HOME = saved;
  }
});

// ---- COACH1: project assets end to end; asset findings survive truncation ----

test('COACH1-S4 project assets from session cwds get audits, overlap, unused and follow-up targets', async () => {
  const h = tmpCoachHome();
  const repo = path.join(h, 'work', 'repo');
  const OLD = new Date('2020-01-01T00:00:00Z');
  const homeReview = writeAsset(h, '.claude/skills/review/SKILL.md', { name: 'review', description: 'Review a pull request' });
  const projReview = writeAsset(repo, '.claude/skills/review/SKILL.md', { name: 'review', description: 'Review a pull request in this repo' });
  const projSkill = writeAsset(repo, '.claude/skills/proj-skill/SKILL.md', { name: 'proj-skill', description: 'Summarize the sprint task' });
  const staleAgent = writeAsset(repo, '.claude/agents/stale-agent.md', { name: 'stale-agent', description: 'Old helper', mtime: OLD });
  for (const d of [1, 2, 3]) {
    writeClaudeSession(h, {
      slug: '-work-repo',
      sessionId: `proj-${d}`,
      cwd: repo,
      start: `2026-10-0${d}T10:00:00.000Z`,
      records: [
        'start the sprint task',
        { skill: 'proj-skill' },
        { meta: `Base directory for this skill: ${path.dirname(projSkill)}\n\nPROJ_BODY` },
        'make the summary shorter',
      ],
    });
  }
  const saved = process.env.AGENT_COACH_HOME;
  process.env.AGENT_COACH_HOME = tmpCoachHome();
  let d;
  try {
    d = await buildDigest({ home: h, sinceDays, nowMs, sources: ['claude'] });
  } finally {
    process.env.AGENT_COACH_HOME = saved;
  }
  const of = (type) => d.findings.filter((f) => f.type === type);
  assert.ok(d.standards.some((a) => a.path === projSkill), 'project skill not audited');
  assert.ok(d.standards.some((a) => a.path === staleAgent), 'project agent not audited');
  const overlap = of('overlapping_assets').find((f) => f.examples.some((e) => e.cwd === projReview));
  assert.ok(overlap, 'no overlap between the home and project "review" skills');
  assert.ok(overlap.examples.some((e) => e.cwd === homeReview));
  assert.deepEqual(of('unused_asset').map((f) => f.target.path), [staleAgent]);
  const follow = of('follow_up').find((f) => f.trigger.kind === 'skill' && f.trigger.name === 'proj-skill');
  assert.ok(follow, 'proj-skill follow_up missing');
  assert.equal(follow.target?.path, projSkill);
});

test('COACH1-S8 standards, overlap and unused findings lead the list and survive the 40 000-char cut', () => {
  const DAY = 86_400_000;
  const start = Date.parse('2026-10-01T00:00:00Z');
  const events = [];
  for (const s of [1, 2, 3]) {
    for (let i = 0; i < 20; i++) {
      const text = Array.from({ length: 20 }, (_, j) => `c${i}w${j}x`).join(' ');
      events.push({ source: 'omp', sessionId: `bulk-${s}`, cwd: '/proj', ts: start + s * DAY + i * 2 * 3_600_000, kind: 'prompt', text });
    }
  }
  const old = Date.parse('2020-01-01');
  const recent = nowMs - 5 * DAY;
  const skill = (name, dir, mtimeMs) => ({ kind: 'skill', name, description: `${name} helper`, path: `${dir}/${name}/SKILL.md`, editable: true, origin: 'claude', mtimeMs });
  const fail = (id) => ({ id, severity: 'major', detail: `${id} ${'detail '.repeat(40)}` });
  // 300 recent skills with two failed checks each overflow the markdown; "stale" (three failures) is the
  // best standards finding and the only unused skill; the recent "dup" pair overlaps.
  const bulk = Array.from({ length: 300 }, (_, i) => skill(`bulk-${String(i).padStart(3, '0')}`, '/h/.claude/skills', recent));
  const stale = skill('stale', '/h/.claude/skills', old);
  const assets = [...bulk, skill('dup', '/h/.claude/skills', recent), skill('dup', '/h/.agents/skills', recent), stale];
  const audits = [
    ...bulk.map((a) => ({ path: a.path, kind: 'skill', name: a.name, score: 50, failed: [fail('trigger'), fail('links')] })),
    { path: stale.path, kind: 'skill', name: 'stale', score: 30, failed: [fail('trigger'), fail('links'), fail('done')] },
  ];
  const d = analyze(events, assets, { minCount: 3, sinceMs: nowMs - 90 * DAY, nowMs, audits, sources: ['omp'] });
  const firstTen = d.findings.slice(0, 10).map((f) => f.type);
  for (const type of ['repeated_prompt', 'standard_violation', 'overlapping_assets', 'unused_asset']) {
    assert.ok(firstTen.includes(type), `${type} not in the first 10: ${firstTen.join(', ')}`);
  }
  const md = renderMarkdown(d);
  assert.ok(md.length <= MAX, `length ${md.length}`);
  assert.match(md, /\(\d+ findings omitted; use finding_examples or --json\)/, 'fixture too small: nothing was cut');
  for (const title of ['Standards: skill "stale"', '2 skill files named "dup"', 'Unused skill "stale"']) {
    assert.ok(md.includes(title), `${title} cut from the markdown`);
  }
});

test('COACH1-S11 digest.standards audits one of two identical project copies', async () => {
  const h = tmpCoachHome();
  const one = writeAsset(path.join(h, 'work', 'one'), '.claude/skills/fmt/SKILL.md', { name: 'fmt', description: 'Format code' });
  const two = writeAsset(path.join(h, 'work', 'two'), '.claude/skills/fmt/SKILL.md', { name: 'fmt', description: 'Format code' });
  for (const repo of ['one', 'two']) {
    writeClaudeSession(h, { slug: `-work-${repo}`, sessionId: `s-${repo}`, cwd: path.join(h, 'work', repo), start: '2026-10-02T10:00:00.000Z', records: ['hello there'] });
  }
  const saved = process.env.AGENT_COACH_HOME;
  process.env.AGENT_COACH_HOME = tmpCoachHome();
  let d;
  try {
    d = await buildDigest({ home: h, sinceDays, nowMs, sources: ['claude'] });
  } finally {
    process.env.AGENT_COACH_HOME = saved;
  }
  assert.equal(d.standards.filter((a) => a.path === one || a.path === two).length, 1);
  assert.equal(d.findings.some((f) => f.type === 'overlapping_assets' && mentions(f, '/fmt/SKILL.md')), false);
});
