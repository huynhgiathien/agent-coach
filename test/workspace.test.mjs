// W1–W7: workspace skill routing — scanWorkspace groups repos/worktrees, finds router gaps, collisions,
// invalid layouts and missed repo skills from session history, and persists last-workspace.json.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW_MS as nowMs, SINCE_DAYS as sinceDays, WS_PROMPTS, makeHome, mentions, ompSession, tmpCoachHome } from './_helpers.mjs';

const { home, coachDir, ws } = makeHome();
process.env.AGENT_COACH_HOME = coachDir;

let scanWorkspace;
let result;
const scan = (opts = {}) => scanWorkspace({ home, path: ws, sinceDays, minCount: 3, nowMs, ...opts });
const of = (type, r = result) => r.findings.filter((f) => f.type === type);
const routerTarget = (name) => path.join(ws, '.claude/skills', name, 'SKILL.md');

before(async () => {
  ({ scanWorkspace } = await import('../lib/workspace.mjs'));
  result = await scan();
});

// ---- W1: scope and errors ----

test('W1: scanWorkspace returns groups and findings for <home>/ws', () => {
  assert.ok(Array.isArray(result.groups), 'groups is not an array');
  assert.ok(Array.isArray(result.findings), 'findings is not an array');
});

test('W1: a folder with no git repos is "Not a workspace: <path> has 0 git repos (needs 2+)"', async () => {
  const notes = path.join(ws, 'notes');
  await assert.rejects(scan({ path: notes }), { message: `Not a workspace: ${notes} has 0 git repos (needs 2+)` });
});

test('W1: a path that does not exist is "Not a workspace … has 0 git repos"', async () => {
  const nope = path.join(ws, 'nope');
  await assert.rejects(scan({ path: nope }), { message: `Not a workspace: ${nope} has 0 git repos (needs 2+)` });
});

test('W1: a folder with one git repo child is not a workspace (needs 2+)', async () => {
  const one = path.join(home, 'one-repo');
  fs.mkdirSync(path.join(one, 'only/.git'), { recursive: true });
  await assert.rejects(scan({ path: one }), { message: `Not a workspace: ${one} has 1 git repos (needs 2+)` });
});

// ---- W2: grouping ----

test('W2: two groups, repoA (with its worktree repoA-wt) and repoB; notes is not a repo', () => {
  assert.deepEqual(result.groups.map((g) => g.name).sort(), ['repoA', 'repoB']);
  const repoA = result.groups.find((g) => g.name === 'repoA');
  assert.ok(mentions(repoA, 'repoA-wt'), 'repoA-wt is not a member of group repoA');
  assert.equal(mentions(result.groups, 'notes'), false, 'notes treated as a repo');
});

test('W2/W3: only the representative checkout is read: wt-only appears nowhere', () => {
  assert.equal(mentions(result, 'wt-only'), false);
});

test('W2/W3: no finding points into the worktree copy', () => {
  assert.equal(mentions(result.findings, `${path.sep}repoA-wt${path.sep}`), false);
});

test('W2: a workspace path through a symlink keeps the worktree with its main repo and matches physical session cwds', async () => {
  const { home: h, ws: w } = makeHome();
  const link = path.join(h, 'ws-link');
  fs.symlinkSync(w, link);
  const r = await scanWorkspace({ home: h, path: link, sinceDays, minCount: 3, nowMs });
  assert.deepEqual(r.groups.map((g) => g.name).sort(), ['repoA', 'repoB']);
  assert.ok(mentions(r.groups.find((g) => g.name === 'repoA'), 'repoA-wt'), 'repoA-wt split from repoA');
  assert.equal(mentions(r, 'wt-only'), false);
  assert.deepEqual(of('missed_repo_skill', r).map((f) => [f.count, f.triggerCount]), [[3, 3]]);
});

// ---- W5: static findings ----

test('W5: findings carry analyze-style ids and the shared fields', () => {
  const ids = result.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  for (const f of result.findings) {
    assert.match(f.id, /^[0-9a-f]{10}$/, `id ${f.id}`);
    for (const key of ['type', 'hint', 'title', 'count', 'sessions', 'examples', 'firstTs', 'lastTs']) assert.ok(key in f, `${f.type} lacks ${key}`);
    assert.ok(Array.isArray(f.examples));
  }
});

