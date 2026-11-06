# Change recipes: from a finding to a proposed change

Read the target file before proposing. Every proposal names absolute paths and shows the exact diff.

- **`follow_up` with a target**: update that skill, agent or command so its default output already does what
  the follow-up asks. Canonical example: the `linear-comment` skill is often followed by "shorter version", so
  make it output a normal version and a shorter version.
- **`follow_up` without a target, or hint `add_rule`**: add one rule line to the context file of the CLI the
  examples come from:
  - omp → `~/.omp/agent/AGENTS.md`
  - claude → `~/.claude/CLAUDE.md`
  - codex → `~/.codex/AGENTS.md`
  - cursor → `~/.cursor/rules/agent-coach.mdc`. Create it if it is missing, with frontmatter
    `description: Standing preferences learned by agent-coach` and `alwaysApply: true`, then add one `- ` line
    per rule. Tell the user: if Cursor does not apply it, paste the line into Cursor Settings → Rules → User Rules.
- **`repeated_prompt` with hint `create_asset`**:
  - For a multi-step or long instruction, create a skill at `~/.claude/skills/<kebab-name>/SKILL.md`. omp,
    Claude Code and Cursor all load this path.
  - For a fixed one-shot instruction, create a command at `~/.claude/commands/<kebab-name>.md`. For
    cursor-only examples, create it at `~/.cursor/commands/<kebab-name>.md`.
  - Say that Codex needs a copy in `~/.codex/skills/` if the user wants it there.
  - New skills must pass `check_asset`: a description with "Use when …" and a "Not for …" boundary, a
    `## Done when` list, and at most 500 lines.
- **`overlapping_assets`**: merge into the more-used editable asset (the finding's `target`). Trash the other
  only if it is editable.
- **`unused_asset`**: delete by moving the asset to a `.trash` folder:
  - skill → `~/.claude/skills/.trash/<name>-<YYYYMMDD>/` (that folder already exists; follow its convention)
  - agent → `<agents dir>/.trash/<name>-<YYYYMMDD>.md`
  - command → `<commands dir>/.trash/<name>-<YYYYMMDD>.md`
- **`costly_asset`**:
  - Agent: propose a cheaper `model:` in its frontmatter, a narrower `tools:` list, or a shorter body. A low
    cache hit rate or a high cache-write share means each run re-writes the prompt cache, so propose reusing
    one agent over spawning new ones.
  - Skill: propose moving rarely needed detail out of `SKILL.md` into a `references/<topic>.md` file that the
    skill reads only when needed.
  - Quote the cost numbers with their basis label (`recorded`, `allocated`). Never quote `unpriced` token
    counts as dollars.
- **`memory_promotion`**:
  1. Write the shared preference as one rule in the context file (as for `add_rule`), or as a step in the
     skill it concerns.
  2. Move each promoted memory file to `<memory dir>/.trash/<file>`.
  3. Delete its line from that project's `MEMORY.md` index. Index lines look like `- [Title](file.md) — …`;
     match on `(file.md)`.
- **`overlapping_assets` of kind memory**: merge the content into the newer file, trash the older one, and fix
  the `MEMORY.md` index line.
- **`standard_violation`**: fix each failed check:
  - `frontmatter` → add the missing `name`/`description`;
  - `trigger` → rewrite the description as "<what it does>. Use when <trigger phrases>.";
  - `boundary` → append "Not for <X>; use <Y>." where Y is the overlapping asset, or else
    "Not for <closest non-goal>.";
  - `size` → move whole sections into `references/<topic>.md` and link each from the body with
    when-to-read guidance;
  - `links` → fix the path or delete the dead link, and link or delete each unreferenced reference file;
  - `done` → add a `## Done when` checklist of observable results;
  - `claims` → replace with a measured number plus its method, or delete;
  - `tools` → add a least-privilege `tools:` list based on what the agent body actually uses.
- **Impact `worse` / `no_change`** (`revise`): propose a different change on the same target. Cite
  before → after. Never re-apply the same diff.

Verify each recipe's result with `check_asset` (skills, agents, commands) before reporting it done.
