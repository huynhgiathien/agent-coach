// Shared helpers for the test suite. Not a test file (no `.test.` in the name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/home', import.meta.url));
export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const NOW_MS = Date.parse('2026-11-01');
export const SINCE_DAYS = 90;
export const SINCE_MS = NOW_MS - SINCE_DAYS * 86_400_000;
export const SECRET = 'sk-abcdefghijklmnopqrstuv12';
export const CURSOR_SECRET = 'cursor-secret-token-123';
export const CURSOR_DB = 'Library/Application Support/Cursor/User/globalStorage/state.vscdb';

// node:sqlite (Node 22.13+ / 23.4+). Drop only its ExperimentalWarning while loading it.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};
const sqlite = await import('node:sqlite').catch(() => null);
process.emitWarning = emitWarning;
export const HAS_SQLITE = sqlite !== null;

const OLD = new Date('2020-01-01T00:00:00Z');
// Files that must look older than the analysis window: unused-asset candidates and memories
// (memories must never be reported as unused even when old).
const AGED = [
  '.claude/skills/old-skill/SKILL.md',
  '.claude/plugins/cache/m/p/1.0.0/skills/plug/SKILL.md',
  '.claude/projects/-a/memory/p1.md',
  '.claude/projects/-a/memory/r1.md',
  '.claude/projects/-a/memory/d1.md',
  '.claude/projects/-a/memory/d2.md',
  '.claude/projects/-b/memory/p2.md',
  '.claude/projects/-c/memory/u1.md',
];

const CURSOR_DAY = '2026-10-10';
const at = (hhmm) => Date.parse(`${CURSOR_DAY}T${hhmm}:00.000Z`);
const iso = (hhmm) => new Date(at(hhmm)).toISOString();

