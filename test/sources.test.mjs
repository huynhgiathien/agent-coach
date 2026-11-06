// S1, S2, S5: session readers emit typed prompts, skill/agent use and token usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvents as readOmp } from '../lib/sources/omp.mjs';
import { readEvents as readClaude } from '../lib/sources/claude.mjs';
import { readEvents as readCodex } from '../lib/sources/codex.mjs';
import { makeHome, SINCE_MS as sinceMs, SECRET, mentions } from './_helpers.mjs';

const { home } = makeHome();
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
