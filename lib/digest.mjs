// Digest: run readers + inventory + standards audit + analysis, persist it, and render it as markdown or tab-separated lines.

import os from 'node:os';
import { analyze, cacheWriteShare, costBasis, localDay as day, usageFor } from './analyze.mjs';
import { listAssets } from './inventory.mjs';
import { readEvents as readClaude } from './sources/claude.mjs';
import { readEvents as readCodex } from './sources/codex.mjs';
import { readEvents as readCursor } from './sources/cursor.mjs';
import { readEvents as readOmp } from './sources/omp.mjs';
import { auditAssets } from './standards.mjs';
import { readDecisions, writeLastDigest } from './state.mjs';
import { snippet } from './text.mjs';

const READERS = { omp: readOmp, claude: readClaude, codex: readCodex, cursor: readCursor };
export const SOURCES = Object.keys(READERS);
const DAY_MS = 86_400_000;
const MAX_CHARS = 40_000;

/** Read sessions and assets, audit the assets, analyze, store the full digest as last-digest.json and return it. */
export async function buildDigest({
  home = os.homedir(),
  sinceDays = 90,
  sources = SOURCES,
  minCount = 3,
  includeDecided = false,
  nowMs = Date.now(),
} = {}) {
  for (const s of sources) if (!READERS[s]) throw new Error(`Unknown source ${s}; use ${SOURCES.join(', ')}`);
  // Shared by the MCP tool and the CLI: a non-positive or NaN window would silently yield an empty digest.
  if (!(typeof sinceDays === 'number' && sinceDays > 0)) throw new Error('since_days must be a positive number');
  if (!(typeof minCount === 'number' && minCount > 0)) throw new Error('min_count must be a positive number');
  const sinceMs = nowMs - sinceDays * DAY_MS;
  const [{ assets, audits }, decisions, ...perSource] = await Promise.all([
    listAssets({ home }).then(async (assets) => ({ assets, audits: await auditAssets(assets) })),
    readDecisions(home),
    ...sources.map((s) => READERS[s]({ home, sinceMs })),
  ]);
  const events = perSource.flatMap((r) => r.events);
  const warnings = perSource.flatMap((r) => r.warnings);
  const digest = analyze(events, assets, { minCount, decisions, sinceMs, nowMs, includeDecided, audits, warnings, sources });
  await writeLastDigest(home, digest);
  return digest;
}

// ---- formatting helpers (shared with lib/dashboard.mjs) ----

const pad = (n) => String(n).padStart(2, '0');
const minute = (ms) => {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const money = (usd) => `$${(usd ?? 0).toFixed(2)}`;
export const cost = (t) => `${money(t.costUsd)}${t.unpriced ? ` (+${t.unpriced} unpriced)` : ''}`;
/**
 * A source's cost with its basis label: `$12.34 (recorded)`. Unpriced sources (tokens only) never show a dollar
 * figure: `unpriced (N usage events)`.
 */
export function sourceCost(source, t) {
  const basis = costBasis[source] ?? 'unpriced';
  if (!t) return `no usage (${basis})`;
  if (basis === 'unpriced' && !t.costUsd) return `unpriced (${t.unpriced} usage events)`;
  return `${money(t.costUsd)} (${basis})${t.unpriced ? ` (+${t.unpriced} unpriced)` : ''}`;
}
export const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
export function num(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
/** Impact metric value: rate as %, perWeek per week, costPerUse in dollars; `–` when not measurable. */
export function metricValue(metric, v) {
  if (v === null || v === undefined) return '–';
  if (metric === 'rate') return pct(v);
  if (metric === 'perWeek') return `${v}/week`;
  if (metric === 'costPerUse') return money(v);
  return String(v);
}
/** Sources present in the window: those with sessions, then those with only usage (subagent runs). */
export const sourcesOf = (digest) => [...new Set([...Object.keys(digest.totals), ...Object.keys(digest.cost.bySource)])];
export const COST_BASIS_NOTE =
  'Cost basis: omp recorded per message; claude allocated from each session’s recorded total; codex and cursor record tokens only (unpriced, never converted to dollars). Cost per run or use counts only runs and uses with a priced usage event.';
/** Cost per priced run/use of a byAgent/bySkill row; `–` when none was priced. */
export const perPriced = (t) => (t.priced ? money(t.costUsd / t.priced) : '–');

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const table = (head, rows) =>
  rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)] : ['_None._'];

