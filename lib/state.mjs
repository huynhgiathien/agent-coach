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

/** `{ [findingId]: { status, note, decidedAt } }`; `{}` when no decision was recorded yet. */
export async function readDecisions(home) {
  const data = await readJson(path.join(coachDir(home), 'decisions.json'));
  return data?.decisions ?? {};
}

export async function recordDecision(home, { id, status, note } = {}) {
  if (!STATUSES.includes(status)) throw new Error('status must be accepted or dismissed');
  if (typeof id !== 'string' || !id) throw new Error('finding id is required');
  const decisions = await readDecisions(home);
  decisions[id] = { status, note: note ?? null, decidedAt: Date.now() };
  await writeJson(path.join(coachDir(home), 'decisions.json'), { version: 1, decisions }, 2);
}

export const writeLastDigest = (home, digest) => writeJson(path.join(coachDir(home), 'last-digest.json'), digest);

/** The digest stored by the last usage_digest run, or null. */
export async function readLastDigest(home) {
  return (await readJson(path.join(coachDir(home), 'last-digest.json'))) ?? null;
}
