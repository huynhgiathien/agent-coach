// S1, S2, S5: session readers emit typed prompts, skill/agent use and token usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { readEvents as readClaude } from '../lib/sources/claude.mjs';
import { readEvents as readCodex } from '../lib/sources/codex.mjs';
import { makeHome, SINCE_MS as sinceMs, SECRET, mentions, tmpCoachHome, writeClaudeSession } from './_helpers.mjs';

const { home, ws } = makeHome();
const [ompResult, claudeResult, codexResult] = await Promise.all([readOmp, readClaude, readCodex].map((read) => read({ home, sinceMs })));
const { events: omp } = ompResult;
const { events: claude } = claudeResult;
const { events: codex } = codexResult;

const of = (events, kind, filter = () => true) => events.filter((e) => e.kind === kind && filter(e));
const s1 = omp.filter((e) => e.sessionId === 'omp-s1');

test('omp: s1 yields exactly its typed prompts, redacted, including /skill:log-work', () => {
  assert.deepEqual(
    of(s1, 'prompt').map((e) => e.text),
    ['draft a comment for FRO-1', 'shorter version', 'yes', 'use key [REDACTED] for deploy', '/skill:log-work QA-1049 2h'],
  );
});

test('omp: developer messages, async results, tool results and skill bodies are not prompts', () => {
  for (const marker of ['DEVELOPER_TEXT', 'ASYNC_RESULT_TEXT', 'TOOL_RESULT_TEXT', 'LOG_WORK_SKILL_BODY', SECRET]) {
    assert.equal(mentions(omp, marker), false, `${marker} leaked into omp events`);
  }
});

test('omp: events carry source, session id, cwd and epoch-ms timestamps', () => {
  const first = of(s1, 'prompt')[0];
  assert.equal(first.source, 'omp');
  assert.equal(first.cwd, '/proj');
  assert.equal(first.ts, Date.parse('2026-10-01T10:00:00.000Z'));
});

test('omp: s1 yields skill linear-comment (model), skill log-work (user) and agent scout', () => {
  const skills = of(s1, 'skill').map((e) => `${e.name}/${e.how}`);
  assert.deepEqual(skills, ['linear-comment/model', 'log-work/user']);
  assert.deepEqual(of(s1, 'agent').map((e) => e.name), ['scout']);
});

test('readers return { events, warnings } and the JSONL readers never warn', () => {
  for (const [name, result] of Object.entries({ omp: ompResult, claude: claudeResult, codex: codexResult })) {
    assert.ok(Array.isArray(result.events), `${name}.events is not an array`);
    assert.deepEqual(result.warnings, [], `${name}.warnings`);
  }
});

test('omp: every main session reads skill://linear-comment', () => {
  const sessions = new Set(of(omp, 'skill', (e) => e.name === 'linear-comment' && !e.sub).map((e) => e.sessionId));
  assert.deepEqual([...sessions].sort(), ['omp-s1', 'omp-s2', 'omp-s3', 'omp-s4', 'omp-s5', 'omp-s6']);
});

test('omp: s4–s6 read linear-comment before their only typed prompt "post it"', () => {
  for (const id of ['omp-s4', 'omp-s5', 'omp-s6']) {
    const s = omp.filter((e) => e.sessionId === id && (e.kind === 'skill' || e.kind === 'prompt'));
    assert.deepEqual(s.map((e) => e.text ?? `skill:${e.name}`), ['skill:linear-comment', 'post it'], id);
  }
});

test('omp: subagent prompts are ignored', () => {
  assert.equal(mentions(omp, 'SUBAGENT_PROMPT_MUST_NOT_APPEAR'), false);
  assert.equal(mentions(omp, 'SUBAGENT_TASK_'), false);
  assert.equal(of(omp, 'prompt', (e) => e.sub).length, 0);
});

test('omp: subagent skill read is emitted with sub: true and the default agent "task"', () => {
  const [ev, ...rest] = of(omp, 'skill', (e) => e.name === 'automation-testing');
  assert.equal(rest.length, 0);
  assert.equal(ev.sub, true);
  assert.equal(ev.agent, 'task');
  assert.equal(ev.sessionId, 'omp-s1-scout');
});

test('omp: main-session usage events carry the recorded cost and token fields', () => {
  const usage = of(s1, 'usage', (e) => !e.sub);
  assert.equal(usage.length, 5);
  for (const u of usage) {
    assert.equal(u.costUsd, 0.1);
    assert.equal(u.model, 'claude-test');
    assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 100, 900, 90]);
  }
});