/** One-line evidence of a finding: counts, rate, range. */
export function evidence(f) {
  const range = `${day(f.firstTs)} → ${day(f.lastTs)}`;
  switch (f.type) {
    case 'follow_up':
      return `${f.count} times in ${f.sessions} sessions, rate ${pct(f.rate)} (${f.occurrences}/${f.triggerCount} triggers), ${range}`;
    case 'repeated_prompt':
      return `${f.count} times in ${f.sessions} sessions, ${range}`;
    case 'costly_asset':
      return `${f.count} uses in ${f.sessions} sessions, ${money(f.costUsd)} total, ${money(f.perUse)} per use vs ${money(f.baseline)} median, cache hit ${pct(f.hitRate)}, cache-write share ${pct(f.cacheWriteShare)}, ${range}`;
    case 'memory_promotion':
      return `${f.count} memories in ${f.sessions} projects`;
    case 'standard_violation':
      return `score ${f.score}/100, ${f.count} failed checks`;
    default:
      return `${f.count} files`;
  }
}

function renderFinding(f, examples) {
  const lines = [`### [${f.id}] ${f.title}`, `- hint: ${f.hint}${f.correction ? ' (correction)' : ''}${f.reappeared ? ' (reappeared after an accepted change)' : ''}`];
  lines.push(`- evidence: ${evidence(f)}`);
  if (f.target) lines.push(`- target: ${f.target.path} (${f.target.editable ? 'editable' : 'read-only'})`);
  if (f.type === 'standard_violation') {
    lines.push('- failed checks:', ...f.examples.map((ex) => `  - ${snippet(ex.text, 200)}`));
    return lines.join('\n');
  }
  const assetList = f.type === 'overlapping_assets' || f.type === 'memory_promotion';
  const shown = f.examples.slice(0, assetList ? 10 : examples);
  if (shown.length) lines.push(assetList ? '- files:' : '- examples:');
  for (const ex of shown) {
    if (assetList) {
      lines.push(`  - ${ex.cwd} (${ex.source}): ${snippet(ex.text, 160)}`);
    } else {
      const ctx = ex.context ? `, ${f.type === 'follow_up' ? 'after: ' : ''}${snippet(ex.context, 80)}` : '';
      lines.push(`  - "${snippet(ex.text, 160)}" (${ex.source}, ${day(ex.ts)}${ctx})`);
    }
  }
  return lines.join('\n');
}

