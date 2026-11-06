// Skill-standards rubric (rea-analysis-optimization): scores editable skills, agents and commands.
// Thresholds are the constants below; change them to tune the rubric.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './inventory.mjs';

const MAX_LINES = 500;
const MAX_WORDS = 5000;
const DESC_MIN = 40;
const DESC_MAX = 1024;
const TRIGGER = /\b(use (it |this )?(when(ever)?|for|to)|when(ever)? the user|when(ever)? (you|i) |triggers?)\b/i;
const BOUNDARY = /\b(not for|do not use|don'?t use|belongs to|instead,? use|use .{1,40} instead|read-only)\b/i;
const DONE = /\b(verify|verification|acceptance|done when|definition of done|check that)\b/i;
const CLAIMS = /\b(\d+(\.\d+)?x (faster|cheaper|smaller)|guarantee[sd]?|always (works|faster))\b/i;
// Markdown link `[text](target "title")`; images too.
const LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/g;
// `references/…` paths mentioned anywhere in the body (code spans included), not inside another dir's path.
const REFERENCE = /(?<![\w./-])(?:\.\/)?(references\/[\w/.-]*\w)/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /``[^\n]*?``|`[^`\n]*`/g;
const AUDITED = ['skill', 'agent', 'command'];

/** Body without fenced code blocks and inline code spans: links shown there are examples, not links. */
function proseOf(body) {
  const out = [];
  let fence = null;
  for (const line of body.split('\n')) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) fence = m[1];
    else out.push(line.replace(CODE_SPAN, ''));
  }
  return out.join('\n');
}

const exists = (p) => fs.promises.access(p).then(() => true, () => false);

async function listFiles(dir, prefix = '') {
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out;
}

/** Relative markdown link targets outside code, decoded; scheme, absolute, `~` and `#` targets are dropped. */
function relativeLinks(text) {
  const out = [];
  for (const m of proseOf(text).matchAll(LINK)) {
    let t = m[1].replace(/[#?].*$/, '');
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(m[1]) || t.startsWith('/') || t.startsWith('~')) continue;
    try {
      t = decodeURI(t);
    } catch {
      // keep the raw target
    }
    out.push(t);
  }
  return out;
}

/**
 * Files under `<dir>/references/` that SKILL.md cannot reach. A file is reached when SKILL.md mentions
 * `references/<file>` or links to it, or when an already reached reference file does.
 */
async function unreachableReferences(dir, body) {
  const refDir = path.join(dir, 'references');
  const pending = new Set(await listFiles(refDir));
  const queue = [];
  const reach = (text, fromDir) => {
    const linked = new Set(relativeLinks(text).map((t) => path.relative(refDir, path.resolve(fromDir, t)).split(path.sep).join('/')));
    for (const rel of pending) {
      if (!text.includes(`references/${rel}`) && !linked.has(rel)) continue;
      pending.delete(rel);
      queue.push(rel);
    }
  };
  reach(body, dir);
  while (queue.length && pending.size) {
    const file = path.join(refDir, queue.shift());
    try {
      reach(await fs.promises.readFile(file, 'utf8'), path.dirname(file));
    } catch {
      // unreadable reference file: it reaches nothing
    }
  }
  return [...pending];
}

/** Relative link targets and `references/…` mentions that do not exist, plus (skills) unreachable reference files. */
async function linkProblems(file, kind, body) {
  const dir = path.dirname(file);
  const targets = new Set(relativeLinks(body));
  for (const m of body.matchAll(REFERENCE)) targets.add(m[1]);
  const problems = [];
  for (const t of targets) if (!(await exists(path.resolve(dir, t)))) problems.push(`missing ${t}`);
  if (kind === 'skill') for (const rel of await unreachableReferences(dir, body)) problems.push(`unreferenced references/${rel}`);
  return problems;
}

async function audit(file, kind, text, name) {
  const { fm, body } = parseFrontmatter(text);
  const desc = typeof fm.description === 'string' ? fm.description.trim() : '';
  const dirName = path.basename(path.dirname(file));
  const checks = [];
  const check = (id, severity, failedDetail) => checks.push({ id, severity, detail: failedDetail });

  const fmProblems = [];
  if (!desc) fmProblems.push('no description');
  if (kind === 'skill') {
    if (typeof fm.name !== 'string' || !fm.name) fmProblems.push('no name');
    else if (fm.name !== dirName) fmProblems.push(`name "${fm.name}" differs from its directory "${dirName}"`);
  }
  check('frontmatter', 'major', fmProblems.length ? fmProblems.join('; ') : null);

  const triggerProblems = [];
  if (desc.length < DESC_MIN || desc.length > DESC_MAX) triggerProblems.push(`description is ${desc.length} chars (${DESC_MIN}–${DESC_MAX})`);
  if (!TRIGGER.test(desc)) triggerProblems.push('description says nothing like "Use when …"');
  check('trigger', 'major', triggerProblems.length ? triggerProblems.join('; ') : null);

  const lines = body.split('\n').length;
  const words = body.split(/\s+/).filter(Boolean).length;
  check(
    'size',
    'major',
    lines > MAX_LINES || words > MAX_WORDS
      ? `body has ${lines} lines and ${words} words (limit ${MAX_LINES} / ${MAX_WORDS}); move detail into references/<topic>.md`
      : null,
  );

  const links = await linkProblems(file, kind, body);
  check('links', 'major', links.length ? links.join('; ') : null);

  check('boundary', 'minor', BOUNDARY.test(desc) || BOUNDARY.test(body) ? null : 'no non-goal such as "Not for …" or "use … instead"');
  check('done', 'minor', DONE.test(body) ? null : 'no done criteria such as "## Done when" or "Verify …"');
  const claim = CLAIMS.exec(body);
  check('claims', 'minor', claim ? `unmeasured claim: ${claim[0]}` : null);
  if (kind === 'agent') check('tools', 'minor', fm.tools ? null : 'frontmatter has no tools list');

  const failed = checks.filter((c) => c.detail);
  return {
    path: file,
    kind,
    name: name ?? (typeof fm.name === 'string' && fm.name ? fm.name : kind === 'skill' ? dirName : path.basename(file, path.extname(file))),
    score: Math.round((100 * (checks.length - failed.length)) / checks.length),
    failed,
  };
}

const inferKind = (file) => (path.basename(file) === 'SKILL.md' ? 'skill' : file.split(path.sep).includes('agents') ? 'agent' : 'command');

/** Audit one file (`~` expands to the home dir); `kind` is inferred from the path when omitted. Throws `File not found: <path>`. */
export async function auditFile(file, kind) {
  const abs = path.resolve(file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file);
  let text;
  try {
    text = await fs.promises.readFile(abs, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error(`File not found: ${file}`);
    throw error;
  }
  return audit(abs, kind ?? inferKind(abs), text);
}

/** Audits of every editable skill, agent and command; unreadable files are skipped. */
export async function auditAssets(assets) {
  const audits = await Promise.all(
    assets
      .filter((a) => a.editable && AUDITED.includes(a.kind))
      .map(async (a) => {
        try {
          return await audit(a.path, a.kind, await fs.promises.readFile(a.path, 'utf8'), a.name);
        } catch {
          return null;
        }
      }),
  );
  return audits.filter(Boolean);
}

/** `score <n>/100` and one line per failed check, or `all checks pass`. */
export const formatAudit = (audit) =>
  [`score ${audit.score}/100`, ...(audit.failed.length ? audit.failed.map((f) => `${f.id} (${f.severity}): ${f.detail}`) : ['all checks pass'])].join('\n');
