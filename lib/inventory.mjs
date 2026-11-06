// Inventory of skills, agents, commands, context files and memories across Claude Code, omp, Codex and Cursor.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDir } from './lines.mjs';

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * Minimal frontmatter: `key: value` lines plus one nesting level of 2-space-indented children.
 * Returns `{ fm, body }`; `body` is the text after the closing `---` (the whole text when there is no frontmatter).
 */
export function parseFrontmatter(text) {
  const fm = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fm, body: text };
  let parent = null;
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      end = i;
      break;
    }
    const child = /^ {2}([\w-]+):\s*(.*)$/.exec(line);
    if (child && parent) {
      fm[parent][child[1]] = unquote(child[2]);
      continue;
    }
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    if (top[2].trim() === '') {
      fm[top[1]] = {};
      parent = top[1];
    } else {
      fm[top[1]] = unquote(top[2]);
      parent = null;
    }
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

const str = (v) => (typeof v === 'string' ? v : null);

async function asset(file, kind, origin, editable, fallbackName, extra = {}) {
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
  } catch {
    return null;
  }
  const { fm } = parseFrontmatter(text);
  return {
    kind,
    name: str(fm.name) || fallbackName,
    description: str(fm.description) ?? '',
    path: file,
    editable,
    origin,
    mtimeMs: stat.mtimeMs,
    ...(kind === 'memory' ? { memoryType: str(fm.metadata?.type) ?? null } : {}),
    ...extra,
  };
}

const isVisibleDir = (ent) => (ent.isDirectory() || ent.isSymbolicLink()) && !ent.name.startsWith('.');

/** `<root>/<n>/SKILL.md` for every visible `<n>` not in `skip`. */
async function skillDir(root, origin, editable, skip = []) {
  const out = [];
  for (const ent of await readDir(root)) {
    if (!isVisibleDir(ent) || skip.includes(ent.name)) continue;
    out.push(asset(path.join(root, ent.name, 'SKILL.md'), 'skill', origin, editable, ent.name));
  }
  return out;
}

/** `<root>/*<ext>` (optionally recursive, skipping dot-dirs) as `kind` assets named by basename. */
async function mdFiles(root, kind, origin, recursive = false, ext = '.md') {
  const out = [];
  for (const ent of await readDir(root)) {
    const p = path.join(root, ent.name);
    if (ent.isFile() && ent.name.endsWith(ext)) out.push(asset(p, kind, origin, true, ent.name.slice(0, -ext.length)));
    else if (recursive && isVisibleDir(ent)) out.push(...(await mdFiles(p, kind, origin, true, ext)));
  }
  return out;
}

async function newest(dirs) {
  let best = null;
  for (const d of dirs) {
    try {
      const { mtimeMs } = await fs.promises.stat(d);
      if (!best || mtimeMs > best.mtimeMs) best = { d, mtimeMs };
    } catch {
      // unreadable version dir
    }
  }
  return best?.d ?? null;
}

/** Plugin caches laid out as `<cache>/<m>/<p>/<v>/skills/<n>/SKILL.md`, newest `<v>` per `<m>/<p>`. */
async function pluginCache(cache) {
  const out = [];
  for (const m of await readDir(cache)) {
    if (!isVisibleDir(m)) continue;
    for (const p of await readDir(path.join(cache, m.name))) {
      if (!isVisibleDir(p)) continue;
      const base = path.join(cache, m.name, p.name);
      const versions = (await readDir(base)).filter(isVisibleDir).map((v) => path.join(base, v.name));
      const v = await newest(versions);
      if (v) out.push(...(await skillDir(path.join(v, 'skills'), 'plugin', false)));
    }
  }
  return out;
}

/** Cursor local plugins: `.cursor/plugins/local/<p>/skills/<n>/SKILL.md`. */
async function cursorPlugins(root) {
  const out = [];
  for (const p of await readDir(root)) {
    if (isVisibleDir(p)) out.push(...(await skillDir(path.join(root, p.name, 'skills'), 'plugin', false)));
  }
  return out;
}

/** omp plugin cache: `<cache>/<mkt>___<plugin>___<ver>/skills/<n>/SKILL.md`, newest per `<mkt>___<plugin>`. */
async function ompPluginCache(cache) {
  const byPlugin = new Map();
  for (const ent of await readDir(cache)) {
    if (!isVisibleDir(ent)) continue;
    const parts = ent.name.split('___');
    const id = parts.length >= 3 ? parts.slice(0, -1).join('___') : ent.name;
    if (!byPlugin.has(id)) byPlugin.set(id, []);
    byPlugin.get(id).push(path.join(cache, ent.name));
  }
  const out = [];
  for (const dirs of byPlugin.values()) {
    const v = await newest(dirs);
    if (v) out.push(...(await skillDir(path.join(v, 'skills'), 'plugin', false)));
  }
  return out;
}

