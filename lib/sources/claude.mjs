// Claude Code session reader: ~/.claude/projects/<slug>/*.jsonl (main) and
// <slug>/<sessionId>/subagents/agent-*.jsonl (subagents, typed by the sibling .meta.json).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine, mapFiles, readDir } from '../lines.mjs';
import { promptText } from '../redact.mjs';

const MARKERS = ['"type":"user"', '"type":"assistant"', 'queued_command', '"type":"cost-state"'];
const SKIP_PREFIXES = ['<local-command-stdout>', '<local-command-caveat>', '<task-notification>', '<system-reminder>'];
const SKILL_BASE = 'Base directory for this skill:';
const DEDUPE_MS = 2000;

/** Text of a user message whose content is a string or text parts only; null otherwise. */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || !content.length) return null;
  if (content.some((p) => p?.type === 'tool_result')) return null;
  const parts = content.filter((p) => p?.type === 'text' && typeof p.text === 'string');
  return parts.length ? parts.map((p) => p.text).join('\n') : null;
}

/** Model id without a context-size tag (`[1m]`) or release date (`-20251001`). */
const modelId = (model) => String(model ?? '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');

async function readFile(file, sinceMs, subAgent) {
  const sub = subAgent !== undefined;
  const events = [];
  const pending = new Set();
  const seenMessages = new Set();
  const usage = []; // { fields, ev|null } for every distinct message.id with usage
  let costState = null;
  const lastPrompt = new Map(); // sessionId -> { text, ts }
  const subId = sub ? path.basename(file, '.jsonl') : null;

  const emit = (rec, fields) => {
    const ts = Date.parse(rec.timestamp);
    if (!(ts >= sinceMs)) return null;
    const sessionId = sub ? `${rec.sessionId}:${subId}` : rec.sessionId;
    const ev = { source: 'claude', sessionId, cwd: rec.cwd ?? null, ts, ...fields };
    if (sub) Object.assign(ev, { sub: true, agent: subAgent });
    events.push(ev);
    return ev;
  };
  const emitPrompt = (rec, text, steering) => {
    if (sub) return;
    const ts = Date.parse(rec.timestamp);
    const prev = lastPrompt.get(rec.sessionId);
    if (prev && prev.text === text && Math.abs(ts - prev.ts) <= DEDUPE_MS) return;
    lastPrompt.set(rec.sessionId, { text, ts });
    emit(rec, { kind: 'prompt', text: promptText(text), ...(steering ? { steering: true } : {}) });
  };

  await forEachLine(file, (line) => {
    if (!MARKERS.some((m) => line.includes(m))) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (!rec || typeof rec !== 'object') return;
    switch (rec.type) {
      case 'user': {
        if (rec.toolUseResult !== undefined) return;
        const text = userText(rec.message?.content);
        if (text === null) return;
        if (rec.isMeta) {
          if (!text.startsWith(SKILL_BASE)) return;
          const dir = text.slice(SKILL_BASE.length).split('\n')[0].trim();
          const name = path.basename(dir);
          if (!name) return;
          if (pending.has(name)) pending.delete(name);
          else emit(rec, { kind: 'skill', name, how: 'user' });
          return;
        }
        const trimmed = text.trimStart();
        if (SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) return;
        if (text.includes('[Request interrupted by user')) {
          if (!sub) emit(rec, { kind: 'interrupt' });
          return;
        }
        if (text.includes('<command-name>')) {
          const name = (/<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1] ?? '').trim().replace(/^\//, '');
          const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '').trim();
          if (name) emitPrompt(rec, `/${name} ${args}`.trim());
          return;
        }
        if (text.trim()) emitPrompt(rec, text);
        return;
      }
      case 'attachment': {
        const a = rec.attachment;
        if (a?.type !== 'queued_command') return;
        const text = typeof a.prompt === 'string' ? a.prompt : userText(a.prompt);
        if (!text || !text.trim() || text.trimStart().startsWith('<task-notification>')) return;
        emitPrompt(rec, text, true);
        return;
      }
      case 'assistant': {
        const m = rec.message;
        if (!m || typeof m !== 'object') return;
        for (const item of Array.isArray(m.content) ? m.content : []) {
          if (item?.type !== 'tool_use') continue;
          if (item.name === 'Skill' && typeof item.input?.skill === 'string') {
            emit(rec, { kind: 'skill', name: item.input.skill, how: 'model' });
            pending.add(item.input.skill);
          } else if (item.name === 'Agent' || item.name === 'Task') {
            emit(rec, { kind: 'agent', name: item.input?.subagent_type ?? 'general-purpose' });
          }
        }
        const u = m.usage;
        if (!u || typeof u !== 'object') return;
        if (m.id) {
          if (seenMessages.has(m.id)) return;
          seenMessages.add(m.id);
        }
        const fields = {
          kind: 'usage',
          model: m.model ?? null,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          costUsd: null,
        };
        // Out-of-window usage still takes its share of the file's cost, so it is weighed too.
        usage.push({ fields, ev: emit(rec, fields) });
        return;
      }
      case 'cost-state':
        costState = rec;
        return;
      default:
    }
  });

  // Claude records cost per model per file only; spread it over that model's usage by price weight.
  // cost-state keys and message.model differ in suffixes (`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`),
  // so both sides are matched by normalized id, and costs that collapse to one id are summed.
  const weight = (f) => f.input + 5 * f.output + 0.1 * f.cacheRead + 1.25 * f.cacheWrite;
  const costs = new Map();
  for (const [model, mu] of Object.entries(costState?.modelUsage ?? {})) {
    if (typeof mu?.costUSD !== 'number') continue;
    const id = modelId(model);
    costs.set(id, (costs.get(id) ?? 0) + mu.costUSD);
  }
  for (const [id, cost] of costs) {
    const mine = usage.filter((x) => modelId(x.fields.model) === id);
    const total = mine.reduce((s, x) => s + weight(x.fields), 0);
    if (total === 0) continue;
    for (const x of mine) if (x.ev) x.ev.costUsd = (cost * weight(x.fields)) / total;
  }
  return events;
}

async function agentType(metaPath) {
  try {
    const t = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'))?.agentType;
    return typeof t === 'string' && t ? t : 'general-purpose';
  } catch {
    return 'general-purpose';
  }
}

/** Events from Claude Code sessions modified since `sinceMs`. */
export async function readEvents({ home = os.homedir(), sinceMs = 0 } = {}) {
  const root = path.join(home, '.claude', 'projects');
  const main = [];
  const subs = [];
  for (const slug of await readDir(root)) {
    if (!slug.isDirectory()) continue;
    const d = path.join(root, slug.name);
    for (const ent of await readDir(d)) {
      if (ent.isFile() && ent.name.endsWith('.jsonl')) main.push(path.join(d, ent.name));
      else if (ent.isDirectory()) {
        const sd = path.join(d, ent.name, 'subagents');
        for (const f of await readDir(sd)) {
          if (f.isFile() && /^agent-.*\.jsonl$/.test(f.name)) subs.push(path.join(sd, f.name));
        }
      }
    }
  }
  const [a, b] = await Promise.all([
    mapFiles(main, sinceMs, (f) => readFile(f, sinceMs)),
    mapFiles(subs, sinceMs, async (f) => readFile(f, sinceMs, await agentType(f.replace(/\.jsonl$/, '.meta.json')))),
  ]);
  return a.concat(b);
}
