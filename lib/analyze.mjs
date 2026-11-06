// Deterministic analysis of session events + asset inventory into usage, cost, memory and findings.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { clusterTexts, isAck, isCorrection, isStandingPreference, jaccard, normalize, snippet, tokens } from './text.mjs';

const TYPE_ORDER = ['follow_up', 'repeated_prompt', 'costly_asset', 'memory_promotion', 'overlapping_assets', 'unused_asset'];
const ORIGIN_ORDER = ['claude', 'omp', 'agents', 'codex'];
const WINDOW_MS = 60 * 60 * 1000;
const FOLLOW_UP_PROMPTS = 3;
const MAX_EXAMPLES = 50;
const MIN_RATE = 0.1;

const findingId = (type, key) => createHash('sha1').update(`${type}|${key}`).digest('hex').slice(0, 10);
const skillName = (name) => String(name).split(':').pop();
const round3 = (x) => Math.round(x * 1000) / 1000;
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);

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

// ---- prompt helpers ----

const isSlash = (text) => text.trimStart().startsWith('/');
const slashName = (text) => text.trimStart().slice(1).split(/\s+/)[0] ?? '';

function example(m) {
  return { text: m.text, ts: m.ts, source: m.source, cwd: m.cwd, ...(m.context ? { context: m.context } : {}) };
}

/** Finding for a prompt cluster; `members` stay attached (non-enumerable) for decision handling. */
function promptFinding(type, key, fields, members, occurrencesOf) {
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
  return f;
}

const distinctOccurrences = (members) => new Set(members.map((m) => m.occ)).size;

/**
 * Analyze events (all sources, readers' order) against the asset inventory.
 * See the plan's Step 5 for every rule; returns { window, totals, usage, cost, memory, findings }.
 */
