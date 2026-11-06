// S17: self-contained, escaped HTML dashboard written under the coach dir.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderHtml, writeDashboard, openInBrowser } from '../lib/dashboard.mjs';
import { CURSOR_DB, CURSOR_SECRET, HAS_SQLITE, NOW_MS as nowMs, SECRET, SINCE_DAYS as sinceDays, makeHome } from './_helpers.mjs';

const skip = !HAS_SQLITE && 'no node:sqlite';
const { home, coachDir } = makeHome();
process.env.AGENT_COACH_HOME = coachDir;
process.env.AGENT_COACH_NO_OPEN = '1';
const { buildDigest } = await import('../lib/digest.mjs');

let digest;
let html;
before(async () => {
  digest = await buildDigest({ home, sinceDays, nowMs });
  html = renderHtml(digest);
});

test('html is one complete document with an inline style', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  assert.equal((html.match(/<style[\s>]/g) ?? []).length, 1);
});

test('html has the overview, activity, cost, findings and standards sections and an SVG chart', () => {
  for (const id of ['overview', 'activity', 'cost', 'findings', 'standards']) {
    assert.match(html, new RegExp(`<section id="${id}"`), `section ${id} missing`);
  }
  assert.ok(html.includes('<svg'));
});

test('html loads nothing external and runs no script', () => {
  assert.equal(/<script/i.test(html), false);
  assert.equal(/\b(src|href)="https?:/i.test(html), false);
  assert.equal(/@import|@font-face|url\(\s*['"]?https?:/i.test(html), false);
});

test('html escapes prompt text taken from the Cursor chat', { skip }, () => {
  assert.ok(html.includes('review this &lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(html.includes('<img src=x'), false);
});

test('html escapes & < > " \' in every digest-derived string', () => {
  const f = digest.findings[0];
  const tricky = { ...digest, findings: [{ ...f, title: `T & <b>bold</b> "q" 'a'` }, ...digest.findings.slice(1)] };
  const out = renderHtml(tricky);
  assert.ok(out.includes('T &amp; &lt;b&gt;bold&lt;/b&gt; &quot;q&quot; '), 'title not escaped');
  assert.match(out, /&quot;q&quot; (&#39;|&#x27;|&apos;)a(&#39;|&#x27;|&apos;)/);
  assert.equal(out.includes('<b>bold</b>'), false);
});

test('overview shows the cost basis next to each source', () => {
  const start = html.indexOf('<section id="overview"');
  const overview = html.slice(start, html.indexOf('</section>', start));
  for (const label of ['recorded', 'allocated', 'unpriced']) assert.ok(overview.includes(label), `missing ${label}`);
});

test('activity bars carry a per-day tooltip with prompts and cost', () => {
  assert.match(html, /<title>2026-10-20: 1 prompts?, \$0\.20<\/title>/);
});

test('warnings section appears only when readers warned', { skip }, async () => {
  assert.equal(html.includes('<section id="warnings"'), false);
  const { home: broken, coachDir: state } = makeHome();
  fs.writeFileSync(path.join(broken, CURSOR_DB), 'not a database '.repeat(500));
  process.env.AGENT_COACH_HOME = state;
  try {
    const warned = renderHtml(await buildDigest({ home: broken, sinceDays, nowMs }));
    assert.ok(warned.includes('<section id="warnings"'));
    assert.ok(warned.includes('Cursor chat DB unreadable: '));
  } finally {
    process.env.AGENT_COACH_HOME = coachDir;
  }
});

test('secrets reach neither the html nor last-digest.json', () => {
  const stored = fs.readFileSync(path.join(coachDir, 'last-digest.json'), 'utf8');
  for (const secret of [CURSOR_SECRET, SECRET]) {
    assert.equal(html.includes(secret), false, `${secret} in html`);
    assert.equal(stored.includes(secret), false, `${secret} in last-digest.json`);
  }
});

test('writeDashboard writes <coachDir>/dashboard.html and returns its absolute path', async () => {
  const file = await writeDashboard(home, digest);
  assert.equal(file, path.join(coachDir, 'dashboard.html'));
  assert.match(fs.readFileSync(file, 'utf8'), /^<!doctype html>[\s\S]*<section id="findings"/i);
});

test('openInBrowser resolves false under AGENT_COACH_NO_OPEN=1', async () => {
  assert.equal(await openInBrowser(path.join(coachDir, 'dashboard.html')), false);
});
