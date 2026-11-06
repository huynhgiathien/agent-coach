// omp session reader: ~/.omp/agent/sessions/<dir>/*.jsonl (main) and deeper *.jsonl (subagents).

import os from 'node:os';
import path from 'node:path';
import { forEachLine, mapFiles, readDir } from '../lines.mjs';
import { promptText } from '../redact.mjs';

const MAIN_MARKERS = ['"type":"session', '"role":"user"', '"role":"assistant"', 'skill-prompt', 'mode_change'];
const SUB_MARKERS = ['"type":"session', '"role":"assistant"', 'skill-prompt'];
const SKILL_URI = /^skill:\/\/([^/?#]+)/;
const SKILL_FILE = /skills\/([^/]+)\/SKILL\.md$/;
// `read` selectors appended to a path (`:raw`, `:50-80`, `:img`, `:conflicts`) are not part of the name.
const SELECTOR = /:(?:raw|img|conflicts|\d[\d+,-]*)(?::.*)?$/;

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
      : '';

function skillFromRead(args) {
  const p = typeof args?.path === 'string' ? args.path.replace(SELECTOR, '') : '';
  return (SKILL_URI.exec(p) ?? SKILL_FILE.exec(p))?.[1] ?? null;
}

async function readFile(file, sub, sinceMs) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let agent = 'task';
  const emit = (entry, fields) => {
    const ts = Date.parse(entry.timestamp);
    if (!(ts >= sinceMs)) return;
    events.push({ source: 'omp', sessionId, cwd, ts, ...fields, ...(sub ? { sub: true } : {}) });
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
            const name = skillFromRead(args);
            if (name) emit(e, { kind: 'skill', name, how: 'model' });
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

async function collectSubFiles(dir, out) {
  for (const ent of await readDir(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await collectSubFiles(p, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
  }
}

/** Events from omp sessions modified since `sinceMs`. */
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
      else if (ent.isDirectory()) await collectSubFiles(p, subs);
    }
  }
  const [a, b] = await Promise.all([
    mapFiles(main, sinceMs, (f) => readFile(f, false, sinceMs)),
    mapFiles(subs, sinceMs, (f) => readFile(f, true, sinceMs)),
  ]);
  return a.concat(b);
}