export function analyze(events, assets, { minCount = 3, decisions = {}, sinceMs = 0, nowMs = Date.now(), includeDecided = false } = {}) {
  const lookup = assetLookup(assets);

  // Sessions keyed source:sessionId, events kept in order.
  const sessions = new Map();
  for (const ev of events) {
    const key = `${ev.source}:${ev.sessionId}`;
    let s = sessions.get(key);
    if (!s) sessions.set(key, (s = { key, source: ev.source, sessionId: ev.sessionId, cwd: null, sub: false, events: [] }));
    if (!s.cwd && ev.cwd) s.cwd = ev.cwd;
    if (ev.sub) s.sub = true;
    s.events.push(ev);
  }
  const mainSessions = [...sessions.values()].filter((s) => !s.sub);

  // ---- totals ----
  const totals = {};
  for (const s of mainSessions) {
    const t = (totals[s.source] ??= { sessions: 0, prompts: 0 });
    t.sessions++;
    for (const ev of s.events) if (ev.kind === 'prompt') t.prompts++;
  }

  // ---- usage ----
  const uses = new Map();
  const countUse = (kind, name, ts) => {
    const k = `${kind}:${name}`;
    const u = uses.get(k) ?? { kind, name, uses: 0, lastTs: 0 };
    u.uses++;
    u.lastTs = Math.max(u.lastTs, ts);
    uses.set(k, u);
  };
  for (const s of sessions.values()) {
    let lastSkill = null;
    for (const ev of s.events) {
      if (ev.kind === 'prompt') {
        if (isSlash(ev.text)) {
          const first = slashName(ev.text);
          if (first.startsWith('skill:')) {
            const n = skillName(first.slice(6));
            if (n && lastSkill !== n) countUse('skill', n, ev.ts);
            lastSkill = n;
            continue;
          }
          if (first) countUse('command', first, ev.ts);
        }
        lastSkill = null;
      } else if (ev.kind === 'skill') {
        const n = skillName(ev.name);
        if (lastSkill !== n) countUse('skill', n, ev.ts);
        lastSkill = n;
      } else if (ev.kind === 'agent') {
        countUse('agent', ev.name, ev.ts);
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
  const followable = (e) => !isAck(e.key) && !isSlash(e.text);

  const findings = [];

  // ---- repeated_prompt ----
  const repeated = [];
  const candidates = typed.filter(followable).sort((a, b) => a.ts - b.ts);
  for (const c of clusterTexts(candidates)) {
    if (c.members.length < minCount || new Set(c.members.map((m) => m.sessionKey)).size < 2) continue;
    const hint = c.tokenCount > 12 ? 'create_asset' : isStandingPreference(c.rep) ? 'add_rule' : 'create_asset';
    const f = promptFinding('repeated_prompt', c.rep, { hint, title: `"${snippet(c.members[0].text)}"` }, c.members);
    findings.push(f);
    repeated.push(c);
  }

  // ---- follow_up: asset triggers ----
  const triggerCount = new Map(); // triggerKey -> occurrences
  const windowMembers = new Map(); // triggerKey -> member entries
  const triggerInfo = new Map(); // triggerKey -> { kind, name }
  let occId = 0;
  const entryOf = new Map(typed.map((e) => [e.ev, e]));
  for (const s of mainSessions) {
    const evs = s.events;
    const occs = [];
    const lastAt = new Map(); // triggerKey -> prompt count at its last occurrence
    let promptCount = 0;
    let prevPrompt = null;
    const addOcc = (kind, name, i) => {
      const key = `${kind}:${name}`;
      if (lastAt.get(key) === promptCount) return; // same trigger again with no prompt in between: one use
      lastAt.set(key, promptCount);
      // Sessions resumed from a handoff can trigger a skill before the user typed anything.
      occs.push({ key, kind, name, i, ts: evs[i].ts, context: prevPrompt ? snippet(prevPrompt.text) : '(start of session)' });
    };
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.kind === 'prompt') {
        if (isSlash(ev.text)) {
          const first = slashName(ev.text);
          if (first && !first.startsWith('skill:')) addOcc('command', first, i);
        }
        promptCount++;
        prevPrompt = ev;
      } else if (ev.kind === 'skill') addOcc('skill', skillName(ev.name), i);
      else if (ev.kind === 'agent' || ev.kind === 'mode') addOcc(ev.kind, ev.name, i);
    }
    const nextSame = new Map();
    for (let k = occs.length - 1; k >= 0; k--) {
      occs[k].end = nextSame.get(occs[k].key) ?? evs.length;
      nextSame.set(occs[k].key, occs[k].i);
    }
    for (const o of occs) {
      const id = occId++;
      triggerCount.set(o.key, (triggerCount.get(o.key) ?? 0) + 1);
      if (!triggerInfo.has(o.key)) triggerInfo.set(o.key, { kind: o.kind, name: o.name });
      let seen = 0;
      for (let j = o.i + 1; j < o.end && seen < FOLLOW_UP_PROMPTS; j++) {
        const ev = evs[j];
        if (ev.kind !== 'prompt') continue;
        if (ev.ts - o.ts > WINDOW_MS) break;
        seen++;
        const e = entryOf.get(ev);
        if (!e || !followable(e)) continue;
        if (!windowMembers.has(o.key)) windowMembers.set(o.key, []);
        windowMembers.get(o.key).push({ ...e, occ: id, context: o.context });
      }
    }
  }
  for (const [tKey, members] of windowMembers) {
    const { kind, name } = triggerInfo.get(tKey);
    const n = triggerCount.get(tKey);
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
            ...(target ? { target: targetOf(target) } : {}),
          },
          c.members,
          distinctOccurrences,
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
      if (!nx || nx.ts - m.ts > WINDOW_MS || !followable(nx) || inCluster.has(nx)) continue;
      members.push({ ...nx, occ: occId, context: snippet(m.text) });
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
          },
          fc.members,
          distinctOccurrences,
        ),
      );
    }
  }

  // ---- cost ----
  const bySource = {};
  const byModelMap = new Map();
  const runs = new Map(); // sub session key -> run
  for (const s of sessions.values()) {
    for (const ev of s.events) {
      if (ev.kind !== 'usage') continue;
      addUsage((bySource[s.source] ??= newTotals()), ev);
      const model = ev.model ?? 'unknown';
      if (!byModelMap.has(model)) byModelMap.set(model, newTotals());
      addUsage(byModelMap.get(model), ev);
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
  const topModel = (models) => [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  const agentMap = new Map();
  for (const r of runs.values()) {
    const a = agentMap.get(r.agent) ?? { name: r.agent, runs: 0, totals: newTotals(), list: [] };
    a.runs++;
    addTotals(a.totals, r.totals);
    a.list.push(r);
    agentMap.set(r.agent, a);
  }

  // Turns: from a typed prompt to the next one, main sessions only.
  const turns = [];
  const sessionTotals = [];
  for (const s of mainSessions) {
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
  const skillMap = new Map();
  for (const t of turns) {
    for (const name of t.skills) {
      const k = skillMap.get(name) ?? { name, uses: 0, totals: newTotals(), list: [], sessions: new Set() };
      k.uses++;
      addTotals(k.totals, t.totals);
      k.list.push(t);
      k.sessions.add(t.session.key);
      skillMap.set(name, k);
    }
  }

  const cost = {
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, t]) => [k, finish(t)])),
    byModel: [...byModelMap].map(([model, t]) => ({ model, ...finish(t) })).sort(byCost).slice(0, 10),
    byAgent: [...agentMap.values()].map((a) => ({ name: a.name, runs: a.runs, ...finish(a.totals) })).sort(byCost),
    bySkill: [...skillMap.values()].map((k) => ({ name: k.name, uses: k.uses, ...finish(k.totals) })).sort(byCost),
    topSessions: sessionTotals.sort(byCost).slice(0, 10),
  };

  // ---- costly_asset ----
  const costly = (kind, name, n, sessionsCount, totals, baseline, items, textOf) => {
    const perUse = totals.costUsd / n;
    if (!(perUse >= 2 * baseline && totals.costUsd >= 5)) return;
    const t = finish(totals);
    const asset = lookup(kind, name);
    const ratio = baseline > 0 ? `${(perUse / baseline).toFixed(1)}×` : 'n/a ×';
    const top = [...items].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, 3);
    const tsList = items.map((x) => x.ts ?? x.prompt?.ts).filter((x) => typeof x === 'number');
    findings.push({
      id: findingId('costly_asset', `${kind}:${name}`),
      type: 'costly_asset',
      hint: asset?.editable ? 'update_asset' : 'add_rule',
      title: `Costly ${kind} "${name}": $${totals.costUsd.toFixed(2)} total, $${perUse.toFixed(2)} per use (${ratio} median), cache hit ${Math.round(t.hitRate * 100)}%`,
      count: n,
      sessions: sessionsCount,
      costUsd: totals.costUsd,
      perUse,
      baseline,
      hitRate: t.hitRate,
      cacheWriteShare: cacheWriteShare(t),
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
  const runBaseline = median([...runs.values()].filter((r) => r.priced > 0).map((r) => r.totals.costUsd));
  for (const a of agentMap.values()) {
    if (a.runs >= 3) costly('agent', a.name, a.runs, a.runs, a.totals, runBaseline, a.list, () => `${a.name} run`);
  }
  const turnBaseline = median(turns.filter((t) => t.priced > 0).map((t) => t.totals.costUsd));
  for (const k of skillMap.values()) {
    if (k.uses >= 3) costly('skill', k.name, k.uses, k.sessions.size, k.totals, turnBaseline, k.list, (t) => t.prompt.text);
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

  // ---- overlapping_assets ----
  const overlapKeys = new Set();
  const overlap = (kind, list, title) => {
    if (!list.some((a) => a.editable)) return;
    const sorted = [...list].sort((a, b) => byStr(a.path, b.path));
    const key = sorted.map((a) => a.path).join('|');
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

  // ---- unused_asset ----
  for (const a of assets) {
    if (!a.editable || !['skill', 'agent', 'command'].includes(a.kind)) continue;
    if (usesOf(a) > 0 || !(a.mtimeMs < sinceMs)) continue;
    findings.push({
      id: findingId('unused_asset', a.path),
      type: 'unused_asset',
      hint: 'delete_asset',
      title: `Unused ${a.kind} "${a.name}"`,
      count: 0,
      sessions: 0,
      target: targetOf(a),
      examples: [{ text: snippet(a.description), ts: a.mtimeMs, source: a.origin, cwd: a.path }],
      firstTs: a.mtimeMs,
      lastTs: a.mtimeMs,
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
      if (d.status !== 'accepted' || !f.members) continue; // dismissed, or accepted asset finding
      const fresh = f.members.filter((m) => m.ts > d.decidedAt);
      const value = f.occurrencesOf ? f.occurrencesOf(fresh) : fresh.length;
      if (value < minCount) continue;
      const sorted = fresh.sort((a, b) => b.ts - a.ts);
      kept.push({
        ...f,
        count: fresh.length,
        sessions: new Set(fresh.map((m) => m.sessionKey)).size,
        ...(f.occurrencesOf ? { occurrences: value, rate: round3(value / f.triggerCount) } : {}),
        examples: sorted.slice(0, MAX_EXAMPLES).map(example),
        firstTs: sorted.at(-1).ts,
        lastTs: sorted[0].ts,
        reappeared: true,
      });
    }
  }

  // ---- order ----
  const score = (f) => (f.type === 'costly_asset' ? f.costUsd : (f.occurrences ?? f.count) * (f.correction ? 2 : 1));
  kept.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || score(b) - score(a) || b.lastTs - a.lastTs);

  return { window: { sinceMs, untilMs: nowMs }, totals, usage, cost, memory, findings: kept };
}