test('omp: scout/sonic subagent usage is tagged sub with the session_init agent', () => {
  const sub = of(omp, 'usage', (e) => /^omp-s2-(scout|sonic)-/.test(e.sessionId));
  assert.equal(sub.length, 7);
  for (const u of sub) {
    assert.equal(u.sub, true);
    assert.equal(u.agent, u.sessionId.split('-')[2]);
  }
  assert.deepEqual(sub.filter((u) => u.agent === 'scout').map((u) => u.costUsd), [10, 10, 10]);
});

test('omp: sinceMs after the fixture dates drops every event', async () => {
  assert.equal((await readOmp({ home, sinceMs: Date.parse('2026-10-23') })).events.length, 0);
});

test('claude: yields typed prompts, /command prompts and queued prompts; drops duplicates and injected text', () => {
  const prompts = of(claude, 'prompt');
  assert.deepEqual(
    prompts.map((e) => e.text.trim()),
    ['review the login form', '/plan-mode', 'also check the signup form', 'run the tests now'],
  );
  assert.equal(prompts.find((e) => e.text === 'also check the signup form').steering, true);
  for (const marker of ['TOOL_RESULT_TEXT', 'LOCAL_STDOUT_TEXT', 'Base directory for this skill', 'PLAN_MODE_SKILL_BODY', 'AGENT_PROMPT_TEXT']) {
    assert.equal(mentions(claude, marker), false, `${marker} leaked into claude events`);
  }
});

test('claude: slash-command skill is "user", Skill tool use is "model" and emitted once', () => {
  assert.deepEqual(
    of(claude, 'skill').map((e) => `${e.name}/${e.how}`),
    ['plan-mode/user', 'linear-comment/model'],
  );
  assert.deepEqual(of(claude, 'agent').map((e) => e.name), ['audit']);
  assert.equal(claude[0].sessionId, 'claude-c1');
  assert.equal(claude[0].cwd, '/proj');
});

test('claude: one usage event per message.id, carrying the whole cost-state amount', () => {
  const usage = of(claude, 'usage');
  assert.equal(usage.length, 1);
  const [u] = usage;
  assert.equal(u.model, 'claude-x');
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 10, 80, 0]);
  assert.ok(Math.abs(u.costUsd - 0.5) < 1e-9, `costUsd ${u.costUsd}`);
});

test('codex: exec/SDK sessions yield nothing', () => {
  assert.equal(codex.filter((e) => e.sessionId === 'codex-b').length, 0);
  assert.equal(mentions(codex, 'EXEC_PROMPT_MUST_NOT_APPEAR'), false);
});

test('codex: interactive session yields one deduped prompt and skill foo', () => {
  const a = codex.filter((e) => e.sessionId === 'codex-a');
  assert.deepEqual(of(a, 'prompt').map((e) => e.text), ['summarize the build failure']);
  assert.deepEqual(of(a, 'skill').map((e) => `${e.name}/${e.how}`), ['foo/model']);
  assert.equal(a[0].cwd, '/proj');
  assert.equal(of(a, 'usage').length, 0);
});

// ---- COACH1: injected records and plugin-qualified skills ----

test('COACH1-S1 claude: teammate pings, sidechain and compact-summary records are not prompts', async () => {
  const h = tmpCoachHome();
  writeClaudeSession(h, {
    sessionId: 'claude-team',
    cwd: '/proj',
    start: '2026-10-10T10:00:00.000Z',
    records: [
      'real typed prompt',
      '<teammate-message teammate_id="lead">TEAMMATE_PING_TEXT</teammate-message>',
      '  \n<teammate-message teammate_id="lead" color="blue">TEAMMATE_INDENTED_TEXT</teammate-message>',
      { text: 'SIDECHAIN_TEXT', isSidechain: true },
      { text: 'COMPACT_SUMMARY_TEXT', isCompactSummary: true },
      'second typed prompt',
    ],
  });
  const { events } = await readClaude({ home: h, sinceMs });
  assert.deepEqual(of(events, 'prompt').map((e) => e.text), ['real typed prompt', 'second typed prompt']);
  for (const marker of ['TEAMMATE_PING_TEXT', 'TEAMMATE_INDENTED_TEXT', 'SIDECHAIN_TEXT', 'COMPACT_SUMMARY_TEXT']) {
    assert.equal(mentions(events, marker), false, `${marker} leaked into claude events`);
  }
});

test('COACH1-S7 claude: a model-invoked plugin:skill Skill call is one skill event, not two', async () => {
  const h = tmpCoachHome();
  writeClaudeSession(h, {
    sessionId: 'claude-plug',
    cwd: '/proj',
    start: '2026-10-10T10:00:00.000Z',
    records: ['write the release notes', { skill: 'myplug:notes' }, { meta: 'Base directory for this skill: /x/.claude/plugins/cache/m/myplug/1.0.0/skills/notes\n\nNOTES_BODY' }],
  });
  const skills = of((await readClaude({ home: h, sinceMs })).events, 'skill');
  assert.equal(skills.length, 1, `skill events: ${JSON.stringify(skills.map((e) => `${e.name}/${e.how}`))}`);
  assert.equal(skills[0].name.split(':').pop(), 'notes');
  assert.equal(skills[0].how, 'model');
});

