# Code navigation with Serena

Serena (MCP, vendored at `<engine>/tools/serena`) reads and edits code by symbol through
language servers. Its tools appear as `mcp__serena__<tool>`; if they are listed as deferred, load the
ones you need in ONE ToolSearch call (`select:mcp__serena__find_symbol,mcp__serena__...`).
`<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.

## When Serena wins, when it does not
| Use Serena | Use Read / Grep / Edit |
|---|---|
| Code file > ~150 lines or unknown structure | Small code file you will read whole anyway |
| "Where is X defined / what are its members" | JSON, YAML, TOML, Markdown, SQL, Dockerfile, CSS, `.env.example`, lockfiles |
| "Who calls X" (semantic, no same-name noise) | Free text: string literals, error messages, routes, config keys, TODOs (Grep) |
| Replace or add a whole function/method/class | One-line change after reading that range |
| Rename across the codebase (LSP refactor) | Language without a working server here (e.g. Go without gopls, Rust without rust-analyzer) |
| Interface -> implementations | New files (Write) |

Grep finds *candidates*; follow up with Serena for definitions and references.

## Tools and the usual sequence (exact names, v2.0.0)
1. Locate: `find_symbol(name_path_pattern="OrderService", relative_path="src/orders", depth=1)`
   lists members without bodies. Unknown file: `get_symbols_overview(relative_path="src/x.ts")`.
   Name paths: `Class/method`; `/Class/method` = exact; overloads `method[1]`.
2. Read: `find_symbol(name_path_pattern="OrderService/cancel", relative_path="src/orders/service.ts", include_body=true)`.
3. Impact: `find_referencing_symbols(name_path="OrderService/cancel", relative_path="src/orders/service.ts")`;
   `find_implementations(...)` for interfaces; `find_declaration(relative_path, regex)` for a call site.
4. Edit:
   - `replace_symbol_body(name_path, relative_path, body)` - body includes the signature; only after
     reading that symbol with `include_body=true`.
   - `insert_after_symbol` / `insert_before_symbol` - new method, class, or an import before the first symbol.
   - `replace_content(relative_path, needle, repl, mode="regex")` - partial edit inside a large body;
     a needle like `start.*?end` avoids quoting the old text.
   - `replace_in_files(needle, repl, mode, paths_include_glob=..., dry_run=true)`, then apply with
     `occurrence_ids` - mechanical multi-file edits.
   - `rename_symbol(name_path, relative_path, new_name)`; `safe_delete_symbol` refuses while references exist.
5. Check: `get_diagnostics_for_file(relative_path, min_severity=1)` (errors only) for fast feedback;
   the evidence is still `hades gate <task> --preset build`.

## Activation and onboarding (keep projects clean)
- HADES starts one Serena per agent (`hades mcp serena`; expected: context `claude-code`, memories
  and onboarding off, dashboard and GUI log window off, telemetry off) without a startup project.
  Before the first symbol tool, call `activate_project` with the absolute `<Project>` path of your
  handover, once (its `session_id` comes from `initial_instructions`). If symbols you know exist are
  not found, they live outside that project: use Grep/Read there.
- On first activation of a repo Serena writes `.serena/project.yml` (+ `cache/`, `.gitignore`) into the
  project unless `project_serena_folder_location` points elsewhere, and may download a language
  server (slow; retry a timed-out first call once, then fall back to Grep/Read).
- Never call `onboarding`, `write_memory` or other memory tools even if they are listed: onboarding
  reads many files and writes `.serena/memories/` into the repo. Team `CONTEXT.md` and `knowledge/`
  are HADES's project memory; durable facts go under LESSONS.
- After your work: `git -C <repo> status --porcelain -- .serena`. If it is listed as untracked, add
  `.serena/` to the local exclude file (`git -C <repo> rev-parse --git-path info/exclude`), never to
  the committed `.gitignore` unless the repo already lists it. Never commit or delete a `.serena/`
  the repo already tracks. Report it under LESSONS so the launch config can be fixed.
- Large repo, first use: pre-index once with
  `node <engine>/bin/hades.mjs tools run serena -- project index <abs project path>`.

## Token tips
- Always pass `relative_path` when you know the directory or file: faster and fewer results.
- `include_body=true` only for symbols you will read or edit; use `depth=1` to list class members.
- `max_matches=1` for a unique symbol; `substring_matching=true` when unsure of the exact name.
- Over `max_answer_chars` the answer is empty or shortened: narrow the query, do not raise the cap.
- Batch independent Serena calls in one turn; they run in order without racing.
- Do not re-read with Serena what you already Read whole; do not Read what Serena already returned.
- Serena line numbers are 0-based; Read offsets are 1-based.
- Claude Code's Edit refuses files you have not Read: after a Serena read, edit with Serena tools
  (or Read just that range first).
- Serena writes its configured line ending (CRLF on Windows by default): if `git diff --stat` shows a
  whole file changed for a small edit but `git diff --ignore-cr-at-eol --stat` does not, convert the
  file back to the repo's ending, use Edit in that repo for the rest of the task, record a LESSON.
- Never use `execute_shell_command` or `serena_repl` if they appear; use Bash (guarded) instead.
