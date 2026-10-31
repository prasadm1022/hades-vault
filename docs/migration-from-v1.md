# Migrating from HADES v1

HADES v1 kept the framework (roles, skills, workflow, templates, scripts) inside the vault. v2
splits it: the **engine** (this repository: agents, skills, policies, CLI, guards, tools) and your
private **vault** (registry, teams, knowledge, tasks). `hades migrate` does the deterministic part;
an LLM pass finishes what needs judgement.

## What changed

| Area | v1 | v2 |
|---|---|---|
| Framework | `<vault>/company/roles`, `skills`, `workflow`, `templates`, `scripts`, `.claude/skills` | engine `agents/`, `skills/`, `company/`, `playbooks/`, `templates/`, `bin/` + `lib/`; v1 copies moved to `<vault>/archive/v1/` |
| Roles | role files read by a general agent | native subagents `hades-<role>` installed by `hades install` |
| Company staff | per-team copies | one `business-analyst`, `software-architect`, `devops-engineer`, `cybersecurity-engineer` for all teams; team-specific notes in `<team_dir>/agents/<role>.md`, company-wide notes in `<vault>/company/staff/<role>.md` |
| Registry | version 2 with `vault`, `git_root`, `hierarchy` | version 3; `vault` and `workspace` (from `git_root`) in `hades.config.json`; `hierarchy` dropped |
| Team data | `TEAM.md` prose | `TEAM.md` + machine-readable `team.json` (commands, environments; `hades team set`) + `CONTEXT.md` digest |
| Tasks | one file `tasks/<id>-<slug>.md` | a folder `tasks/<id>-<slug>/` with `README.md`, `state.json`, `defects.json`, work plan, gates, stage files `01`-`09`; numbering continues after v1 records, which stay as history |
| Evidence | agent reports | `hades gate`, `hades task coverage`, `hades defect` records |
| Safety | prompt rules | guard hook + deny rules |

### Role mapping (team notes in `<team_dir>/agents/`)

| v1 note | v2 note |
|---|---|
| `project-manager` | `project-manager` (the PM is the main session; notes only) |
| `business-analyst` | `business-analyst` (company staff) |
| `software-architect` | `software-architect` (company staff) |
| `devops-engineer` | `devops-engineer` (company staff) |
| `security-engineer` | `cybersecurity-engineer` (company staff) |
| `senior-qa-engineer` | `qa-engineer` |
| `senior-aiml-engineer` | `aiml-data-engineer` |
| `senior-fullstack-engineer` | split into `backend-engineer` + `frontend-engineer` (kept as `.v1.md` until `/hades-learn <team> --migrate`) |
| `uiux-engineer` | `frontend-engineer` (UI/UX + frontend; kept as `.v1.md` until `/hades-learn <team> --migrate`) |
| - | `tech-lead` (new) |

## Steps

1. **Update and install the engine.** Clone v2 with submodules (`getting-started.md` steps 2 and 4)
   and point it at your existing vault: `hades init --vault <v1 vault> --workspace <projects folder>`.
2. **Commit or stash the vault.** Files with uncommitted changes are skipped (see below).
3. **Preview:** `hades migrate --dry-run` (`--json` lists every action).
4. **Migrate:** `hades migrate`. It
   - writes registry v3 and moves `vault`/`git_root` into `hades.config.json`;
   - renames team role notes per the table, keeps split notes as `<role>.v1.md`, creates missing notes;
   - moves the v1 framework folders to `archive/v1/` and rewrites references to them in vault files
     to engine paths (map in `company/MIGRATION.md`; `tasks/` and `legacy/` are left as history);
   - scaffolds `company/staff/*.md`, `team.json` (best effort from `TEAM.md`) and `CONTEXT.md` per
     team, and rewrites the vault's `HADES.md`, `CLAUDE.md`, `README.md` (old copies in `archive/v1/`);
   - leaves `hades-migrate: TODO` markers where judgement is needed (`TODO(hades-migrate)` in
     `team.json` environment notes). Running it again changes nothing.
5. **Install and check:** `hades install`, then `hades doctor` (fix every FAIL; old v1 skills in
   `<workspace>/.claude` that shadow the installed ones are reported).
6. **Review and commit the vault** yourself (`git -C <vault> status`, then commit). HADES does not
   commit `hades migrate` changes; committing them first keeps the next step's commit reviewable.
7. **LLM pass, per team:** in Claude Code, `/hades-learn <team> --migrate` (the teams are listed in
   the migrate report's `next` line). The knowledge curator, per
   `playbooks/knowledge-capture.md` *Migrate mode*:
   - files every line of the `agents/*.v1.md` notes into the v2 role notes (backend, frontend,
     tech lead, DevOps, ...) and then deletes the `.v1.md` files;
   - removes the `hades-migrate` markers;
   - writes `CONTEXT.md` (<= 120 lines) from `TEAM.md` and the knowledge files;
   - fills `team.json` through `hades detect <project> --write <team>` and `hades team set` (the
     environments from `TEAM.md`, replacing the `TODO(hades-migrate)` notes);
   - never touches a file with uncommitted changes that predate the migration (a changed file
     without a `hades-migrate` marker); it lists such files in the report instead.
   The skill commits the changed and deleted files as `learn(<team>): finish v1 migration`.

## Resuming a v1 task

`/hades <team> continue <task-id>` resumes a task. A v2 task folder continues from the stage
`hades task show` reports. A v1 single-file record (`tasks/<id>-<slug>.md`, optionally with a
`tasks/<id>-artifacts/` folder and a `RESUME.md` in it) is adopted first:

`hades task adopt <id> [--stage <first stage to run>] [--size S|M|L]` creates `tasks/<id>-<slug>-v2/`
with `state.json` (every stage before `--stage` `skipped`, note `v1 record: <file>`), `README.md`
from the task template (Request taken from the record's Request section, or a pointer to it, and a
`Legacy` line linking the record and the artifacts folder) and an empty `defects.json`, and prints
`<id> <folder>`. The v1 record and its artifacts are never moved, edited or deleted.

The PM picks `--stage` from the record's `status`, `## Gates` table and `RESUME.md`:

| v1 evidence | First stage to run |
|---|---|
| no Business Brief, or G1 not passed | `analysis` |
| G1 passed; no technical plan, or G2 not passed | `design` |
| G2 passed; no work plan | `planning` |
| work plan; work packages not all done and green | `build` |
| built; QA not passed | `qa` |
| QA passed; nothing committed | `release` |
| committed; not deployed | `deploy` |
| deployed; no security pass | `security` |

Every spawn of an adopted task gets the v1 record and the artifacts folder (absolute paths) in its
Read line. Later stages need v2 files the skipped stages would have written; they are converted,
not redone: `01` with `AC-n` ids from the v1 brief (business analyst; `hades task plan` needs them),
a pointer `02` to the v1 technical plan (architect), and, when resuming at `build` or later, the work
plan from the v1 work packages (tech lead, plan mode), with the packages the v1 notes and a green
`hades gate <task> --preset build` confirm marked `hades task item <task> <W#> done`.

## Dirty files

Before touching a file, `hades migrate` checks `git status` in the vault. A file with uncommitted
changes is skipped and listed (`dirty ... skipped: ...`), and the report's `next` line says to commit
or stash it and run `hades migrate` again. `--include-dirty` touches them anyway; use it only when the
vault is not a git repository or you have a backup. Conflicts (a target that already exists) are
also skipped and listed, never overwritten.
