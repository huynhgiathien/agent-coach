// S1, S15: Cursor IDE chats from state.vscdb, Cursor assets in the inventory, the plugin manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from '../lib/sources/cursor.mjs';
import { listAssets } from '../lib/inventory.mjs';
import { CURSOR_DB, CURSOR_SECRET, HAS_SQLITE, NOW_MS as nowMs, REPO, SINCE_DAYS as sinceDays, SINCE_MS as sinceMs, makeHome, mentions } from './_helpers.mjs';

const skip = !HAS_SQLITE && 'no node:sqlite';
const { home, coachDir } = makeHome();
const { events, warnings } = HAS_SQLITE ? await readEvents({ home, sinceMs }) : { events: [], warnings: [] };
const of = (sessionId, kind) => events.filter((e) => e.sessionId === sessionId && (!kind || e.kind === kind));

test('cursor: the fixture DB reads without warnings', { skip }, () => {
  assert.deepEqual(warnings, []);
  assert.ok(events.every((e) => e.source === 'cursor'));
});

test('cursor: k1 yields exactly one prompt, the b1 text unescaped, with the workspace cwd', { skip }, () => {
  const prompts = of('k1', 'prompt');
  assert.deepEqual(prompts.map((e) => e.text), ['review this <img src=x onerror=alert(1)>']);
  assert.equal(prompts[0].cwd, '/proj');
  assert.equal(prompts[0].ts, Date.parse('2026-10-10T09:01:00.000Z'));
});

test('cursor: k1 read_file_v2 of a SKILL.md is skill cursor-skill (model)', { skip }, () => {
  assert.deepEqual(of('k1', 'skill').map((e) => ({ name: e.name, how: e.how })), [{ name: 'cursor-skill', how: 'model' }]);
});

test('cursor: k1 task_v2 is agent "explore"', { skip }, () => {
  assert.deepEqual(of('k1', 'agent').map((e) => e.name), ['explore']);
});

test('cursor: k1 yields one usage event from tokenCount, unpriced', { skip }, () => {
  const usage = of('k1', 'usage');
  assert.equal(usage.length, 1);
  const [u] = usage;
  assert.deepEqual(
    { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: u.costUsd, model: u.model },
    { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: null, model: 'gpt-x' },
  );
});

test('cursor: k1 events follow the conversation order (prompt, skill, agent)', { skip }, () => {
  const order = of('k1').filter((e) => e.kind !== 'usage' && e.kind !== 'touch').map((e) => e.kind);
  assert.deepEqual(order, ['prompt', 'skill', 'agent']);
});

test('cursor: subagent composer k2 yields no prompt; its usage is sub with agent "explore"', { skip }, () => {
  assert.equal(of('k2', 'prompt').length, 0);
  assert.equal(mentions(events, 'sub prompt'), false);
  const usage = of('k2', 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].sub, usage[0].agent, usage[0].input, usage[0].output], [true, 'explore', 50, 5]);
});

test('cursor W6: a read_file_v2 of a SKILL.md is a touch, and the skill event carries its path', { skip }, () => {
  const touches = of('k1', 'touch');
  assert.deepEqual(touches.map((e) => [e.path, e.cwd, e.sub]), [['/x/.cursor/skills/cursor-skill/SKILL.md', '/proj', undefined]]);
  assert.equal(of('k1', 'skill')[0].path, '/x/.cursor/skills/cursor-skill/SKILL.md');
  assert.equal(of('k1', 'touch')[0].parentSessionId, undefined);
});

test('cursor W6: a subagent edit_file_v2 with a workspace-relative path is a touch under the cwd, tagged with its parent', { skip }, () => {
  const touches = of('k2', 'touch');
  assert.deepEqual(touches.map((e) => [e.path, e.sub, e.parentSessionId]), [['/proj/src/y.ts', true, 'k1']]);
  for (const e of of('k2')) assert.equal(e.parentSessionId, 'k1', e.kind);
});

test('cursor: draft composer k3 and display-only bubbles yield nothing', { skip }, () => {
  assert.equal(of('k3').length, 0);
  assert.equal(mentions(events, 'draft text'), false);
  assert.equal(mentions(events, 'hidden'), false);
});

test('cursor: the auth token in ItemTable never reaches an event', { skip }, () => {
  assert.equal(mentions(events, CURSOR_SECRET), false);
});

test('cursor: sinceMs after the composers were updated drops them', { skip }, async () => {
  const later = await readEvents({ home, sinceMs: Date.parse('2026-10-11') });
  assert.deepEqual(later, { events: [], warnings: [] });
});