function render(digest, findings, examples) {
  const out = [];
  let shown = 0;
  const of = (type) => findings.filter((f) => f.type === type);
  const section = (type, limit) => {
    const list = of(type).slice(0, limit);
    shown += list.length;
    return list.length ? [list.map((f) => renderFinding(f, examples)).join('\n\n')] : ['_None._'];
  };
  const { window, totals, cost: c, memory, usage, impact = [], standards = [], warnings = [] } = digest;

  out.push(`# Agent usage digest`, '');
  out.push(`Window: ${day(window.sinceMs)} → ${day(window.untilMs)}`);
  if (digest.filter?.name) out.push(`Filter: findings whose trigger or target is named "${digest.filter.name}"`);
  const sources = sourcesOf(digest);
  out.push(
    sources.length
      ? sources
          .map((s) => {
            const t = totals[s] ?? { sessions: 0, prompts: 0 };
            const u = c.bySource[s];
            return `- ${s}: ${t.sessions} sessions, ${t.prompts} prompts, ${sourceCost(s, u)}${u ? `, cache hit ${pct(u.hitRate)}` : ''}`;
          })
          .join('\n')
      : '- no sessions in the window',
  );
  if (warnings.length) out.push('', ...warnings.map((w) => `> ⚠ ${w}`));

  if (impact.length) {
    out.push('', '## Impact of accepted changes', '');
    out.push(
      ...table(
        ['id', 'change', 'metric', 'before → after', 'samples', 'verdict'],
        impact.map((r) => [r.id, snippet(r.title, 80), r.metric, `${metricValue(r.metric, r.before)} → ${metricValue(r.metric, r.after)}`, r.samples, r.verdict]),
      ),
    );
  }

  out.push('', '## Follow-up patterns', '', ...section('follow_up', 15));
  out.push('', '## Repeated prompts', '', ...section('repeated_prompt', 15));

  out.push('', '## Cost & cache', '', COST_BASIS_NOTE, '', '### By source', '');
  out.push(
    ...table(
      ['source', 'cost', 'input', 'output', 'cache read', 'cache write', 'hit rate'],
      Object.entries(c.bySource).map(([s, t]) => [s, sourceCost(s, t), num(t.input), num(t.output), num(t.cacheRead), num(t.cacheWrite), pct(t.hitRate)]),
    ),
  );
  out.push('', '### Top models', '');
  out.push(
    ...table(
      ['model', 'cost', 'input', 'output', 'cache read', 'cache write', 'hit rate'],
      c.byModel.slice(0, 10).map((t) => [t.model, cost(t), num(t.input), num(t.output), num(t.cacheRead), num(t.cacheWrite), pct(t.hitRate)]),
    ),
  );
  out.push('', '### Top agents (subagent runs)', '');
  out.push(
    ...table(
      ['agent', 'runs', 'cost', 'cost/run', 'hit rate', 'cache-write share'],
      c.byAgent.slice(0, 10).map((t) => [t.name, t.runs, cost(t), perPriced(t), pct(t.hitRate), pct(cacheWriteShare(t))]),
    ),
  );
  out.push('', '### Top skills (turns that used the skill)', '');
  out.push(
    ...table(
      ['skill', 'uses', 'cost', 'cost/use', 'hit rate'],
      c.bySkill.slice(0, 10).map((t) => [t.name, t.uses, cost(t), perPriced(t), pct(t.hitRate)]),
    ),
  );
  out.push('', '### Top sessions', '');
  out.push(
    ...table(
      ['source', 'session', 'cwd', 'cost', 'hit rate', 'first prompt'],
      c.topSessions.slice(0, 10).map((t) => [t.source, t.sessionId, t.cwd ?? '-', sourceCost(t.source, t), pct(t.hitRate), snippet(t.firstPrompt, 80)]),
    ),
  );
  out.push('', '### Costly assets', '', ...section('costly_asset', Infinity));

  out.push('', '## Memory', '');
  out.push(
    ...table(
      ['project', 'origin', 'memories', 'types'],
      memory.byProject.map((p) => [p.project, p.origin, p.count, Object.entries(p.types).map(([k, v]) => `${k} ${v}`).join(', ')]),
    ),
  );
  const total = memory.byProject.reduce((s, p) => s + p.count, 0);
  if (total) out.push('', `${total} memories in ${memory.byProject.length} projects.`);
  out.push('', '### Promotion candidates', '', ...section('memory_promotion', Infinity));

  out.push('', '## Skill standards', '');
  out.push(
    ...table(
      ['score', 'kind', 'name', 'failed checks'],
      [...standards]
        .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, 10)
        .map((a) => [a.score, a.kind, a.name, a.failed.map((f) => `${f.id} (${f.severity})`).join(', ') || '-']),
    ),
  );
  out.push('', ...section('standard_violation', 15));

  out.push('', '## Overlapping assets', '', ...section('overlapping_assets', 20));

  out.push('', '## Unused assets', '');
  const unused = of('unused_asset').slice(0, 30);
  shown += unused.length;
  out.push(
    ...(unused.length
      ? unused.map((f) => `- [${f.id}] ${f.target.kind} "${f.target.name}": ${f.target.path} (modified ${day(f.lastTs)})`)
      : ['_None._']),
  );

  out.push('', '## Usage', '');
  out.push(...table(['kind', 'name', 'uses', 'last used'], usage.slice(0, 20).map((u) => [u.kind, u.name, u.uses, day(u.lastTs)])));

  const omitted = digest.findings.length - shown;
  if (omitted > 0) out.push('', `(${omitted} findings omitted; use finding_examples or --json)`);
  return `${out.join('\n')}\n`;
}

