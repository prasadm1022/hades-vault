# CLI reference

`node <engine>/bin/hades.mjs <command> [subcommand] [args] [--flags]` (`hades ...` below). Zero
dependencies, Node >= 22. Output is short on purpose: agents read it, and every line costs tokens.

- `hades help` (`--help`, `-h`, no command) lists commands; `hades <command> --help` prints the
  exact usage; `hades --version` (`-v`) prints the engine version.
- Flags: `--flag value` or `--flag=value`; a flag followed by another flag or by nothing is boolean,
  and a command's switches (`--dry-run`, `--force`, `--open`, `--allow-empty`, ...) never take the
  next word; `--` passes the rest verbatim (`hades tools run`). Every command refuses a flag it does
  not know before doing anything (exit 1, `unknown flag --x`; one shared check, `allowFlags` in
  `lib/core/util.mjs`, against the command's `FLAGS`, per subcommand where it has them), so a typo
  such as `--dryrun` never runs the real thing. `--help` and `--json` are accepted everywhere.
- `--json` gives machine output on every command except `mcp` and `tools run` (`run`: with `--dry-run`).
- `<task>` = task ID (`portal-012`); `<team>` = team name, alias or a path inside the team's
  project (longest `project_path` wins).
- Commands that need a vault (`org`, `team`, `task`, `defect`, `gate`, `status`, `migrate`, `run`,
  `usage --task`, `detect --write`) fail with `no vault at ...` until `hades init` has run.
- `HADES_DEBUG=1` adds stack traces to errors.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error, bad usage, or refused (stage order, defect transition, guard-blocked value, unknown team) |
| 2 | the command ran and the result is red: `gate` (a red step, or `GATE EMPTY`), `task plan` (rejected), `task coverage` (gaps), `task stage planning\|build\|qa\|deploy\|security done` refused by its check (planning: AC not covered by `work-plan.json`; qa: coverage gaps; build, qa, deploy, security: blocking defects), `task close --status done` refused (unfinished stages, unverified critical/high defects, coverage gaps), `tools verify` (mismatch), `doctor` (a FAIL), `export` (a CONFLICT left in place) |
| other | passed through from the child: `tools run`, `mcp` |

## Setup

| Command | Does |
|---|---|
| `hades init [--vault <path>] [--workspace <path>]` | writes `<engine>/hades.config.json` (merged: other keys such as `aws` are kept). Defaults: `HADES_VAULT`/`HADES_WORKSPACE`, the configured value (a relative path, in a flag, an environment variable or the config, is relative to the engine, never to the current folder), else `<engine>/.vault` (git-ignored by the engine; a legacy `<engine>/vault` with a `registry.json` is used while `.vault` does not exist) and the engine's parent folder. A vault inside the engine is stored relative (`".vault"`). A vault path without `registry.json` is scaffolded from `templates/vault/` and `git init`-ed (its own repository) unless it is tracked inside another git repository; a vault inside the engine (or git-ignored by the surrounding repository) always gets its own repository, also when it already exists without one (nothing is committed). Refuses the engine folder itself; notes when it repoints away from a vault that still holds a registry |
| `hades install [--scope user\|project] [--workspace <dir>] [--autonomy guarded\|full] [--dry-run] [--uninstall]` | renders `agents/` and `skills/` into `<claude>/agents/hades/` and `<claude>/skills/<name>/` (marked `hades-generated`), registers the guard hook, deny and allow rules in `settings.json` (backup first), records everything in `<engine>/.hades/install.json`. `user` (default) = `~/.claude` or `CLAUDE_CONFIG_DIR`; `project` = `<workspace>/.claude`. The hook command runs the absolute Node.js path of the installing process (quoted) and the hook entry sets `"onFailure": "block"`. Allow rules (guarded mode): the `hades` subcommands `task`, `defect`, `gate`, `team resolve`, `team set`, `team list`, `detect`, `status`, `usage`, `doctor` (never `run`, `install`, `migrate`, `tools`, `mcp`) and `git add\|commit\|status\|diff\|log\|rev-parse`, plain and as `git -C <repo> ...`; an engine path with spaces is quoted. `--autonomy full` (user scope only) sets `permissions.defaultMode: bypassPermissions`; `--autonomy guarded` removes it again; without `--autonomy` a re-install keeps the autonomy recorded for that scope and directory (a first install is `guarded`). The agents' MCP servers run with the same absolute Node path (`command: "{{NODE}}"`, rendered). Unmarked files are never overwritten; `--uninstall` removes only what the record lists. See `autonomy-and-safety.md` |
| `hades export <target> [--dir <dir>] [--scope project\|user] [--dry-run] [--force]` | renders HADES for another coding agent ([`other-agents.md`](other-agents.md)). Targets: `agents-md`, `codex`, `cursor`, `gemini`, `copilot`, `windsurf` (alias `devin`), `cline`, `opencode`; `roo` and `aider` fall back to `agents-md` with a note. Writes the PM procedure as the agent's skill or command (with a short section mapping the Claude Code terms; single-agent mode where the platform has no custom agents), the role agents in its subagent format, the MCP servers (`<node> <engine>/bin/hades.mjs mcp <name>`) and the guard as its pre-tool hook (`hooks/guard.mjs --format <target>`), each only where the platform documents a format. `project` (default) = `--dir` (default: the workspace; a folder inside a registered project gets a WARN); `user` = the agent's home folder (`--dir` refused; honours `CODEX_HOME`, `COPILOT_HOME`, `CLINE_MCP_SETTINGS_PATH`). Files marked `hades-generated` are updated; an unmarked file at the same path, an existing `AGENTS.md` without the HADES block, invalid JSON, a same-name MCP server that does not run HADES or a Codex `[mcp_servers.<name>]` table of your own is a `CONFLICT`, left as it is (exit 2) unless `--force` (backup `<file>.hades-backup-<timestamp>` first; a TOML table clash stays a conflict). JSON configuration is merged (backup first, other keys kept); the Codex `config.toml` gets a marked block. Prints what it wrote, notes and a `todo:` list (trust the folder, approve servers and hooks) |
| `hades doctor [--aws-profile <profile>]` | one line per check, `OK\|WARN\|FAIL <check>: <detail> -> <fix>`: Node, git, Claude Code version, uv, Docker, config, vault, workspace, registry, team folders, stack fingerprints, tool pins, installed files, guard hook and its matcher, the Node binary of the guard hook (FAIL when missing or older than 22; WARN for `node` from `PATH`) and of the installed agents' MCP servers (WARN), AWS profile (`aws.profile`/`profiles`, else `AWS_PROFILE`; `--aws-profile` checks one ad hoc). A profile whose identity is the account root user is a FAIL. Exit 2 on any FAIL |
| `hades tools list` | pinned tools: pin, license, how each resolves now |
| `hades tools setup [<name>...] [--force] [--from-source]` | installs pinned tools into `.tools-bin/` (default: all runnable). `--force` reinstalls; `--from-source` builds rea from the vendored tree (macOS/Linux). Exit 1 if any tool fails |
| `hades tools run <name> -- <args>` | runs a pinned tool; stdio inherited, exit code passed through |
| `hades tools verify` | submodule HEADs equal `tools/tools.lock.json`; exit 2 on mismatch |
| `hades tools bump <name> <tag> [--force]` | moves a pin after checking the release is >= 14 days old (`--force` overrides); network; never commits |
| `hades mcp <serena\|rea\|playwright\|aws> [--project <dir>]` | starts a pinned MCP server on stdio (agent frontmatter). stdout is the MCP channel; errors go to stderr. Working directory: `--project`, else the current one. `serena` starts without a project unless `--project` pins one, and the agents start it without: they call `activate_project` with the absolute `<Project>` path before the first symbol tool |
| `hades mcp aws` | AWS MCP server through `mcp-proxy-for-aws`, signed with the configured profile (`hades.config.json` `aws`, else `AWS_PROFILE`); `read_only: true` adds `--read-only`. No profile: one stderr line, exit 1 (the server is simply unavailable) |

Tool aliases: `playwright` = `playwright-mcp`, `aws` = `mcp-proxy-for-aws`, `zap` = `zaproxy`.

## Organizations and teams

| Command | Does |
|---|---|
| `hades org new <org> --root <path> [--description "..."] [--aliases a,b]` | scaffolds `organizations/<org>/` from `templates/organization/` and registers it; `--root` = folder holding its projects |
| `hades org list` | organizations with their teams |
| `hades team new <team> --org <org> --project <path> [--type main\|sub] [--description "..."] [--aliases a,b]` | scaffolds `<org_dir>/teams/<team>/` from `templates/team/`, fills `team.json` by detection, writes `projects/<name>.md`, adds a row to `ORG.md`, registers the team. A missing project folder is created and `git init -b main`-ed (greenfield, no commit) |
| `hades team resolve [<name\|alias\|path>]` | prints `{team, organization, type, team_dir, project_path}` (default: current directory); exit 1 if none |
| `hades team list [--org <org>]` | teams with type, status, organization, project path |
| `hades team set <team> command <key> "<cmd>" [--project <rel>]` | sets a project command; `<key>` = `install`, `build`, `lint`, `types`, `test`, `run`, `format`; `""` clears it; `--project` = an existing `projects[].path` (default `.`) |
| `hades team set <team> env <test\|live> <field> "<value>"` | sets an environment field: `url` (http(s) or `""`), `deploy`, `health`, `rollback`, `via_push` (`true\|false`), `notes` |
| `hades team set <team> security <key> <value>` | `semgrep_config` (any config; `""` removes it), `dast_live` (`baseline\|none`), `dast_test` (`baseline\|full\|api\|none`) |
| `hades team set <team> branch-strategy <current-branch\|feature-branch>` | commit branch rule (`company/commit-policy.md`) |
| `hades team set <team> project add <rel>` | adds a `projects[]` entry with empty commands (relative path inside `project_path`; no-op if present) and prints the `detect --write` line that fills it |
| `hades team set <team> project remove <rel>` | removes that entry (exit 1 if absent) |
| `hades detect [<path>] [--write <team>] [--overwrite] [--depth <n>]` | fingerprints `<path>` (default: the team's project with `--write`, else the current directory) and subdirectories to `--depth` (default 2); prints stacks and commands per project. `--write` merges into `team.json`: fills empty commands, adds projects, never touches environments; `--overwrite` also replaces non-empty commands and stacks. Fingerprints: engine `playbooks/stacks.json`, with `<vault>/company/playbooks/stacks.json` merged over it by `id` when a vault exists (vault entries replace same-id entries, new ids are added; an invalid vault file is ignored with a warning) |
| `hades status [<team>\|<org>]` | organizations, teams (type, status), open tasks with stage and blocking defects; v1 records counted as legacy; at most 40 lines |

`team set` and `detect --write` are the only ways to change `team.json`; nobody edits it by hand.
Values are stored on one line; a value after `--` counts as the last argument (for values starting
with `--`). Prints `team.json (<team>): <setting> = <value>` (`(unchanged)` when equal). Shell
values (`command`; `deploy`, `health`, `rollback`) are checked with the guard's `checkShell`
(`hooks/guard.mjs`) first; a blocked value is refused (exit 1) with the guard reason, nothing
written.

## Tasks

| Command | Does |
|---|---|
| `hades task new <team> --title "..." [--size S\|M\|L] [--request-file <path>]` | creates `<team_dir>/tasks/<id>-<slug>/` with `README.md` (request verbatim: the file, else the title), `state.json` (intake done), `defects.json`; prints `<id> <folder>` |
| `hades task adopt <v1-task-id> [--stage <first stage to run>] [--size S\|M\|L]` | adopts a HADES v1 record (`<team_dir>/tasks/<id>-<slug>.md`, optional `<id>-artifacts/`) into a new v2 folder `<id>-<slug>-v2/`: `state.json` with every stage before `--stage` `skipped` (note `v1 record: <file>`), `README.md` from the task template (Request from the record's Request section, or a pointer; a `Legacy` line linking the record and the artifacts folder), empty `defects.json`; prints `<id> <folder>`. The v1 files are never moved or changed (`migration-from-v1.md`, Resuming a v1 task) |
| `hades task show <task>` | compact status: stages, next stage, rounds, plan counts, open/blocking defects, last gate, deploy, commits, usage, folder |
| `hades task stage <task> <stage> <status> [--note "..."] [--model <m>] [--force]` | moves the stage machine (rules below); prints the next stage |
| `hades task size <task> <S\|M\|L> [--force]` | sets or raises the size (also in README frontmatter); lowering needs `--force` |
| `hades task plan <task> --from <file>` | validates the tech lead's draft (`<task folder>/work-plan.draft.json`) and stores `work-plan.json`; exit 2 with the problem list when rejected |
| `hades task item <task> <W#> <todo\|doing\|done>` | updates a work item (sets `at`); warns when its dependencies are not done |
| `hades task coverage <task>` | AC -> work items -> test cases matrix from `01`, `work-plan.json`, `06`; exit 2 when an AC has no work item or no test case, or there are no ACs |
| `hades task commit <task> [--repo <path>]` | records the repo's HEAD `{repo, hash, summary}` (default repo: the team's project path); an already recorded hash is not added twice |
| `hades task deploy <task> --env <test\|live\|none\|pending-push> [--url <url>] [--note "..."]` | records the deploy result in `state.deploy` (`--url` must be http(s)) |
| `hades task close <task> --status <done\|blocked> [--note "..."] [--force]` | closes the task, marks `close` done; `done` is refused (exit 2) while a stage before `close` is not `done` or `skipped`, any critical/high defect is `open`, `fixed`, `reopened` or `blocked`, or (`qa` not skipped) `hades task coverage` has gaps (an AC without a work item or a test case); `blocked` closes regardless and warns about stages still pending or running |
| `hades task list [<team>] [--open]` | tasks of a team (default: the team of the current directory), incl. v1 records |
| `hades task path <task>` | prints the task folder |

**Plan validation** (`task plan`): items `W<n>` unique, `title`, `owner` one of `backend-engineer`,
`frontend-engineer`, `aiml-data-engineer`, `devops-engineer`, `tech-lead`, `wave` >= 1, `files`
non-empty, `acceptance` = AC ids present in `01`, `done_when`; `depends_on` must name items of an
earlier wave; items of one wave and project must not share a file (a path ending in `/` covers
everything below it); every AC of `01` is covered by an item (AC -> work item coverage is checked
here, at planning). A `project` not in `team.json` is a warning. Item statuses of the previous plan
are kept; extra top-level keys are stored.

**Coverage parsing**: AC ids are `AC-n` anywhere in `01-business-solution.md`; a `TC-n` in
`06-test-plan.md` maps to the AC ids on its line, and a TC on a heading or without AC ids also takes
the AC ids of the following lines up to the next TC or heading.

### Stages and rules

Stages, in order: `intake analysis design planning build qa release deploy security close`
(`release` = the release commit). Status: `pending running done skipped failed blocked`.

- Order (exit 1): `running` or `done` is refused while an earlier stage is `pending`, `running` or
  `failed` (a failed stage is retried first). The one exception: source-level `security` may be
  `running` while `deploy` is `running` or `failed`; DAST and `security done` wait for the deploy.
- `blocked` = given up for this task: later stages continue where safe and the next stage skips it.
  `skipped` needs `--note`. The `close` stage completes only through `hades task close`
  (`hades task stage <task> close done\|skipped` is refused, exit 1).
- Checks at `done` (exit 2): `planning` needs `01` with AC ids and a `work-plan.json` covering each;
  `qa` needs `hades task coverage` without gaps (every AC has a work item and a test case); a stage
  cannot pass while a critical/high defect of its sources is `open`, `fixed` or `reopened`:
  `build` <- `review`; `qa` <- `qa`, `review`; `deploy` <- `deploy`; `security` <- `security`.
- `task close --status done` is refused (exit 2) while a stage before `close` is not `done` or
  `skipped` (a `blocked` or `failed` stage included), while any critical/high defect is unverified
  (`blocked` included), or, unless `qa` was skipped, while `hades task coverage` has gaps.
- Each `qa` / `security` move to `running` from another status is a round (`rounds` in
  `state.json`); above 3 the CLI warns (`exceeds the limit of 3`) and the PM blocks the stage.
- `qa running` warns about coverage gaps; the PM runs `hades task coverage <task>` first.
- `state.stage` is the first stage not `done`, `skipped` or `blocked`.
- `--force` overrides the order, coverage and defect checks of `task stage` and `task close`; the
  PM uses it only with a written reason.

## Defects

| Command | Does |
|---|---|
| `hades defect add <task> --title "..." --severity <critical\|high\|medium\|low> --owner <role> --source <qa\|security\|review\|deploy> [--repro "..."] [--refs a,b] [--evidence "..."] [--by <role>] [--note "..."]` | records a defect (`open`, round 0); prints its ID (`D<n>`) |
| `hades defect update <task> <D#> --status <fixed\|verified\|reopened\|wontfix> [--note "..."] [--by <role>] [--force]` | moves a defect (transitions below) |
| `hades defect list <task> [--open] [--owner <role>] [--source <qa\|security\|review\|deploy>] [--severity <s>]` | one line per defect: `D# severity status owner r<round> title`; `--open` = not `verified` and not `wontfix` |

Sources: `qa` (QA testing), `security` (cybersecurity testing), `review` (tech-lead integration
review), `deploy` (failed deploy or health check). Owners: `backend-engineer`, `frontend-engineer`,
`aiml-data-engineer`, `devops-engineer`, `tech-lead` (glue between layers, fixed in the tech lead's fix
mode; a failure needing changes in several layers is one defect per layer, owned by its engineer).

| From | Allowed `--status` |
|---|---|
| `open` | `fixed`, `wontfix` |
| `fixed` | `verified`, `reopened`, `wontfix` |
| `reopened` | `fixed`, `wontfix` |
| `verified` | `reopened` |
| `wontfix` | `reopened` |
| `blocked` | `wontfix` |

- Each move to `fixed` is a round. `reopened` after round 3 becomes `blocked` (set by the CLI only).
- `wontfix` needs `--note` (the reason). Any other move is refused (exit 1) unless `--force`.
- Default `--by`: `fixed` -> the owner; `wontfix` -> `project-manager`; otherwise the finder of the
  source.

## Gates

| Command | Does |
|---|---|
| `hades gate <task> [--preset build\|precommit\|predeploy\|security\|full] [--only <steps>] [--project <rel>] [--timeout <minutes>] [--allow-empty]` | runs the steps for every `team.json` project (or one with `--project`); one line per step plus an excerpt of the first failure; appends the run to `gates.json`; exit 2 when red. Nothing runnable (every step `n/a`, or a project whose selected build/lint/types/test commands are all empty) is red: exit 2, last line `GATE EMPTY (no commands configured: run hades detect --write or hades team set)` (`GATE RED` when a step also failed); `--allow-empty` accepts it as a recorded waiver (`allow_empty` in the run; `GATE GREEN (<n> n/a; empty accepted by --allow-empty)`) |
| `hades gate <task> --dast <url> [--mode baseline\|full\|api] [--openapi <url>] [--i-own-this-target] [--timeout <minutes>]` | ZAP scan of a deployed system (Docker); default mode `baseline` (passive) |

| Preset | Steps |
|---|---|
| `build` (default) | build, lint, types, test |
| `precommit` | build, test, secrets |
| `predeploy` | build, test, secrets, sast, deps |
| `security` | secrets, sast, deps |
| `full` | build, lint, types, test, secrets, sast, deps |

- `build`, `lint`, `types`, `test` run the project's `team.json` command through the platform shell
  (`CI=true`, colours and framework telemetry off; a timeout kills the whole process tree). Each
  command is checked with `checkShell` first; a blocked command is not run and the step is `error`
  with note `blocked by the guard (<rule id>)` and the guard reason. `secrets` = gitleaks, `sast` = semgrep
  (`security.semgrep_config`, default `p/default`), `deps` = trivy fs (vulnerable dependencies, IaC
  misconfigurations). `--only a,b` runs exactly those steps (preset `custom`).
- Step status: `pass`, `fail`, `n/a` (no command configured), `error` (tool or command missing,
  blocked by the guard, unreadable report). The run is red when any step is `fail` or `error`, and
  when nothing runnable is left (`GATE EMPTY`, above) unless `--allow-empty`.
- Scanner findings of severity critical/high fail a step; lower ones are shown as counts.
- Default timeouts (minutes): build/lint/types 30, test 45, secrets/sast/deps 30, dast 90;
  `--timeout` overrides every step of the run. A timeout is a `fail`.
- DAST: `full` and `api` are active scans: refused when the target or `--openapi` host is the live
  host (`environments.live.url`), and, without `--i-own-this-target`, when the target is not the test
  host. `team.json` `security.dast_live` (`baseline\|none`) caps scans of the live host and
  `security.dast_test` (`baseline\|full\|api\|none`) those of the test host: a mode above the
  setting, or any mode when it is `none`, is refused (exit 1) with the setting named. Otherwise
  `baseline` is allowed anywhere. With no deployed environment the cybersecurity engineer scans the
  app it runs locally: `hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target`.
  `localhost` targets are reached as `host.docker.internal`.
- Full logs and reports: `<engine>/.hades/logs/<task>/` (never in the vault).

## Usage and runs

| Command | Does |
|---|---|
| `hades usage --task <task> [--session <id,...>]` | tokens by model and estimated cost between `opened` and `closed` (or now), from Claude Code transcripts incl. subagents; stored in `state.usage`. Every session active in the window counts; `--session` keeps only those IDs. Exit 1 without a Claude data directory |
| `hades usage [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--no-ccusage]` | daily report, default the last 7 days; via ccusage with offline prices, falling back to the built-in parser (`--no-ccusage` forces it) |
| `hades run "<requirements>" [--team <team>] [--model <alias>] [--max-budget-usd <n>] [--max-turns <n>] [--dry-run]` | runs the whole pipeline headless in the workspace (below) |

`hades run` executes `claude -p "/hades [<team>] <requirements>" --permission-mode bypassPermissions
--output-format stream-json --verbose` (plus `--model`, `--max-budget-usd`, `--max-turns` when
given) with the workspace as working directory, prints one line per tool call and the final result
with its cost, and saves the raw stream to `<engine>/.hades/runs/<timestamp>.jsonl`. `--team` must be
registered (omit it to let the PM resolve or create the team). `--dry-run` prints the working
directory and command line only. Exit 0 when the run ends with a non-error result, else 1. Deny
rules and the guard hook still apply; the guard refuses `hades run` from inside an agent.

## Migration

| Command | Does |
|---|---|
| `hades migrate [--dry-run] [--include-dirty]` | upgrades a HADES v1 vault (registry v2) to v2 (`migration-from-v1.md`). `--dry-run` prints the plan (`--json` for every action); files with uncommitted changes are skipped and listed unless `--include-dirty`. Idempotent |

## Locking

Parallel agents run CLI writes on the same task. Every read-modify-write of `state.json`,
`defects.json`, `work-plan.json`, `gates.json` and `team.json`, and task ID allocation (`.new-task`),
holds `<file>.lock` (created exclusively, held for milliseconds). A lock older than
`HADES_LOCK_STALE_MS` (15 s) was left by a crashed process and is broken (only by the holder of
`<lock>.break`); a command that cannot take a lock within `HADES_LOCK_WAIT_MS` (30 s) exits 1 with
`timed out after <n>s waiting for <lock>` (delete it if no `hades` command is running). Files are
written to a temp file (`<file>.<pid>.<n>.tmp`) and renamed. The vault `.gitignore` ignores these
leftovers.

## Environment variables

| Variable | Effect |
|---|---|
| `HADES_VAULT`, `HADES_WORKSPACE` | override `hades.config.json` |
| `HADES_CONFIG_FILE` | another config file (tests) |
| `HADES_LOCK_STALE_MS`, `HADES_LOCK_WAIT_MS` | lock timings in ms (defaults 15000 and 30000; see Locking) |
| `HADES_INSTALL_SOURCE`, `HADES_TEMPLATES_DIR`, `HADES_ENGINE_ROOT` | another source for `install`, templates for `migrate`, engine root for the tools module (tests) |
| `HADES_DEFAULT_VAULT` | replaces the built-in default vault `<engine>/.vault` (lowest priority, after the env and the config; the tests point it at a missing folder so they never reach a real vault) |
| `HADES_TOOL_<NAME>` | use this executable or `.mjs` for a tool (`HADES_TOOL_PLAYWRIGHT_MCP`) |
| `HADES_DOCKER` | `0`/`1` forces Docker detection |
| `HADES_GUARD=off`, `HADES_GUARD_POLICY`, `HADES_GUARD_LOG` | guard switch, policy file, log file (owner only; `hooks/README.md`) |
| `CLAUDE_CONFIG_DIR` | Claude Code user directory for `install`, `usage` |
| `CODEX_HOME`, `COPILOT_HOME`, `CLINE_MCP_SETTINGS_PATH`, `APPDATA` | user-scope locations for `export --scope user` (Codex home, Copilot home, Cline MCP settings file, Devin config on Windows) |
| `AWS_PROFILE` | AWS profile when `hades.config.json` has none |
| `GITHUB_TOKEN` | sent only to api.github.com by `tools bump` |
| `HADES_DEBUG` | stack traces |