// ---- W6: touch events and parentSessionId (workspace skill routing) ----

test('omp W6: an edit toolCall emits a touch event with arguments.path', () => {
  for (const id of ['omp-w1', 'omp-w2', 'omp-w3']) {
    const touches = of(omp, 'touch', (e) => e.sessionId === id);
    assert.deepEqual(touches.map((e) => e.path), [path.join(ws, 'repoB/src/x.ts')], id);
    assert.equal(touches[0].source, 'omp');
    assert.equal(touches[0].cwd, ws);
    assert.equal(touches[0].ts, Date.parse(`2026-10-1${id.at(-1)}T10:00:30.000Z`));
  }
});

test('omp W6: a skill:// read emits the skill event and no touch; the edit in the same message is a touch', () => {
  const w4 = omp.filter((e) => e.sessionId === 'omp-w4');
  assert.deepEqual(of(w4, 'touch').map((e) => e.path), [path.join(ws, 'repoA/x.ts')]);
  assert.deepEqual(of(w4, 'skill').map((e) => `${e.name}/${e.how}`), ['repo-repoa/model']);
  assert.equal(of(omp, 'touch', (e) => /^[a-z][a-z0-9+.-]*:\/\//i.test(e.path)).length, 0, 'scheme:// path emitted as touch');
});

test('omp W6: a subagent read of a file path is a touch tagged sub', () => {
  const [t, ...rest] = of(omp, 'touch', (e) => e.sessionId === 'omp-s1-scout');
  assert.equal(rest?.length, 0);
  assert.equal(t?.path, '/x/.claude/skills/automation-testing/SKILL.md');
  assert.equal(t?.sub, true);
});

test('omp W6: subagent events carry parentSessionId of their main session; main events do not', () => {
  const scout = omp.filter((e) => e.sessionId === 'omp-s1-scout');
  assert.ok(scout.length > 0);
  for (const e of scout) assert.equal(e.parentSessionId, 'omp-s1', `${e.kind}`);
  const s2subs = omp.filter((e) => /^omp-s2-(scout|sonic)-/.test(e.sessionId));
  assert.ok(s2subs.length > 0);
  for (const e of s2subs) assert.equal(e.parentSessionId, 'omp-s2', e.sessionId);
  assert.equal(omp.filter((e) => !e.sub && e.parentSessionId !== undefined).length, 0);
});

test('omp W6: a nested subagent (<main>/Scout/Scout.Deep.jsonl) resolves parentSessionId to the top main session', async () => {
  const { home: h } = makeHome();
  const mainDir = path.join(h, '.omp/agent/sessions/-proj/2026-10-01T10-00-00-000Z_omp-s1');
  const parentFile = path.join(mainDir, 'Scout.jsonl');
  fs.mkdirSync(path.join(mainDir, 'Scout'), { recursive: true });
  const lines = [
    { type: 'session', version: 3, id: 'omp-s1-deep', timestamp: '2026-10-01T12:05:00.000Z', cwd: '/proj', parentSession: parentFile },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'd1', name: 'read', arguments: { path: '/proj/deep.ts' } }], stopReason: 'toolUse' },
      id: 'd-1', parentId: null, timestamp: '2026-10-01T12:05:10.000Z',
    },
  ];
  fs.writeFileSync(path.join(mainDir, 'Scout/Scout.Deep.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const { events } = await readOmp({ home: h, sinceMs });
  const deep = events.filter((e) => e.sessionId === 'omp-s1-deep');
  assert.deepEqual(deep.map((e) => [e.kind, e.path, e.sub, e.parentSessionId]), [['touch', '/proj/deep.ts', true, 'omp-s1']]);
});

test('omp W6: an edit without arguments.path yields a touch per [path#TAG] header of its input', async () => {
  const { home: h } = makeHome();
  const file = path.join(h, '.omp/agent/sessions/-proj/2026-10-05T10-00-00-000Z_omp-e1.jsonl');
  const input = '[/proj/a.ts#1A2B]\nPUT 1.=1:\n+x\n[/proj/src/b.ts#3c4d]\nCUT 2\n[skill://nope#AAAA]\nCUT 1';
  const lines = [
    { type: 'session', version: 3, id: 'omp-e1', timestamp: '2026-10-05T10:00:00.000Z', cwd: '/proj' },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { input } }], stopReason: 'toolUse' },
      id: 'e-1', parentId: null, timestamp: '2026-10-05T10:00:10.000Z',
    },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const { events } = await readOmp({ home: h, sinceMs });
  assert.deepEqual(of(events, 'touch', (e) => e.sessionId === 'omp-e1').map((e) => e.path), ['/proj/a.ts', '/proj/src/b.ts']);
});

