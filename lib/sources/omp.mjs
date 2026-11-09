// omp session reader: ~/.omp/agent/sessions/<dir>/*.jsonl (main) and deeper *.jsonl (subagents).
// A subagent file lives under `<dir>/<main file stem>/…`, so its root main session is found by nesting.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, forEachLine, mapFiles, readDir } from '../lines.mjs';
import { promptText } from '../redact.mjs';

const MAIN_MARKERS = ['"type":"session', '"role":"user"', '"role":"assistant"', 'skill-prompt', 'mode_change'];
const SUB_MARKERS = ['"type":"session', '"role":"assistant"', 'skill-prompt'];
const SKILL_URI = /^skill:\/\/([^/?#]+)/;
const SKILL_FILE = /skills\/([^/]+)\/SKILL\.md$/;
// `read` selectors appended to a path (`:raw`, `:50-80`, `:img`, `:conflicts`) are not part of the name.
const SELECTOR = /:(?:raw|img|conflicts|\d[\d+,-]*)(?::.*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// `edit` input sections start with `[<path>#<TAG>]`.
const EDIT_HEADER = /^\[([^\]\n#]+)#[0-9A-Za-z]{4}\]/gm;
const FILE_TOOLS = new Set(['read', 'edit', 'write']);

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
      : '';

/**
 * Skill a `read` loads: `{ name }` for `skill://<name>`, `{ name, path }` for a `…/skills/<name>/SKILL.md`
 * file (`~` expanded to `home`).
 */
function skillFromRead(args, home) {
  const p = typeof args?.path === 'string' ? args.path.replace(SELECTOR, '') : '';
  const uri = SKILL_URI.exec(p)?.[1];
  if (uri) return { name: uri };
  const file = SKILL_FILE.exec(p)?.[1];
  return file ? { name: file, path: expandHome(p, home) } : null;
}

/**
 * File paths a read/edit/write toolCall works on, `~` expanded to `home`; `scheme://` paths (skills, agents,
 * URLs) are not files.
 */
function touchedPaths(name, args, home) {
  const out = [];
  if (typeof args?.path === 'string' && args.path) out.push(args.path.replace(SELECTOR, ''));
  else if (name === 'edit' && typeof args?.input === 'string') for (const m of args.input.matchAll(EDIT_HEADER)) out.push(m[1].trim());
  return out.filter((p) => p && !SCHEME.test(p)).map((p) => expandHome(p, home));
}

async function readFile(file, sub, sinceMs, home, parentSessionId) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let agent = 'task';
  const emit = (entry, fields) => {
    const ts = Date.parse(entry.timestamp);
    if (!(ts >= sinceMs)) return;
    events.push({ source: 'omp', sessionId, cwd, ts, ...fields, ...(sub ? { sub: true, ...(parentSessionId ? { parentSessionId } : {}) } : {}) });
  };
  const markers = sub ? SUB_MARKERS : MAIN_MARKERS;
  await forEachLine(file, (line) => {
    if (!markers.some((m) => line.includes(m))) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'session':
        if (typeof e.id === 'string') sessionId = e.id;
        if (typeof e.cwd === 'string') cwd = e.cwd;
        return;
      case 'session_init':
        if (typeof e.agent === 'string' && e.agent) agent = e.agent;
        return;
      case 'mode_change':
        if (!sub && typeof e.mode === 'string' && e.mode !== 'none') emit(e, { kind: 'mode', name: e.mode });
        return;
      case 'custom_message': {
        if (e.customType !== 'skill-prompt' || e.display === false) return;
        const name = e.details?.name;
        if (typeof name !== 'string' || !name) return;
        if (!sub) emit(e, { kind: 'prompt', text: promptText(`/skill:${name} ${e.details.args ?? ''}`.trim()) });
        emit(e, { kind: 'skill', name, how: 'user' });
        return;
      }
      case 'message': {
        const m = e.message;
        if (!m || typeof m !== 'object') return;
        if (m.role === 'user') {
          if (sub || m.attribution !== 'user') return;
          const text = textOf(m.content);
          if (!text.trim()) return;
          emit(e, { kind: 'prompt', text: promptText(text), ...(m.steering === true ? { steering: true } : {}) });
          return;
        }
        if (m.role !== 'assistant') return;
        for (const item of Array.isArray(m.content) ? m.content : []) {
          if (item?.type !== 'toolCall') continue;
          const args = item.arguments;
          if (item.name === 'read') {
            const skill = skillFromRead(args, home);
            if (skill) emit(e, { kind: 'skill', ...skill, how: 'model' });
          }
          if (FILE_TOOLS.has(item.name)) {
            for (const p of touchedPaths(item.name, args, home)) emit(e, { kind: 'touch', path: p });
          } else if (item.name === 'task') {
            if (Array.isArray(args?.tasks)) {
              for (const t of args.tasks) emit(e, { kind: 'agent', name: t?.agent ?? args.agent ?? 'task' });
            } else {
              emit(e, { kind: 'agent', name: args?.agent ?? 'task' });
            }
          }
        }
        const u = m.usage;
        if (u && typeof u === 'object') {
          emit(e, {
            kind: 'usage',
            model: m.model ?? null,
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            costUsd: typeof u.cost?.total === 'number' ? u.cost.total : null,
          });
        }
        if (!sub && m.stopReason === 'aborted') emit(e, { kind: 'interrupt' });
        return;
      }
      default:
    }
  });
  if (sub) for (const ev of events) ev.agent = agent;
  return events;
}

async function collectSubFiles(dir, top, out) {
  for (const ent of await readDir(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await collectSubFiles(p, top, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push({ file: p, top });
  }
}

/** Session id in the header of a main session file; else the id part of its `<ts>_<id>` stem. */
async function mainSessionId(top) {
  let fh;
  try {
    fh = await fs.promises.open(`${top}.jsonl`, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('"type":"session"')) continue;
      try {
        const id = JSON.parse(line).id;
        if (typeof id === 'string' && id) return id;
      } catch {
        // partial line
      }
    }
  } catch {
    // no main file
  } finally {
    await fh?.close();
  }
  const stem = path.basename(top);
  return stem.includes('_') ? stem.slice(stem.indexOf('_') + 1) : stem;
}

/** `{ events, warnings }` from omp sessions modified since `sinceMs`; this reader never warns. */
export async function readEvents({ home = os.homedir(), sinceMs = 0 } = {}) {
  const root = path.join(home, '.omp', 'agent', 'sessions');
  const main = [];
  const subs = [];
  for (const dir of await readDir(root)) {
    if (!dir.isDirectory()) continue;
    const d = path.join(root, dir.name);
    for (const ent of await readDir(d)) {
      const p = path.join(d, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) main.push(p);
      else if (ent.isDirectory()) await collectSubFiles(p, p, subs);
    }
  }
  // Every subagent, however deeply nested, belongs to the main session its top directory is named after.
  const roots = new Map();
  for (const { top } of subs) if (!roots.has(top)) roots.set(top, null);
  await Promise.all([...roots.keys()].map(async (top) => roots.set(top, await mainSessionId(top))));
  const parentOf = new Map(subs.map((s) => [s.file, roots.get(s.top)]));
  const [a, b] = await Promise.all([
    mapFiles(main, sinceMs, (f) => readFile(f, false, sinceMs, home)),
    mapFiles(subs.map((s) => s.file), sinceMs, (f) => readFile(f, true, sinceMs, home, parentOf.get(f))),
  ]);
  return { events: a.concat(b), warnings: [] };
}
