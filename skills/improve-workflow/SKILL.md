---
name: improve-workflow
description: Turn my Claude Code, Codex and omp history into concrete changes — update a skill/agent when I keep correcting its output or it costs too much, create a skill or command for prompts I repeat, add standing rules to AGENTS.md/CLAUDE.md, promote recurring memories into rules or skills, merge overlapping and delete unused skills/agents/memories. Proposes diffs; edits only what I confirm. Use when the user asks to improve their workflow, skills, agents, memories, cost, plan or prompts.
argument-hint: "[days] [skill-or-agent name]"
---

# Improve my agent workflow

Use the plugin's MCP tools `usage_digest`, `finding_examples` and `record_decision`. Propose first; write nothing until the user confirms.

1. Call `usage_digest` with `since_days` set to the first argument (default 90). If a skill, agent or command name is given, also pass it as `name`; the digest then lists only the findings whose trigger or target has that name.
2. Pick the top 10 findings or fewer. Merge findings that mean the same thing; for example, a `follow_up` and a `repeated_prompt` for "shorter version" become one proposal. Call `finding_examples` whenever 3 examples do not make the intent clear. Read each target file before proposing a change to it.
3. Map each finding to a change:
   - **`follow_up` with a target**: update that skill, agent or command so its default output already does what the follow-up asks. Canonical example: the `linear-comment` skill is often followed by "shorter version", so make it output a normal version and a shorter version.
   - **`follow_up` without a target, or hint `add_rule`**: add one rule line to the context file of the CLI the examples come from:
     - omp → `~/.omp/agent/AGENTS.md`
     - claude → `~/.claude/CLAUDE.md`
     - codex → `~/.codex/AGENTS.md`
   - **`repeated_prompt` with hint `create_asset`**:
     - For a multi-step or long instruction, create a skill at `~/.claude/skills/<kebab-name>/SKILL.md`. omp and Claude Code both load this path.
     - For a fixed one-shot instruction, create a command at `~/.claude/commands/<kebab-name>.md`.
     - Say that Codex needs a copy in `~/.codex/skills/` if the user wants it there.
   - **`overlapping_assets`**: merge into the more-used editable asset (the finding's `target`). Trash the other only if it is editable.
   - **`unused_asset`**: delete by moving the asset to a `.trash` folder:
     - skill → `~/.claude/skills/.trash/<name>-<YYYYMMDD>/` (that folder already exists; follow its convention)
     - agent → `<agents dir>/.trash/<name>-<YYYYMMDD>.md`
     - command → `<commands dir>/.trash/<name>-<YYYYMMDD>.md`
   - **`costly_asset`**:
     - Agent: propose a cheaper `model:` in its frontmatter, a narrower `tools:` list, or a shorter body. A low cache hit rate or a high cache-write share means each run re-writes the prompt cache, so propose reusing one agent over spawning new ones.
     - Skill: propose moving rarely needed detail out of `SKILL.md` into a `references/<topic>.md` file that the skill reads only when needed.
     - Quote the cost numbers as evidence.
   - **`memory_promotion`**:
     1. Write the shared preference as one rule in the context file (as for `add_rule`), or as a step in the skill it concerns.
     2. Move each promoted memory file to `<memory dir>/.trash/<file>`.
     3. Delete its line from that project's `MEMORY.md` index. Index lines look like `- [Title](file.md) — …`; match on `(file.md)`.
   - **`overlapping_assets` of kind memory**: merge the content into the newer file, trash the older one, and fix the `MEMORY.md` index line.
4. Show a numbered list. Each item has:
   - the change type: `update`, `create`, `rule`, `promote`, `merge` or `delete`;
   - the absolute path of every file it edits or creates (expand `~`; for example `/Users/<you>/.claude/skills/linear-comment/SKILL.md`);
   - the exact absolute `.trash` destination of every file it moves, including each memory file moved by a memory promotion or merge, and the absolute path of each `MEMORY.md` index it changes;
   - evidence: counts, rate, date range, and 1–2 redacted examples;
   - the exact proposed change: a unified diff for edits, or the full file for creates.

   Nothing is written yet.
5. Ask which numbers to apply (`all`, `none`, or a list), and which rejected ones to dismiss forever. Apply only the confirmed numbers. Keep each file's frontmatter `name` and its existing structure and voice.
6. Call `record_decision`: `accepted` for each applied finding, `dismissed` for each finding the user said to dismiss. Record nothing for deferred items.
7. Report every changed path. Say that an accepted pattern will reappear in the digest if it continues after today.

Rules:

- Never edit read-only assets (`editable: false`: plugin caches, `skills/synced`, `.codex/skills/.system`). For those, show the proposed change against the plugin's source repository instead.
- Never delete outright; move to `.trash`.
- Never read raw session logs. The digest and examples are already redacted.
- Never print secrets.
- Memory files are editable only when `editable: true`. omp `MEMORY.md` and `memory_summary.md` are regenerated by omp, so propose changes to `learned.md` or to a context file instead.
