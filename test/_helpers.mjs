// Shared constants for the test suite. Not a test file (no `.test.` in the name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/home', import.meta.url));
export const NOW_MS = Date.parse('2026-11-01');
export const SINCE_DAYS = 90;
export const SINCE_MS = NOW_MS - SINCE_DAYS * 86_400_000;
export const SECRET = 'sk-abcdefghijklmnopqrstuv12';

const OLD = new Date('2020-01-01T00:00:00Z');
// Files that must look older than the analysis window: unused-asset candidates and memories
// (memories must never be reported as unused even when old).
const AGED = [
  '.claude/skills/old-skill/SKILL.md',
  '.claude/plugins/cache/m/p/1.0.0/skills/plug/SKILL.md',
  '.claude/projects/-a/memory/p1.md',
  '.claude/projects/-a/memory/r1.md',
  '.claude/projects/-a/memory/d1.md',
  '.claude/projects/-a/memory/d2.md',
  '.claude/projects/-b/memory/p2.md',
  '.claude/projects/-c/memory/u1.md',
];

export async function ageFixtures() {
  await Promise.all(AGED.map((rel) => fs.promises.utimes(path.join(FIXTURE_HOME, rel), OLD, OLD)));
}

export const tmpCoachHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coach-test-'));

/** True when any string inside the value contains `needle`. */
export const mentions = (value, needle) => JSON.stringify(value).includes(needle);
