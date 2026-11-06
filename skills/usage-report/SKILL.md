---
name: usage-report
description: Report how I use Claude Code, Codex, Cursor and omp — sessions, top skills/agents/commands, token cost and prompt-cache hit rates, repeated prompts, follow-up corrections, memories, skill-standard scores and the impact of past changes — and open an HTML dashboard. Use when the user asks for usage stats, cost, cache usage, memories, what they repeat, or which skills/agents they use. Read-only report; for changes use improve-workflow.
argument-hint: "[days]"
---

# Agent usage report

Use the plugin's MCP tools `usage_dashboard` and `list_assets`. This skill reports; it changes nothing.

1. Call `usage_dashboard` with `since_days` set to the argument (default 90). It writes
   `~/.agent-coach/dashboard.html`, opens it in the browser, and returns the dashboard line followed by the
   markdown digest.
2. Call `list_assets` for the asset inventory and per-asset uses.
3. Present, in this order. Give each item its counts and date range, and show every cost with its basis
   label exactly as the digest prints it (`recorded`, `allocated` or `unpriced`):
   1. The dashboard path, and whether it opened.
   2. Activity per CLI (sessions, prompts), and every `⚠` warning from the digest header.
   3. Impact of accepted changes: before → after, samples and verdict per row.
   4. Cost & cache per CLI, then the top 5 models, agents, skills and sessions by cost, each with its cache hit rate.
   5. Costly assets, with cost per use against the median.
   6. Top 10 assets by uses.
   7. Top 5 follow-up patterns (what the user typed right after a skill, agent, mode or command).
   8. Top 5 repeated prompts.
   9. The 5 lowest skill-standard scores and their failed checks.
   10. Memory counts per project, and memory promotion candidates.
   11. Overlapping assets.
   12. Unused assets.
4. End with: "Run the improve-workflow skill to turn these into changes."

## Rules

- Never edit or create files other than the dashboard the tool writes, and never call `record_decision`.
- Never convert `unpriced` token counts into dollars; Codex and Cursor record tokens only.
- Quote prompts only as the digest shows them; they are already redacted. Never read raw session logs or
  Cursor's database.
- Use `finding_examples` only when the user asks for more examples of one finding.

## Done when

- The dashboard path and whether it opened are reported.
- Every section in step 3 is reported, or reported as empty.
- No file other than `~/.agent-coach/dashboard.html` and the tool's own state changed.
