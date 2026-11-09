// Workspace skill routing: one folder holding several git repos (and their worktrees). Finds repos without a
// workspace router skill, routers that miss repo skills, skill name collisions, skill files that never load,
// and sessions that worked in a repo without reading its router or repo skills.
//
// Only the workspace's direct child dirs and their known subpaths are read; git is never spawned.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localDay as day } from './analyze.mjs';
import { fitMarkdown, renderFinding } from './digest.mjs';
import { listAssets, parseFrontmatter } from './inventory.mjs';
import { expandHome, readDir } from './lines.mjs';
import { readEvents as readClaude } from './sources/claude.mjs';
import { readEvents as readCursor } from './sources/cursor.mjs';
import { readEvents as readOmp } from './sources/omp.mjs';
import { readDecisions, readLastWorkspace, writeLastWorkspace } from './state.mjs';
import { snippet } from './text.mjs';

// Codex records no file paths, so it cannot show which repo a session worked in.
const READERS = [readOmp, readClaude, readCursor];
const SKILL_ROOTS = ['.claude', '.agents', '.cursor', '.codex', '.omp'];
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md'];
const USER_ORIGINS = new Set(['claude', 'omp', 'agents', 'codex', 'cursor']);
const WORKTREE = `${path.sep}.git${path.sep}worktrees${path.sep}`;
const SKILL_FILE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/;
const DAY_MS = 86_400_000;
const MAX_EXAMPLES = 50;
const MISSED_RATE = 0.5;
// Findings of earlier scans stay in last-workspace.json (newest first, up to this many) so their ids still
// resolve in finding_examples and record_decision after a narrower scan.
const MAX_STORED = 2000;
const SECTIONS = [
  ['Router coverage', ['router_missing', 'router_stale']],
  ['Missed repo skills', ['missed_repo_skill']],
  ['Name collisions', ['name_collision']],
  ['Invalid layout', ['invalid_layout']],
];
const TYPE_ORDER = SECTIONS.flatMap(([, types]) => types);

const findingId = (type, key) => createHash('sha1').update(`${type}|${key}`).digest('hex').slice(0, 10);
/** Lowercase, alphanumerics only: the slug a router `repo-<slug>` is named after. */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);

async function stat(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

/**
 * Group root of a child dir from its `.git`: the dir itself for a `.git` dir; for a `.git` file
 * `gitdir: <X>` with X inside `<root>/.git/worktrees/`, that `<root>` (X is resolved to its physical path,
 * as `dir` is); null when there is no `.git`.
 */
async function gitRoot(dir) {
  const git = path.join(dir, '.git');
  let st;
  try {
    st = await fs.promises.lstat(git);
  } catch {
    return null;
  }
  if (st.isDirectory() || !st.isFile()) return dir;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(git, 'utf8'));
    if (!m) return dir;
    const target = path.resolve(dir, m[1].trim());
    const physical = await fs.promises.realpath(target).catch(() => target);
    const at = physical.indexOf(WORKTREE);
    return at > 0 ? physical.slice(0, at) : dir;
  } catch {
    return dir;
  }
}

