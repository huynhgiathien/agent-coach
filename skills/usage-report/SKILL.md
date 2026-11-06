---
name: usage-report
description: Report how I use Claude Code, Codex and omp — sessions, top skills/agents/commands, token cost and prompt-cache hit rates, repeated prompts, follow-up corrections, memories, unused or overlapping skills. Use when the user asks for usage stats, cost, cache usage, memories, what they repeat, or which skills/agents they use. Read-only.
argument-hint: "[days]"
---

# Agent usage report

Use the plugin's MCP tools `usage_digest` and `list_assets`. This skill is read-only.

1. Call `usage_digest` with `since_days` set to the argument (default 90).
2. Call `list_assets` for the asset inventory and per-asset uses.
3. Present, in this order, each item with its counts and date range:
   1. Activity per CLI: sessions and prompts.
   2. Cost & cache per CLI, then the top 5 models, agents, skills and sessions by cost, each with its cache hit rate.
   3. Costly assets, with cost per use against the median.
   4. Top 10 assets by uses.
   5. Top 5 follow-up patterns (what the user typed right after a skill, agent, mode or command).
   6. Top 5 repeated prompts.
   7. Memory counts per project, and memory promotion candidates.
   8. Overlapping assets.
   9. Unused assets.
4. End with: "Run the improve-workflow skill to turn these into changes."

Rules:

- Never edit or create files, and never call `record_decision`.
- Quote prompts only as the digest shows them; they are already redacted. Never read raw session logs.
- Use `finding_examples` only when the user asks for more examples of one finding.
