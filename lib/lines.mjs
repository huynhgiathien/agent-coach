// File helpers for the session readers: line iteration, directory listing, bounded parallel reads.

import fs from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** A recorded file path with a leading `~` or `~/` expanded to `home`; any other path unchanged. */
export const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

const MAX_IN_MEMORY = 256 * 1024 * 1024;

/** Call `fn(line)` for every line of `path`, in order. */
export async function forEachLine(path, fn) {
  const { size } = await fs.promises.stat(path);
  if (size <= MAX_IN_MEMORY) {
    const text = await fs.promises.readFile(path, 'utf8');
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      fn(text.slice(start, end));
      start = end + 1;
    }
    return;
  }
  const rl = createInterface({ input: fs.createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

/** Directory entries (`Dirent[]`), sorted by name; `[]` when the directory is missing or unreadable. */
export async function readDir(path) {
  try {
    return (await fs.promises.readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Run `fn(path)` → `Event[]` over files modified at or after `sinceMs`, a few at a time.
 * Unreadable files are skipped. Results are concatenated in `paths` order.
 */
export async function mapFiles(paths, sinceMs, fn, concurrency = 4) {
  const results = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const i = next++;
      try {
        if ((await fs.promises.stat(paths[i])).mtimeMs < sinceMs) continue;
        results[i] = await fn(paths[i]);
      } catch {
        // unreadable file: skip
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results.flatMap((r) => r ?? []);
}
