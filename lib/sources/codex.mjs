// Codex session reader: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl (interactive sessions only).

import os from 'node:os';
import path from 'node:path';
import { forEachLine, mapFiles, readDir } from '../lines.mjs';
import { promptText } from '../redact.mjs';

const MARKERS = ['"session_meta"', '"turn_context"', '"user_message"', '"item_completed"', '"function_call"', '"token_count"'];
const SKILL_TOKEN = /(?:^|\s)\$([a-z][a-z0-9-]*)/g;
const SKILL_FILE = /skills\/([^/\s]+)\/SKILL\.md/;
const DEDUPE_MS = 2000;

async function readFile(file, sinceMs) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let model = null;
  let skip = false;
  let first = true;
  let last = null; // { text, ts } of the previous prompt
  const emit = (rec, fields) => {
    const ts = Date.parse(rec.timestamp);
    if (!(ts >= sinceMs)) return;
    events.push({ source: 'codex', sessionId, cwd, ts, ...fields });
  };
  const prompt = (rec, text) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('# AGENTS.md instructions')) return;
    const ts = Date.parse(rec.timestamp);
    if (last && last.text === text && Math.abs(ts - last.ts) <= DEDUPE_MS) return;
    last = { text, ts };
    // Skill mentions come from the redacted text so a secret after `$` never becomes a skill name.
    const clean = promptText(text);
    emit(rec, { kind: 'prompt', text: clean });
    for (const m of clean.matchAll(SKILL_TOKEN)) emit(rec, { kind: 'skill', name: m[1], how: 'user' });
  };

  await forEachLine(file, (line) => {
    if (skip) return;
    const isFirst = first;
    first = false;
    if (!isFirst && !MARKERS.some((m) => line.includes(m))) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const p = rec?.payload;
    if (!p || typeof p !== 'object') return;
    switch (rec.type) {
      case 'session_meta':
        if (p.source === 'exec' || String(p.originator).startsWith('codex_sdk')) skip = true;
        sessionId = p.id ?? sessionId;
        cwd = p.cwd ?? cwd;
        return;
      case 'turn_context':
        if (typeof p.model === 'string') model = p.model;
        return;
      case 'event_msg':
        if (p.type === 'user_message') prompt(rec, p.message);
        else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
          const parts = Array.isArray(p.item.content) ? p.item.content : [];
          prompt(rec, parts.filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n'));
        } else if (p.type === 'token_count') {
          const u = p.info?.last_token_usage;
          if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return;
          const cached = u.cached_input_tokens ?? 0;
          emit(rec, { kind: 'usage', model, input: u.input_tokens - cached, output: u.output_tokens, cacheRead: cached, cacheWrite: 0, costUsd: null });
        }
        return;
      case 'response_item': {
        if (p.type !== 'function_call') return;
        let args;
        try {
          args = JSON.parse(p.arguments);
        } catch {
          return;
        }
        if (p.name === 'exec_command') {
          const cmd = Array.isArray(args?.cmd) ? args.cmd.join(' ') : args?.cmd;
          const name = typeof cmd === 'string' ? SKILL_FILE.exec(cmd)?.[1] : null;
          if (name) emit(rec, { kind: 'skill', name, how: 'model' });
        } else if (p.name === 'spawn_agent') {
          emit(rec, { kind: 'agent', name: args?.agent_type ?? args?.role ?? 'codex-subagent' });
        }
        return;
      }
      default:
    }
  });
  return skip ? [] : events;
}

/** Events from interactive Codex sessions modified since `sinceMs`; exec/SDK runs are skipped. */
export async function readEvents({ home = os.homedir(), sinceMs = 0 } = {}) {
  const root = path.join(home, '.codex', 'sessions');
  const files = [];
  for (const y of await readDir(root)) {
    if (!y.isDirectory()) continue;
    for (const m of await readDir(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of await readDir(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, y.name, m.name, d.name);
        for (const f of await readDir(dir)) {
          if (f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) files.push(path.join(dir, f.name));
        }
      }
    }
  }
  return mapFiles(files, sinceMs, (f) => readFile(f, sinceMs));
}
