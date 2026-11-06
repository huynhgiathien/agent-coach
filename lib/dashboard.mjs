// Self-contained HTML dashboard of a digest: one file, inline CSS and SVG, no script, no external resources.
// Every digest-derived string goes through esc().

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TYPE_ORDER, cacheWriteShare, localDay as day } from './analyze.mjs';
import { COST_BASIS_NOTE, cost, evidence, metricValue, money, num, pct, perPriced, sourceCost, sourcesOf } from './digest.mjs';
import { coachDir } from './state.mjs';
import { snippet } from './text.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape `& < > " '`. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const TYPE_TITLES = {
  follow_up: 'Follow-up patterns',
  repeated_prompt: 'Repeated prompts',
  costly_asset: 'Costly assets',
  memory_promotion: 'Memory promotion candidates',
  standard_violation: 'Skill standard violations',
  overlapping_assets: 'Overlapping assets',
  unused_asset: 'Unused assets',
};

const STYLE = `
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --card:#f5f5f7; --line:#d2d2d7; --bar:#0a84ff; --cost:#ff9f0a;
  --good:#1f8f3a; --bad:#c62828; --warn:#a15c00; --neutral:#6e6e73; }
@media (prefers-color-scheme: dark) { :root { --bg:#121214; --fg:#f2f2f7; --muted:#a1a1a6; --card:#1e1e22; --line:#3a3a3f;
  --bar:#409cff; --cost:#ffb340; --good:#4cd964; --bad:#ff6961; --warn:#ffcc66; --neutral:#a1a1a6; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 32px 64px; background:var(--bg); color:var(--fg);
  font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { margin:0 0 4px; font-size:24px; } h2 { margin:32px 0 12px; font-size:19px; border-bottom:1px solid var(--line); padding-bottom:6px; }
h3 { margin:20px 0 8px; font-size:15px; } .muted { color:var(--muted); }
nav a { color:var(--bar); margin-right:12px; text-decoration:none; }
.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; }
.card { background:var(--card); border-radius:10px; padding:12px 14px; }
.card .big { font-size:20px; font-weight:600; }
.warn { background:var(--card); border-left:4px solid var(--warn); padding:8px 12px; margin:6px 0; }
table { border-collapse:collapse; width:100%; margin:6px 0 12px; font-size:13px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; } td.n { text-align:right; font-variant-numeric:tabular-nums; }
.badge { display:inline-block; padding:1px 7px; border-radius:9px; font-size:12px; border:1px solid currentColor; }
.improved { color:var(--good); } .worse { color:var(--bad); } .no_change, .insufficient_data, .read-only { color:var(--neutral); }
.editable { color:var(--good); }
.finding { background:var(--card); border-radius:10px; padding:10px 14px; margin:8px 0; }
.finding .id { font-family:ui-monospace, Menlo, monospace; color:var(--muted); margin-right:6px; }
.finding .title { font-weight:600; } .finding ul { margin:6px 0 0; padding-left:18px; }
code, .path { font-family:ui-monospace, Menlo, monospace; font-size:12px; word-break:break-all; }
details summary { cursor:pointer; color:var(--muted); margin-top:4px; }
svg { max-width:100%; height:auto; } svg text { fill:var(--muted); font-size:11px; }
svg .bar { fill:var(--bar); } svg .cost { fill:none; stroke:var(--cost); stroke-width:2; } svg .axis { stroke:var(--line); }
svg .model { fill:var(--cost); }
`;

const tableHtml = (head, rows, numeric = []) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">None.</p>';

/** Every local day from `sinceMs` to `untilMs`, inclusive. */
function daysBetween(sinceMs, untilMs) {
  const out = [];
  const d = new Date(sinceMs);
  d.setHours(12, 0, 0, 0);
  const last = day(untilMs);
  for (let i = 0; i < 4000; i++) {
    const k = day(d.getTime());
    out.push(k);
    if (k >= last) break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 960×220 SVG: prompts per day as bars, known cost per day as a line on its own scale. */
function activitySvg(digest) {
  const W = 960;
  const H = 220;
  const L = 44;
  const R = 56;
  const T = 12;
  const B = 28;
  const byDay = new Map(digest.activity.byDay.map((d) => [d.day, d]));
  const days = daysBetween(digest.window.sinceMs, digest.window.untilMs);
  const maxP = Math.max(1, ...digest.activity.byDay.map((d) => d.prompts));
  const maxC = Math.max(0, ...digest.activity.byDay.map((d) => d.costUsd));
  const pw = W - L - R;
  const ph = H - T - B;
  const step = pw / days.length;
  const bars = [];
  const points = [];
  days.forEach((k, i) => {
    const d = byDay.get(k);
    const x = L + i * step;
    if (d && d.prompts > 0) {
      const h = (d.prompts / maxP) * ph;
      const tip = `${k}: ${d.prompts} prompt${d.prompts === 1 ? '' : 's'}, ${money(d.costUsd)}`;
      bars.push(
        `<rect class="bar" x="${x.toFixed(1)}" y="${(T + ph - h).toFixed(1)}" width="${Math.max(1, step - 1).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(tip)}</title></rect>`,
      );
    }
    if (maxC > 0) points.push(`${(x + step / 2).toFixed(1)},${(T + ph - ((d?.costUsd ?? 0) / maxC) * ph).toFixed(1)}`);
  });
  const labels = [
    `<text x="${L - 6}" y="${T + 10}" text-anchor="end">${maxP}</text>`,
    `<text x="${L - 6}" y="${T + ph}" text-anchor="end">0</text>`,
    `<text x="${L}" y="${H - 8}">${esc(days[0])}</text>`,
    `<text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(days.at(-1))}</text>`,
    maxC > 0 ? `<text x="${W - R + 6}" y="${T + 10}">$${Math.round(maxC)}</text>` : '',
    `<text x="${W - R + 6}" y="${T + ph}">$0</text>`,
  ].join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Prompts and cost per day">
