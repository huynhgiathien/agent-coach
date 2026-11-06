// S18: skill-standards rubric (lib/standards.mjs), standard_violation findings, frontmatter parsing.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditFile, auditAssets } from '../lib/standards.mjs';
import { listAssets, parseFrontmatter } from '../lib/inventory.mjs';
import { NOW_MS as nowMs, REPO, SINCE_DAYS as sinceDays, makeHome } from './_helpers.mjs';

const { home, coachDir } = makeHome();
const skillFile = (name) => path.join(home, '.claude/skills', name, 'SKILL.md');
const ids = (audit) => audit.failed.map((f) => f.id).sort();
const majors = (audit) => audit.failed.filter((f) => f.severity === 'major');

/** A throwaway file under a fresh tmp dir; returns its absolute path. */
function scratch(rel, text, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-std-'));
  for (const [r, t] of Object.entries({ [rel]: text, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true });
    fs.writeFileSync(path.join(dir, r), t);
  }
  return path.join(dir, rel);
}
const GOOD_DESC = 'Summarize build failures for the team. Use when the user asks why CI failed. Not for flaky test triage.';
const skillText = (body, fm = `name: s\ndescription: ${GOOD_DESC}`) => `---\n${fm}\n---\n\n${body}\n`;
const DONE = '## Done when\n\n- Verify the summary names the failing step.';

let digest;
before(async () => {
  process.env.AGENT_COACH_HOME = coachDir;
  const { buildDigest } = await import('../lib/digest.mjs');
  digest = await buildDigest({ home, sinceDays, nowMs });
});

// ---- parseFrontmatter ----

test('parseFrontmatter returns { fm, body } with one nesting level', () => {
  const { fm, body } = parseFrontmatter('---\nname: "x"\nmetadata:\n  type: feedback\n---\n\nBody line.\n');
  assert.deepEqual(fm, { name: 'x', metadata: { type: 'feedback' } });
  assert.equal(body.trim(), 'Body line.');
});

// ---- auditFile on fixtures ----

test('auditFile: fixture bad-skill fails exactly trigger and links', async () => {
  const audit = await auditFile(skillFile('bad-skill'));
  assert.deepEqual(ids(audit), ['links', 'trigger']);
  assert.ok(audit.failed.every((f) => f.severity === 'major'));
  assert.equal(audit.score, 71); // 5 of 7 skill checks pass
});

test('auditFile: the links failure names the missing references/missing.md', async () => {
  const audit = await auditFile(skillFile('bad-skill'));
  assert.match(audit.failed.find((f) => f.id === 'links').detail, /references\/missing\.md/);
});

test('auditFile: fixture linear-comment passes every check (score 100)', async () => {
  const audit = await auditFile(skillFile('linear-comment'));
  assert.deepEqual(audit.failed, []);
  assert.equal(audit.score, 100);
  assert.deepEqual([audit.kind, audit.name], ['skill', 'linear-comment']);
});

test('auditFile: a missing file throws "File not found: <path>"', async () => {
  await assert.rejects(async () => auditFile('/nope/SKILL.md'), { message: 'File not found: /nope/SKILL.md' });
});

// ---- individual checks on throwaway files ----

test('frontmatter: a skill whose name differs from its dir fails (major)', async () => {
  const audit = await auditFile(scratch('other/SKILL.md', skillText(DONE)));
  assert.deepEqual(ids(audit), ['frontmatter']);
  assert.equal(audit.failed[0].severity, 'major');
});

