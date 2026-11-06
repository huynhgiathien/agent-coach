# Asking the user which changes to apply

Every question improve-workflow asks follows these steps. Nothing is applied without an explicit selection.

1. **Render the full numbered proposal list in chat before every question.** Pickers cannot show diffs, so
   the list (with its `<details>` diffs) is what the user decides from.
2. **Use the first native question tool present in your tool list:**
   - **omp `ask`**: `{ questions: [{ id, question, options: [{ label, description }], multi: true }] }`, all
     options in one question.
   - **Claude Code `AskUserQuestion`**: `{ questions: [{ question, header, multiSelect: true, options: [{ label, description }] }] }`.
     - Limits: each question takes 2–4 options and one call takes at most 4 questions.
     - Split the proposals into consecutive chunks of 4, one question per chunk, with header `Apply 1–4`,
       `Apply 5–8`, and so on (at most 12 characters).
     - A chunk with only 1 proposal gets a second option, `None of these`.
     - With more than 16 proposals, issue a second call.
   - **Codex `request_user_input`**: use it only when it is listed in your tools. Put one question per
     proposal chunk, as for Claude Code, and use multi-select if its schema offers it.
   - **Cursor `ask_question`**: use the schema Cursor shows. Use multi-select if offered; otherwise ask one
     yes/no question per proposal.
3. **Option text.**
   - `label` = `<n>. <type> <short name>`, at most 60 characters, for example `1. update linear-comment`.
   - `description` = the proposal's one-line evidence summary.
   - Never pre-select an option, and never mark one as recommended for applying changes.
4. **Fallback** when no native tool exists, or the tool errors: print the checklist below, then stop and wait
   for the reply.

   ````markdown
   **Apply which changes?** Reply with numbers (`1 3`, `2-4`), `all`, or `none`.

   - [ ] **1 · update** `~/.claude/skills/linear-comment/SKILL.md` — "shorter version" after 43% of runs (Oct 1 → Nov 5)
     <details><summary>Proposed change</summary>

     ```diff
     …
     ```
     </details>
   ````

5. **Parse the reply.**
   - Accept numbers separated by spaces or commas, ranges `a-b`, `all` and `none`.
   - Re-ask once on anything else. A second unclear answer, or no answer, means apply nothing.
   - Ignore numbers that are out of range, and say so.

Verify before applying: the selected numbers are echoed back to the user exactly as parsed.
