# Knowledge capture (learning loop)

Run by `hades-knowledge-curator` at task close (`/hades`) or on demand (`/hades-learn`). Goal: the
next task starts from `CONTEXT.md` and never rediscovers what this task learned.
`<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.
Scope: vault files only. Never edit a project repo (stale project docs -> backlog) or the engine,
never commit (the PM commits exactly the files in your OUTPUT). Paths below are relative to the
Team folder unless they start with `<vault>` or `<engine>`; `<org_dir>` = the team folder's `../..`.

## Inputs (summaries first, details only to confirm a fact)
1. Task `README.md`: Request, Decisions, Lessons (one line per role return, plus owner notes), Outcome.
2. `state.json` (size, rounds, model per stage, deploy, usage) and `defects.json` (what broke, where,
   source, how many rounds).
3. The `## Summary` of each stage file; `gates.json` failures (step + excerpt only).
4. Current `CONTEXT.md`, `team.json`, and only the `knowledge/`, `projects/`, `agents/` and `skills/`
   files the inputs touch.

## Procedure
1. **Lessons** -> `knowledge/lessons.md`: `- YYYY-MM-DD <task-id>: <what happened> -> <do next time>`.
   Sources: README Lessons, defects that needed > 1 round, red gates, failed deploys, escalations.
   Reusable ones go under *Standing lessons* at the top (<= 15; merge or sharpen, never duplicate);
   dated ones below.
2. **Facts** -> `knowledge/architecture.md`, `conventions.md`, `domain.md`, `glossary.md`. Replace
   wrong statements; never append a contradiction.
3. **Decisions** -> `knowledge/decisions.md`, only lasting non-obvious choices (README Decisions, 02):
   `### ADR-NNN <title> (YYYY-MM-DD, <task-id>)` with Context, Decision, Consequences. Task-local
   assumptions stay in the README.
4. **Commands and environments** -> `team.json`, through the CLI only (never edit the file):
   stack changed -> `hades detect <project> --write <team>`; a command a role had to correct ->
   `hades team set <team> command <key> "<cmd>" [--project <rel>]`; an environment fact DevOps did
   not record -> `hades team set <team> env <test|live> <field> "<value>"`. A refused shell value
   prints the guard reason: record it as a lesson, never work around it. Mirror changes in `TEAM.md`.
5. **Projects** -> `projects/<repo>.md`: purpose, entry points, run/test notes, gotchas, when changed.
6. **Team skills** -> a procedure done, or certain to be done, more than once (deploy sequence,
   test-data recipe, migration pattern, eval run): `skills/<kebab>/SKILL.md` with frontmatter
   `name`, `description` and numbered steps with exact commands. Update rather than duplicate.
7. **Role notes** -> `agents/<role>.md` (project-manager, business-analyst, software-architect,
   tech-lead, backend-engineer, frontend-engineer, aiml-data-engineer, qa-engineer, devops-engineer,
   cybersecurity-engineer): guidance only that role needs (e.g. "qa-engineer: admin UI uses hash
   routes; test via #/"). Recurring defect patterns -> the owner role's notes. A role that needed
   opus escalation in 2+ recent tasks of this team -> `model: opus` under *Overrides*
   (`<engine>/company/model-routing.md`); never downgrade after one good task.
8. **Promote** -> true for more than one team of the org: move to `<org_dir>/knowledge/` or
   `<org_dir>/skills/`, leave a one-line pointer. True for every org: `<vault>/company/`
   (`knowledge/`; habits of company staff in `staff/<role>.md`). A changed cross-team contract ->
   `<org_dir>/ORG.md`.
9. **Technology** -> the task used a technology with no engine playbook
   (`<engine>/playbooks/tech/README.md` lists them) or found one wrong or incomplete: write or update
   `<vault>/company/playbooks/tech/<tech>.md` and its fingerprint in
   `<vault>/company/playbooks/stacks.json` (`<engine>/playbooks/learn-technology.md` steps 5-6).
   Generic ones also go under *Engine upstream candidates* in `<vault>/company/knowledge/lessons.md`.
10. **Usage** -> compare `state.json` usage with the last 5 closed tasks of the same size
    (`hades task list <team>`, their `state.json`). Only when notable (> 1.5x their median, or one
    stage or model > 50% of the tokens): one line in `knowledge/lessons.md`
    `- YYYY-MM-DD <task-id> usage: <tokens> / $<cost> vs median <tokens> (size <S|M|L>): <cause> -> <remedy>`.
11. **Backlog** -> follow-ups, tech debt, stale project docs: `tasks/BACKLOG.md` (create if missing),
    `- <task-id>: <item>`.
12. **CONTEXT.md** last: refresh the digest from all of the above; <= 120 lines (check the count).
    It lists team skills (`name: one line`), points to knowledge files by section instead of copying
    them, and names any vault tech playbook the team's stacks use.

## Relearn mode (assignment says so, or no task)
Compare `team.json` with `hades detect <project>` (print only); read project docs and
`git -C <repo> log -30 --stat` (filtered) for what changed since the last learning; then steps 2,
4-8, 11, 12.

## Migrate mode (assignment says so: one team after `hades migrate` from HADES v1)
Open items: `Grep -rln "hades-migrate" <Team folder>` and the files `<Team folder>/agents/*.v1.md`.
Untouchable: `git -C <vault> status --porcelain -- <Team folder>` lists a file with no
`hades-migrate` marker that is not a `.v1.md` -> its uncommitted changes predate the migration
(`hades migrate` skips dirty files): never edit it (by hand or through `hades`, e.g. an untouchable
`team.json` skips step 3), move or delete it; name it under DECISIONS.
1. **Role notes**: file every line of each `agents/*.v1.md` into the v2 notes
   (`<engine>/docs/migration-from-v1.md` role table): `senior-fullstack-engineer.v1.md` ->
   `backend-engineer.md` (database, API, services, jobs) and `frontend-engineer.md` (UI);
   `uiux-engineer.v1.md` -> `frontend-engineer.md`; work breakdown, contracts and integration ->
   `tech-lead.md`; deploy and infrastructure -> `devops-engineer.md`. Merge under *Project notes*
   (`model:` lines under *Overrides*); drop duplicates and stale lines.
2. **Markers**: remove every `<!-- hades-migrate: TODO ... -->` line once its item is done.
3. **team.json** through the CLI only: `hades detect <project> --write <team>`; each environment
   fact in `TEAM.md` -> `hades team set <team> env <test|live> <field> "<value>"` (url, deploy,
   health, rollback, via_push, notes); the `TODO(hades-migrate)` notes value -> the real notes or
   `""`; a command detect missed -> `hades team set <team> command <key> "<cmd>" [--project <rel>]`.
4. Steps 2, 5, 7 and 11 for what `TEAM.md`, `legacy/` and `knowledge/` say, then step 12:
   `CONTEXT.md` from `TEAM.md` and the knowledge files, <= 120 lines, without the marker line.
5. Delete each `.v1.md` once all its lines are filed; list it in OUTPUT as `deleted <path>`.
Done when the Grep finds nothing and no `.v1.md` remains, except untouchable files (DECISIONS).

## Quality bar
- A new member reading only `CONTEXT.md`, then the files it points to, can run the next task.
- Living documents: correct, merge, delete stale lines; headings and bullets; short.
- Every change has a source (task file, CLI output, or project path).
- No secret values, no personal data, no logs, no client names in learned playbooks.

## Return
The 8-line return contract (`<engine>/company/handover.md`). OUTPUT = every vault file changed
(absolute paths); SUMMARY = what the team learned; GATE: n/a.
