---
name: improve-workflow
description: Turn my Claude Code, Codex, Cursor and omp history into concrete changes — update a skill/agent when I keep correcting its output, it costs too much, or it fails the skill standards; create a skill or command for prompts I repeat; add standing rules; promote recurring memories; merge overlapping and delete unused skills/agents/memories; route repo skills in a multi-repo workspace. Proposes diffs and lets me pick which to apply. Use when the user asks to improve their workflow, skills, agents, memories, cost, plan or prompts. Not for usage stats alone; use usage-report.
argument-hint: "[days] [skill-or-agent name] [workspace <path>]"
---

# Improve my agent workflow

Use the plugin's MCP tools `usage_digest`, `workspace_scan`, `finding_examples`, `check_asset` and
`record_decision`.
Propose first; write nothing until the user selects changes.

1. Read `references/asking.md` now; every question in this skill follows it. Read
   `references/change-recipes.md` before step 4.
2. Call `usage_digest` with `since_days` set to the first argument (default 90). If a skill, agent or
   command name is given, also pass it as `name`; the digest then lists only the findings whose trigger or
   target has that name. Keep only the impact rows whose title contains that name.
2b. Workspace. If the current folder has 2 or more child dirs that contain `.git`, or the arguments contain
   `workspace <path>`, call `workspace_scan` with that path (else the current folder) and the same
   `since_days`. Add its findings to the pool for step 4 with change type `workspace`. Build them with the
   Workspace section of `references/change-recipes.md`: workspace-level skills are edited after the user
   picks them; repo-level skills are only shown as patches.
3. Impact first. For each `## Impact of accepted changes` row with verdict `worse` or `no_change`, add a
   `revise` proposal for the same target that changes it differently. Cite before → after and the samples.
   Mention each `improved` row in one line.
4. Pick the top 10 findings or fewer.
   - Discard noise first: findings whose examples are not prompts the user typed (pasted logs, agent or
     teammate messages, one-off chat).
   - Merge findings that mean the same thing; for example, a `follow_up` and a `repeated_prompt` for
     "shorter version" become one proposal.
   - After discarding and merging, keep filling up to 10 proposals from the remaining sections in digest
     order: costly assets, memory promotion, skill standards, overlapping assets, unused assets. Stop early
     only when no findings are left.
   - The markdown shows only part of a long digest (it ends with "N findings omitted"). For findings beyond
     it, call `usage_digest` with `format: json` or `finding_examples` with the finding id.
   - Call `finding_examples` whenever 3 examples do not make the intent clear.
   - Read each target file before proposing a change to it.
   - Build each change by following `references/change-recipes.md`.
5. Show the proposals as a numbered markdown list. Each item has:
   - the change type: `update`, `create`, `rule`, `promote`, `merge`, `delete`, `revise` or `workspace`;
   - the absolute path of every file it edits or creates (expand `~`, for example
     `/Users/<you>/.claude/skills/linear-comment/SKILL.md`);
   - the exact absolute `.trash` destination of every file it moves, including each memory file moved by a
     memory promotion or merge, and the absolute path of each `MEMORY.md` index it changes;
   - a one-line evidence summary (counts, rate, date range; costs with their basis label) and 1–2 redacted
     examples;
   - the exact change inside `<details><summary>Proposed change</summary>`: a unified diff for edits, the
     full file for creates.

   Nothing is written yet.
6. Ask "Apply which changes?" as a multi-select over the proposal numbers. Then ask "Dismiss which of the
   others forever?" as a multi-select over the proposals that were not selected; skip it when none are left.
   Both questions follow `references/asking.md`.
7. Apply only the selected proposals. Keep each file's frontmatter `name` and its existing structure and voice.
8. Verify: call `check_asset` on every skill, agent or command file created or edited. Fix any major failure
   the change introduced and call `check_asset` again.
9. Call `record_decision`: `accepted` for each applied finding, `dismissed` for each finding the user chose
   to dismiss. Record nothing for the rest.
10. Report every changed path with its final `check_asset` score. Say that the Impact section of future
    reports compares before and after once 3 or more new uses have happened.

## Rules

- Never edit read-only assets (`editable: false`: plugin caches, `skills/synced`, `.codex/skills/.system`,
  `.cursor/skills-cursor`). For those, show the proposed change against the plugin's source repository instead.
- Never write a file inside a repo of a workspace (`editable: false` in `workspace_scan`); show a patch for
  its main checkout instead. Never touch worktree copies.
- Never delete outright; move to `.trash`.
- Never read raw session logs or Cursor's database. The digest and examples are already redacted.
- Never print secrets.
- No answer, or an unclear answer after one re-ask, means apply nothing.
- Memory files are editable only when `editable: true`. omp `MEMORY.md` and `memory_summary.md` are
  regenerated by omp, so propose changes to `learned.md` or to a context file instead.

## Done when

- Every selected proposal is applied and nothing else changed.
- Every created or edited skill, agent or command passes `check_asset` with no major failure.
- `record_decision` was called once per applied or dismissed finding.
- Each changed path is reported with its score.
