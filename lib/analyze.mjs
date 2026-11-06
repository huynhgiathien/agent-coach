// Deterministic analysis of session events + asset inventory into usage, cost, activity, memory, standards,
// impact of accepted changes, and findings.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { clusterTexts, isAck, isCorrection, isStandingPreference, jaccard, normalize, similarity, snippet, tokens } from './text.mjs';

export const TYPE_ORDER = ['follow_up', 'repeated_prompt', 'costly_asset', 'memory_promotion', 'standard_violation', 'overlapping_assets', 'unused_asset'];
const ORIGIN_ORDER = ['claude', 'omp', 'agents', 'codex'];
const WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const UNUSED_AGE_MS = 30 * DAY_MS;
const FOLLOW_UP_PROMPTS = 3;
const MAX_EXAMPLES = 50;
const MIN_RATE = 0.1;
const SIMILAR = 0.5;

/**
 * Basis of each source's money figures: omp records per-message cost, Claude cost is allocated from each
 * session's recorded total, Codex and Cursor record tokens only. Tokens are never converted into dollars.
 */
export const costBasis = { omp: 'recorded', claude: 'allocated', codex: 'unpriced', cursor: 'unpriced' };

const findingId = (type, key) => createHash('sha1').update(`${type}|${key}`).digest('hex').slice(0, 10);
/** Bare name of a skill or agent: `plugin:name` → `name`. */
const skillName = (name) => String(name).split(':').pop();
const round3 = (x) => Math.round(x * 1000) / 1000;
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);
const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an epoch-ms time in local time. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const descTokens = (a) => new Set(tokens(normalize(a.description ?? '')));

// ---- totals ----

const newTotals = () => ({ costUsd: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function addUsage(t, ev) {
  if (typeof ev.costUsd === 'number') t.costUsd += ev.costUsd;
  else t.unpriced++;
  t.input += ev.input ?? 0;
  t.output += ev.output ?? 0;
  t.cacheRead += ev.cacheRead ?? 0;
  t.cacheWrite += ev.cacheWrite ?? 0;
}
function addTotals(t, o) {
  for (const k of ['costUsd', 'unpriced', 'input', 'output', 'cacheRead', 'cacheWrite']) t[k] += o[k];
}
function finish(t) {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return { ...t, hitRate: denom ? round3(t.cacheRead / denom) : 0 };
}
/** Share of prompt tokens written to the cache: cacheWrite / (input + cacheRead + cacheWrite). */
export function cacheWriteShare(t) {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return denom ? round3(t.cacheWrite / denom) : 0;
}
const tokenSum = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
const byCost = (a, b) => b.costUsd - a.costUsd || tokenSum(b) - tokenSum(a);

// ---- assets ----

/** Name an asset is also invoked by: a skill's dir name, an agent/command file's basename. */
function altName(a) {
  if (a.kind === 'skill') return path.basename(path.dirname(a.path));
  if (a.kind === 'agent' || a.kind === 'command') return path.basename(a.path, '.md');
  return null;
}

/** `{ uses, lastTs }` of an asset from a `kind:name` → `{ uses, lastTs }` map, counting its alt name too. */
export function usageFor(byKey, a) {
  const alt = altName(a);
  const hits = [byKey.get(`${a.kind}:${a.name}`), alt && alt !== a.name ? byKey.get(`${a.kind}:${alt}`) : undefined].filter(Boolean);
  return { uses: hits.reduce((s, u) => s + u.uses, 0), lastTs: hits.reduce((m, u) => Math.max(m, u.lastTs), 0) };
}

/** `(kind, name)` → best asset: editable first, then origin claude, omp, agents, codex, rest. */
function assetLookup(assets) {
  const rank = (a) => (a.editable ? 0 : 10) + (ORIGIN_ORDER.includes(a.origin) ? ORIGIN_ORDER.indexOf(a.origin) : ORIGIN_ORDER.length);
  const map = new Map();
  const add = (key, a) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(a)) map.get(key).push(a);
  };
  for (const a of assets) {
    add(`${a.kind}:${a.name}`, a);
    const alt = altName(a);
    if (alt) add(`${a.kind}:${alt}`, a);
  }
  for (const list of map.values()) list.sort((a, b) => rank(a) - rank(b));
  return (kind, name) => map.get(`${kind}:${name}`)?.[0] ?? null;
}

const targetOf = (a) => (a ? { kind: a.kind, name: a.name, path: a.path, editable: a.editable } : undefined);

/** Dir holding a project asset's `.claude` or `.agents` dir. */
const projectRoot = (p) => /^(.*)[\\/]\.(?:claude|agents)[\\/]/.exec(p)?.[1] ?? path.dirname(p);

/**
 * Finding key of an asset. Project assets: `project:<repoId>:<kind>:<path relative to the repo's worktree top>`
 * (lib/inventory.mjs sets repoId/repoRoot; without them, the project root), so one decision covers every clone
 * and worktree of a repo and survives edits, while other repos keep their own. Anything else: its absolute path.
 */
