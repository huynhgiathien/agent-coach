# Agent Coach plugin

Improve your Claude Code, Codex and omp setup from your own history. Agent Coach reads the session
transcripts, token and cost usage, and memory files these CLIs already keep on your machine, and finds:

- prompts you type again and again;
- corrections you keep making after a skill, agent, mode or command (for example "shorter version"
  right after the `linear-comment` skill);
- unused or overlapping skills, agents, commands and memories;
- costly skills and agents, with their prompt-cache hit rates;
- memories that should become a skill step or an AGENTS.md/CLAUDE.md rule.

The Node code does the counting and clustering. The agent running the skill does the judgement and
writes the changes, and it edits files only after you confirm. There are no hooks, no API calls and no
network access.

## What it adds

- MCP tools:
  - `usage_digest`: the analysis as markdown (at most 40 000 characters) or JSON. Every finding has an id.
    Pass `name` (for example `linear-comment`) to list only the findings whose trigger or target has that
    name; the stored digest stays complete, so `finding_examples` works for any id.
  - `list_assets`: skills, agents, commands, context files and memories, with uses and paths.
  - `finding_examples`: the stored, redacted examples of one finding.
  - `record_decision`: mark a finding `accepted` or `dismissed`. Dismissed findings never come back;
    accepted ones come back only if the pattern keeps happening afterwards.
- Skills:
  - `usage-report` (read-only), for requests such as "show my agent usage report", "what do I spend on
    subagents?", "which skills do I never use?".
  - `improve-workflow`, for requests such as "improve my workflow", "improve the linear-comment skill",
    "clean up my memories". It shows numbered proposals with diffs and applies only the numbers you pick.
- The `agent-coach` CLI (`bin/`):

  ```sh
  agent-coach digest [--days N] [--source omp,claude,codex] [--min-count N] [--name skill-or-agent] [--all] [--json]
  agent-coach assets [--kind skill|agent|command|context|memory]
  agent-coach examples <finding-id> [--limit N]
  agent-coach decide <finding-id> accepted|dismissed [--note text]
  ```

Requires Node.js 20 or later on your PATH. No npm dependencies.

## Install

### Prompt your agent to set it up

Paste this into Claude Code, Codex or omp:

```text
Set up the Agent Coach plugin from https://github.com/huynhgiathien/agent-coach. Read its README first.
1. Install it for every agent CLI on my PATH (claude, codex, omp) using the commands in the README's Install section. Show me each command before running it.
2. Tell me to start a new session and test it there with "show my agent usage report". Do not change any skill, agent or memory during setup.
```

### One command

Installs it in Claude Code, Codex and omp, whichever are on your PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/huynhgiathien/agent-coach/main/install.sh | sh
```

The script runs these commands; run them yourself to install in only one CLI:

```sh
claude plugin marketplace add huynhgiathien/agent-coach
claude plugin install agent-coach@agent-coach-plugin

codex plugin marketplace add huynhgiathien/agent-coach
codex plugin add agent-coach@agent-coach-plugin

