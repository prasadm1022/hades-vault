# Pipeline

Stages (CLI names, in order): `intake analysis design planning build qa release deploy security close`
(`release` = the release commit). The operational procedure is the PM skill (`skills/hades/SKILL.md`);
this file states the contract it follows. File names, IDs (AC-n, TC-n, W#, D#) and JSON:
`docs/file-formats.md`. Spawn prompt and return: `handover.md`. Gates: `quality-gates.md`. Models:
`model-routing.md`.

For every stage the PM runs `hades task stage <task> <stage> running --model <m>` when it spawns the
owner and `hades task stage <task> <stage> done|failed|skipped|blocked [--note "<why>"]` at exit. Exit
is judged by the evidence named below, never by a return message. Status: `hades task show <task>`.
The PM reads stage Summaries and CLI output only, never product code.

## Depth per size

| Stage | S | M | L |
|---|---|---|---|
| analysis | BA note <= 15 lines, >= 1 AC | full `01` | full `01` + NFRs, permission matrix, data retention |
| design | architect note <= 15 lines (files, risk, rollback) | full `02` | full `02` incl. threat notes; `04-model-plan.md` when AI/ML/data is in scope |
| planning | PM writes one W (no tech-lead spawn) | tech lead | tech lead (greenfield: scaffold first); critical path flagged for opus |
| build | one engineer, one wave; UX as `## UX` in `05` | UX design (`04-ux-design.md`) for frontend items; waves; QA test plan; integration review | same as M |
| qa | `06` with targeted TCs; build gate | full `06`/`07` | full + negative, permission, a11y, regression; smoke TCs on the test env after deploy |
| release, deploy | full policy | full policy | full policy |
| security | security preset + diff review | + manual review of changed flows; DAST baseline on the deployed URL | + ASVS review (L3 for auth/payment), active DAST on test env, REA on built artefacts when relevant |
| close | knowledge-curator | knowledge-curator | knowledge-curator |

## Stages

### 0 intake - PM
- In: the owner's request; `hades team resolve <query>` (none: see Greenfield).
- Do: `hades task new <team> --title "..." --size <S|M|L> --request-file <file>`; request verbatim in
  `README.md`; size (larger when unsure); first assumptions. Per repo and the vault
  `git -C <repo> status --short`; pre-existing changes go to README *Commits* (`commit-policy.md`).
- Exit: task folder with request and size. Evidence: `hades task show <task>`.

### 1 analysis - business-analyst
- In: README request, `CONTEXT.md`, domain knowledge, product code and docs (read-only).
- Out: `01-business-solution.md`: actors, requirements, AC-n in Given/When/Then, edge cases, out of
  scope, testable NFRs, assumptions.
- Exit (G1): every requirement has >= 1 AC. Evidence: `hades task coverage <task>` lists every AC.

### 2 design - software-architect, then aiml-data-engineer (L with AI/ML/data scope)
- In: `01`, `CONTEXT.md`, architecture/conventions/decisions knowledge, code (scout or serena lookups).
- Out `02-technical-solution.md`: AC -> component map, contracts (API, events, schemas), data model and
  reversible migrations, test strategy, deploy strategy (env, migration order, rollback, new
  resources and cost), security notes (trust boundaries, authz, tenancy), risks, ADR candidates;
  greenfield: stack and repository skeleton. Its Summary states `AI/ML/data: yes|no`.
- Out `04-model-plan.md` (aiml-data-engineer, size L with `AI/ML/data: yes`, after `02`): models and
  prompts, data contracts, eval set, metrics with baselines and thresholds, budget.
- Exit (G2 design): every AC-n of `01` appears in the `02` map; contracts, data model, test and deploy
  strategy present; `04-model-plan.md` when required.

### 3 planning - tech-lead (S: PM)
- In: `01` (Summary + AC), `02`, `04-model-plan.md`.
- Greenfield (no commit yet): the tech lead first scaffolds the repo (`git init -b main` if needed,
  skeleton per `02`, one passing test), runs `hades detect <path> --write <team>`, and the build gate
  must pass on the skeleton.
- Out: `03-work-plan.md` and the work plan: the tech lead writes `<task folder>/work-plan.draft.json`
  and runs `hades task plan <task> --from <task folder>/work-plan.draft.json`. Wave 1 = contracts and
  foundations (shared types, schemas, migrations); later waves build on them in parallel; same-wave
  items share no file. QA's automated tests live in files no item lists (named in `03`).
- Exit (G2): `hades task plan` exit 0; `hades task coverage <task>` shows no AC without a W (AC -> W
  coverage is checked here; TC gaps are expected until `06`).

### 4 build - backend / frontend / aiml-data engineers in waves; QA in parallel
- PM, first message (M/L): QA plan mode in the background (`06-test-plan.md`: TC-n per AC-n, smoke
  cases marked); M/L with frontend items: the frontend engineer writes `04-ux-design.md` (flows, screens,
  states, accessibility, responsive widths, copy) before any frontend W starts.
- Per wave, one spawn per owner role with its W IDs. The next wave starts only when the wave's items
  are `done` and `hades gate <task> --preset build` is ok (the PM's run is the evidence of record).
- Engineer: code + tests for its items, `05-impl-<role>.md`, `hades task item <task> <W#> doing|done`,
  `hades gate <task> --preset build --project <rel>` until ok.
- M/L after the last wave: the tech lead's integration review (`## Integration review` in `03`);
  findings beyond glue are defects `--source review`, fixed and verified (defect loop) in this stage.
- Exit (G3): every W `done`; build gate ok on all projects (a gate with no runnable step prints
  `GATE EMPTY` and is red); no open critical/high review defect.

### 5 qa - qa-engineer
- Entry (M/L): `hades task coverage <task>` shows a TC for every AC before `qa running` (AC -> TC
  coverage). S: the round-1 execute spawn writes `06` first; coverage is checked at its exit.
- In: `01` AC, `06`, `05-*` Summaries, `gates.json`; the app run locally (`team.json` `run`; Playwright MCP for UI).
- Out: `07-qa-report.md` `## Round n` (TC results with evidence paths); defects via `hades defect add ... --source qa`.
- Exit (G4, G6): every TC executed; `hades task coverage <task>` has no gap; `hades defect list <task>
  --open --source qa` shows no critical/high; mediums fixed or `wontfix` with the PM's reason.

### 6 release - PM
- `hades gate <task> --preset precommit` ok, then the release commit per `commit-policy.md`, then
  `hades task commit <task> --repo <path>` per repo.
- Exit (G8): docs for changed behaviour are in the commit (the tech lead lists them in the owning
  item's files and in `03`; the PM checks the commit); every changed repo has a recorded commit.
  Evidence: `hades task show <task>`, `git -C <repo> log -1 --stat <hash>`.

### 7 deploy - devops-engineer
- In: `02` deploy strategy, `team.json` environments, recorded commits. Rules: `deployment-policy.md`.
- Only committed HEAD is deployed: deploy config changed in this stage is validated, returned to
  the PM, committed (`chore(deploy): ...`) and then deployed by a re-spawn.
- Out: `08-deployment.md` `## Deploy n`; `hades task deploy <task> --env <test|live|none|pending-push> [--url <url>]`;
  environment facts via `hades team set <team> env <test|live> <field> <value>`; greenfield: CI and
  deploy configuration. A red health check is rolled back and recorded as defects `--source deploy`.
- Exit (G7): health check green on the deployed env, or `none`/`pending-push` recorded with reason;
  rollback recorded. L with a test env: QA runs the smoke TCs against its URL (failures: defect
  loop, fix commit, redeploy, smoke again). Still red after the defect loop: the stage is `blocked`,
  not `failed` (`failed` = retry, later stages wait; `blocked` = continue with what is safe).

### 8 security - cybersecurity-engineer
- In: `01`, `02` security notes, the task commits' diff, `08` URL. Rules: `security-policy.md`.
- Source-level work needs only the release commit: the PM spawns it in the background when deploy
  starts (`security` may be `running` while `deploy` runs); deployed-system tests (DAST,
  headers/TLS) wait for the recorded deploy. No deploy (`none`, `pending-push`, not provisioned):
  the engineer starts the app locally (`team.json` `run`, else `docker compose`), runs
  `hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target` and the probes
  (local = test), then stops it.
- Out: `09-security-report.md` `## Round n`; defects via `hades defect add ... --source security`.
- Exit (G5): `hades gate <task> --preset security` ok; DAST per policy done or recorded n/a;
  `hades defect list <task> --open --source security` shows no critical/high.

### 9 close - PM + knowledge-curator
- `hades usage --task <task>`; learning loop (`knowledge-policy.md`); `hades task close <task>
  --status done|blocked --note "..."`; then the vault commit, last (`commit-policy.md`: the task
  folder, `team.json` and every vault file the task changed); report.
- Exit (G9): README *Lessons*, *Learning* and *Outcome* filled; task closed; vault committed.

## Defect loop (sources qa, review, security, deploy)

1. The finder records: `hades defect add <task> --title --severity --owner <role> --source <src> --repro --refs --evidence`
   (qa: QA; review: tech lead; security: cybersecurity engineer; deploy: DevOps).
2. The PM spawns each owner once with all its defect IDs. The engineer fixes, runs the build gate,
   `hades defect update <task> <D#> --status fixed --by <role>`. Owner `tech-lead` = glue between
   layers (tech lead fix mode); a failure needing changes in several layers = one defect per layer,
   each owned by that layer's engineer.
3. The finder verifies: `verified` or `reopened`. Security: QA verifies first, then PM fix commit,
   DevOps redeploys the same env, the cybersecurity engineer re-verifies. Deploy: PM fix commit,
   DevOps redeploys; health green = verified.
4. Severity: critical/high block the stage; medium is fixed in the same round when cheap, otherwise
   `wontfix` with the PM's reason plus a `tasks/BACKLOG.md` line; low goes to the backlog.

## Round limits

- Each move to `fixed` is a round; the second round of a defect runs the engineer on opus (the
  frontend engineer keeps its model); a reopen after round 3 makes it `blocked`.
- QA and security stages run at most 3 rounds each (`rounds` in `state.json`): a verify that adds a
  new critical/high defect starts a round (`failed`, then `running`); when the CLI reports the
  limit exceeded, no further fix spawn runs and the stage is `blocked`.
- A gate that stays red after 3 distinct fix attempts blocks the stage (note); build blocked ->
  later stages `skipped`, task closed `blocked`, nothing committed.

## Blocked work

- Mark the stage `blocked` with a note; do not wait, do not ask. Record the blocker, its evidence and
  the exact owner action that clears it (credential name, licence, environment).
- Continue with what is safe: independent items and stages proceed. Nothing red is deployed to live.
  A critical/high defect `blocked`: still commit (body `Known defects: D#...`), deploy to test only
  (else `--env none`), close the task `blocked`.
- An unresolved critical/high security defect on a live deploy: DevOps rolls that deploy back; the
  commits stay local and the report marks them do-not-push.
- Close with `--status blocked` when any AC is not delivered.

## Parallelism

- build: QA's test plan and the waves; engineers of one wave in parallel.
- deploy and source-level security in parallel after release.
- Background spawns whenever nothing waits on the result. Never parallel: two roles on one file,
  two waves, two deploys to one environment.

## Greenfield (no project yet)

1. Intake: use the named organization or create it (`hades org new`); `hades team new` creates and
   git-inits the project folder (the path the owner named, else `<org root>/<team>`); size L.
2. Analysis as usual. Design: the architect chooses stack, hosting and the repository skeleton
   (mainstream, well supported, what the organization already runs, then cost).
3. Planning: the tech lead scaffolds the skeleton before writing the plan (section 3).
4. Deploy: DevOps adds CI and the deploy configuration (`deployment-policy.md`, Not provisioned).
5. First release commit on `main`; the owner adds a remote and pushes.

## Multi-team tasks

- One task, one PM: the owning team is the one that delivers the requested outcome (tie: the
  contract provider).
- Each other team whose repos change gets a linked task: `hades task new <other> --title "<task-id>: ..."`
  with its own short `01` (the ACs it delivers, citing the parent's AC IDs), plan, gates and commits.
  The parent README lists linked tasks.
- Contracts are frozen in the parent `02` and recorded in `ORG.md` *Cross-team contracts* (both
  organizations' when they differ). Providers build and deploy before consumers; changes stay
  backward compatible until every consumer is deployed.