function assetKey(a) {
  if (a.origin !== 'project') return a.path;
  const root = a.repoRoot ?? projectRoot(a.path);
  return `project:${a.repoId ?? root}:${a.kind}:${path.relative(root, a.path).split(path.sep).join('/')}`;
}

/** `assets` grouped by assetKey, in first-seen order. */
function byAssetKey(assets) {
  const groups = new Map();
  for (const a of assets) {
    const k = assetKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return groups;
}

/**
 * Project assets copied unchanged into several clones or worktrees (same kind, name and content hash) become
 * one asset: the first by `rank`, which orders copies by uses from sessions under their own project root,
 * then newest, then path. Returns the kept assets, the paths of the dropped copies, and `rank`.
 */
function collapseCopies(assets, events) {
  const cwds = new Map(); // kind:name -> cwds of its uses
  const use = (kind, name, cwd) => {
    if (!name || !cwd) return;
    const k = `${kind}:${name}`;
    if (!cwds.has(k)) cwds.set(k, []);
    cwds.get(k).push(cwd);
  };
  for (const ev of events) {
    if (ev.kind === 'skill' || ev.kind === 'agent') use(ev.kind, skillName(ev.name), ev.cwd);
    else if (ev.kind === 'prompt' && isSlash(ev.text)) {
      const first = slashName(ev.text);
      if (first.startsWith('skill:')) use('skill', skillName(first.slice(6)), ev.cwd);
      else use('command', first, ev.cwd);
    }
  }
  const usesUnder = (a) => {
    const root = projectRoot(a.path);
    const names = [...new Set([a.name, altName(a)].filter(Boolean))];
    return names.flatMap((n) => cwds.get(`${a.kind}:${n}`) ?? []).filter((c) => c === root || c.startsWith(root + path.sep)).length;
  };
  const rank = (list) =>
    list.map((a) => ({ a, uses: usesUnder(a) })).sort((x, y) => y.uses - x.uses || y.a.mtimeMs - x.a.mtimeMs || byStr(x.a.path, y.a.path)).map((x) => x.a);
  const groups = new Map();
  for (const a of assets) {
    if (a.origin !== 'project' || !a.hash) continue;
    const k = `${a.kind}\u0000${a.name}\u0000${a.hash}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const dropped = new Set();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const a of rank(list).slice(1)) dropped.add(a.path);
  }
  return { kept: dropped.size ? assets.filter((a) => !dropped.has(a.path)) : assets, dropped, rank };
}

// ---- prompt helpers ----

const isSlash = (text) => text.trimStart().startsWith('/');
const slashName = (text) => text.trimStart().slice(1).split(/\s+/)[0] ?? '';
/** A prompt that may be a follow-up: not an acknowledgement and not a `/command`. */
const followable = (text, key) => !isAck(key) && !isSlash(text);
/**
 * `/name` prompt at `i` that invoked the skill `name` (its next non-usage event is that skill, as Claude Code
 * records a slash-invoked skill); such a prompt is a skill use, not a command.
 */
function invokesSkill(evs, i, name) {
  let j = i + 1;
  while (j < evs.length && evs[j].kind === 'usage') j++;
  return evs[j]?.kind === 'skill' && skillName(evs[j].name) === skillName(name);
}

function example(m) {
  return { text: m.text, ts: m.ts, source: m.source, cwd: m.cwd, ...(m.context ? { context: m.context } : {}) };
}

/**
 * Finding for a prompt cluster. `members` (follow-up members carry `occTs`, their trigger's time) and, for
 * follow-ups, `occurrencesOf` and `triggerTimes` stay attached (non-enumerable) for decision handling.
 */
function promptFinding(type, key, fields, members, occurrencesOf, triggerTimes) {
  const sorted = [...members].sort((a, b) => b.ts - a.ts);
  const f = {
    id: findingId(type, key),
    type,
    ...fields,
    count: members.length,
    sessions: new Set(members.map((m) => m.sessionKey)).size,
    ...(occurrencesOf ? { occurrences: occurrencesOf(members) } : {}),
    correction: members.filter((m) => m.steering || isCorrection(m.key)).length * 2 >= members.length,
    examples: sorted.slice(0, MAX_EXAMPLES).map(example),
    firstTs: sorted.at(-1).ts,
    lastTs: sorted[0].ts,
  };
  Object.defineProperty(f, 'members', { value: members, enumerable: false });
  Object.defineProperty(f, 'occurrencesOf', { value: occurrencesOf, enumerable: false });
  Object.defineProperty(f, 'triggerTimes', { value: triggerTimes, enumerable: false });
  return f;
}

const distinctOccurrences = (members) => new Set(members.map((m) => m.occ)).size;

// ---- shared by findings and impact ----

/** Events grouped by `${source}:${sessionId}`, in order; a session with any `sub` event is a subagent session. */
function groupSessions(events) {
  const sessions = new Map();
  for (const ev of events) {
    const key = `${ev.source}:${ev.sessionId}`;
    let s = sessions.get(key);
    if (!s) sessions.set(key, (s = { key, source: ev.source, sessionId: ev.sessionId, cwd: null, sub: false, events: [] }));
    if (!s.cwd && ev.cwd) s.cwd = ev.cwd;
    if (ev.sub) s.sub = true;
    s.events.push(ev);
  }
  return [...sessions.values()];
}

/**
 * Asset-trigger occurrences of one main session: skill, agent and mode events and `/command` prompts, keyed
 * `kind:name`. The same key again with no typed prompt in between is one use. `end` is the event index of the
 * next occurrence of the same key, where its follow-up window stops.
 */
function assetOccurrences(evs) {
  const occs = [];
  const lastAt = new Map(); // key -> prompt count at its last occurrence
  let promptCount = 0;
  let prevPrompt = null;
  const add = (kind, name, i) => {
    const key = `${kind}:${name}`;
    if (lastAt.get(key) === promptCount) return;
    lastAt.set(key, promptCount);
    // Sessions resumed from a handoff can trigger a skill before the user typed anything.
    occs.push({ key, kind, name, i, ts: evs[i].ts, context: prevPrompt ? snippet(prevPrompt.text) : '(start of session)' });
  };
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.kind === 'prompt') {
      if (isSlash(ev.text)) {
        const first = slashName(ev.text);
        if (first && !first.startsWith('skill:') && !invokesSkill(evs, i, first)) add('command', first, i);
      }
      promptCount++;
      prevPrompt = ev;
    } else if (ev.kind === 'skill') add('skill', skillName(ev.name), i);
    else if (ev.kind === 'agent') add('agent', skillName(ev.name), i);
    else if (ev.kind === 'mode') add('mode', ev.name, i);
  }
  const nextSame = new Map();
  for (let k = occs.length - 1; k >= 0; k--) {
    occs[k].end = nextSame.get(occs[k].key) ?? evs.length;
    nextSame.set(occs[k].key, occs[k].i);
  }
  return occs;
}

/** Typed prompts in the follow-up window of occurrence `o`: the next 3 within 60 min, before the same key recurs. */
function windowPrompts(evs, o) {
  const out = [];
  for (let j = o.i + 1; j < o.end && out.length < FOLLOW_UP_PROMPTS; j++) {
    const ev = evs[j];
    if (ev.kind !== 'prompt') continue;
    if (ev.ts - o.ts > WINDOW_MS) break;
    out.push(ev);
  }
  return out;
}

/**
 * Cost aggregates: totals per source and model (main + sub), subagent runs grouped by agent, and main-session
 * turns (a typed prompt up to the next one; usage and skills before the first prompt belong to no turn).
 * `priced` counts the runs/turns with at least one priced usage event; per-use costs divide by it, so
 * unpriced (tokens-only) uses never count as $0.
 */
function costParts(sessions) {
  const bySource = {};
  const byModel = new Map();
  const runs = new Map(); // sub session key -> run
  for (const s of sessions) {
    for (const ev of s.events) {
      if (ev.kind !== 'usage') continue;
      addUsage((bySource[s.source] ??= newTotals()), ev);
      const model = ev.model ?? 'unknown';
      if (!byModel.has(model)) byModel.set(model, newTotals());
      addUsage(byModel.get(model), ev);
      if (!s.sub) continue;
      let r = runs.get(s.key);
      if (!r) runs.set(s.key, (r = { agent: ev.agent ?? 'task', source: s.source, sessionId: s.sessionId, cwd: s.cwd, ts: ev.ts, totals: newTotals(), priced: 0, models: new Map() }));
      addUsage(r.totals, ev);
      if (typeof ev.costUsd === 'number') {
        r.priced++;
        r.models.set(model, (r.models.get(model) ?? 0) + ev.costUsd);
      }
    }
  }

  const agents = new Map();
  for (const r of runs.values()) {
    const a = agents.get(r.agent) ?? { name: r.agent, runs: 0, priced: 0, totals: newTotals(), list: [] };
    a.runs++;
    if (r.priced > 0) a.priced++;
    addTotals(a.totals, r.totals);
    a.list.push(r);
    agents.set(r.agent, a);
  }

  const turns = [];
  const sessionTotals = [];
  for (const s of sessions) {
    if (s.sub) continue;
    const st = newTotals();
    let turn = null;
    let firstPrompt = null;
    for (const ev of s.events) {
      if (ev.kind === 'prompt') {
        firstPrompt ??= ev.text;
        turn = { prompt: ev, session: s, skills: new Set(), totals: newTotals(), priced: 0, models: new Map() };
        turns.push(turn);
      } else if (ev.kind === 'skill') {
        turn?.skills.add(skillName(ev.name));
      } else if (ev.kind === 'usage') {
        addUsage(st, ev);
        if (!turn) continue;
        addUsage(turn.totals, ev);
        if (typeof ev.costUsd === 'number') {
          turn.priced++;
          const model = ev.model ?? 'unknown';
          turn.models.set(model, (turn.models.get(model) ?? 0) + ev.costUsd);
        }
      }
    }
    if (tokenSum(st) + st.unpriced > 0 || st.costUsd > 0) {
      sessionTotals.push({ source: s.source, sessionId: s.sessionId, cwd: s.cwd, firstPrompt: firstPrompt ? snippet(firstPrompt) : '', ...finish(st) });
    }
  }
  const skills = new Map();
  for (const t of turns) {
    for (const name of t.skills) {
      const k = skills.get(name) ?? { name, uses: 0, priced: 0, totals: newTotals(), list: [] };
      k.uses++;
      if (t.priced > 0) k.priced++;
      addTotals(k.totals, t.totals);
      k.list.push(t);
      skills.set(name, k);
    }
  }
  return { bySource, byModel, runs, agents, turns, sessionTotals, skills };
}

/** Follow-up rate after a decision: share of trigger occurrences whose window has a prompt similar to `rep`. */
function followUpRate(mainSessions, { triggerKey, rep }) {
  let occurrences = 0;
  let hits = 0;
  const isHit = (text, key) => followable(text, key) && similarity(key, rep) >= SIMILAR;
  if (triggerKey.startsWith('prompt:')) {
    const triggerRep = triggerKey.slice('prompt:'.length);
    for (const s of mainSessions) {
      const prompts = s.events.filter((e) => e.kind === 'prompt');
      const keys = prompts.map((p) => normalize(p.text));
      const isTrigger = (i) => followable(prompts[i].text, keys[i]) && similarity(keys[i], triggerRep) >= SIMILAR;
      for (let i = 0; i < prompts.length; i++) {
        if (!isTrigger(i)) continue;
        occurrences++;
        const nx = i + 1;
        if (nx < prompts.length && prompts[nx].ts - prompts[i].ts <= WINDOW_MS && !isTrigger(nx) && isHit(prompts[nx].text, keys[nx])) hits++;
      }
    }
  } else {
    for (const s of mainSessions) {
      for (const o of assetOccurrences(s.events)) {
        if (o.key !== triggerKey) continue;
        occurrences++;
        if (windowPrompts(s.events, o).some((ev) => isHit(ev.text, normalize(ev.text)))) hits++;
      }
    }
  }
  return { value: occurrences ? hits / occurrences : null, samples: occurrences };
}

/**
 * Before vs after for every accepted decision with a baseline, over events from `decidedAt` to `nowMs`.
 * Events start at `sinceMs`, so perWeek divides by the observed days since max(decidedAt, sinceMs).
 * Verdict: insufficient_data below `minCount` samples (or < 7 observed days for perWeek), improved at
 * <= 0.7 × before, worse at >= 1.1 × before, else no_change. Newest decision first.
 */
function measureImpact(events, decisions, { minCount, nowMs, sinceMs }) {
  const rows = [];
  for (const [id, d] of Object.entries(decisions)) {
    const snap = d?.snapshot;
    if (d?.status !== 'accepted' || !snap?.baseline || typeof d.decidedAt !== 'number') continue;
    const { metric } = snap.baseline;
    const start = Math.max(d.decidedAt, sinceMs);
    const sessions = groupSessions(events.filter((ev) => ev.ts >= start && ev.ts <= nowMs));
    const mainSessions = sessions.filter((s) => !s.sub);
    const afterDays = (nowMs - start) / DAY_MS;
    let value = null;
    let samples = 0;
    if (metric === 'rate') {
      ({ value, samples } = followUpRate(mainSessions, snap));
    } else if (metric === 'perWeek') {
      for (const s of mainSessions) {
        for (const ev of s.events) {
          if (ev.kind !== 'prompt') continue;
          const key = normalize(ev.text);
          if (followable(ev.text, key) && similarity(key, snap.rep) >= SIMILAR) samples++;
        }
      }
      value = afterDays > 0 ? samples / (afterDays / 7) : null;
    } else if (metric === 'costPerUse') {
      const parts = costParts(sessions);
      const hit = snap.kind === 'agent' ? parts.agents.get(snap.name) : parts.skills.get(snap.name);
      samples = hit?.priced ?? 0;
      value = samples ? hit.totals.costUsd / samples : null;
    } else continue;
    const before = snap.baseline.value;
    const verdict =
      value === null || samples < minCount || (metric === 'perWeek' && afterDays < 7)
        ? 'insufficient_data'
        : value <= 0.7 * before
          ? 'improved'
          : value >= 1.1 * before
            ? 'worse'
            : 'no_change';
    rows.push({
      id,
      type: snap.type,
      title: snap.title,
      decidedAt: d.decidedAt,
      metric,
      before: round3(before),
      after: value === null ? null : round3(value),
      samples,
      verdict,
    });
  }
  return rows.sort((a, b) => b.decidedAt - a.decidedAt);
}

/**
 * Analyze events (all sources, readers' order) against the asset inventory. `audits` come from
 * lib/standards.mjs and `warnings` from the readers; both are passed through. Every source in `sources` gets a
 * `totals` row, 0 when it had no session. See the plan's Step 5 for every rule; returns
 * { window, totals, costBasis, activity, usage, cost, memory, standards, impact, warnings, findings }.
 */
export function analyze(
  events,
  allAssets,
  { minCount = 3, decisions = {}, sinceMs = 0, nowMs = Date.now(), includeDecided = false, audits: allAudits = [], warnings = [], sources = [] } = {},
) {
  const { kept: assets, dropped, rank } = collapseCopies(allAssets, events);
  const audits = allAudits.filter((a) => !dropped.has(a.path));
  const lookup = assetLookup(assets);
  const sessions = groupSessions(events);
  const mainSessions = sessions.filter((s) => !s.sub);

  // ---- totals ----
  const totals = Object.fromEntries(sources.map((s) => [s, { sessions: 0, prompts: 0 }]));
  for (const s of mainSessions) {
    const t = (totals[s.source] ??= { sessions: 0, prompts: 0 });
    t.sessions++;
    for (const ev of s.events) if (ev.kind === 'prompt') t.prompts++;
  }

  // ---- activity: typed prompts (main) and known cost (main + sub) per local day ----
  const days = new Map();
  const dayOf = (ts) => {
    const k = localDay(ts);
    let d = days.get(k);
    if (!d) days.set(k, (d = { day: k, prompts: 0, costUsd: 0 }));
    return d;
  };
  for (const s of sessions) {
    for (const ev of s.events) {
      if (ev.kind === 'prompt' && !s.sub) dayOf(ev.ts).prompts++;
      else if (ev.kind === 'usage' && typeof ev.costUsd === 'number' && ev.costUsd !== 0) dayOf(ev.ts).costUsd += ev.costUsd;
    }
  }
  const activity = { byDay: [...days.values()].filter((d) => d.prompts > 0 || d.costUsd > 0).sort((a, b) => byStr(a.day, b.day)) };

  // ---- usage ----
  const uses = new Map();
  const countUse = (kind, name, ts) => {
    const k = `${kind}:${name}`;
    const u = uses.get(k) ?? { kind, name, uses: 0, lastTs: 0 };
    u.uses++;
    u.lastTs = Math.max(u.lastTs, ts);
    uses.set(k, u);
  };
  for (const s of sessions) {
    let lastSkill = null;
    for (let i = 0; i < s.events.length; i++) {
      const ev = s.events[i];
      if (ev.kind === 'prompt') {
        if (isSlash(ev.text)) {
          const first = slashName(ev.text);
          if (first.startsWith('skill:')) {
            const n = skillName(first.slice(6));
            if (n && lastSkill !== n) countUse('skill', n, ev.ts);
            lastSkill = n;
            continue;
          }
          if (first && !invokesSkill(s.events, i, first)) countUse('command', first, ev.ts);
        }
        lastSkill = null;
      } else if (ev.kind === 'skill') {
        const n = skillName(ev.name);
        if (lastSkill !== n) countUse('skill', n, ev.ts);
        lastSkill = n;
      } else if (ev.kind === 'agent') {
        countUse('agent', skillName(ev.name), ev.ts);
      }
    }
  }
  const usage = [...uses.values()].sort((a, b) => b.uses - a.uses || b.lastTs - a.lastTs || byStr(a.name, b.name));
  const usesOf = (a) => usageFor(uses, a).uses;

  // ---- typed prompts ----
  const typed = [];
  for (const s of mainSessions) {
    let prev = null;
    for (const ev of s.events) {
      if (ev.kind !== 'prompt') continue;
      const entry = { key: normalize(ev.text), text: ev.text, ts: ev.ts, source: s.source, cwd: ev.cwd ?? s.cwd, sessionKey: s.key, steering: !!ev.steering, ev };
      if (prev) prev.next = entry;
      prev = entry;
      typed.push(entry);
    }
  }
  const isFollowable = (e) => followable(e.text, e.key);

  const findings = [];

  // ---- repeated_prompt ----
  const repeated = [];
  const candidates = typed.filter(isFollowable).sort((a, b) => a.ts - b.ts);
  for (const c of clusterTexts(candidates)) {
    if (c.members.length < minCount || new Set(c.members.map((m) => m.sessionKey)).size < 2) continue;
    const hint = c.tokenCount > 12 ? 'create_asset' : isStandingPreference(c.rep) ? 'add_rule' : 'create_asset';
    findings.push(promptFinding('repeated_prompt', c.rep, { hint, title: `"${snippet(c.members[0].text)}"`, rep: c.rep }, c.members));
    repeated.push(c);
  }

  // ---- follow_up: asset triggers ----
  const triggerTimes = new Map(); // triggerKey -> occurrence times
  const windowMembers = new Map(); // triggerKey -> member entries
  const triggerInfo = new Map(); // triggerKey -> { kind, name }
  let occId = 0;
  const entryOf = new Map(typed.map((e) => [e.ev, e]));
  for (const s of mainSessions) {
    for (const o of assetOccurrences(s.events)) {
      const id = occId++;
      if (!triggerTimes.has(o.key)) triggerTimes.set(o.key, []);
      triggerTimes.get(o.key).push(o.ts);
      if (!triggerInfo.has(o.key)) triggerInfo.set(o.key, { kind: o.kind, name: o.name });
      for (const ev of windowPrompts(s.events, o)) {
        const e = entryOf.get(ev);
        if (!e || !isFollowable(e)) continue;
        if (!windowMembers.has(o.key)) windowMembers.set(o.key, []);
        windowMembers.get(o.key).push({ ...e, occ: id, occTs: o.ts, context: o.context });
      }
    }
  }
  for (const [tKey, members] of windowMembers) {
    const { kind, name } = triggerInfo.get(tKey);
    const times = triggerTimes.get(tKey);
    const n = times.length;
    const target = kind === 'mode' ? null : lookup(kind, name);
    for (const c of clusterTexts(members)) {
      const occurrences = distinctOccurrences(c.members);
      const rate = occurrences / n;
      if (occurrences < minCount || rate < MIN_RATE) continue;
      findings.push(
        promptFinding(
          'follow_up',
          `${tKey}->${c.rep}`,
          {
            hint: target ? 'update_asset' : 'add_rule',
            title: `After ${kind} "${name}": "${snippet(c.members[0].text)}"`,
            triggerCount: n,
            rate: round3(rate),
            trigger: { kind, name },
            triggerKey: tKey,
            rep: c.rep,
            ...(target ? { target: targetOf(target) } : {}),
          },
          c.members,
          distinctOccurrences,
          times,
        ),
      );
    }
  }

  // ---- follow_up: prompt triggers ----
  for (const c of repeated) {
    const inCluster = new Set(c.members);
    const members = [];
    for (const m of c.members) {
      const nx = m.next;
      if (!nx || nx.ts - m.ts > WINDOW_MS || !isFollowable(nx) || inCluster.has(nx)) continue;
      members.push({ ...nx, occ: occId, occTs: m.ts, context: snippet(m.text) });
      occId++;
    }
    const n = c.members.length;
    for (const fc of clusterTexts(members.sort((a, b) => a.ts - b.ts))) {
      const occurrences = distinctOccurrences(fc.members);
      const rate = occurrences / n;
      if (occurrences < minCount || rate < MIN_RATE) continue;
      findings.push(
        promptFinding(
          'follow_up',
          `prompt:${c.rep}->${fc.rep}`,
          {
            hint: 'create_asset',
            title: `After prompt "${snippet(c.rep, 80)}": "${snippet(fc.members[0].text)}"`,
            triggerCount: n,
            rate: round3(rate),
            trigger: { kind: 'prompt', name: c.rep },
            triggerKey: `prompt:${c.rep}`,
            rep: fc.rep,
          },
          fc.members,
          distinctOccurrences,
          c.members.map((m) => m.ts),
        ),
      );
    }
  }

  // ---- cost ----
  const parts = costParts(sessions);
  const topModel = (models) => [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  const cost = {
    bySource: Object.fromEntries(Object.entries(parts.bySource).map(([k, t]) => [k, finish(t)])),
    byModel: [...parts.byModel].map(([model, t]) => ({ model, ...finish(t) })).sort(byCost).slice(0, 10),
    byAgent: [...parts.agents.values()].map((a) => ({ name: a.name, runs: a.runs, priced: a.priced, ...finish(a.totals) })).sort(byCost),
    bySkill: [...parts.skills.values()].map((k) => ({ name: k.name, uses: k.uses, priced: k.priced, ...finish(k.totals) })).sort(byCost),
    topSessions: parts.sessionTotals.sort(byCost).slice(0, 10),
  };

  // ---- costly_asset: per-use cost over priced runs/turns (`items`) only ----
  const costly = (kind, name, items, totals, baseline, textOf) => {
    const n = items.length;
    const perUse = totals.costUsd / n;
    if (!(perUse >= 2 * baseline && totals.costUsd >= 5)) return;
    const t = finish(totals);
    const asset = lookup(kind, skillName(name));
    const ratio = baseline > 0 ? `${(perUse / baseline).toFixed(1)}×` : 'n/a ×';
    const top = [...items].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, 3);
    const tsList = items.map((x) => x.ts ?? x.prompt?.ts).filter((x) => typeof x === 'number');
    findings.push({
      id: findingId('costly_asset', `${kind}:${name}`),
      type: 'costly_asset',
      hint: asset?.editable ? 'update_asset' : 'add_rule',
      title: `Costly ${kind} "${name}": $${totals.costUsd.toFixed(2)} total, $${perUse.toFixed(2)} per use (${ratio} median), cache hit ${Math.round(t.hitRate * 100)}%`,
      count: n,
      sessions: new Set(items.map((x) => `${x.source ?? x.session.source}:${x.sessionId ?? x.session.sessionId}`)).size,
      costUsd: totals.costUsd,
      perUse,
      baseline,
      hitRate: t.hitRate,
      cacheWriteShare: cacheWriteShare(t),
      trigger: { kind, name },
      ...(asset ? { target: targetOf(asset) } : {}),
      examples: top.map((x) => ({
        text: textOf(x),
        ts: x.ts ?? x.prompt.ts,
        source: x.source ?? x.session.source,
        cwd: x.cwd ?? x.prompt?.cwd ?? x.session?.cwd ?? null,
        context: `$${x.totals.costUsd.toFixed(2)}, ${topModel(x.models)}`,
      })),
      firstTs: minOf(tsList),
      lastTs: maxOf(tsList),
    });
  };
  const runBaseline = median([...parts.runs.values()].filter((r) => r.priced > 0).map((r) => r.totals.costUsd));
  for (const a of parts.agents.values()) {
    if (a.priced >= 3) costly('agent', a.name, a.list.filter((r) => r.priced > 0), a.totals, runBaseline, () => `${a.name} run`);
  }
  const turnBaseline = median(parts.turns.filter((t) => t.priced > 0).map((t) => t.totals.costUsd));
  for (const k of parts.skills.values()) {
    if (k.priced >= 3) costly('skill', k.name, k.list.filter((t) => t.priced > 0), k.totals, turnBaseline, (t) => t.prompt.text);
  }

  // ---- memory ----
  const memories = assets.filter((a) => a.kind === 'memory');
  const memGroups = new Map();
  for (const m of memories) {
    const k = `${m.project}\u0000${m.origin}`;
    const g = memGroups.get(k) ?? { project: m.project, origin: m.origin, count: 0, types: {} };
    g.count++;
    const type = m.memoryType ?? 'none';
    g.types[type] = (g.types[type] ?? 0) + 1;
    memGroups.set(k, g);
  }
  const memory = { byProject: [...memGroups.values()].sort((a, b) => b.count - a.count || byStr(a.project, b.project)) };

  // ---- memory_promotion ----
  const cands = memories.filter((m) => m.memoryType === 'feedback' || m.memoryType === 'user');
  const parent = cands.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const candTokens = cands.map(descTokens);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      if (cands[i].project === cands[j].project) continue;
      if (jaccard(candTokens[i], candTokens[j]) >= 0.4) parent[root(i)] = root(j);
    }
  }
  const comps = new Map();
  cands.forEach((m, i) => {
    const r = root(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(m);
  });
  const promote = (list) => {
    const sorted = [...list].sort((a, b) => byStr(a.path, b.path));
    const projects = new Set(sorted.map((m) => m.project)).size;
    const mt = sorted.map((m) => m.mtimeMs);
    findings.push({
      id: findingId('memory_promotion', sorted.map((m) => m.path).join('|')),
      type: 'memory_promotion',
      hint: 'promote_memory',
      title: `Promote memory "${sorted[0].name}" (${sorted.length} in ${projects} projects)`,
      count: sorted.length,
      sessions: projects,
      target: targetOf(sorted[0]),
      examples: sorted.map((m) => ({ text: m.description, ts: m.mtimeMs, source: m.project, cwd: m.path })),
      firstTs: minOf(mt),
      lastTs: maxOf(mt),
    });
  };
  for (const list of comps.values()) {
    if (new Set(list.map((m) => m.project)).size >= 2) promote(list);
    else for (const m of list) if (m.memoryType === 'user') promote([m]);
  }

  // ---- standard_violation: >= 1 major or >= 2 minor failed checks; one finding per assetKey ----
  const byPath = new Map(assets.map((a) => [a.path, a]));
  const failing = new Map(); // asset -> audit
  for (const a of audits) {
    const majors = a.failed.filter((f) => f.severity === 'major').length;
    if (majors < 1 && a.failed.length - majors < 2) continue;
    failing.set(byPath.get(a.path) ?? { kind: a.kind, name: a.name, path: a.path, editable: true, mtimeMs: null }, a);
  }
  for (const [key, copies] of byAssetKey([...failing.keys()])) {
    const [asset, ...others] = rank(copies);
    const a = failing.get(asset);
    const mtimeMs = asset.mtimeMs ?? null;
    findings.push({
      id: findingId('standard_violation', key),
      type: 'standard_violation',
      hint: 'update_asset',
      title: `Standards: ${a.kind} "${a.name}" fails ${a.failed.map((f) => f.id).join(', ')}`,
      count: a.failed.length,
      sessions: 0,
      score: a.score,
      target: targetOf(asset),
      examples: [
        ...a.failed.map((f) => ({ text: `${f.id} (${f.severity}): ${f.detail}`, ts: mtimeMs, source: a.kind, cwd: a.path })),
        ...others.map((o) => ({ text: `also in ${o.path} (score ${failing.get(o).score})`, ts: o.mtimeMs ?? null, source: a.kind, cwd: o.path })),
      ],
      firstTs: mtimeMs,
      lastTs: mtimeMs,
    });
  }

  // ---- overlapping_assets ----
  const overlapKeys = new Set();
  const overlap = (kind, list, title) => {
    if (!list.some((a) => a.editable)) return;
    const sorted = [...list].sort((a, b) => byStr(a.path, b.path));
    const key = [...new Set(sorted.map(assetKey))].sort().join('|');
    if (overlapKeys.has(key)) return;
    overlapKeys.add(key);
    const keep = list
      .filter((a) => a.editable)
      .sort((a, b) => (kind === 'memory' ? 0 : usesOf(b) - usesOf(a)) || b.mtimeMs - a.mtimeMs)[0];
    const mt = list.map((a) => a.mtimeMs);
    findings.push({
      id: findingId('overlapping_assets', key),
      type: 'overlapping_assets',
      hint: 'merge_assets',
      title,
      count: list.length,
      sessions: 0,
      target: targetOf(keep),
      examples: sorted.map((a) => ({ text: snippet(a.description), ts: a.mtimeMs, source: a.origin, cwd: a.path })),
      firstTs: minOf(mt),
      lastTs: maxOf(mt),
    });
  };
  for (const kind of ['skill', 'agent', 'command', 'context', 'memory']) {
    const ofKind = assets.filter((a) => a.kind === kind);
    const groups = new Map();
    for (const a of ofKind) {
      const g = kind === 'memory' ? a.project : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    }
    for (const [project, list] of groups) {
      const where = kind === 'memory' ? ` in ${project}` : '';
      const byName = new Map();
      for (const a of list) {
        if (!byName.has(a.name)) byName.set(a.name, []);
        byName.get(a.name).push(a);
      }
      for (const [name, same] of byName) if (same.length >= 2) overlap(kind, same, `${same.length} ${kind} files named "${name}"${where}`);
      const toks = list.map(descTokens);
      for (let i = 0; i < list.length; i++) {
        if (toks[i].size < 5) continue;
        for (let j = i + 1; j < list.length; j++) {
          if (toks[j].size < 5 || list[i].name === list[j].name) continue;
          if (jaccard(toks[i], toks[j]) >= 0.5) overlap(kind, [list[i], list[j]], `Similar ${kind}s "${list[i].name}" and "${list[j].name}"${where}`);
        }
      }
    }
  }

  // ---- unused_asset: one finding per assetKey, on the best-ranked copy ----
  const unused = assets.filter(
    // Untouched for 30 days and not used in the window; recently written assets get time to be used.
    (a) => a.editable && ['skill', 'agent', 'command'].includes(a.kind) && usesOf(a) === 0 && a.mtimeMs < nowMs - UNUSED_AGE_MS,
  );
  for (const [key, copies] of byAssetKey(unused)) {
    const ranked = rank(copies);
    const a = ranked[0];
    const mt = ranked.map((c) => c.mtimeMs);
    findings.push({
      id: findingId('unused_asset', key),
      type: 'unused_asset',
      hint: 'delete_asset',
      title: `Unused ${a.kind} "${a.name}"`,
      count: 0,
      sessions: 0,
      target: targetOf(a),
      examples: ranked.map((c) => ({ text: snippet(c.description), ts: c.mtimeMs, source: c.origin, cwd: c.path })),
      firstTs: minOf(mt),
      lastTs: maxOf(mt),
    });
  }

  // ---- decisions ----
  let kept = findings;
  if (!includeDecided) {
    kept = [];
    for (const f of findings) {
      const d = decisions[f.id];
      if (!d) {
        kept.push(f);
        continue;
      }
      if (d.status !== 'accepted' || !f.members) continue; // dismissed, or accepted asset/standards finding
      // Only what happened after the decision: follow-ups whose trigger came later, and later triggers.
      const fresh = f.members.filter((m) => (m.occTs ?? m.ts) > d.decidedAt);
      const value = f.occurrencesOf ? f.occurrencesOf(fresh) : fresh.length;
      if (value < minCount) continue;
      const triggerCount = f.triggerTimes?.filter((t) => t > d.decidedAt).length;
      const sorted = fresh.sort((a, b) => b.ts - a.ts);
      kept.push({
        ...f,
        count: fresh.length,
        sessions: new Set(fresh.map((m) => m.sessionKey)).size,
        ...(f.occurrencesOf ? { occurrences: value, triggerCount, rate: round3(value / triggerCount) } : {}),
        examples: sorted.slice(0, MAX_EXAMPLES).map(example),
        firstTs: sorted.at(-1).ts,
        lastTs: sorted[0].ts,
        reappeared: true,
        decidedAt: d.decidedAt,
      });
    }
  }

  // ---- order: the best finding of each type first (in TYPE_ORDER), then the rest by type and score ----
  const score = (f) => (f.type === 'costly_asset' ? f.costUsd : (f.occurrences ?? f.count) * (f.correction ? 2 : 1));
  kept.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || score(b) - score(a) || (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const heads = TYPE_ORDER.map((type) => kept.find((f) => f.type === type)).filter(Boolean);
  const ordered = [...heads, ...kept.filter((f) => !heads.includes(f))];

  return {
    window: { sinceMs, untilMs: nowMs },
    totals,
    costBasis,
    activity,
    usage,
    cost,
    memory,
    standards: audits,
    impact: measureImpact(events, decisions, { minCount, nowMs, sinceMs }),
    warnings,
    findings: ordered,
  };
}
