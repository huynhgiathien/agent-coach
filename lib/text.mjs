// Prompt normalization, classification and clustering.

const STOPWORDS = new Set(
  'a an the to of for in on at me my i you your it its this that please pls plz can could would will give make just and or with be is are so'.split(' '),
);
const ACKS = new Set([
  'yes', 'y', 'ok', 'okay', 'go', 'go ahead', 'continue', 'proceed', 'do it', 'sure', 'n', 'approve', 'approved', 'lgtm',
  'thanks', 'thank you', 'next', 'done',
]);
const CORRECTION =
  /\b(short|shorter|shorten|concise|brief|longer|detail|again|instead|wrong|not|don t|dont|no|fix|forgot|missing|redo|revert|change|update|version|format|simpler|also|remove|without)\b/;
const STANDING = /\b(always|never|don t|do not|remember|make sure|from now on)\b/;

/** Lowercase, replace URLs/ticket keys/paths/numbers with placeholders, strip punctuation. */
export function normalize(text) {
  return String(text ?? '')
    .slice(0, 2000)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/\b[a-z]{2,10}-\d+\b/g, ' key ')
    .replace(/(?:~|\.{0,2})\/[\w.\/-]+/g, ' path ')
    .replace(/\b\d+\b/g, ' n ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words of a normalized string. */
export const tokens = (normalized) => normalized.split(' ').filter((t) => t && !STOPWORDS.has(t));

export const isAck = (normalized) => ACKS.has(normalized);
export const isCorrection = (normalized) => CORRECTION.test(normalized);
export const isStandingPreference = (normalized) => STANDING.test(normalized);

/** Collapse whitespace and cut to at most `max` characters, ending with an ellipsis when cut. */
export function snippet(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const SHORT_TOKENS = 12;
const THRESHOLD = 0.5;

function shingles(toks) {
  const out = new Set();
  for (let i = 0; i + 3 <= toks.length; i++) out.add(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  return out;
}

/** Jaccard similarity of two sets; 0 when both are empty. */
export function jaccard(a, b) {
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Greedy clustering of entries `{ key, ... }` (key = normalized text). Exact-key groups are taken
 * largest first; each joins the first earlier cluster of the same length class whose rep has
 * Jaccard similarity >= 0.5 (token sets for <= 12 tokens, word 3-shingles otherwise).
 * Candidate clusters are found through a rare-token-first prefix index, which is exact for Jaccard.
 * Returns `[{ rep, members, tokenCount }]` in creation order.
 */
export function clusterTexts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.key) continue;
    let g = groups.get(entry.key);
    if (!g) {
      const toks = tokens(entry.key);
      if (!toks.length) continue;
      const long = toks.length > SHORT_TOKENS;
      g = { key: entry.key, members: [], tokenCount: toks.length, long, set: long ? shingles(toks) : new Set(toks) };
      if (!g.set.size) continue;
      groups.set(entry.key, g);
    }
    g.members.push(entry);
  }
  const sorted = [...groups.values()].sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Global order: rarest feature first, so prefixes are short and selective.
  const freq = new Map();
  for (const g of sorted) for (const f of g.set) freq.set(f, (freq.get(f) ?? 0) + 1);
  const order = (set) => [...set].sort((a, b) => freq.get(a) - freq.get(b) || (a < b ? -1 : a > b ? 1 : 0));
  const prefix = (ordered) => ordered.slice(0, ordered.length - Math.ceil(THRESHOLD * ordered.length) + 1);

  const clusters = [];
  const index = [new Map(), new Map()]; // [short, long]: feature -> cluster indexes (ascending)
  for (const g of sorted) {
    const idx = index[g.long ? 1 : 0];
    const pre = prefix(order(g.set));
    const candidates = new Set();
    for (const f of pre) for (const c of idx.get(f) ?? []) candidates.add(c);
    let target = -1;
    for (const c of [...candidates].sort((a, b) => a - b)) {
      const rep = clusters[c];
      if (rep.set.size * 2 < g.set.size || g.set.size * 2 < rep.set.size) continue;
      if (jaccard(rep.set, g.set) >= THRESHOLD) {
        target = c;
        break;
      }
    }
    if (target >= 0) {
      clusters[target].members.push(...g.members);
      continue;
    }
    const c = clusters.length;
    clusters.push({ rep: g.key, members: [...g.members], tokenCount: g.tokenCount, set: g.set });
    for (const f of pre) {
      let list = idx.get(f);
      if (!list) idx.set(f, (list = []));
      list.push(c);
    }
  }
  return clusters.map(({ rep, members, tokenCount }) => ({ rep, members, tokenCount }));
}