/** First `cwd` recorded in any of the project's session files (reads only the start of each file). */
async function firstCwd(dir) {
  for (const ent of await readDir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    let fh;
    try {
      fh = await fs.promises.open(path.join(dir, ent.name), 'r');
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = JSON.parse(line).cwd;
          if (typeof cwd === 'string' && cwd) return cwd;
        } catch {
          // partial or invalid line
        }
      }
    } catch {
      // unreadable file
    } finally {
      await fh?.close();
    }
  }
  return null;
}

async function claudeProject(dir, slug) {
  try {
    const p = JSON.parse(await fs.promises.readFile(path.join(dir, 'sessions-index.json'), 'utf8'))?.originalPath;
    if (typeof p === 'string' && p) return p;
  } catch {
    // no index
  }
  return (await firstCwd(dir)) ?? slug;
}

async function claudeMemories(home) {
  const root = path.join(home, '.claude', 'projects');
  const out = [];
  for (const slug of await readDir(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    const memDir = path.join(dir, 'memory');
    const files = (await readDir(memDir)).filter((f) => f.isFile() && f.name.endsWith('.md') && f.name !== 'MEMORY.md');
    if (!files.length) continue;
    const project = await claudeProject(dir, slug.name);
    for (const f of files) out.push(asset(path.join(memDir, f.name), 'memory', 'claude', true, f.name, { project }));
  }
  return out;
}

async function ompMemories(home) {
  const root = path.join(home, '.omp', 'agent', 'memories');
  const out = [];
  for (const enc of await readDir(root)) {
    if (!isVisibleDir(enc)) continue;
    for (const [file, editable] of [['learned.md', true], ['MEMORY.md', false], ['memory_summary.md', false]]) {
      const p = path.join(root, enc.name, file);
      out.push(asset(p, 'memory', 'omp', editable, `${enc.name}/${file}`, { project: enc.name }));
    }
  }
  return out;
}

/** Every skill, agent, command, context file and memory under `home`. Missing roots are skipped. */
export async function listAssets({ home = os.homedir() } = {}) {
  const h = (...p) => path.join(home, ...p);
  const groups = await Promise.all([
    skillDir(h('.claude', 'skills'), 'claude', true, ['synced']),
    (async () => {
      const out = [];
      for (const bucket of await readDir(h('.claude', 'skills', 'synced'))) {
        if (isVisibleDir(bucket)) out.push(...(await skillDir(h('.claude', 'skills', 'synced', bucket.name), 'synced', false)));
      }
      return out;
    })(),
    skillDir(h('.omp', 'agent', 'skills'), 'omp', true),
    skillDir(h('.agents', 'skills'), 'agents', true),
    skillDir(h('.codex', 'skills'), 'codex', true),
    skillDir(h('.codex', 'skills', '.system'), 'system', false),
    pluginCache(h('.claude', 'plugins', 'cache')),
    pluginCache(h('.codex', 'plugins', 'cache')),
    ompPluginCache(h('.omp', 'plugins', 'cache', 'plugins')),
    skillDir(h('.omp', 'agent', 'managed-skills'), 'managed', true),
    mdFiles(h('.claude', 'agents'), 'agent', 'claude'),
    mdFiles(h('.omp', 'agent', 'agents'), 'agent', 'omp'),
    mdFiles(h('.claude', 'commands'), 'command', 'claude', true),
    mdFiles(h('.omp', 'agent', 'commands'), 'command', 'omp'),
    mdFiles(h('.codex', 'prompts'), 'command', 'codex'),
    skillDir(h('.cursor', 'skills'), 'cursor', true),
    skillDir(h('.cursor', 'skills-cursor'), 'system', false),
    cursorPlugins(h('.cursor', 'plugins', 'local')),
    mdFiles(h('.cursor', 'agents'), 'agent', 'cursor'),
    mdFiles(h('.cursor', 'commands'), 'command', 'cursor'),
    mdFiles(h('.cursor', 'rules'), 'context', 'cursor', false, '.mdc'),
    [
      asset(h('.claude', 'CLAUDE.md'), 'context', 'claude', true, 'CLAUDE.md (claude)'),
      asset(h('.omp', 'agent', 'AGENTS.md'), 'context', 'omp', true, 'AGENTS.md (omp)'),
      asset(h('.codex', 'AGENTS.md'), 'context', 'codex', true, 'AGENTS.md (codex)'),
    ],
    claudeMemories(home),
    ompMemories(home),
  ]);
  const assets = (await Promise.all(groups.flat())).filter(Boolean);
  // Context files are always named after the CLI, never their frontmatter.
  for (const a of assets) if (a.kind === 'context') a.name = `${path.basename(a.path)} (${a.origin})`;
  return assets;
}