<line class="axis" x1="${L}" y1="${T + ph}" x2="${W - R}" y2="${T + ph}"/>${bars.join('')}${
    points.length ? `<polyline class="cost" points="${points.join(' ')}"><title>Known cost per day (max ${esc(money(maxC))})</title></polyline>` : ''
  }${labels}</svg>`;
}

/** Horizontal bars: top 10 models by known cost. */
function modelSvg(models) {
  const top = models.slice(0, 10);
  if (!top.length) return '<p class="muted">No usage recorded.</p>';
  const W = 960;
  const row = 24;
  const L = 260;
  const R = 150;
  const H = top.length * row + 8;
  const max = Math.max(...top.map((m) => m.costUsd), 0);
  const bars = top.map((m, i) => {
    const w = max > 0 ? (m.costUsd / max) * (W - L - R) : 0;
    const y = 4 + i * row;
    const label = m.unpriced && !m.costUsd ? `unpriced (${m.unpriced} usage events)` : cost(m);
    return `<text x="${L - 8}" y="${y + 15}" text-anchor="end">${esc(snippet(m.model, 38))}</text><rect class="model" x="${L}" y="${y + 3}" width="${Math.max(w, 1).toFixed(1)}" height="${row - 8}"><title>${esc(`${m.model}: ${label}, cache hit ${pct(m.hitRate)}`)}</title></rect><text x="${(L + w + 6).toFixed(1)}" y="${y + 15}">${esc(label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cost by model">${bars.join('')}</svg>`;
}

function findingCard(f) {
  const examples = f.examples.slice(0, 3);
  const exampleItems = examples.map((ex) => {
    if (f.type === 'standard_violation') return `<li>${esc(ex.text)}</li>`;
    if (f.type === 'overlapping_assets' || f.type === 'memory_promotion' || f.type === 'unused_asset') {
      return `<li><span class="path">${esc(ex.cwd)}</span> (${esc(ex.source)}): ${esc(snippet(ex.text, 200))}</li>`;
    }
    const ctx = ex.context ? ` — ${f.type === 'follow_up' ? 'after: ' : ''}${esc(snippet(ex.context, 120))}` : '';
    return `<li>“${esc(snippet(ex.text, 300))}” <span class="muted">(${esc(ex.source)}, ${esc(typeof ex.ts === 'number' ? day(ex.ts) : '-')}${ctx})</span></li>`;
  });
  const target = f.target
    ? `<div>target: <span class="path">${esc(f.target.path)}</span> <span class="badge ${f.target.editable ? 'editable' : 'read-only'}">${f.target.editable ? 'editable' : 'read-only'}</span></div>`
    : '';
  const flags = `${f.correction ? ' · correction' : ''}${f.reappeared ? ' · reappeared after an accepted change' : ''}`;
  return `<div class="finding"><div><span class="id">${esc(f.id)}</span><span class="title">${esc(f.title)}</span></div>
<div class="muted">hint: ${esc(f.hint)}${esc(flags)} · ${esc(evidence(f))}</div>${target}${
    exampleItems.length ? `<details><summary>Examples</summary><ul>${exampleItems.join('')}</ul></details>` : ''
  }</div>`;
}

/** The digest as one complete, self-contained HTML document. */
export function renderHtml(digest) {
  const { window, totals, cost: c, memory, usage, impact = [], standards = [], warnings = [], findings } = digest;
  const range = `${day(window.sinceMs)} → ${day(window.untilMs)}`;
  const out = [];
  out.push(
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>Agent usage dashboard ${esc(range)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    `<h1>Agent usage dashboard</h1><div class="muted">${esc(range)} · generated ${esc(day(Date.now()))} by agent-coach</div>`,
    '<nav><a href="#overview">Overview</a><a href="#activity">Activity</a><a href="#cost">Cost</a><a href="#impact">Impact</a><a href="#findings">Findings</a><a href="#standards">Standards</a><a href="#memory">Memory</a><a href="#usage">Usage</a></nav>',
  );

  const cards = sourcesOf(digest).map((s) => {
    const t = totals[s] ?? { sessions: 0, prompts: 0 };
    const u = c.bySource[s];
    return `<div class="card"><div class="muted">${esc(s)}</div><div class="big">${esc(sourceCost(s, u))}</div><div>${t.sessions} sessions · ${t.prompts} prompts</div><div class="muted">cache hit ${esc(u ? pct(u.hitRate) : '–')}</div></div>`;
  });
  out.push(`<section id="overview"><h2>Overview</h2><div class="cards">${cards.join('') || '<p class="muted">No sessions in the window.</p>'}</div><p class="muted">${esc(COST_BASIS_NOTE)}</p></section>`);

  if (warnings.length) out.push(`<section id="warnings"><h2>Warnings</h2>${warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}</section>`);

  out.push(`<section id="activity"><h2>Activity</h2><p class="muted">Bars: typed prompts per day. Line: known (recorded or allocated) cost per day.</p>${activitySvg(digest)}</section>`);

  out.push('<section id="cost"><h2>Cost &amp; cache</h2>');
  out.push(
    '<h3>By source</h3>',
    tableHtml(
      ['source', 'cost', 'input', 'output', 'cache read', 'cache write', 'hit rate'],
      Object.entries(c.bySource).map(([s, t]) => [esc(s), esc(sourceCost(s, t)), num(t.input), num(t.output), num(t.cacheRead), num(t.cacheWrite), pct(t.hitRate)].map(String)),
      [2, 3, 4, 5, 6],
    ),
    '<h3>Top models by cost</h3>',
    modelSvg(c.byModel),
    '<h3>Top agents (subagent runs)</h3>',
    tableHtml(
      ['agent', 'runs', 'cost', 'cost/run', 'hit rate', 'cache-write share'],
      c.byAgent.slice(0, 10).map((t) => [esc(t.name), t.runs, esc(cost(t)), esc(perPriced(t)), pct(t.hitRate), pct(cacheWriteShare(t))]),
      [1, 2, 3, 4, 5],
    ),
    '<h3>Top skills (turns that used the skill)</h3>',
    tableHtml(
      ['skill', 'uses', 'cost', 'cost/use', 'hit rate'],
      c.bySkill.slice(0, 10).map((t) => [esc(t.name), t.uses, esc(cost(t)), esc(perPriced(t)), pct(t.hitRate)]),
      [1, 2, 3, 4],
    ),
    '<h3>Top sessions</h3>',
    tableHtml(
      ['source', 'session', 'cwd', 'cost', 'hit rate', 'first prompt'],
      c.topSessions.slice(0, 10).map((t) => [esc(t.source), `<code>${esc(t.sessionId)}</code>`, `<span class="path">${esc(t.cwd ?? '-')}</span>`, esc(sourceCost(t.source, t)), pct(t.hitRate), esc(snippet(t.firstPrompt, 100))]),
      [3, 4],
    ),
    '</section>',
  );

  out.push(
    '<section id="impact"><h2>Impact of accepted changes</h2>',
    impact.length
      ? tableHtml(
          ['id', 'change', 'decided', 'metric', 'before → after', 'samples', 'verdict'],
          impact.map((r) => [
            `<code>${esc(r.id)}</code>`,
            esc(snippet(r.title, 120)),
            esc(day(r.decidedAt)),
            esc(r.metric),
            esc(`${metricValue(r.metric, r.before)} → ${metricValue(r.metric, r.after)}`),
            r.samples,
            `<span class="badge ${esc(r.verdict)}">${esc(r.verdict.replace('_', ' '))}</span>`,
          ]),
          [5],
        )
      : '<p class="muted">No accepted change with a baseline yet. improve-workflow records one when you accept a proposal.</p>',
    '</section>',
  );

  out.push('<section id="findings"><h2>Findings</h2>');
  for (const type of TYPE_ORDER) {
    const list = findings.filter((f) => f.type === type);
    if (!list.length) continue;
    out.push(`<h3>${esc(TYPE_TITLES[type])} <span class="muted">(${list.length})</span></h3>`, ...list.map(findingCard));
  }
  if (!findings.length) out.push('<p class="muted">No findings.</p>');
  out.push('</section>');

  out.push(
    '<section id="standards"><h2>Skill standards</h2>',
    tableHtml(
      ['score', 'kind', 'name', 'failed checks', 'path'],
      [...standards]
        .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((a) => [a.score, esc(a.kind), esc(a.name), esc(a.failed.map((f) => `${f.id} (${f.severity})`).join(', ') || '–'), `<span class="path">${esc(a.path)}</span>`]),
      [0],
    ),
    '</section>',
  );

  const memTotal = memory.byProject.reduce((s, p) => s + p.count, 0);
  out.push(
    `<section id="memory"><h2>Memory</h2><p class="muted">${memTotal} memories in ${memory.byProject.length} projects.</p>`,
    tableHtml(
      ['project', 'origin', 'memories', 'types'],
      memory.byProject.map((p) => [`<span class="path">${esc(p.project)}</span>`, esc(p.origin), p.count, esc(Object.entries(p.types).map(([k, v]) => `${k} ${v}`).join(', '))]),
      [2],
    ),
    '</section>',
  );

  out.push(
    '<section id="usage"><h2>Usage</h2>',
    tableHtml(['kind', 'name', 'uses', 'last used'], usage.slice(0, 30).map((u) => [esc(u.kind), esc(u.name), u.uses, esc(day(u.lastTs))]), [2]),
    '</section>',
    '</body></html>',
    '',
  );
  return out.join('\n');
}

/** Write `<coachDir>/dashboard.html` atomically; returns its absolute path. */
export async function writeDashboard(home, digest) {
  const dir = path.resolve(coachDir(home));
  const file = path.join(dir, 'dashboard.html');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(`${file}.tmp`, renderHtml(digest));
  await fs.promises.rename(`${file}.tmp`, file);
  return file;
}

/** Open `file` in the default browser; false under AGENT_COACH_NO_OPEN=1 or when no opener can be launched. */
export function openInBrowser(file) {
  if (process.env.AGENT_COACH_NO_OPEN === '1') return Promise.resolve(false);
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => resolve(false));
  });
}

/**
 * Write the dashboard, open it when `open` is true and AGENT_COACH_NO_OPEN is not 1, and return the
 * `Dashboard: <path> (<status>)` line. "could not launch a browser" means a real launch failure.
 */
export async function publishDashboard(home, digest, open) {
  const file = await writeDashboard(home, digest);
  const wanted = open && process.env.AGENT_COACH_NO_OPEN !== '1';
  const status = !wanted ? 'not opened' : (await openInBrowser(file)) ? 'opened in your browser' : 'could not launch a browser; open the file manually';
  return `Dashboard: ${file} (${status})`;
}
