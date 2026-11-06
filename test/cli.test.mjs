// S9, S15, S17, S18: bin/agent-coach install-cursor-mcp, check and dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome } from './_helpers.mjs';

const CLI = fileURLToPath(new URL('../bin/agent-coach', import.meta.url));
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

function cli(home, coachDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, AGENT_COACH_HOME: coachDir, AGENT_COACH_NO_OPEN: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- install-cursor-mcp ----

const SEED = '{"mcpServers":{"github":{"command":"x","env":{"T":"keep"}}}}';
function seeded(text = SEED) {
  const { home, coachDir } = makeHome();
  const file = path.join(home, '.cursor/mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text !== null) fs.writeFileSync(file, text);
  return { home, coachDir, file };
}

test('install-cursor-mcp adds agent-coach, keeps other servers and backs up the original', () => {
  const { home, coachDir, file } = seeded();
  const r = cli(home, coachDir, 'install-cursor-mcp');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Added agent-coach to ~/.cursor/mcp.json; restart Cursor');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.mcpServers.github, { command: 'x', env: { T: 'keep' } });
  assert.deepEqual(config.mcpServers['agent-coach'], { command: 'node', args: [SERVER] });
  assert.ok(path.isAbsolute(config.mcpServers['agent-coach'].args[0]));
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), SEED);
});

test('install-cursor-mcp succeeds without printing the other servers\' settings', () => {
  const { home, coachDir } = seeded();
  const r = cli(home, coachDir, 'install-cursor-mcp');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(`${r.stdout}${r.stderr}`.includes('keep'), false);
});

test('install-cursor-mcp is idempotent: a second run says "already" and changes nothing', () => {
  const { home, coachDir, file } = seeded();
  assert.equal(cli(home, coachDir, 'install-cursor-mcp').code, 0);
  const before = fs.readFileSync(file, 'utf8');
  const r = cli(home, coachDir, 'install-cursor-mcp');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('install-cursor-mcp with invalid JSON exits 1 with the manual-add instructions and leaves the file alone', () => {
  const { home, coachDir, file } = seeded('{ not json');
  const r = cli(home, coachDir, 'install-cursor-mcp');
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('~/.cursor/mcp.json is not valid JSON'), r.stderr);
  assert.ok(r.stderr.includes(`{"agent-coach":{"command":"node","args":["${SERVER}"]}}`), r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('install-cursor-mcp creates mcp.json when Cursor has none yet', () => {
  const { home, coachDir, file } = seeded(null);
  const r = cli(home, coachDir, 'install-cursor-mcp');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { 'agent-coach': { command: 'node', args: [SERVER] } } });
});

// ---- check ----

test('check prints the score and failed checks and exits 1 on a major failure', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'check', path.join(home, '.claude/skills/bad-skill/SKILL.md'));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^score 71\/100\n/);
  assert.match(r.stdout, /^trigger \(major\): /m);
  assert.match(r.stdout, /^links \(major\): .*references\/missing\.md/m);
});

test('check exits 0 on a file that passes every check', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'check', path.join(home, '.claude/skills/linear-comment/SKILL.md'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'score 100/100\nall checks pass');
});

test('check on a missing file prints the error and exits 1', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'check', '/nope/SKILL.md');
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), 'error: File not found: /nope/SKILL.md');
});

// ---- dashboard ----

test('dashboard --no-open writes the file and prints the Dashboard line', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'dashboard', '--days', '400', '--no-open');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n')[0], `Dashboard: ${path.join(coachDir, 'dashboard.html')} (not opened)`);
  assert.ok(fs.existsSync(path.join(coachDir, 'dashboard.html')));
});

test('reading the Cursor DB prints no SQLite ExperimentalWarning', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'digest', '--days', '400', '--source', 'cursor');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(/ExperimentalWarning|SQLite is an experimental/.test(r.stderr), false, r.stderr);
});

// ---- mcp.json holds tokens: its mode survives the rewrite (reviewer fix 4) ----

const mode = (file) => fs.statSync(file).mode & 0o777;

test('install-cursor-mcp keeps an existing mcp.json at mode 0600', () => {
  const { home, coachDir, file } = seeded();
  fs.chmodSync(file, 0o600);
  assert.equal(cli(home, coachDir, 'install-cursor-mcp').code, 0);
  assert.equal(mode(file).toString(8), '600');
});

test('install-cursor-mcp creates a new mcp.json at mode 0600', () => {
  const { home, coachDir, file } = seeded(null);
  assert.equal(cli(home, coachDir, 'install-cursor-mcp').code, 0);
  assert.equal(mode(file).toString(8), '600');
});

test('dashboard without --no-open honours AGENT_COACH_NO_OPEN=1 and says "not opened"', () => {
  const { home, coachDir } = makeHome();
  const r = cli(home, coachDir, 'dashboard', '--days', '400');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n')[0], `Dashboard: ${path.join(coachDir, 'dashboard.html')} (not opened)`);
});
