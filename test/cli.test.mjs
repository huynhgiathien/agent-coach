// S9, S15, S17, S18, W1, W7: bin/agent-coach install-cursor-mcp, check, dashboard and workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, tmpCoachHome, writeAsset, writeClaudeSession } from './_helpers.mjs';

const CLI = fileURLToPath(new URL('../bin/agent-coach', import.meta.url));
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

function cli(home, coachDir, ...args) {
  return cliIn(undefined, home, coachDir, ...args);
}

function cliIn(cwd, home, coachDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
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

// ---- COACH1 review: assets lists the project assets of the last digest ----

test('COACH1-R3 assets lists project assets from the cwds of the last digest', () => {
  const home = tmpCoachHome();
  const coachDir = tmpCoachHome();
  const repo = path.join(home, 'work', 'repo');
  const skill = writeAsset(repo, '.claude/skills/repo-skill/SKILL.md', { name: 'repo-skill', description: 'Repo-only skill' });
  writeClaudeSession(home, { slug: '-work-repo', sessionId: 'cli-1', cwd: repo, start: '2026-10-02T10:00:00.000Z', records: ['hello there'] });
  const before = cli(home, coachDir, 'assets', '--kind', 'skill');
  assert.equal(before.code, 0, before.stderr);
  assert.equal(before.stdout.includes(skill), false, 'project skill listed before any digest');
  const d = cli(home, coachDir, 'digest', '--source', 'claude');
  assert.equal(d.code, 0, d.stderr);
  const after = cli(home, coachDir, 'assets', '--kind', 'skill');
  assert.equal(after.code, 0, after.stderr);
  const line = after.stdout.split('\n').find((l) => l.endsWith(`\t${skill}`));
  assert.ok(line, `project skill missing:\n${after.stdout}`);
  assert.match(line, /^skill\trepo-skill\tproject\teditable\t/);
});

// ---- workspace (W1, W7) ----

test('workspace <ws> prints the markdown scan and exits 0', () => {
  const { home, coachDir, ws } = makeHome();
  const r = cli(home, coachDir, 'workspace', ws, '--days', '400');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('## Repos'), r.stdout);
  assert.ok(r.stdout.includes('## Router coverage'), r.stdout);
  assert.ok(fs.existsSync(path.join(coachDir, 'last-workspace.json')), 'last-workspace.json not written');
});

test('workspace without a path scans the cwd', () => {
  const { home, coachDir, ws } = makeHome();
  const r = cliIn(ws, home, coachDir, 'workspace', '--days', '400');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('## Router coverage'), r.stdout);
});

test('workspace --json --min-count 1 prints the findings as JSON', () => {
  const { home, coachDir, ws } = makeHome();
  const r = cli(home, coachDir, 'workspace', ws, '--days', '400', '--min-count', '1', '--json');
  assert.equal(r.code, 0, r.stderr);
  const types = new Set(JSON.parse(r.stdout).findings.map((f) => f.type));
  for (const t of ['router_missing', 'router_stale', 'name_collision', 'invalid_layout', 'missed_repo_skill']) assert.ok(types.has(t), `missing ${t}`);
});

test('workspace on a non-workspace path prints the error and exits 1', () => {
  const { home, coachDir, ws } = makeHome();
  const notes = path.join(ws, 'notes');
  const r = cli(home, coachDir, 'workspace', notes);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim(), `error: Not a workspace: ${notes} has 0 git repos (needs 2+)`);
});

test('examples and decide resolve a workspace finding id with no last-digest.json; dismissed it is gone next scan', () => {
  const { home, coachDir, ws } = makeHome();
  const scan = () => {
    const r = cli(home, coachDir, 'workspace', ws, '--days', '400', '--json');
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const f = scan().findings.find((x) => x.type === 'missed_repo_skill');
  assert.ok(f, 'missed_repo_skill missing');
  assert.equal(fs.existsSync(path.join(coachDir, 'last-digest.json')), false);

  const ex = cli(home, coachDir, 'examples', f.id);
  assert.equal(ex.code, 0, ex.stderr);
  assert.ok(ex.stdout.includes('add input validation to the form handler'), ex.stdout);

  const d = cli(home, coachDir, 'decide', f.id, 'dismissed');
  assert.equal(d.code, 0, d.stderr);
  const decision = JSON.parse(fs.readFileSync(path.join(coachDir, 'decisions.json'), 'utf8')).decisions[f.id];
  assert.equal(decision.snapshot?.type, 'missed_repo_skill');
  assert.equal(scan().findings.some((x) => x.id === f.id), false, 'dismissed finding reappeared');
});

test('examples falls through last-digest.json to last-workspace.json', () => {
  const { home, coachDir, ws } = makeHome();
  assert.equal(cli(home, coachDir, 'digest', '--days', '400').code, 0);
  const r = cli(home, coachDir, 'workspace', ws, '--days', '400', '--json');
  assert.equal(r.code, 0, r.stderr);
  const f = JSON.parse(r.stdout).findings.find((x) => x.type === 'router_stale');
  assert.ok(f, 'router_stale missing');
  const ex = cli(home, coachDir, 'examples', f.id);
  assert.equal(ex.code, 0, ex.stderr);
  assert.ok(ex.stdout.includes('a-skill'), ex.stdout);
});
