// Cursor IDE chat reader: the global `state.vscdb` (SQLite), opened read-only through node:sqlite.
// Only `composerHeaders` and the `cursorDiskKV` keys `composerData:*` / `bubbleId:*` are queried;
// `ItemTable` (auth tokens) is never read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from '../lines.mjs';
import { promptText } from '../redact.mjs';

const DB_PATHS = [
  ['Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'],
  ['.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'],
  ['AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'],
];
const MAX_COMPOSER_BYTES = 2 * 1024 * 1024;
const MAX_BUBBLE_BYTES = 512 * 1024;
const SKILL_FILE = /skills(?:-cursor)?\/([^/"\\]+)\/SKILL\.md/;
const SUBAGENT_TYPE = /"subagent_?type"\s*:\s*"([^"]+)"/i;
const FILE_TOOLS = new Set(['read_file_v2', 'edit_file_v2', 'read_file', 'edit_file']);

/**
 * The file a read/edit tool call works on: `target_file` (or `path`) in its args, else its params; `~` is
 * expanded to `home`, a relative path resolved against the cwd.
 */
function toolFile(tool, cwd, home) {
  const raw = typeof tool.rawArgs === 'string' ? json(tool.rawArgs) : null;
  const params = typeof tool.params === 'string' ? json(tool.params) : tool.params;
  const recorded = raw?.target_file ?? raw?.path ?? params?.targetFile ?? params?.relativeWorkspacePath;
  if (typeof recorded !== 'string' || !recorded) return null;
  const p = expandHome(recorded, home);
  if (path.isAbsolute(p)) return p;
  return cwd ? path.resolve(cwd, p) : null;
}

/** node:sqlite (Node 22.13+ / 23.4+) without its ExperimentalWarning; null when this Node has none. */
async function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message ?? warning).includes('SQLite')) return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

const text = (v) => (v == null ? null : typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));
function json(v) {
  try {
    return JSON.parse(text(v));
  } catch {
    return null;
  }
}

/** Folder of a workspace from `User/workspaceStorage/<id>/workspace.json`, or null. */
function workspaceFolder(userDir, workspaceId) {
  if (!workspaceId) return null;
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(userDir, 'workspaceStorage', workspaceId, 'workspace.json'), 'utf8'));
    const url = ws.folder ?? ws.workspace;
    return typeof url === 'string' && url.startsWith('file:') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

/** Events of one composer (chat) in conversation order. */
function composerEvents(header, data, bubbles, cwd, sinceMs, home) {
  const events = [];
  const sub = header.isSubagent === 1 || !!data.subagentInfo;
  const agent = sub ? header.subagentTypeName ?? data.subagentInfo?.subagentTypeName ?? 'cursor-subagent' : null;
  const info = data.subagentInfo;
  const parent = sub ? info?.rootParentConversationId ?? info?.parentComposerId : null;
  const startTs = header.createdAt ?? data.createdAt ?? null;
  const emit = (ts, fields) => {
    if (!(ts >= sinceMs)) return;
    const subFields = sub ? { sub: true, agent, ...(typeof parent === 'string' && parent ? { parentSessionId: parent } : {}) } : {};
    events.push({ source: 'cursor', sessionId: header.composerId, cwd, ts, ...fields, ...subFields });
  };
  for (const b of bubbles) {
    if (b.isDisplayOnly || b.skipRendering) continue;
    const ts = Date.parse(b.createdAt) || startTs;
    if (b.type === 1 && !sub && typeof b.text === 'string' && b.text.trim()) emit(ts, { kind: 'prompt', text: promptText(b.text) });
    const tool = b.type === 2 ? b.toolFormerData : null;
    if (tool && typeof tool === 'object') {
      const args = typeof tool.rawArgs === 'string' ? tool.rawArgs : JSON.stringify(tool.params ?? {});
      if (tool.name === 'read_file_v2' || tool.name === 'read_file') {
        const m = SKILL_FILE.exec(args);
        const file = m ? toolFile(tool, cwd, home) : null;
        if (m) emit(ts, { kind: 'skill', name: m[1], ...(file ? { path: file } : {}), how: 'model' });
      } else if (tool.name === 'task_v2' || tool.name === 'task') {
        emit(ts, { kind: 'agent', name: SUBAGENT_TYPE.exec(args)?.[1] ?? 'cursor-subagent' });
      }
      if (FILE_TOOLS.has(tool.name)) {
        const file = toolFile(tool, cwd, home);
        if (file) emit(ts, { kind: 'touch', path: file });
      }
    }
    const t = b.tokenCount;
    if (t && (t.inputTokens > 0 || t.outputTokens > 0)) {
      emit(ts, {
        kind: 'usage',
        model: b.modelInfo?.modelName ?? data.modelConfig?.modelName ?? null,
        input: t.inputTokens ?? 0,
        output: t.outputTokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: null,
      });
    }
  }
  return events;
}

