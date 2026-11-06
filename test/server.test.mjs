// S9: stdio MCP server speaks newline-delimited JSON-RPC and exposes the four tools.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_HOME, ageFixtures, tmpCoachHome } from './_helpers.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const coachHome = tmpCoachHome();
let child;
let nextId = 1;
const pending = new Map();
let stderr = '';

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 30_000);
    pending.set(id, {
      resolve: (msg) => (clearTimeout(timer), resolve(msg)),
      reject: (err) => (clearTimeout(timer), reject(err)),
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const callTool = (name, args) => rpc('tools/call', { name, arguments: args });

before(async () => {
  await ageFixtures();
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOME: FIXTURE_HOME, AGENT_COACH_HOME: coachHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`server exited with ${code}; stderr: ${stderr}`));
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.resolve(msg);
    pending.delete(msg.id);
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'agent-coach');
});

after(() => child?.kill());

test('tools/list returns the four tools', async () => {
  const { result } = await rpc('tools/list');
  assert.deepEqual(
    result.tools.map((t) => t.name).sort(),
    ['finding_examples', 'list_assets', 'record_decision', 'usage_digest'],
  );
});

test('usage_digest returns a markdown digest of the fixture home', async () => {
  const { result } = await callTool('usage_digest', { since_days: 400 });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.ok(result.content[0].text.includes('linear-comment'));
});

test('finding_examples with an unknown id is a tool error', async () => {
  const { result } = await callTool('finding_examples', { finding_id: 'bogus' });
  assert.equal(result.isError, true);
});

test('record_decision rejects an invalid status as a tool error', async () => {
  const { result } = await callTool('record_decision', { finding_id: 'abc', status: 'maybe' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /status must be accepted or dismissed/);
});

test('usage_digest name filter returns only that asset\'s findings and keeps the full stored digest', async () => {
  const { result } = await callTool('usage_digest', { since_days: 400, name: 'linear-comment', format: 'json' });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const shown = JSON.parse(result.content[0].text);
  assert.ok(shown.findings.length >= 1, 'expected at least one linear-comment finding');
  for (const f of shown.findings) {
    assert.ok(f.trigger?.name === 'linear-comment' || f.target?.name === 'linear-comment', `unfiltered finding ${f.id} ${f.title}`);
  }
  const stored = JSON.parse(fs.readFileSync(path.join(coachHome, 'last-digest.json'), 'utf8'));
  assert.ok(stored.findings.some((f) => f.type === 'repeated_prompt'), 'stored digest lost the unfiltered findings');
});