test('cursor: no chat DB yields no events and no warning', { skip }, async () => {
  const { home: bare } = makeHome();
  fs.renameSync(path.join(bare, CURSOR_DB), path.join(bare, `${CURSOR_DB}.moved`));
  assert.deepEqual(await readEvents({ home: bare, sinceMs }), { events: [], warnings: [] });
});

test('cursor: a corrupt chat DB yields one "unreadable" warning and no events', { skip }, async () => {
  const { home: broken } = makeHome();
  fs.writeFileSync(path.join(broken, CURSOR_DB), Buffer.from('this is not a sqlite database\n'.repeat(300)));
  const result = await readEvents({ home: broken, sinceMs });
  assert.deepEqual(result.events, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Cursor chat DB unreadable: /);
});

test('digest: a corrupt Cursor DB is a warning in the digest and in the markdown header', { skip }, async () => {
  const { home: broken, coachDir: state } = makeHome();
  fs.writeFileSync(path.join(broken, CURSOR_DB), Buffer.from('this is not a sqlite database\n'.repeat(300)));
  process.env.AGENT_COACH_HOME = state;
  try {
    const { buildDigest, renderMarkdown } = await import('../lib/digest.mjs');
    const digest = await buildDigest({ home: broken, sinceDays, nowMs });
    assert.equal(digest.warnings.length, 1);
    assert.match(digest.warnings[0], /^Cursor chat DB unreadable: /);
    assert.ok(renderMarkdown(digest).includes('> ⚠ Cursor chat DB unreadable: '));
    assert.ok(digest.findings.length > 0, 'other sources must still be analyzed');
  } finally {
    delete process.env.AGENT_COACH_HOME;
  }
});

test('digest: the fixture Cursor chat counts as one cursor session with one prompt', { skip }, async () => {
  process.env.AGENT_COACH_HOME = coachDir;
  try {
    const { buildDigest } = await import('../lib/digest.mjs');
    const digest = await buildDigest({ home, sinceDays, nowMs });
    assert.deepEqual(digest.totals.cursor, { sessions: 1, prompts: 1 });
    assert.deepEqual(digest.warnings, []);
  } finally {
    delete process.env.AGENT_COACH_HOME;
  }
});

// ---- inventory rows for ~/.cursor ----

test('inventory: Cursor skills, agents, commands and rules with their origin and editable flag', async () => {
  const h = fs.mkdtempSync(path.join(path.dirname(home), 'coach-cursor-assets-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true });
    fs.writeFileSync(path.join(h, rel), text);
  };
  const md = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
  put('.cursor/skills/cs/SKILL.md', md('cs', 'Cursor user skill'));
  put('.cursor/skills-cursor/builtin/SKILL.md', md('builtin', 'Cursor built-in skill'));
  put('.cursor/plugins/local/pl/skills/ps/SKILL.md', md('ps', 'Cursor plugin skill'));
  put('.cursor/agents/ca.md', md('ca', 'Cursor agent'));
  put('.cursor/commands/cc.md', md('cc', 'Cursor command'));
  put('.cursor/rules/style.mdc', '---\ndescription: House style\nalwaysApply: true\n---\n\n- Be brief.\n');

  const rows = (await listAssets({ home: h }))
    .filter((a) => a.path.includes('/.cursor/'))
    .map((a) => `${a.kind} ${a.name} ${a.origin} ${a.editable}`)
    .sort();
  assert.deepEqual(rows, [
    'agent ca cursor true',
    'command cc cursor true',
    'context style.mdc (cursor) cursor true',
    'skill builtin system false',
    'skill cs cursor true',
    'skill ps plugin false',
  ]);
});

// ---- plugin manifest ----

test('.cursor-plugin/plugin.json names agent-coach, points at the bundled skills and registers no MCP server', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, '.cursor-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-coach');
  assert.ok(fs.statSync(path.join(REPO, manifest.skills)).isDirectory(), `skills dir ${manifest.skills}`);
  assert.equal('mcpServers' in manifest, false);
});

test('cursor: on a Node without node:sqlite, Cursor is skipped with one warning', { skip }, () => {
  const reader = new URL('../lib/sources/cursor.mjs', import.meta.url).href;
  const script = `const { readEvents } = await import(${JSON.stringify(reader)});
process.stdout.write(JSON.stringify(await readEvents({ home: ${JSON.stringify(home)}, sinceMs: ${sinceMs} })));`;
  const r = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    events: [],
    warnings: [`Cursor skipped: Node ${process.version} has no node:sqlite (needs 22.13+)`],
  });
});