test('W5 router_missing: exactly one, for repoB, proposing <ws>/.claude/skills/repo-repob/SKILL.md', () => {
  const list = of('router_missing');
  assert.equal(list.length, 1, JSON.stringify(list.map((f) => f.title)));
  const [f] = list;
  assert.equal(f.hint, 'create_asset');
  assert.equal(f.target.path, routerTarget('repo-repob'));
  assert.equal(f.target.editable, true);
  assert.ok(mentions(f.examples, 'b-skill'), 'examples lack b-skill');
  assert.ok(mentions(f.examples, 'CLAUDE.md'), 'examples lack CLAUDE.md');
});

test('W5 router_missing: a proposed router never collides with an existing skill dir or another repo', async () => {
  const { home: h, ws: w } = makeHome();
  fs.mkdirSync(path.join(w, 'repo-b/.git'), { recursive: true });
  fs.writeFileSync(path.join(w, 'repo-b/CLAUDE.md'), '# repo-b\n\nAnother B.\n');
  // An existing skill at repo-repob that routes nothing (its slug is shared by repoB and repo-b).
  const existing = path.join(w, '.claude/skills/repo-repob/SKILL.md');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '---\nname: repo-repob\ndescription: Overview of the B services. Use when a task involves B. Not for other repos.\n---\n\nbody\n');
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const targetOf = (name) => of('router_missing', r).find((f) => f.title.includes(`repo ${name} `))?.target.path;
  assert.equal(targetOf('repoB'), path.join(w, '.claude/skills/repo-repob-2/SKILL.md'));
  assert.equal(targetOf('repo-b'), path.join(w, '.claude/skills/repo-repo-b/SKILL.md'));
  for (const f of r.findings) {
    if (f.hint === 'create_asset') assert.equal(fs.existsSync(f.target.path), false, `${f.type} targets existing ${f.target.path}`);
  }
  const missed = of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'));
  assert.equal(missed?.target.path, path.join(w, '.claude/skills/repo-repob-2/SKILL.md'));
});

test('W5 router_missing: the evidence counts repo skills and context files separately', async () => {
  const { renderWorkspace } = await import('../lib/workspace.mjs');
  const { home: h, ws: w } = makeHome();
  fs.writeFileSync(path.join(w, 'repoB/AGENTS.md'), '# repoB agents\n');
  fs.rmSync(path.join(w, 'repoB/.claude/skills/b-skill'), { recursive: true });
  const md = renderWorkspace(await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs }));
  assert.match(md, /^- evidence: 0 repo skills, 2 context files, no router$/m);
  assert.match(renderWorkspace(result), /^- evidence: 1 repo skill, 1 context file, no router$/m);
});

test('W5 router_stale: repo-repoa misses a-skill (count 1) and targets the router', () => {
  const list = of('router_stale');
  assert.equal(list.length, 1, JSON.stringify(list.map((f) => f.title)));
  const [f] = list;
  assert.equal(f.hint, 'update_asset');
  assert.equal(f.target.path, routerTarget('repo-repoa'));
  assert.equal(f.count, 1);
  assert.ok(mentions(f.examples, 'a-skill'), 'examples lack a-skill');
  assert.equal(mentions(f.examples, 'create-pr'), false, 'create-pr is in the router and must not be listed missing');
});

test('W5 name_collision: create-pr in 2 scopes (workspace + repoA), examples list both paths', () => {
  const list = of('name_collision');
  assert.equal(list.length, 1, JSON.stringify(list.map((f) => f.title)));
  const [f] = list;
  assert.ok(mentions(f, 'create-pr'));
  assert.equal(f.hint, 'merge_assets');
  assert.equal(f.count, 2);
  assert.ok(mentions(f.examples, path.join(ws, '.claude/skills/create-pr/SKILL.md')), 'workspace copy missing');
  assert.ok(mentions(f.examples, path.join(ws, 'repoA/.claude/skills/create-pr/SKILL.md')), 'repoA copy missing');
});

