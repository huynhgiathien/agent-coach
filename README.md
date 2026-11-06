# Agent Coach plugin

Improve your Claude Code, Codex, Cursor and omp setup from your own history. Agent Coach reads the session
transcripts, chat stores, token and cost usage, and memory files these tools already keep on your machine,
and finds:

- prompts you type again and again;
- corrections you keep making after a skill, agent, mode or command (for example "shorter version"
  right after the `linear-comment` skill);
- unused or overlapping skills, agents, commands and memories;
- costly skills and agents, with their prompt-cache hit rates;
- memories that should become a skill step or an AGENTS.md/CLAUDE.md rule;
- skills, agents and commands that fail the skill standards (see [Standards](#standards));
- whether the changes you accepted earlier actually helped.

The Node code does the counting and clustering. The agent running the skill does the judgement and
writes the changes, and it edits files only after you pick them. There are no hooks, no API calls and no
network access.

## What it adds

- MCP tools:
  - `usage_digest`: the analysis as markdown (at most 40 000 characters) or JSON. Every finding has an id.
    Pass `name` (for example `linear-comment`) to list only the findings whose trigger or target has that
    name; the stored digest stays complete, so `finding_examples` works for any id.
  - `usage_dashboard`: the same analysis written as one self-contained HTML file and opened in your
    browser (see [Dashboard](#dashboard)). Returns the file path and the markdown digest.
  - `list_assets`: skills, agents, commands, context files and memories, with uses and paths.
  - `finding_examples`: the stored, redacted examples of one finding.
  - `check_asset`: score one skill, agent or command file against the standards rubric.
  - `record_decision`: mark a finding `accepted` or `dismissed`. Dismissed findings never come back;
    accepted ones come back only if the pattern keeps happening afterwards. Accepting stores a baseline
    that later digests compare in their Impact section.
- Skills:
  - `usage-report` (read-only), for requests such as "show my agent usage report", "what do I spend on
    subagents?", "which skills do I never use?". It always writes and opens the dashboard.
  - `improve-workflow`, for requests such as "improve my workflow", "improve the linear-comment skill",
    "clean up my memories". It shows numbered proposals with diffs, asks which to apply through the host's
    native picker (omp `ask`, Claude Code `AskUserQuestion`, Codex `request_user_input`, Cursor
    `ask_question`) or a markdown checklist, applies only the ones you pick, and checks each edited skill
    with `check_asset`.
- The `agent-coach` CLI (`bin/`):

  ```sh
  agent-coach digest [--days N] [--source omp,claude,codex,cursor] [--min-count N] [--name skill-or-agent] [--all] [--json]
  agent-coach dashboard [--days N] [--source omp,claude,codex,cursor] [--min-count N] [--no-open]
  agent-coach check <path>            # exit code 1 when a major check fails
  agent-coach assets [--kind skill|agent|command|context|memory]
  agent-coach examples <finding-id> [--limit N]
  agent-coach decide <finding-id> accepted|dismissed [--note text]
  agent-coach install-cursor-mcp      # register the MCP server in ~/.cursor/mcp.json
  ```

Requires Node.js 20 or later on your PATH; reading Cursor chats needs Node 22.13+ or 23.4+ (for
`node:sqlite`). No npm dependencies.

## Install

### Prompt your agent to set it up

Paste this into Claude Code, Codex, Cursor or omp:

```text
Set up the Agent Coach plugin from https://github.com/huynhgiathien/agent-coach. Read its README first.
1. Install it for every agent tool I have (claude, codex, omp on my PATH, and Cursor if ~/.cursor exists) using the commands in the README's Install section. Show me each command before running it.
2. Tell me to restart Cursor or start a new session and test it there with "show my agent usage report". Do not change any skill, agent or memory during setup.
```

### One command

Installs it in Claude Code, Codex, omp and Cursor, whichever are present:

```sh
curl -fsSL https://raw.githubusercontent.com/huynhgiathien/agent-coach/main/install.sh | sh
```

The script runs these commands; run them yourself to install in only one tool:

```sh
claude plugin marketplace add huynhgiathien/agent-coach
claude plugin install agent-coach@agent-coach-plugin

codex plugin marketplace add huynhgiathien/agent-coach
codex plugin add agent-coach@agent-coach-plugin

omp plugin marketplace add huynhgiathien/agent-coach
omp plugin install agent-coach@agent-coach-plugin

# Cursor: clone into the local plugins folder (skills), then register the MCP server
git clone --depth 1 https://github.com/huynhgiathien/agent-coach ~/.cursor/plugins/local/agent-coach
node ~/.cursor/plugins/local/agent-coach/bin/agent-coach install-cursor-mcp
```

`install-cursor-mcp` adds `agent-coach` under `mcpServers` in `~/.cursor/mcp.json` with the absolute path of
`server.mjs`, keeps every other server, saves the original as `mcp.json.bak`, and never prints the file (it
can hold tokens). Running it again changes nothing.

No token or configuration is needed. Restart Cursor, or start a new session in the other tools, after
installing.

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
node ~/agent-coach/bin/agent-coach install-cursor-mcp
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
  `spawn_agent` calls and `token_count` usage. Codex records tokens only (`unpriced`).
- **Cursor chats**: the IDE chat store `state.vscdb` under `~/Library/Application Support/Cursor/User/globalStorage/`
  (macOS), `~/.config/Cursor/User/globalStorage/` (Linux) or `%APPDATA%/Cursor/User/globalStorage/`
  (Windows), opened read-only with `node:sqlite`. Only the `composerHeaders` table and the `cursorDiskKV`
  keys `composerData:*` and `bubbleId:*` are queried: typed prompts, `read_file` reads of a `SKILL.md`,
  `task` subagent calls and `tokenCount` usage. Cursor records tokens only (`unpriced`). Draft and
  display-only messages and subagent prompts are skipped. Not read: `ItemTable` (auth tokens), `agentKv:*`,
  `~/.cursor/projects/*/agent-transcripts`, `~/.cursor/ai-tracking`, the cursor-agent CLI store
  `~/.cursor/chats`, and Cursor Memories (kept server-side).
- **Skills**: `~/.claude/skills/*/SKILL.md`, `~/.claude/skills/synced/*/*/SKILL.md` (read-only),
  `~/.omp/agent/skills`, `~/.omp/agent/managed-skills`, `~/.agents/skills`, `~/.codex/skills`,
  `~/.codex/skills/.system` (read-only), `~/.cursor/skills`, `~/.cursor/skills-cursor` (Cursor built-ins,
  read-only), `~/.cursor/plugins/local/*/skills` (read-only), and the newest version of each plugin in
  `~/.claude/plugins/cache`, `~/.codex/plugins/cache` and `~/.omp/plugins/cache/plugins` (read-only).
- **Agents and commands**: `~/.claude/agents/*.md`, `~/.omp/agent/agents/*.md`, `~/.cursor/agents/*.md`,
  `~/.claude/commands/**/*.md`, `~/.omp/agent/commands/*.md`, `~/.codex/prompts/*.md`,
  `~/.cursor/commands/*.md`.
- **Context files**: `~/.claude/CLAUDE.md`, `~/.omp/agent/AGENTS.md`, `~/.codex/AGENTS.md`,
  `~/.cursor/rules/*.mdc`.
- **Memories**: Claude Code project memories in `~/.claude/projects/<project>/memory/*.md` (the
  `MEMORY.md` index is kept in sync when a memory is merged or trashed), and omp memories in
  `~/.omp/agent/memories/<project>/` (`learned.md` is editable; `MEMORY.md` and `memory_summary.md`
  are regenerated by omp and treated as read-only). Codex memories are not read.

It never opens credential files (`auth_credentials`, `.credentials.json`) or SQLite databases other than
Cursor's `state.vscdb`, and from that file only the table and keys named above.

### Cost basis

Every money figure carries the basis of its source, in markdown and in the dashboard:

| source | basis | meaning |
|---|---|---|
| omp | `recorded` | per-message cost as omp recorded it |
| claude | `allocated` | each session's recorded total, split across its messages by token price ratios |
| codex | `unpriced` | tokens only; never converted into dollars |
| cursor | `unpriced` | tokens only; never converted into dollars |

Cost per run or per use (agent and skill tables, `costly_asset` findings, `costPerUse` impact) counts only
the runs and uses that have a priced usage event; tokens-only runs are never counted as $0.

## Dashboard

`usage_dashboard`, `agent-coach dashboard` and the `usage-report` skill write
`~/.agent-coach/dashboard.html` and open it in your default browser. It is one file with inline CSS and
SVG: no script, no web fonts and no external URLs, and every string taken from your history is
HTML-escaped. It shows overview cards per tool (sessions, prompts, cost with its basis, cache hit rate),
reader warnings, prompts and cost per day, cost by model, top agents, skills and sessions, the impact of
accepted changes, every finding with its examples, all standards scores, memory counts and top usage.

Set `AGENT_COACH_NO_OPEN=1` (or pass `--no-open` / `open: false`) to write it without opening a browser.

## Standards

The skill standards come from the
[rea-analysis-optimization](https://github.com/morluto/rea/blob/HEAD/.agents/skills/rea-analysis-optimization/SKILL.md)
skill: pin the question and an independent check, remove the earliest unnecessary work, give every cache
a key, owner, invalidation and lifetime, measure before and after on the same task, limit claims to what
was measured, and label token estimates separately from recorded usage. Agent Coach applies them three ways.

**1. Rubric.** Every editable skill, agent and command is scored; `score = 100 × passed / applicable`. A file
with at least 1 major or 2 minor failures becomes a `standard_violation` finding. `check_asset` and
`agent-coach check` score one file on demand.

| id | severity | applies to | fails when |
|---|---|---|---|
| `frontmatter` | major | all | no `description`; for skills, `name` missing or different from the directory name |
| `trigger` | major | all | description shorter than 40 or longer than 1024 characters, or no trigger phrase such as "Use when …", "Use whenever …", "when the user …" or "triggers" |
| `size` | major | all | body over 500 lines or 5000 words (move detail into `references/<topic>.md`) |
| `links` | major | all | a relative markdown link, or a `references/…` path in the body, does not exist; for skills, a file in `references/` that the body cannot reach (it is reached when the body, or a reference file the body reaches, mentions or links it). Links inside code spans and fenced blocks are examples and are ignored |
| `boundary` | minor | all | neither description nor body names a non-goal ("Not for …", "use … instead", "read-only", …) |
| `done` | minor | all | the body has no done criteria ("Done when", "verify", "acceptance", …) |
| `claims` | minor | all | the body makes an unmeasured claim such as "3x faster", "guaranteed" or "always works" |
| `tools` | minor | agents | the frontmatter has no `tools` list |

**2. Impact of accepted changes.** When a finding is accepted, `record_decision` stores its metric as a
baseline: the follow-up `rate` for `follow_up`, prompts `perWeek` for `repeated_prompt`, and `costPerUse`
for `costly_asset`. Each later digest measures the same metric on the events since the decision (or since
the start of the digest window, when the decision is older) and gives a verdict. Recording a decision again
keeps the stored baseline when the finding is no longer in the digest, and a finding that reappears after
an accepted change counts only what happened after that decision. Verdicts:

- `insufficient_data` with fewer than `min_count` (default 3) samples, or fewer than 7 days for `perWeek`;
- `improved` when after ≤ 0.7 × before;
- `worse` when after ≥ 1.1 × before;
- `no_change` otherwise.

`improve-workflow` proposes a different change for `worse` and `no_change` rows.

**3. This repository.** Both bundled skills pass `agent-coach check` with no failed check. Money figures
carry their basis; token counts are never priced. No cache is used: a full scan is fast enough (below),
so there is nothing to key, own, invalidate or expire.

### Performance

Measured on 2026-11-06 with `time node bin/agent-coach digest --days 90` on an Apple M1 Pro, macOS 26.4.1,
Node v23.11.0, no cache, against this history:

- omp: 3.0 GB of sessions, of which 807 main and 1801 subagent files (2.62 GB) were modified in the window;
- Claude Code: 31 MB of projects; Codex: 472 KB of sessions; Cursor: an 87 MB `state.vscdb` plus a 5 MB WAL.

| run | wall | user | sys |
|---|---|---|---|
| `digest --days 90` (3 runs) | 11.8–13.7 s | 9.7–10.1 s | 3.0–3.4 s |
| `digest --days 90 --all` | 12.7 s | 9.9 s | 3.3 s |
| `dashboard --days 90 --no-open` | 13.1 s | 10.0 s | 3.4 s |

Peak memory was 455 MB (`/usr/bin/time -l`). Per reader in the same window: omp 10.5 s (173 609 events),
Claude 0.12 s, Codex 5 ms, Cursor 71 ms. The markdown digest was 38 642 characters and the dashboard 191 KB.
These numbers hold only for this machine and this history; time your own run before relying on them.

## Privacy

Agent Coach runs locally and makes no network requests. Prompt text is redacted before it is stored or
shown: API keys, GitHub/Slack/AWS tokens, JWTs, bearer tokens, `password=…`-style values, plain-language
passwords, and long hex or base64 strings become `[REDACTED]`. Cursor's `ItemTable`, which holds its auth
tokens, is never read. Its state lives in `~/.agent-coach` (`decisions.json`, `last-digest.json` and
`dashboard.html`); set `AGENT_COACH_HOME` to move it, and delete the directory to reset it. There is no
telemetry.

## Troubleshooting

- **"No digest yet. Run usage_digest first."**: `finding_examples` and `examples` read the last digest.
  Run `usage_digest` (or `agent-coach digest`) once, then retry.
- **"Unknown finding … Run usage_digest again."**: the id comes from an older digest. Run the digest again.
- **"Corrupt …/decisions.json"**: fix or delete the file named in the message.
- **Tools missing in a session**: check that `node` is on the PATH of the app that runs the agent.
- **"Cursor skipped: … node:sqlite"**: your Node has no `node:sqlite`. Upgrade to Node 22.13+ or 23.4+;
  the other tools are still analyzed.
- **"Cursor chat DB unreadable: …"**: the chat store could not be opened read-only (for example while
  Cursor rewrites it). Run the digest again; the other tools are still analyzed.
- **Cursor tools missing**: run `agent-coach install-cursor-mcp`, restart Cursor, and check that
  Settings → MCP lists `agent-coach`.
- **The dashboard does not open**: the tool prints the file path; open it manually, or set
  `AGENT_COACH_NO_OPEN=1` to stop it from trying.

## Support

Open an issue at https://github.com/huynhgiathien/agent-coach/issues.

## License

MIT