/**
 * Only the findings whose trigger or target is named `name` (the full digest is what last-digest.json keeps,
 * so finding_examples works for any id). Returns the digest unchanged when `name` is empty.
 */
export function filterDigest(digest, name) {
  if (!name) return digest;
  const findings = digest.findings.filter((f) => f.trigger?.name === name || f.target?.name === name);
  return { ...digest, filter: { name }, findings };
}

/** Digest as JSON for tools and the CLI: every finding, at most 3 examples each. */
export const digestJson = (digest) =>
  JSON.stringify({ ...digest, findings: digest.findings.map((f) => ({ ...f, examples: f.examples.slice(0, 3) })) }, null, 1);

/** Markdown digest, at most 40 000 characters. */
export function renderMarkdown(digest) {
  const all = digest.findings;
  let text = render(digest, all, 3);
  if (text.length <= MAX_CHARS) return text;
  text = render(digest, all, 1);
  if (text.length <= MAX_CHARS) return text;
  // Drop the lowest-ranked findings until it fits.
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (render(digest, all.slice(0, mid), 1).length <= MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  text = render(digest, all.slice(0, lo), 1);
  if (text.length <= MAX_CHARS) return text;
  const tail = `\n(${all.length} findings omitted; use finding_examples or --json)\n`;
  return text.slice(0, MAX_CHARS - tail.length) + tail;
}

// ---- assets / examples ----

const KIND_ORDER = ['skill', 'agent', 'command', 'context', 'memory'];

/** One tab-separated line per asset: kind, name, origin, editable, uses, lastUsed, path[, project, memoryType]. */
export function formatAssets(assets, lastDigest) {
  const uses = new Map((lastDigest?.usage ?? []).map((u) => [`${u.kind}:${u.name}`, u]));
  const lines = [];
  if (!lastDigest) lines.push('No usage data yet; run usage_digest first.');
  lines.push('# kind\tname\torigin\teditable\tuses\tlastUsed\tpath\t[project\tmemoryType]');
  const sorted = [...assets].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.path < b.path ? -1 : 1),
  );
  for (const a of sorted) {
    const tracked = lastDigest && ['skill', 'agent', 'command'].includes(a.kind);
    const u = tracked ? usageFor(uses, a) : null;
    const cols = [a.kind, a.name, a.origin, a.editable ? 'editable' : 'read-only', u ? u.uses : '-', u?.lastTs ? day(u.lastTs) : '-', a.path];
    if (a.kind === 'memory') cols.push(a.project ?? '-', a.memoryType ?? '-');
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}

/** Stored examples of one finding: `YYYY-MM-DD HH:mm\tsource\tcwd\ttext[\tafter: context]`. */
export function formatExamples(lastDigest, id, limit = 20) {
  if (!lastDigest) throw new Error('No digest yet. Run usage_digest first.');
  const f = lastDigest.findings.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown finding ${id}. Run usage_digest again.`);
  return f.examples
    .slice(0, limit)
    .map((ex) => `${minute(ex.ts)}\t${ex.source}\t${ex.cwd ?? '-'}\t${snippet(ex.text, 300)}${ex.context ? `\tafter: ${ex.context}` : ''}`)
    .join('\n');
}