async function readSkill(file, fallbackName, scope) {
  let text;
  let st;
  try {
    [text, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatter(text);
  const str = (v) => (typeof v === 'string' ? v : '');
  return { name: str(fm.name) || fallbackName, description: str(fm.description), text: `${str(fm.description)}\n${body}`, path: file, scope, mtimeMs: st.mtimeMs };
}

/**
 * Skills (`<dir>/<root>/skills/<n>/SKILL.md`), flat `.claude/skills/*.md` files and context files of one
 * checkout. `skills` has one entry per name, the first in SKILL_ROOTS order; `allSkills` has every copy.
 */
async function inventory(dir, scope) {
  const skills = [];
  for (const root of SKILL_ROOTS) {
    const skillsDir = path.join(dir, root, 'skills');
    for (const ent of await readDir(skillsDir)) {
      if (ent.name.startsWith('.') || !(ent.isDirectory() || ent.isSymbolicLink())) continue;
      skills.push(readSkill(path.join(skillsDir, ent.name, 'SKILL.md'), ent.name, scope));
    }
  }
  const flat = [];
  const flatDir = path.join(dir, '.claude', 'skills');
  for (const ent of await readDir(flatDir)) {
    if (ent.isFile() && ent.name.endsWith('.md')) flat.push(path.join(flatDir, ent.name));
  }
  const context = [];
  for (const name of CONTEXT_FILES) {
    const st = await stat(path.join(dir, name));
    if (st?.isFile()) context.push({ name, path: path.join(dir, name), mtimeMs: st.mtimeMs });
  }
  const flatStats = await Promise.all(flat.map(async (p) => ({ path: p, mtimeMs: (await stat(p))?.mtimeMs ?? 0 })));
  const allSkills = (await Promise.all(skills)).filter(Boolean);
  const seen = new Set();
  const unique = allSkills.filter((s) => !seen.has(s.name) && seen.add(s.name));
  return { skills: unique, allSkills, flat: flatStats, context };
}

/** Child repos of `ws`, grouped by main checkout: `{ count, groups }`. */
async function findGroups(ws) {
  const byRoot = new Map();
  let count = 0;
  for (const ent of await readDir(ws)) {
    if (ent.name.startsWith('.') || !ent.isDirectory()) continue;
    const dir = path.join(ws, ent.name);
    const root = await gitRoot(dir);
    if (!root) continue;
    count++;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(dir);
  }
  const groups = [];
  for (const [root, members] of byRoot) {
    let representative = members.includes(root) ? root : null;
    if (!representative) {
      const times = await Promise.all(members.map(async (m) => (await stat(m))?.mtimeMs ?? 0));
      representative = members[times.indexOf(Math.max(...times))];
    }
    groups.push({ name: path.basename(root), root, representative, members });
  }
  groups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { count, groups };
}

/** `./<dir>` (not followed by more of a name) or `` `<dir>` `` in the router's text. */
function mentionsDir(text, dir) {
  const d = escapeRe(dir);
  return new RegExp(`\\./${d}(?![\\w-]|\\.[\\w])`).test(text) || text.includes(`\`${dir}\``);
}

/** A whole-word mention of a skill name. */
const mentionsName = (text, name) => new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`).test(text);

/**
 * A workspace `repo-*` skill routes group G when its description names a member dir, or when its slug is
 * norm(G) and no other group has that norm (`OmnicasaWeb` and `omnicasa-web` would both claim one slug).
 * Body mentions do not count: routers often cite related repos there.
 */
const isRouterOf = (skill, g, slugUnique) =>
  skill.name.startsWith('repo-') &&
  ((slugUnique && norm(skill.name.slice('repo-'.length)) === norm(g.name)) ||
    g.members.some((m) => mentionsDir(skill.description, path.basename(m))));

const fileExample = (text, file, source, ts) => ({ text, ts, source, cwd: file });

function staticFinding(type, key, fields, examples) {
  const ts = examples.map((e) => e.ts);
  return { id: findingId(type, key), type, count: examples.length, sessions: 0, ...fields, examples, firstTs: minOf(ts), lastTs: maxOf(ts) };
}

/** router_missing, router_stale, name_collision and invalid_layout from the inventory. */
function staticFindings(ws, groups, wsInv, userSkills) {
  const findings = [];
  const wsName = path.basename(ws);
  for (const g of groups) {
    const { skills, context } = g.inventory;
    if (!g.routers.length) {
      if (!skills.length && !context.length) continue;
      findings.push(
        staticFinding(
          'router_missing',
          g.root,
          {
            hint: 'create_asset',
            title: `No workspace router for repo ${g.name} (${skills.length} repo skills, ${context.map((c) => c.name).join(', ') || 'no context file'})`,
            target: g.routerTarget,
            skillCount: skills.length,
            contextCount: context.length,
          },
          [
            ...skills.map((s) => fileExample(s.name, s.path, g.name, s.mtimeMs)),
            ...context.map((c) => fileExample(c.name, c.path, g.name, c.mtimeMs)),
          ],
        ),
      );
      continue;
    }
    for (const r of g.routers) {
      const missing = skills.filter((s) => !mentionsName(r.text, s.name));
      if (!missing.length) continue;
      findings.push(
        staticFinding(
          'router_stale',
          `${r.path}|${g.root}`,
          {
            hint: 'update_asset',
            title: `Router "${r.name}" does not list ${missing.length} repo skills of ${g.name}`,
            target: { kind: 'skill', name: r.name, path: r.path, editable: true },
          },
          missing.map((s) => fileExample(s.name, s.path, g.name, s.mtimeMs)),
        ),
      );
    }
  }

  // name_collision: the same skill name in two or more of user, workspace and each repo group.
  const byName = new Map();
  const add = (s, scope) => {
    if (!byName.has(s.name)) byName.set(s.name, new Map());
    const scopes = byName.get(s.name);
    if (!scopes.has(scope)) scopes.set(scope, []);
    scopes.get(scope).push(s);
  };
  for (const s of userSkills) add(s, 'user');
  for (const s of wsInv.allSkills) add(s, 'workspace');
  for (const g of groups) for (const s of g.inventory.allSkills) add(s, g.name);
  for (const [name, scopes] of byName) {
    if (scopes.size < 2) continue;
    const examples = [...scopes].flatMap(([scope, list]) => list.map((s) => fileExample(`${scope}: ${name}`, s.path, scope, s.mtimeMs)));
    findings.push({
      ...staticFinding('name_collision', name, { hint: 'merge_assets', title: `Skill "${name}" exists in ${scopes.size} scopes: ${[...scopes.keys()].join(', ')}` }, examples),
      count: scopes.size,
    });
  }

  // invalid_layout: flat .claude/skills/*.md files never load as skills.
  const layouts = [{ dir: ws, name: wsName, flat: wsInv.flat, editable: true }, ...groups.map((g) => ({ dir: g.representative, name: g.name, flat: g.inventory.flat, editable: false }))];
  for (const l of layouts) {
    if (!l.flat.length) continue;
    findings.push(
      staticFinding(
        'invalid_layout',
        l.dir,
        {
          hint: 'update_asset',
          title: `${l.flat.length} flat .md files in ${l.name}/.claude/skills never load as skills`,
          target: { kind: 'skill', name: l.name, path: path.join(l.dir, '.claude', 'skills'), editable: l.editable },
        },
        l.flat.map((f) => fileExample(path.basename(f.path), f.path, l.name, f.mtimeMs)),
      ),
    );
  }
  return findings;
}

/**
 * missed_repo_skill: root sessions, started anywhere, that touched a repo in the workspace but never read its
 * router or one of its repo skills. A session started inside a repo's checkout is skipped for that repo (its
 * skills load natively there) but counts for the other repos it touches. `outside` counts the missed sessions
 * started outside the workspace: no workspace skill loads there, so they need a rule in the user context file.
 */
function missedFindings(ws, groups, events, { minCount }) {
  const memberOf = new Map();
  for (const g of groups) for (const m of g.members) memberOf.set(m, g);
  const groupOfPath = (p) => {
    const rel = path.relative(ws, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return memberOf.get(path.join(ws, rel.split(path.sep)[0])) ?? null;
  };

  // Per root session: skills loaded by name (`skill://`, Skill tool, `/skill:`), every loaded skill name (for
  // workspace routers), and the groups whose own `skills/<n>/SKILL.md` was read or edited. A SKILL.md read by
  // path counts for a repo only inside that repo: a user or workspace copy of the same name is not its skill.
  const sessions = new Map();
  for (const ev of events) {
    const key = `${ev.source}:${ev.parentSessionId ?? ev.sessionId}`;
    let s = sessions.get(key);
    if (!s) {
      s = { key, cwd: null, anyCwd: null, prompt: null, touched: new Map(), named: new Set(), loaded: new Set(), repoSkillReads: new Set() };
      sessions.set(key, s);
    }
    if (!s.anyCwd && ev.cwd) s.anyCwd = ev.cwd;
    if (!ev.sub && !s.cwd && ev.cwd) s.cwd = ev.cwd;
    if (ev.kind === 'prompt' && !ev.sub && !s.prompt) s.prompt = ev;
    else if (ev.kind === 'skill') {
      const name = String(ev.name).split(':').pop();
      s.loaded.add(name);
      if (!ev.path) s.named.add(name);
    } else if (ev.kind === 'touch' && typeof ev.path === 'string') {
      const abs = path.isAbsolute(ev.path) ? ev.path : ev.cwd ? path.resolve(ev.cwd, ev.path) : null;
      if (!abs) continue;
      const g = groupOfPath(abs);
      if (!g) continue;
      if (!s.touched.has(g)) s.touched.set(g, ev.ts);
      if (SKILL_FILE.test(abs)) s.repoSkillReads.add(g);
    }
  }

  const perGroup = new Map();
  for (const s of sessions.values()) {
    if (!s.touched.size) continue;
    const cwd = s.cwd ?? s.anyCwd;
    const home = typeof cwd === 'string' ? groupOfPath(cwd) : null;
    const outside = !(typeof cwd === 'string' && inside(cwd, ws));
    for (const [g, touchTs] of s.touched) {
      if (g === home) continue;
      if (!perGroup.has(g)) perGroup.set(g, []);
      const covered =
        s.repoSkillReads.has(g) || g.routers.some((r) => s.loaded.has(r.name)) || g.inventory.skills.some((k) => s.named.has(k.name));
      const ts = s.prompt?.ts ?? touchTs;
      perGroup.get(g).push({ covered, outside, ts, example: { text: s.prompt?.text ?? '(no typed prompt)', ts, source: s.prompt?.source ?? s.key.split(':')[0], cwd } });
    }
  }

  const findings = [];
  for (const [g, list] of perGroup) {
    const missed = list.filter((x) => !x.covered).sort((a, b) => b.ts - a.ts);
    if (list.length < minCount || missed.length / list.length < MISSED_RATE) continue;
    const router = g.routers[0];
    const outside = missed.filter((x) => x.outside).length;
    findings.push({
      id: findingId('missed_repo_skill', g.root),
      type: 'missed_repo_skill',
      hint: missedHint(outside, router),
      title: `Repo ${g.name} worked on without its router or repo skills in ${missed.length} of ${list.length} sessions`,
      count: missed.length,
      triggerCount: list.length,
      rate: Math.round((missed.length / list.length) * 1000) / 1000,
      outside,
      sessions: missed.length,
      target: router ? { kind: 'skill', name: router.name, path: router.path, editable: true } : g.routerTarget,
      examples: missed.slice(0, MAX_EXAMPLES).map((x) => x.example),
      firstTs: missed.at(-1).ts,
      lastTs: missed[0].ts,
      // For decisions: an accepted finding reappears only with enough missed sessions after it.
      members: list.map(({ covered, outside: out, ts }) => ({ covered, outside: out, ts })),
      routed: Boolean(router),
    });
  }
  return findings;
}

/** add_rule when a missed session started outside the workspace (only a user rule reaches it), else the router fix. */
const missedHint = (outside, router) => (outside > 0 ? 'add_rule' : router ? 'update_asset' : 'create_asset');

/** Drop dismissed findings and accepted ones, except a missed_repo_skill with >= minCount missed sessions since. */
function applyDecisions(findings, decisions, minCount) {
  const kept = [];
  for (const f of findings) {
    const d = decisions[f.id];
    if (!d) {
      kept.push(f);
      continue;
    }
    if (d.status !== 'accepted' || f.type !== 'missed_repo_skill') continue;
    const after = f.members.filter((m) => m.ts > d.decidedAt);
    const missed = after.filter((m) => !m.covered);
    if (missed.length < minCount) continue;
    const examples = f.examples.filter((ex) => ex.ts > d.decidedAt);
    const outside = missed.filter((m) => m.outside).length;
    kept.push({
      ...f,
      count: missed.length,
      triggerCount: after.length,
      rate: Math.round((missed.length / after.length) * 1000) / 1000,
      outside,
      hint: missedHint(outside, f.routed),
      sessions: missed.length,
      examples,
      firstTs: minOf(missed.map((m) => m.ts)),
      lastTs: maxOf(missed.map((m) => m.ts)),
      reappeared: true,
      decidedAt: d.decidedAt,
    });
  }
  return kept;
}

/** Lowercase, each run of non-alphanumerics turned into `-`, no leading or trailing `-`. */
const kebab = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The router each group would get: `repo-<norm(G)>` when that skill dir does not exist and no other group
 * shares the norm; else `repo-<kebab(G)>`, with `-2`, `-3`, … appended until the dir does not exist and no
 * other group was given it. A proposed router never points at an existing file.
 */
async function assignRouterTargets(ws, groups, normCount) {
  const skillsDir = path.join(ws, '.claude', 'skills');
  const taken = new Set();
  const free = async (name) => !taken.has(name) && !(await stat(path.join(skillsDir, name)));
  for (const g of groups) {
    let name = `repo-${norm(g.name)}`;
    if (normCount.get(norm(g.name)) !== 1 || !(await free(name))) {
      const base = `repo-${kebab(g.name)}`;
      name = base;
      for (let n = 2; !(await free(name)); n++) name = `${base}-${n}`;
    }
    taken.add(name);
    g.routerTarget = { kind: 'skill', name, path: path.join(skillsDir, name, 'SKILL.md'), editable: true };
  }
}

/**
 * Scan one workspace folder: `{ workspace, window, groups, findings }`, also stored as last-workspace.json.
 * Throws `Not a workspace: …` when `path` holds fewer than 2 git repos. `maxStored` (tests only) caps the
 * findings kept in last-workspace.json.
 */
export async function scanWorkspace({
  home = os.homedir(),
  path: wsPath,
  sinceDays = 90,
  minCount = 3,
  nowMs = Date.now(),
  maxStored = MAX_STORED,
} = {}) {
  if (typeof wsPath !== 'string' || !wsPath) throw new Error('path is required');
  if (!(typeof sinceDays === 'number' && sinceDays > 0)) throw new Error('since_days must be a positive number');
  if (!(typeof minCount === 'number' && minCount > 0)) throw new Error('min_count must be a positive number');
  const given = path.resolve(expandHome(wsPath, home));
  const notWorkspace = (n) => new Error(`Not a workspace: ${given} has ${n} git repos (needs 2+)`);
  // Physical path: git `gitdir:` files and session cwds record physical paths (macOS /tmp → /private/tmp).
  let ws;
  try {
    ws = await fs.promises.realpath(given);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw notWorkspace(0);
    throw error;
  }
  const { count, groups } = await findGroups(ws);
  if (count < 2) throw notWorkspace(count);

  const sinceMs = nowMs - sinceDays * DAY_MS;
  const [wsInv, userSkills, decisions, inventories, ...perSource] = await Promise.all([
    inventory(ws, 'workspace'),
    listAssets({ home }).then((assets) => assets.filter((a) => a.kind === 'skill' && USER_ORIGINS.has(a.origin))),
    readDecisions(home),
    Promise.all(groups.map((g) => inventory(g.representative, g.name))),
    ...READERS.map((read) => read({ home, sinceMs })),
  ]);
  const routers = wsInv.skills.filter((s) => s.name.startsWith('repo-'));
  const normCount = new Map();
  for (const g of groups) normCount.set(norm(g.name), (normCount.get(norm(g.name)) ?? 0) + 1);
  for (const [i, g] of groups.entries()) {
    g.inventory = inventories[i];
    g.routers = routers.filter((r) => isRouterOf(r, g, normCount.get(norm(g.name)) === 1));
  }
  await assignRouterTargets(ws, groups, normCount);
  const events = perSource
    .flatMap((r) => r.events)
    .filter((ev) => ev.ts <= nowMs && (ev.kind === 'prompt' || ev.kind === 'skill' || ev.kind === 'touch'));

  const all = [...staticFindings(ws, groups, wsInv, userSkills), ...missedFindings(ws, groups, events, { minCount })];
  const score = (f) => f.count;
  const findings = applyDecisions(all, decisions, minCount)
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || score(b) - score(a) || (a.title < b.title ? -1 : 1))
    .map(({ members, routed, ...f }) => f);

  const result = {
    workspace: ws,
    window: { sinceMs, untilMs: nowMs },
    groups: groups.map((g) => ({
      name: g.name,
      root: g.root,
      representative: g.representative,
      members: g.members,
      skills: g.inventory.skills.map((s) => s.name),
      context: g.inventory.context.map((c) => c.name),
      flat: g.inventory.flat.map((f) => path.basename(f.path)),
      routers: g.routers.map((r) => r.name),
    })),
    workspaceSkills: wsInv.skills.map((s) => s.name),
    findings,
  };
  const previous = (await readLastWorkspace(home))?.findings ?? [];
  const ids = new Set(findings.map((f) => f.id));
  const stored = [...findings, ...previous.filter((f) => !ids.has(f.id))].slice(0, Math.max(maxStored, findings.length));
  await writeLastWorkspace(home, { ...result, findings: stored });
  return result;
}