test('size: a body of 520 lines fails (major) and points to references/', async () => {
  const body = `${DONE}\n${Array.from({ length: 520 }, (_, i) => `line ${i}`).join('\n')}`;
  const audit = await auditFile(scratch('s/SKILL.md', skillText(body)));
  assert.deepEqual(ids(audit), ['size']);
  assert.match(audit.failed[0].detail, /references\//);
});

test('size: a body of 450 lines passes', async () => {
  const lines = Array.from({ length: 450 }, (_, i) => `line ${i}`);
  const audit = await auditFile(scratch('s/SKILL.md', skillText(`${DONE}\n${lines.join('\n')}`)));
  assert.deepEqual(ids(audit), []);
});

test('size: a body over 5000 words fails even when it has few lines', async () => {
  const audit = await auditFile(scratch('s/SKILL.md', skillText(`${DONE}\n${'word '.repeat(5100)}`)));
  assert.deepEqual(ids(audit), ['size']);
});

test('links: an existing reference that is linked passes; an unlinked one fails as unreferenced', async () => {
  const file = scratch('s/SKILL.md', skillText(`Read [the guide](references/used.md) first.\n\n${DONE}`), {
    's/references/used.md': 'used',
    's/references/orphan.md': 'orphan',
  });
  const audit = await auditFile(file);
  assert.deepEqual(ids(audit), ['links']);
  assert.match(audit.failed[0].detail, /orphan\.md/);
  assert.doesNotMatch(audit.failed[0].detail, /used\.md/);
});

test('links: a references/… path mentioned in backticks still counts as referenced; http, mailto and # links are ignored', async () => {
  const body = `Read \`references/used.md\` before step 2. See [docs](https://example.com/x), [mail](mailto:a@b.c) and [top](#top).\n\n${DONE}`;
  const audit = await auditFile(scratch('s/SKILL.md', skillText(body), { 's/references/used.md': 'used' }));
  assert.deepEqual(ids(audit), []);
});

test('links: markdown links inside inline code or a fenced code block are examples, not links', async () => {
  const body = 'Index lines look like `- [Title](file.md) — note`.\n\n```markdown\n- [Other](other.md) — note\n```\n\n' + DONE;
  const audit = await auditFile(scratch('s/SKILL.md', skillText(body)));
  assert.deepEqual(ids(audit), []);
});

test('links: a references file mentioned only by a referenced references file counts as referenced', async () => {
  const file = scratch('s/SKILL.md', skillText(`Read \`references/guide.md\` first.\n\n${DONE}`), {
    's/references/guide.md': 'Load `references/helper.js` into the page.',
    's/references/helper.js': '// helper',
  });
  assert.deepEqual(ids(await auditFile(file)), []);
});

test('links: a references file mentioned only by an unreferenced references file is still unreferenced', async () => {
  const file = scratch('s/SKILL.md', skillText(DONE), {
    's/references/orphan.md': 'Load `references/chained.js` into the page.',
    's/references/chained.js': '// chained',
  });
  const audit = await auditFile(file);
  assert.deepEqual(ids(audit), ['links']);
  assert.match(audit.failed[0].detail, /chained\.js/);
  assert.match(audit.failed[0].detail, /orphan\.md/);
});

test('boundary and done: missing non-goal and missing done criteria are two minor failures', async () => {
  const fm = 'name: s\ndescription: Summarize build failures for the team. Use when the user asks why CI failed.';
  const audit = await auditFile(scratch('s/SKILL.md', skillText('Summarize the log.', fm)));
  assert.deepEqual(ids(audit), ['boundary', 'done']);
  assert.ok(audit.failed.every((f) => f.severity === 'minor'));
});

test('claims: an unmeasured "3x faster" claim fails (minor) and quotes the match', async () => {
  const audit = await auditFile(scratch('s/SKILL.md', skillText(`This is 3x faster than grep.\n\n${DONE}`)));
  assert.deepEqual(ids(audit), ['claims']);
  assert.match(audit.failed[0].detail, /^unmeasured claim: 3x faster/);
});

test('tools: an agent without a tools list fails (minor); kind is inferred from the /agents/ path', async () => {
  const text = `---\nname: helper\ndescription: ${GOOD_DESC}\n---\n\n${DONE}\n`;
  const audit = await auditFile(scratch('agents/helper.md', text));
  assert.equal(audit.kind, 'agent');
  assert.deepEqual(ids(audit), ['tools']);
  assert.equal(audit.failed[0].severity, 'minor');
});

test('trigger: a description over 1024 characters fails', async () => {
  const fm = `name: s\ndescription: Use when the user asks. Not for X. ${'word '.repeat(220)}`;
  const audit = await auditFile(scratch('s/SKILL.md', skillText(DONE, fm)));
  assert.deepEqual(ids(audit), ['trigger']);
});

test('trigger: "Use whenever …" counts as a trigger phrase', async () => {
  const fm = 'name: s\ndescription: Summarize build failures for the team. Use whenever the user asks why CI failed. Not for flaky test triage.';
  assert.deepEqual(ids(await auditFile(scratch('s/SKILL.md', skillText(DONE, fm)))), []);
});

// ---- auditAssets / digest ----

test('auditAssets scores editable skills, agents and commands only', async () => {
  const audits = await auditAssets(await listAssets({ home }));
  const byName = new Map(audits.map((a) => [a.name, a]));
  assert.equal(byName.get('linear-comment').score, 100);
  assert.ok(byName.has('audit'), 'editable agent audit.md missing');
  assert.equal(audits.some((a) => a.path.includes('/plugins/cache/')), false, 'read-only plugin skill audited');
  assert.equal(audits.some((a) => a.path.includes('/synced/')), false, 'read-only synced skill audited');
  assert.equal(audits.some((a) => a.path.includes('/memory/')), false, 'memory audited');
});

test('digest: standard_violation for bad-skill, none for linear-comment', () => {
  const violations = digest.findings.filter((f) => f.type === 'standard_violation');
  const bad = violations.find((f) => f.target?.path.endsWith('/.claude/skills/bad-skill/SKILL.md'));
  assert.ok(bad, 'bad-skill violation missing');
  assert.equal(bad.title, 'Standards: skill "bad-skill" fails trigger, links');
  assert.equal(violations.some((f) => f.target?.name === 'linear-comment'), false);
});

test('digest: standards lists every audit; markdown has a Skill standards section naming bad-skill', async () => {
  assert.equal(digest.standards.find((a) => a.name === 'linear-comment').score, 100);
  const { renderMarkdown } = await import('../lib/digest.mjs');
  const md = renderMarkdown(digest);
  const section = md.slice(md.indexOf('## Skill standards'));
  assert.ok(md.includes('## Skill standards'));
  assert.ok(section.includes('bad-skill'));
});

// ---- agent-coach's own skills ----

for (const name of ['usage-report', 'improve-workflow']) {
  test(`own skill ${name} has no failed major check`, async () => {
    const audit = await auditFile(path.join(REPO, 'skills', name, 'SKILL.md'));
    assert.deepEqual(majors(audit), []);
  });
}

test('own skill improve-workflow: references/asking.md and change-recipes.md exist and count as referenced', async () => {
  const dir = path.join(REPO, 'skills/improve-workflow');
  for (const ref of ['asking.md', 'change-recipes.md']) assert.ok(fs.existsSync(path.join(dir, 'references', ref)), `missing ${ref}`);
  const audit = await auditFile(path.join(dir, 'SKILL.md'));
  assert.equal(audit.failed.some((f) => f.id === 'links'), false, JSON.stringify(audit.failed));
});
