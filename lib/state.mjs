// Persistent state in the coach dir: decisions.json and last-digest.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUSES = ['accepted', 'dismissed'];

/** `$AGENT_COACH_HOME`, else `<home>/.agent-coach`. */
export const coachDir = (home = os.homedir()) => process.env.AGENT_COACH_HOME ?? path.join(home, '.agent-coach');

async function readJson(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Corrupt ${file}; fix or delete it`);
  }
}

async function writeJson(file, value, indent) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, indent)}\n`);
  await fs.promises.rename(tmp, file);
}

/** `{ [findingId]: { status, note, decidedAt, snapshot } }`; `{}` when no decision was recorded yet. */
export async function readDecisions(home) {
  const data = await readJson(path.join(coachDir(home), 'decisions.json'));
  return data?.decisions ?? {};
}

const WEEK_MS = 604_800_000;

/** What the Impact section compares later: the finding's identity and its metric at decision time. */
function snapshotOf(digest, id) {
  const f = digest?.findings?.find((x) => x.id === id);
  if (!f) return null;
  let baseline = null;
  if (f.type === 'follow_up') baseline = { metric: 'rate', value: f.rate, samples: f.triggerCount };
  else if (f.type === 'repeated_prompt') {
    // A reappeared finding counts only prompts after its earlier decision, so measure the same span.
    const weeks = (digest.window.untilMs - Math.max(digest.window.sinceMs, f.decidedAt ?? 0)) / WEEK_MS;
    baseline = { metric: 'perWeek', value: Math.round((f.count / weeks) * 1000) / 1000, samples: f.count };
  } else if (f.type === 'costly_asset') baseline = { metric: 'costPerUse', value: f.perUse, samples: f.count };
  const subject = f.trigger ?? f.target;
  return {
    type: f.type,
    title: f.title,
    ...(f.rep !== undefined ? { rep: f.rep } : {}),
    ...(f.triggerKey !== undefined ? { triggerKey: f.triggerKey } : {}),
    ...(subject ? { kind: subject.kind, name: subject.name } : {}),
    baseline,
  };
}

/**
 * Record a decision with a snapshot of the finding from the last digest, so later digests can measure the
 * change. When the last digest no longer has the finding (accepted findings are hidden), the stored snapshot
 * and its baseline are kept and only the status and decision time change. Returns the confirmation text,
 * naming the baseline when there is one.
 */
export async function recordDecision(home, { id, status, note } = {}) {
  if (!STATUSES.includes(status)) throw new Error('status must be accepted or dismissed');
  if (typeof id !== 'string' || !id) throw new Error('finding id is required');
  const [decisions, digest] = await Promise.all([readDecisions(home), readLastDigest(home)]);
  const snapshot = snapshotOf(digest, id) ?? decisions[id]?.snapshot ?? null;
  decisions[id] = { status, note: note ?? null, decidedAt: Date.now(), snapshot };
  await writeJson(path.join(coachDir(home), 'decisions.json'), { version: 1, decisions }, 2);
  const b = snapshot?.baseline;
  return `Recorded ${status} for ${id}.${b ? ` Baseline: ${b.metric} ${b.value} over ${b.samples} samples; the Impact section will compare future use.` : ''}`;
}

export const writeLastDigest = (home, digest) => writeJson(path.join(coachDir(home), 'last-digest.json'), digest);

/** The digest stored by the last usage_digest run, or null. */
export async function readLastDigest(home) {
  return (await readJson(path.join(coachDir(home), 'last-digest.json'))) ?? null;
}