// ---- output ----

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const list = (names, max) => (names.length ? `${names.length}: ${snippet(names.join(', '), max)}` : '0');

function render(result, findings, examples) {
  const out = ['# Workspace skill routing', ''];
  out.push(`Workspace: ${result.workspace}`);
  out.push(`Window: ${day(result.window.sinceMs)} → ${day(result.window.untilMs)}`);
  out.push(`${result.groups.length} repo groups, ${result.groups.reduce((n, g) => n + g.members.length, 0)} checkouts, ${result.workspaceSkills.length} workspace skills`);
  out.push('', '## Repos', '');
  out.push('| group | members | skills | context | routers |', '|---|---|---|---|---|');
  for (const g of result.groups) {
    out.push(`| ${[g.name, list(g.members.map((m) => path.basename(m)), 60), list(g.skills, 80), g.context.join(', ') || '-', g.routers.join(', ') || '-'].map(cell).join(' | ')} |`);
  }
  let shown = 0;
  for (const [title, types] of SECTIONS) {
    const mine = findings.filter((f) => types.includes(f.type));
    shown += mine.length;
    out.push('', `## ${title}`, '', mine.length ? mine.map((f) => renderFinding(f, examples)).join('\n\n') : '_None._');
  }
  const omitted = result.findings.length - shown;
  if (omitted > 0) out.push('', `(${omitted} findings omitted; use finding_examples or --json)`);
  return `${out.join('\n')}\n`;
}

/** Markdown scan, at most 40 000 characters (truncated like the digest). */
export const renderWorkspace = (result) => fitMarkdown((findings, examples) => render(result, findings, examples), result.findings);

/** JSON for tools and the CLI: every finding, at most 3 examples each. */
export const workspaceJson = (result) =>
  JSON.stringify({ ...result, findings: result.findings.map((f) => ({ ...f, examples: f.examples.slice(0, 3) })) }, null, 1);
