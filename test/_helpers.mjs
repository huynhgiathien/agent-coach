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
    kv('composerData:k2', { composerId: 'k2', createdAt: at('09:05'), fullConversationHeadersOnly: [{ bubbleId: 'c1', type: 1 }, { bubbleId: 'c2', type: 2 }] });
    kv('bubbleId:k2:c1', { bubbleId: 'c1', type: 1, text: 'sub prompt', createdAt: iso('09:05') });
    kv('bubbleId:k2:c2', { bubbleId: 'c2', type: 2, text: '', createdAt: iso('09:06'), tokenCount: { inputTokens: 50, outputTokens: 5 } });

    putHeader.run('k3', 'ws1', at('09:07'), at('09:07'), 0, null, workspace);
    kv('composerData:k3', { composerId: 'k3', createdAt: at('09:07'), isDraft: true, fullConversationHeadersOnly: [{ bubbleId: 'd1', type: 1 }] });
    kv('bubbleId:k3:d1', { bubbleId: 'd1', type: 1, text: 'draft text', createdAt: iso('09:07') });
  } finally {
    db.close();
  }
}

/**
 * A private copy of the fixture home (committed fixtures are never mutated): aged unused-asset
 * candidates and memories, plus the Cursor chat DB when node:sqlite loads.
 * `coachDir` is a separate empty state dir for AGENT_COACH_HOME.
 */
export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-home-'));
  fs.cpSync(FIXTURE_HOME, home, { recursive: true });
  for (const rel of AGED) fs.utimesSync(path.join(home, rel), OLD, OLD);
  if (HAS_SQLITE) buildCursorDb(path.join(home, CURSOR_DB));
  return { home, coachDir: tmpCoachHome() };
}

export const tmpCoachHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coach-test-'));

/** True when any string inside the value contains `needle`. */
export const mentions = (value, needle) => JSON.stringify(value).includes(needle);

/** Events of every reader result `{ events, warnings }`, concatenated in reader order. */
export const eventsOf = (...results) => results.flatMap((r) => r.events);