function readDb(sqlite, file, sinceMs, home) {
  const userDir = path.dirname(path.dirname(file));
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    // Statements stay in consts and use .all(): Node 23 finalizes a chained prepare().iterate() mid-loop.
    let headers;
    try {
      const listHeaders = db.prepare(
        'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, subagentTypeName, value FROM composerHeaders WHERE COALESCE(lastUpdatedAt, createdAt) >= ?',
      );
      headers = listHeaders.all(sinceMs);
    } catch (error) {
      if (!/no such table/.test(error.message)) throw error;
      // Older Cursor: no header table, so list composer ids from their data keys.
      const listIds = db.prepare("SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'");
      headers = listIds.all().map((r) => ({ composerId: r.key.slice('composerData:'.length), workspaceId: null, createdAt: null, isSubagent: null, subagentTypeName: null, value: null }));
    }
    const getData = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ? AND length(value) <= ?');
    const getBubbles = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? AND length(value) <= ?');
    const folders = new Map();
    const events = [];
    for (const header of headers) {
      const id = header.composerId;
      const data = json(getData.all(`composerData:${id}`, MAX_COMPOSER_BYTES)[0]?.value);
      if (!data || typeof data !== 'object' || data.isDraft || data.isEphemeral) continue;
      const prefix = `bubbleId:${id}:`;
      const order = new Map((Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : []).map((h, i) => [h?.bubbleId, i]));
      const bubbles = [];
      for (const row of getBubbles.all(prefix, `bubbleId:${id};`, MAX_BUBBLE_BYTES)) {
        const b = json(row.value);
        if (!b || typeof b !== 'object') continue;
        bubbles.push({ b, key: row.key, index: order.get(row.key.slice(prefix.length)) ?? Infinity, created: Date.parse(b.createdAt) || 0 });
      }
      bubbles.sort((x, y) => x.index - y.index || x.created - y.created || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      let cwd = json(header.value)?.workspaceIdentifier?.uri?.fsPath ?? null;
      if (!cwd && header.workspaceId) {
        if (!folders.has(header.workspaceId)) folders.set(header.workspaceId, workspaceFolder(userDir, header.workspaceId));
        cwd = folders.get(header.workspaceId);
      }
      events.push(...composerEvents(header, data, bubbles.map((x) => x.b), typeof cwd === 'string' ? cwd : null, sinceMs, home));
    }
    return events;
  } finally {
    db.close();
  }
}

/** `{ events, warnings }` from Cursor IDE chats updated since `sinceMs`; no DB means no events and no warning. */
export async function readEvents({ home = os.homedir(), sinceMs = 0 } = {}) {
  const file = DB_PATHS.map((p) => path.join(home, ...p)).find((p) => fs.existsSync(p));
  if (!file) return { events: [], warnings: [] };
  const sqlite = await loadSqlite();
  if (!sqlite) return { events: [], warnings: [`Cursor skipped: Node ${process.version} has no node:sqlite (needs 22.13+)`] };
  try {
    return { events: readDb(sqlite, file, sinceMs, home), warnings: [] };
  } catch (error) {
    return { events: [], warnings: [`Cursor chat DB unreadable: ${error.message}`] };
  }
}