test('W5 invalid_layout: exactly one, for repoB, listing flat.md, patch only (editable false)', () => {
  const list = of('invalid_layout');
  assert.equal(list.length, 1, JSON.stringify(list.map((f) => f.title)));
  const [f] = list;
  assert.equal(f.hint, 'update_asset');
  assert.ok(mentions(f, 'repoB'));
  assert.ok(mentions(f.examples, 'flat.md'), 'examples lack flat.md');
  assert.equal(f.target.editable, false);
});

test('W5 invalid_layout: a flat .md at the workspace root is editable (true)', async () => {
  const { home: h, ws: w } = makeHome();
  fs.writeFileSync(path.join(w, '.claude/skills/root-flat.md'), '# root flat\n');
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const root = of('invalid_layout', r).find((f) => mentions(f.examples, 'root-flat.md'));
  assert.ok(root, 'no invalid_layout for the workspace root');
  assert.equal(root.target.editable, true);
});

test('W3: a skill in two skill roots of one checkout counts once (.claude first); name_collision still lists every path', async () => {
  const { home: h, ws: w } = makeHome();
  const copy = (rel, name) => {
    const file = path.join(w, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: Second copy of ${name}. Use when testing roots. Not for anything else.\n---\n\nbody\n`);
  };
  copy('repoA/.agents/skills/a-skill/SKILL.md', 'a-skill');
  copy('repoA/.agents/skills/create-pr/SKILL.md', 'create-pr');
  copy('repoB/.agents/skills/b-skill/SKILL.md', 'b-skill');
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const [stale] = of('router_stale', r);
  assert.equal(stale?.count, 1);
  assert.deepEqual(stale.examples.map((ex) => ex.cwd), [path.join(w, 'repoA/.claude/skills/a-skill/SKILL.md')]);
  const [missing] = of('router_missing', r);
  assert.equal(missing.examples.filter((ex) => ex.text === 'b-skill').length, 1);
  assert.equal(missing.count, 2);
  assert.deepEqual(r.groups.find((g) => g.name === 'repoB').skills, ['b-skill']);
  assert.deepEqual(r.groups.find((g) => g.name === 'repoA').skills.sort(), ['a-skill', 'create-pr']);
  assert.equal(of('name_collision', r).some((f) => mentions(f, 'b-skill') || mentions(f, '"a-skill')), false);
  const [collision] = of('name_collision', r);
  assert.equal(collision.count, 2);
  assert.ok(mentions(collision.examples, path.join(w, 'repoA/.agents/skills/create-pr/SKILL.md')), 'second repoA copy missing');
  assert.equal(collision.examples.length, 3);
});

// ---- W4: router association ----

test('W4: a repo- skill whose slug equals norm(G) is a router even without ./<dir> in its text', async () => {
  const { home: h, ws: w } = makeHome();
  const dir = path.join(w, '.claude/skills/repo-repob');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: repo-repob\ndescription: Overview of the B service. Use when a task involves B. Not for other repos.\n---\n\n## Repo skills\n\n- `b-skill` — deploy B\n',
  );
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  assert.equal(of('router_missing', r).length, 0, 'repo-repob not recognised as router of repoB');
  assert.equal(of('router_stale', r).some((f) => f.target?.path === path.join(dir, 'SKILL.md')), false);
  const missed = of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'));
  assert.equal(missed?.hint, 'update_asset');
  assert.equal(missed?.target.path, path.join(dir, 'SKILL.md'));
});

test('W4: a slug match counts only when norm(G) is unique; groups sharing a norm fall back to the description', async () => {
  const { home: h, ws: w } = makeHome();
  fs.mkdirSync(path.join(w, 'repo_b/.git'), { recursive: true });
  fs.writeFileSync(path.join(w, 'repo_b/CLAUDE.md'), '# repo_b\n\nAnother B.\n');
  const file = path.join(w, '.claude/skills/repo-repob/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const router = (description) =>
    fs.writeFileSync(file, `---\nname: repo-repob\ndescription: ${description}\n---\n\n## Repo skills\n\n- \`b-skill\` — deploy B\n`);
  const routersOf = (r, name) => r.groups.find((g) => g.name === name).routers;

  router('Overview of the B service. Use when a task involves B. Not for other repos.');
  let r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  assert.deepEqual([routersOf(r, 'repoB'), routersOf(r, 'repo_b')], [[], []], 'ambiguous slug matched');
  assert.equal(of('router_missing', r).length, 2);

  router('Overview of the ./repo_b repo — another B. Use when a task involves repo_b. Not for other repos.');
  r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  assert.deepEqual([routersOf(r, 'repoB'), routersOf(r, 'repo_b')], [[], ['repo-repob']]);
});

test('W4: a repo- skill that cites ./repoB only in its body (not its description) is not repoB\'s router', async () => {
  const { home: h, ws: w } = makeHome();
  const file = path.join(w, '.claude/skills/repo-services/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '---\nname: repo-services\ndescription: Overview of the backend services. Use when a task involves services. Not for the frontend.\n---\n\n' +
      'Covers ./repoB and `repoB`.\n\n## Repo skills\n\n- `b-skill` — deploy B; read ./repoB/.claude/skills/b-skill/SKILL.md\n',
  );
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const missing = of('router_missing', r);
  assert.equal(missing.length, 1, JSON.stringify(missing.map((f) => f.title)));
  assert.equal(missing[0].target.path, path.join(w, '.claude/skills/repo-repob/SKILL.md'));
  assert.equal(of('router_stale', r).some((f) => f.target?.path === file), false, 'router_stale targets the body-only skill');
  assert.equal(mentions(r.groups.find((g) => g.name === 'repoB'), 'repo-services'), false, 'repo-services listed as a repoB router');
  assert.equal(of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'))?.hint, 'create_asset');
});

// ---- W6: missed_repo_skill ----

test('W6 missed_repo_skill: repoB missed in 3 of 3 touched sessions, create_asset with the router_missing target', () => {
  const list = of('missed_repo_skill');
  assert.equal(list.length, 1, JSON.stringify(list.map((f) => f.title)));
  const [f] = list;
  assert.ok(mentions(f, 'repoB'));
  assert.deepEqual([f.count, f.triggerCount, f.rate, f.hint], [3, 3, 1, 'create_asset']);
  assert.equal(f.target.path, routerTarget('repo-repob'));
  assert.equal(f.sessions, 3);
});

test('W6 missed_repo_skill: examples are each missed session\'s first typed prompt with cwd and ts', () => {
  const f = of('missed_repo_skill')[0];
  assert.deepEqual(f.examples.map((ex) => ex.text).sort(), [...WS_PROMPTS].sort());
  for (const ex of f.examples) {
    assert.equal(ex.cwd, ws);
    assert.ok(ex.ts >= Date.parse('2026-10-11') && ex.ts < Date.parse('2026-10-14'), `ts ${ex.ts}`);
  }
  assert.ok(f.firstTs >= Date.parse('2026-10-11') && f.lastTs < Date.parse('2026-10-14'));
});

test('W6: reading a SKILL.md covers a repo only when the file is inside that repo, not a user or workspace copy', async () => {
  const { home: h, ws: w } = makeHome();
  const dir = path.join(h, '.omp/agent/sessions/-ws');
  const session = (n, skillPath) => {
    const iso = `2026-10-2${n}T10:00:00.000Z`;
    fs.writeFileSync(
      path.join(dir, `${iso.replace(/[:.]/g, '-')}_omp-r${n}.jsonl`),
      ompSession(`omp-r${n}`, w, iso, `B task number ${n}`, [['read', skillPath], ['edit', path.join(w, 'repoB/src/x.ts')]]),
    );
  };
  session(1, path.join(h, '.claude/skills/b-skill/SKILL.md')); // user copy
  session(2, path.join(h, '.claude/skills/b-skill/SKILL.md'));
  session(3, path.join(w, '.claude/skills/b-skill/SKILL.md')); // workspace copy
  session(4, path.join(w, 'repoB/.claude/skills/b-skill/SKILL.md')); // the repo's own skill
  session(5, path.join(w, 'repoB/.claude/skills/b-skill/SKILL.md'));
  session(6, path.join(w, 'repoB/.claude/skills/b-skill/SKILL.md'));
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const missed = of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'));
  assert.deepEqual([missed?.count, missed?.triggerCount], [6, 9]);
  assert.ok(mentions(missed.examples, 'B task number 3') && !mentions(missed.examples, 'B task number 4'));
});

test('W6 (option A): sessions started outside the workspace count and set outside/add_rule; a repo cwd skips only its own repo', async () => {
  const { home: h, ws: w } = makeHome();
  const dir = path.join(h, '.omp/agent/sessions/-tmp');
  fs.mkdirSync(dir, { recursive: true });
  const session = (id, cwd, iso, toolCalls) =>
    fs.writeFileSync(path.join(dir, `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`), ompSession(id, cwd, iso, `task ${id}`, toolCalls));
  for (const n of [1, 2, 3]) session(`omp-o${n}`, '/tmp', `2026-10-2${n}T10:00:00.000Z`, [['edit', path.join(w, 'repoB/src/x.ts')]]);
  // Started inside repoA: repoA's own skills load natively, so it is skipped for repoA but counts for repoB.
  session('omp-in-a', path.join(w, 'repoA'), '2026-10-24T10:00:00.000Z', [
    ['edit', path.join(w, 'repoA/x.ts')],
    ['edit', path.join(w, 'repoB/src/x.ts')],
  ]);
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 1, nowMs });
  const b = of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'));
  assert.deepEqual([b?.count, b?.triggerCount, b?.outside, b?.hint], [7, 7, 3, 'add_rule']);
  assert.equal(b.target.path, path.join(w, '.claude/skills/repo-repob/SKILL.md'));
  assert.equal(b.examples.filter((ex) => ex.cwd === '/tmp').length, 3);
  assert.equal(of('missed_repo_skill', r).some((f) => f.title.startsWith('Repo repoA ')), false, 'repo-cwd session counted for its own repo');
  // Only fixture sessions started in the workspace: outside 0 keeps the create/update hint.
  assert.deepEqual([of('missed_repo_skill')[0].outside, of('missed_repo_skill')[0].hint], [0, 'create_asset']);
});

test('W6: `~/` paths in session history are expanded to the home dir for touches and repo SKILL.md reads', async () => {
  const { home: h, ws: w } = makeHome();
  const rel = path.relative(h, w); // `ws`: the fixture workspace is <home>/ws
  const tilde = (p) => `~/${rel}/${p}`;
  const dir = path.join(h, '.omp/agent/sessions/-ws');
  const session = (n, toolCalls) => {
    const iso = `2026-10-2${n}T10:00:00.000Z`;
    fs.writeFileSync(path.join(dir, `${iso.replace(/[:.]/g, '-')}_omp-t${n}.jsonl`), ompSession(`omp-t${n}`, w, iso, `tilde task ${n}`, toolCalls));
  };
  for (const n of [1, 2, 3]) session(n, [['edit', tilde('repoB/src/x.ts')]]);
  session(4, [['read', tilde('repoB/.claude/skills/b-skill/SKILL.md')], ['edit', tilde('repoB/src/x.ts')]]);
  const r = await scanWorkspace({ home: h, path: w, sinceDays, minCount: 3, nowMs });
  const missed = of('missed_repo_skill', r).find((f) => mentions(f, 'repoB'));
  // 3 fixture sessions + 3 tilde sessions missed; the tilde SKILL.md read covers session 4.
  assert.deepEqual([missed?.count, missed?.triggerCount], [6, 7]);
  assert.ok(mentions(missed.examples, 'tilde task 1') && !mentions(missed.examples, 'tilde task 4'));
});

test('W6: no missed_repo_skill for repoA (its one session read the router), even at min_count 1', async () => {
  assert.equal(of('missed_repo_skill').some((f) => mentions(f, 'repoA')), false);
  const r = await scan({ minCount: 1 });
  const missed = of('missed_repo_skill', r);
  assert.equal(missed.some((f) => mentions(f.examples, 'update the A request handler')), false, 'covered repoA session counted as missed');
  assert.equal(missed.length, 1);
});

test('W6: min_count above the touched sessions drops missed_repo_skill', async () => {
  assert.equal(of('missed_repo_skill', await scan({ minCount: 4 })).length, 0);
});

test('W6: a window that ends before the sessions drops missed_repo_skill but keeps static findings', async () => {
  const r = await scan({ nowMs: Date.parse('2026-10-05'), sinceDays: 30 });
  assert.equal(of('missed_repo_skill', r).length, 0);
  assert.equal(of('router_missing', r).length, 1);
});

// ---- W7: persistence and decisions ----

const decisionsFile = () => path.join(coachDir, 'decisions.json');
const writeDecisions = (decisions) => fs.writeFileSync(decisionsFile(), JSON.stringify({ version: 1, decisions }));

test('W7: the scan writes its findings to last-workspace.json in the coach dir', () => {
  const stored = JSON.parse(fs.readFileSync(path.join(coachDir, 'last-workspace.json'), 'utf8'));
  for (const f of result.findings) assert.ok(stored.findings.some((s) => s.id === f.id), `${f.type} ${f.id} not stored`);
});

test('W7: last-workspace.json keeps earlier findings after the new ones, newest scan first, up to the cap', async () => {
  const saved = process.env.AGENT_COACH_HOME;
  process.env.AGENT_COACH_HOME = tmpCoachHome();
  try {
    const first = makeHome();
    const second = makeHome();
    const read = () => JSON.parse(fs.readFileSync(path.join(process.env.AGENT_COACH_HOME, 'last-workspace.json'), 'utf8')).findings.map((f) => f.id);
    const a = await scanWorkspace({ home: first.home, path: first.ws, sinceDays, minCount: 3, nowMs });
    const b = await scanWorkspace({ home: second.home, path: second.ws, sinceDays, minCount: 3, nowMs });
    const bIds = b.findings.map((f) => f.id);
    const older = a.findings.map((f) => f.id).filter((id) => !bIds.includes(id));
    assert.ok(older.length >= 3, 'fixture should give distinct ids per workspace');
    assert.deepEqual(read(), [...bIds, ...older]);
    // The cap drops the oldest stored findings, never the current scan's.
    const c = await scanWorkspace({ home: first.home, path: first.ws, sinceDays, minCount: 3, nowMs, maxStored: a.findings.length + 2 });
    const cIds = c.findings.map((f) => f.id);
    assert.deepEqual(read(), [...cIds, ...bIds.filter((id) => !cIds.includes(id))].slice(0, a.findings.length + 2));
    await scanWorkspace({ home: first.home, path: first.ws, sinceDays, minCount: 3, nowMs, maxStored: 1 });
    assert.deepEqual(read(), cIds);
  } finally {
    process.env.AGENT_COACH_HOME = saved;
  }
});

test('W7: a dismissed router_missing is filtered from the next scan; the others stay', async () => {
  const id = of('router_missing')[0].id;
  try {
    writeDecisions({ [id]: { status: 'dismissed', note: null, decidedAt: Date.parse('2026-10-20'), snapshot: null } });
    const r = await scan();
    assert.equal(r.findings.some((f) => f.id === id), false);
    assert.equal(of('router_stale', r).length, 1);
  } finally {
    fs.rmSync(decisionsFile(), { force: true });
  }
});

test('W7: an accepted static finding is dropped from the next scan', async () => {
  const id = of('name_collision')[0].id;
  try {
    writeDecisions({ [id]: { status: 'accepted', note: null, decidedAt: Date.parse('2026-10-20'), snapshot: null } });
    assert.equal((await scan()).findings.some((f) => f.id === id), false);
  } finally {
    fs.rmSync(decisionsFile(), { force: true });
  }
});

test('W7: an accepted missed_repo_skill reappears only with >= min_count missed sessions after decidedAt', async () => {
  const id = of('missed_repo_skill')[0].id;
  try {
    // Accepted before 2026-10-11: all 3 missed sessions come after → reappears.
    writeDecisions({ [id]: { status: 'accepted', note: null, decidedAt: Date.parse('2026-10-01'), snapshot: null } });
    assert.ok((await scan()).findings.some((f) => f.id === id), 'did not reappear');
    // Accepted on 2026-10-12: only 10-12 and 10-13 remain (2 < 3) → stays hidden.
    writeDecisions({ [id]: { status: 'accepted', note: null, decidedAt: Date.parse('2026-10-12'), snapshot: null } });
    assert.equal((await scan()).findings.some((f) => f.id === id), false, 'reappeared with 2 missed sessions');
  } finally {
    fs.rmSync(decisionsFile(), { force: true });
  }
});
