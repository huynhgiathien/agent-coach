// Inventory of skills, agents, commands, context files and memories across Claude Code, omp, Codex and Cursor.

import { createHash } from 'node:crypto';
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
    // Project copies of one file in several clones are collapsed by content in lib/analyze.mjs.
    ...(origin === 'project' ? { hash: createHash('sha1').update(text).digest('hex') } : {}),
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

/**
 * Each project dir plus its ancestors, up to but excluding `home` (or the filesystem root for dirs outside
 * `home`), once each.
 */
function projectRoots(home, projectDirs) {
  const top = path.resolve(home);
  const roots = new Set();
  for (const cwd of projectDirs) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
    for (let d = path.resolve(cwd); d !== top && d !== path.dirname(d); d = path.dirname(d)) roots.add(d);
  }
  return [...roots];
}

const readText = (p) => fs.promises.readFile(p, 'utf8').catch(() => null);

/** `url` of `[remote "origin"]` in a git config file's text, or null. */
function originUrl(config) {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inOrigin = /^\s*\[\s*remote\s+"origin"\s*\]/.test(line);
      continue;
    }
    const m = inOrigin && /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1]) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/**
 * A git remote URL as `host/path`: no scheme, user or port, no `.git` suffix, host lowercased, so the https
 * and ssh URLs of one repo are equal. A local origin (a path or `file://` URL) is resolved against `base`,
 * the main worktree (or bare repo) it belongs to.
 */
export function normalizeRemote(url, base = '/') {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?\/+(.*)$/i.exec(u);
  if (full) return `${full[1].toLowerCase()}/${full[2]}`;
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)\/*(.*)$/.exec(u);
  if (scp && scp[1].length > 1) return `${scp[1].toLowerCase()}/${scp[2]}`;
  return path.resolve(base, u.replace(/^file:\/\//i, ''));
}

/**
 * Identity of the repo holding project dir `dir`, read from git's files (no `git` process): `id` is the
 * normalized origin URL, else the main worktree's path (no remote), else `dir` (not a git repo); `root` is
 * the worktree top (`dir` outside git). Clones and worktrees of one repo share `id`.
 */
async function repoIdentity(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    const st = await fs.promises.stat(dotGit).catch(() => null);
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? '');
        if (!m) return { id: dir, root: dir };
        gitDir = path.resolve(d, m[1]);
      }
      const common = await readText(path.join(gitDir, 'commondir'));
      const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
      // The main worktree holds `.git`; a bare repo (several can share one folder) is its own dir.
      const main = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
      const url = originUrl((await readText(path.join(commonDir, 'config'))) ?? '');
      return { id: url ? normalizeRemote(url, main) : main, root: d };
    }
    if (path.dirname(d) === d) return { id: dir, root: dir };
  }
}

/** Project-level skills, agents and commands under one dir: editable, origin `project`, with `repoId`/`repoRoot`. */
async function projectAssets(dir) {
  const lists = await Promise.all([
    skillDir(path.join(dir, '.claude', 'skills'), 'project', true),
    mdFiles(path.join(dir, '.claude', 'agents'), 'agent', 'project'),
    mdFiles(path.join(dir, '.claude', 'commands'), 'command', 'project', true),
    skillDir(path.join(dir, '.agents', 'skills'), 'project', true),
  ]);
  const assets = (await Promise.all(lists.flat())).filter(Boolean);
  if (!assets.length) return assets;
  const { id, root } = await repoIdentity(dir);
  for (const a of assets) Object.assign(a, { repoId: id, repoRoot: root });
  return assets;
}

/**
 * Every skill, agent, command, context file and memory under `home`, plus the project assets of
 * `projectDirs` (session cwds) and of their ancestors below `home`. Missing roots are skipped. A file reached
 * through several paths (symlinks) is listed once, under the first path scanned (home roots before projects).
 */
export async function listAssets({ home = os.homedir(), projectDirs = [] } = {}) {
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
    ...projectRoots(home, projectDirs).map(projectAssets),
  ]);
  const found = (await Promise.all(groups.flat())).filter(Boolean);
  const reals = await Promise.all(found.map((a) => fs.promises.realpath(a.path).catch(() => a.path)));
  const seen = new Set();
  const assets = found.filter((_, i) => !seen.has(reals[i]) && seen.add(reals[i]));
  // Context files are always named after the CLI, never their frontmatter.
  for (const a of assets) if (a.kind === 'context') a.name = `${path.basename(a.path)} (${a.origin})`;
  return assets;
}