/** Cursor IDE chat store with composers k1 (main), k2 (subagent) and k3 (draft), plus an auth token in ItemTable. */
function buildCursorDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
        isSubagent INTEGER, subagentTypeName TEXT, value TEXT);
    `);
    const putItem = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    const putKv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    const putHeader = db.prepare(
      'INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, subagentTypeName, value) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const kv = (key, value) => putKv.run(key, JSON.stringify(value));
    const workspace = JSON.stringify({ workspaceIdentifier: { uri: { fsPath: '/proj' } } });

    putItem.run('cursorAuth/accessToken', CURSOR_SECRET);

    putHeader.run('k1', 'ws1', at('09:00'), at('09:10'), 0, null, workspace);
    kv('composerData:k1', {
      composerId: 'k1',
      createdAt: at('09:00'),
      fullConversationHeadersOnly: ['b1', 'b2', 'b3', 'b4'].map((bubbleId, i) => ({ bubbleId, type: i === 0 || i === 3 ? 1 : 2 })),
    });
    kv('bubbleId:k1:b1', { bubbleId: 'b1', type: 1, text: 'review this <img src=x onerror=alert(1)>', createdAt: iso('09:01') });
    kv('bubbleId:k1:b2', {
      bubbleId: 'b2', type: 2, text: '', createdAt: iso('09:02'),
      toolFormerData: { name: 'read_file_v2', rawArgs: '{"target_file":"/x/.cursor/skills/cursor-skill/SKILL.md"}' },
      tokenCount: { inputTokens: 100, outputTokens: 10 },
      modelInfo: { modelName: 'gpt-x' },
    });
    kv('bubbleId:k1:b3', {
      bubbleId: 'b3', type: 2, text: '', createdAt: iso('09:03'),
      toolFormerData: { name: 'task_v2', rawArgs: '{"subagent_type":"explore"}' },
      tokenCount: { inputTokens: 0, outputTokens: 0 },
    });
    kv('bubbleId:k1:b4', { bubbleId: 'b4', type: 1, text: 'hidden', isDisplayOnly: true, createdAt: iso('09:04') });

    putHeader.run('k2', 'ws1', at('09:05'), at('09:06'), 1, 'explore', workspace);
    kv('composerData:k2', {
      composerId: 'k2',
      createdAt: at('09:05'),
      subagentInfo: { subagentTypeName: 'explore', parentComposerId: 'k1' },
      fullConversationHeadersOnly: [{ bubbleId: 'c1', type: 1 }, { bubbleId: 'c2', type: 2 }, { bubbleId: 'c3', type: 2 }],
    });
    kv('bubbleId:k2:c1', { bubbleId: 'c1', type: 1, text: 'sub prompt', createdAt: iso('09:05') });
    kv('bubbleId:k2:c2', { bubbleId: 'c2', type: 2, text: '', createdAt: iso('09:06'), tokenCount: { inputTokens: 50, outputTokens: 5 } });
    // edit_file_v2 records no rawArgs, only a workspace-relative path in params.
    kv('bubbleId:k2:c3', {
      bubbleId: 'c3', type: 2, text: '', createdAt: iso('09:06'),
      toolFormerData: { name: 'edit_file_v2', params: { relativeWorkspacePath: 'src/y.ts' } },
    });

    putHeader.run('k3', 'ws1', at('09:07'), at('09:07'), 0, null, workspace);
    kv('composerData:k3', { composerId: 'k3', createdAt: at('09:07'), isDraft: true, fullConversationHeadersOnly: [{ bubbleId: 'd1', type: 1 }] });
    kv('bubbleId:k3:d1', { bubbleId: 'd1', type: 1, text: 'draft text', createdAt: iso('09:07') });
  } finally {
    db.close();
  }
}

// ---- workspace fixture (spec W1–W7): <home>/ws ----

export const WS_PROMPTS = [
  'fix the build error in the B service',
  'rename the exported helper in x.ts',
  'add input validation to the form handler',
];
const WS_TOUCHED_A_PROMPT = 'update the A request handler';

const skillMd = (name, description, body = '## Done when\n\n- Verify the result.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** omp main session: one typed prompt, then assistant toolCalls (no usage, so global cost totals are unchanged). */
export function ompSession(id, cwd, isoTs, prompt, toolCalls) {
  const ts = Date.parse(isoTs);
  const at = (offsetS) => new Date(ts + offsetS * 1000).toISOString();
  const lines = [
    { type: 'title', v: 1, title: 'Workspace fixture session', source: 'auto', updatedAt: at(0), pad: '' },
    { type: 'session', version: 3, id, timestamp: at(0), cwd, title: 'Workspace fixture session', titleSource: 'auto' },
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: prompt }], attribution: 'user', timestamp: ts },
      id: `${id}-1`, parentId: null, timestamp: at(0),
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: toolCalls.map(([name, p], i) => ({ type: 'toolCall', id: `${id}-c${i}`, name, arguments: { path: p, i: 'Working' }, intent: 'x' })),
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test', stopReason: 'toolUse', timestamp: ts + 30_000,
      },
      id: `${id}-2`, parentId: `${id}-1`, timestamp: at(30),
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

/**
 * `<home>/ws`: repoA (.git dir) + its worktree repoA-wt (.git file; its extra wt-only skill must be ignored),
 * repoB (.git dir, flat .claude/skills/flat.md, no router), notes (no .git), workspace router repo-repoa
 * (mentions ./repoA and create-pr, not a-skill) and workspace create-pr. Plus 4 omp sessions with cwd <home>/ws:
 * omp-w1..w3 (2026-10-11..13) edit repoB/src/x.ts and read no skill; omp-w4 edits repoA/x.ts and reads skill://repo-repoa.
 */
function buildWorkspace(home) {
  const ws = path.join(home, 'ws');
  const put = (rel, text) => {
    const file = path.join(ws, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const repoSkills = (dir) => {
    put(`${dir}/.claude/skills/a-skill/SKILL.md`, skillMd('a-skill', 'Run the A importer. Use when the user imports A data. Not for B.'));
    put(`${dir}/.claude/skills/create-pr/SKILL.md`, skillMd('create-pr', 'Open a PR in repoA. Use when the user asks for a PR. Not for other repos.'));
  };

  fs.mkdirSync(path.join(ws, 'repoA/.git/worktrees/repoA-wt'), { recursive: true });
  put('repoA/.git/HEAD', 'ref: refs/heads/main\n');
  put('repoA/CLAUDE.md', '# repoA\n\nThe A service. Node 23.\n');
  repoSkills('repoA');

  put('repoA-wt/.git', `gitdir: ${path.join(ws, 'repoA/.git/worktrees/repoA-wt')}\n`);
  put('repoA-wt/CLAUDE.md', '# repoA\n\nThe A service. Node 23.\n');
  repoSkills('repoA-wt');
  put('repoA-wt/.claude/skills/wt-only/SKILL.md', skillMd('wt-only', 'Worktree-only skill. Use when never. Not for anything.'));

  fs.mkdirSync(path.join(ws, 'repoB/.git'), { recursive: true });
  put('repoB/.git/HEAD', 'ref: refs/heads/main\n');
  put('repoB/CLAUDE.md', '# repoB\n\nThe B service. TypeScript.\n');
  put('repoB/.claude/skills/flat.md', '# Flat skill\n\nNever loads: not in a <name>/SKILL.md dir.\n');
  put('repoB/.claude/skills/b-skill/SKILL.md', skillMd('b-skill', 'Deploy the B service. Use when the user deploys B. Not for A.'));
  put('repoB/src/x.ts', 'export const x = 1;\n');

  put('notes/todo.md', '# notes\n');
  put('repoA/x.ts', 'export const a = 1;\n');

  put(
    '.claude/skills/repo-repoa/SKILL.md',
    skillMd(
      'repo-repoa',
      'Overview of the ./repoA repo — the A service. Use when a task involves repoA. Not for other repos.',
      '## Repo skills\n\n- `create-pr` — open a PR; read ./repoA/.claude/skills/create-pr/SKILL.md\n\n## Done when\n\n- Verify the repo skill was read.',
    ),
  );
  put('.claude/skills/create-pr/SKILL.md', skillMd('create-pr', 'Open a PR anywhere. Use when the user asks for a PR. Not for releases.'));

  // The worktree is the newest member: a representative picked by mtime alone would wrongly read wt-only.
  fs.utimesSync(path.join(ws, 'repoA'), OLD, OLD);

  const sessions = path.join(home, '.omp/agent/sessions/-ws');
  fs.mkdirSync(sessions, { recursive: true });
  WS_PROMPTS.forEach((prompt, i) => {
    const iso = `2026-10-1${i + 1}T10:00:00.000Z`;
    fs.writeFileSync(
      path.join(sessions, `${iso.replace(/[:.]/g, '-')}_omp-w${i + 1}.jsonl`),
      ompSession(`omp-w${i + 1}`, ws, iso, prompt, [['edit', path.join(ws, 'repoB/src/x.ts')]]),
    );
  });
  fs.writeFileSync(
    path.join(sessions, '2026-10-14T10-00-00-000Z_omp-w4.jsonl'),
    ompSession('omp-w4', ws, '2026-10-14T10:00:00.000Z', WS_TOUCHED_A_PROMPT, [
      ['edit', path.join(ws, 'repoA/x.ts')],
      ['read', 'skill://repo-repoa'],
    ]),
  );
  return ws;
}

/**
 * A private copy of the fixture home (committed fixtures are never mutated): aged unused-asset
 * candidates and memories, the Cursor chat DB when node:sqlite loads, and the `ws` workspace
 * (`ws` = `<home>/ws`, see buildWorkspace). `coachDir` is a separate empty state dir for AGENT_COACH_HOME.
 * `home` is a physical path (macOS: /var → /private/var), as session cwds and git `gitdir:` files record it.
 */
export function makeHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-home-')));
  fs.cpSync(FIXTURE_HOME, home, { recursive: true });
  for (const rel of AGED) fs.utimesSync(path.join(home, rel), OLD, OLD);
  if (HAS_SQLITE) buildCursorDb(path.join(home, CURSOR_DB));
  const ws = buildWorkspace(home);
  return { home, coachDir: tmpCoachHome(), ws };
}

export const tmpCoachHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coach-test-'));

/** True when any string inside the value contains `needle`. */
export const mentions = (value, needle) => JSON.stringify(value).includes(needle);

/** Events of every reader result `{ events, warnings }`, concatenated in reader order. */
export const eventsOf = (...results) => results.flatMap((r) => r.events);

/**
 * Write `<home>/.claude/projects/<slug>/<sessionId>.jsonl` from compact records, one minute apart from `start`:
 * a string is a typed prompt; `{ text, ...flags }` a user record with extra top-level flags (isSidechain …);
 * `{ meta }` an isMeta text record; `{ skill }` / `{ agent }` an assistant Skill / Agent tool_use.
 */
export function writeClaudeSession(home, { sessionId, cwd, start, records, slug = '-t' }) {
  const file = path.join(home, '.claude', 'projects', slug, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = records.map((r, i) => {
    const base = { sessionId, cwd, uuid: `${sessionId}-${i}`, timestamp: new Date(Date.parse(start) + i * 60_000).toISOString() };
    if (typeof r === 'string') return { ...base, type: 'user', message: { role: 'user', content: r } };
    if (r.meta) return { ...base, type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: r.meta }] } };
    if (r.skill || r.agent) {
      const item = r.skill
        ? { type: 'tool_use', id: `tu-${i}`, name: 'Skill', input: { skill: r.skill } }
        : { type: 'tool_use', id: `tu-${i}`, name: 'Agent', input: { subagent_type: r.agent, prompt: 'p' } };
      return { ...base, type: 'assistant', message: { id: `msg-${sessionId}-${i}`, role: 'assistant', model: 'claude-x', content: [item] } };
    }
    const { text, ...flags } = r;
    return { ...base, ...flags, type: 'user', message: { role: 'user', content: text } };
  });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Write a frontmatter markdown asset at `<root>/<rel>`; `mtime` (Date) backdates it. Returns its path. */
export function writeAsset(root, rel, { name, description, mtime } = {}) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}