omp plugin marketplace add huynhgiathien/agent-coach
omp plugin install agent-coach@agent-coach-plugin
```

No token or configuration is needed. Start a new session after installing.

### Local install, without a marketplace

Clone the repository:

```sh
git clone https://github.com/huynhgiathien/agent-coach ~/agent-coach
```

Then either add the clone as a marketplace in omp:

```sh
omp plugin marketplace add ~/agent-coach
omp plugin install agent-coach@agent-coach-plugin
```

or load it in Claude Code for one session:

```sh
claude --plugin-dir ~/agent-coach
```

To register only the MCP tools:

```sh
claude mcp add agent-coach --scope user -- node ~/agent-coach/server.mjs
codex mcp add agent-coach -- node ~/agent-coach/server.mjs
```

To also get the skills, copy `skills/usage-report` and `skills/improve-workflow` into `~/.claude/skills/`
or `~/.agents/skills/`. Run `git pull` in the clone to update.

## What it reads

Everything is read-only, except the plugin's own state in `~/.agent-coach`.

- **omp sessions**: `~/.omp/agent/sessions/<dir>/*.jsonl` (main sessions) and every deeper `*.jsonl`
  (subagent sessions). Typed prompts, `/skill:` invocations, `skill://` reads, `task` subagent calls,
  plan and other modes, interrupts, and per-message token usage and cost.
- **Claude Code sessions**: `~/.claude/projects/<project>/*.jsonl` and
  `<project>/<session>/subagents/agent-*.jsonl` with their `.meta.json`. Typed prompts, slash commands,
  queued prompts, `Skill` and `Agent` tool calls, token usage, and the session's `cost-state` record.
  Claude Code records cost per session and model only, so per-message cost is allocated from that total
  by token price ratios (input 1, output 5, cache read 0.1, cache write 1.25). Session totals are exact;
  skill and agent costs are proportional estimates. Subagent transcripts have no cost record, so their
  usage is counted in tokens and shown as "unpriced". Claude Code deletes transcripts after
  `cleanupPeriodDays` (about 30 days by default), so older Claude history is not available.
- **Codex sessions**: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, interactive sessions only
  (`codex exec` and SDK runs are skipped). Typed prompts, `$skill` mentions, `SKILL.md` reads,
  `spawn_agent` calls and `token_count` usage. Codex records no cost.
- **Skills**: `~/.claude/skills/*/SKILL.md`, `~/.claude/skills/synced/*/*/SKILL.md` (read-only),
  `~/.omp/agent/skills`, `~/.omp/agent/managed-skills`, `~/.agents/skills`, `~/.codex/skills`,
  `~/.codex/skills/.system` (read-only), and the newest version of each plugin in
  `~/.claude/plugins/cache`, `~/.codex/plugins/cache` and `~/.omp/plugins/cache/plugins` (read-only).
- **Agents and commands**: `~/.claude/agents/*.md`, `~/.omp/agent/agents/*.md`,
  `~/.claude/commands/**/*.md`, `~/.omp/agent/commands/*.md`, `~/.codex/prompts/*.md`.
- **Context files**: `~/.claude/CLAUDE.md`, `~/.omp/agent/AGENTS.md`, `~/.codex/AGENTS.md`.
- **Memories**: Claude Code project memories in `~/.claude/projects/<project>/memory/*.md` (the
  `MEMORY.md` index is kept in sync when a memory is merged or trashed), and omp memories in
  `~/.omp/agent/memories/<project>/` (`learned.md` is editable; `MEMORY.md` and `memory_summary.md`
  are regenerated by omp and treated as read-only). Codex memories are not read.

It never opens credential files (`auth_credentials`, `.credentials.json`) or SQLite databases.

## Privacy

Agent Coach runs locally and makes no network requests. Prompt text is redacted before it is stored or
shown: API keys, GitHub/Slack/AWS tokens, JWTs, bearer tokens, `password=…`-style values, plain-language
passwords, and long hex or base64 strings become `[REDACTED]`. Its state lives in `~/.agent-coach`
(`decisions.json` and `last-digest.json`); set `AGENT_COACH_HOME` to move it, and delete the directory
to reset it. There is no telemetry.

## Troubleshooting

- **"No digest yet. Run usage_digest first."**: `finding_examples` and `examples` read the last digest.
  Run `usage_digest` (or `agent-coach digest`) once, then retry.
- **"Unknown finding … Run usage_digest again."**: the id comes from an older digest. Run the digest again.
- **"Corrupt …/decisions.json"**: fix or delete the file named in the message.
- **Tools missing in a session**: check that `node` is on the PATH of the app that runs the agent.

## Support

Open an issue at https://github.com/huynhgiathien/agent-coach/issues.

## License

MIT
