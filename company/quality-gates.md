# Quality gates

A stage exits only when its gates are green or waived. The PM records each gate in the task
`README.md` *Gates* table: status (`green`, `red`, `waived`, `n/a`) and the evidence (command and
one-line result, or file#section). Commands: `docs/cli.md`.

| Gate | Stage | Applies | Green when | Evidence |
|---|---|---|---|---|
| G1 Requirements | analysis | all (S: note) | every requirement has AC-n in Given/When/Then; assumptions recorded | `hades task coverage <task>` lists every AC |
| G2 Design & plan | design, planning | all (S: note + one W) | every AC maps to a component (`02`) and to >= 1 W; contracts, data model, test and deploy strategy, rollback written; `04-model-plan.md` for L AI/ML/data work | AC map in `02`; `hades task plan` exit 0; `hades task coverage` no AC without W |
| G3 Build | build | all | build, lint, types, test pass in every project; integration review (M/L) done, no critical/high review defect unverified | `hades gate <task> --preset build` ok in `gates.json`; `hades defect list <task> --open --source review` |
| G4 Tests | qa | all | every TC executed; every AC has >= 1 passing TC; no critical/high `qa` or `review` defect `open`, `fixed` or `reopened` (the CLI refuses `qa done` otherwise) | `hades task coverage <task>` no gaps; `hades defect list <task> --open --source qa` (and `--source review`); `07` round section |
| G5 Security | release, deploy, security | all | no secrets committed; predeploy scans clean before live; no critical/high security defect unresolved; mediums fixed or `wontfix` with reason; DAST done per `security-policy.md` | `--preset precommit` at release; `--preset predeploy` before live; `--preset security` and `hades gate <task> --dast <url>`; `hades defect list <task> --open --source security`; `09` |
| G6 UX | build, qa | user-facing changes | `04` covers flows, states, accessibility, responsive widths, copy; QA TCs for states, keyboard, screen-reader basics and widths pass | `04-ux-design.md` incl. `## UX review`; TC results in `07` with screenshot paths |
| G7 Ops | deploy | every deploy; migrations and config changes | health check exits 0 (red: rolled back, defects `--source deploy`); rollback recorded; live preconditions met; migrations ordered, reversible, backed up; config documented by env-var name | `hades task deploy` record; `08` section with health line, rollback and backup commands |
| G8 Docs | release | behaviour changes | project docs that describe the change (README, API spec, `.env.example`, changelog) updated in the same commit (the tech lead lists them in the owning item's files; the PM checks the commit, a miss gets a `docs(<scope>)` commit); nothing written to `CLAUDE.md`/`.claude/` | `git -C <repo> log -1 --stat <hash>` |
| G9 Knowledge | close | all | learning loop done; `CONTEXT.md` current and <= 120 lines; usage recorded | `hades usage --task <task>`; README *Learning* lists the vault files changed |

## Evidence rules

- Green means a command ran on the current code and its result was seen. A gate run older than the
  last code change is stale (`gates.json` records `head` and `dirty`): rerun it.
- `n/a` is never `pass`. A gate whose every step is `n/a` is red: `hades gate` exits 2 with
  `GATE EMPTY (no commands configured: run hades detect --write or hades team set)` until a command
  is configured; only a PM waiver (reason in the *Gates* row) runs it with `--allow-empty`.
- Claims in return messages, without a matching file or CLI record, are red.

## Waivers

- Only the PM waives, with a written reason in the README *Gates* row; every waiver is listed in
  the final report.
- Never waivable: G5 for changes touching authentication, authorisation, payments or tenancy; any
  open critical defect; the live-deploy preconditions of `deployment-policy.md`.