test('claude W6: Read/Edit/Write/MultiEdit/NotebookEdit are touches; subagent touches carry parentSessionId', async () => {
  const { home: h } = makeHome();
  const dir = path.join(h, '.claude/projects/-proj');
  const rec = (sessionId, ts, tools) => ({
    type: 'assistant', sessionId, cwd: '/proj', timestamp: ts,
    message: { role: 'assistant', content: tools.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) },
  });
  const main = [
    rec('claude-t1', '2026-10-06T10:00:00.000Z', [
      ['Read', { file_path: '/proj/a.ts' }],
      ['Edit', { file_path: '/proj/b.ts', old_string: 'x', new_string: 'y' }],
      ['Write', { file_path: '/proj/c.ts', content: '' }],
      ['MultiEdit', { file_path: '/proj/d.ts', edits: [] }],
      ['NotebookEdit', { notebook_path: '/proj/e.ipynb', new_source: '' }],
      ['Bash', { command: 'cat /proj/f.ts' }],
    ]),
  ];
  fs.writeFileSync(path.join(dir, 'claude-t1.jsonl'), `${main.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const subDir = path.join(dir, 'claude-t1/subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sub = [rec('claude-t1', '2026-10-06T10:01:00.000Z', [['Read', { file_path: '/proj/g.ts' }]])];
  fs.writeFileSync(path.join(subDir, 'agent-s1.jsonl'), `${sub.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const { events } = await readClaude({ home: h, sinceMs });
  const mainTouches = of(events, 'touch', (e) => e.sessionId === 'claude-t1');
  assert.deepEqual(mainTouches.map((e) => e.path), ['/proj/a.ts', '/proj/b.ts', '/proj/c.ts', '/proj/d.ts', '/proj/e.ipynb']);
  assert.ok(mainTouches.every((e) => e.parentSessionId === undefined && !e.sub && e.cwd === '/proj'));
  const subTouches = of(events, 'touch', (e) => e.sessionId === 'claude-t1:agent-s1');
  assert.deepEqual(subTouches.map((e) => [e.path, e.sub, e.parentSessionId]), [['/proj/g.ts', true, 'claude-t1']]);
});

test('W6: `~/` file paths are expanded to the reader home in omp and claude touch and skill events', async () => {
  const { home: h } = makeHome();
  const ompFile = path.join(h, '.omp/agent/sessions/-proj/2026-10-07T10-00-00-000Z_omp-h1.jsonl');
  const ompLines = [
    { type: 'session', version: 3, id: 'omp-h1', timestamp: '2026-10-07T10:00:00.000Z', cwd: '/proj' },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'h1', name: 'read', arguments: { path: '~/ws/repoB/.claude/skills/b-skill/SKILL.md:raw' } },
          { type: 'toolCall', id: 'h2', name: 'edit', arguments: { input: '[~/ws/repoB/src/x.ts#1A2B]\nCUT 1' } },
          { type: 'toolCall', id: 'h3', name: 'write', arguments: { path: '~' } },
        ],
        stopReason: 'toolUse',
      },
      id: 'h-1', parentId: null, timestamp: '2026-10-07T10:00:10.000Z',
    },
  ];
  fs.writeFileSync(ompFile, `${ompLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const claudeLine = {
    type: 'assistant', sessionId: 'claude-h1', cwd: '/proj', timestamp: '2026-10-07T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '~/ws/repoB/src/y.ts' } }] },
  };
  fs.writeFileSync(path.join(h, '.claude/projects/-proj/claude-h1.jsonl'), `${JSON.stringify(claudeLine)}\n`);

  const omp = (await readOmp({ home: h, sinceMs })).events.filter((e) => e.sessionId === 'omp-h1');
  assert.deepEqual(of(omp, 'touch').map((e) => e.path), [
    path.join(h, 'ws/repoB/.claude/skills/b-skill/SKILL.md'),
    path.join(h, 'ws/repoB/src/x.ts'),
    h,
  ]);
  assert.deepEqual(of(omp, 'skill').map((e) => [e.name, e.path]), [['b-skill', path.join(h, 'ws/repoB/.claude/skills/b-skill/SKILL.md')]]);
  const claude = (await readClaude({ home: h, sinceMs })).events.filter((e) => e.sessionId === 'claude-h1');
  assert.deepEqual(of(claude, 'touch').map((e) => e.path), [path.join(h, 'ws/repoB/src/y.ts')]);
});
