# File formats

Every machine-readable file HADES reads or writes. The CLI (`bin/hades.mjs`) is the only writer of
the JSON files below; agents change them through CLI commands (`docs/cli.md`), never by hand.

## `hades.config.json` (engine root, git-ignored)

```json
{
  "vault": "C:/Users/me/git/my-vault",
  "workspace": "C:/Users/me/git",
  "aws": { "profile": "hades-deploy", "region": "eu-west-1", "read_only": false }
}
```

- Written by `hades init` (merged: other keys are kept). `HADES_VAULT` and `HADES_WORKSPACE`
  override `vault` and `workspace`; defaults: `<engine>/vault`, the engine's parent folder.
- `aws` (optional, read by `hades mcp aws` and `hades doctor`): `profile` (string) or `profiles`
  (list); without either, `AWS_PROFILE`. `region` = where the AWS MCP server operates.
  `read_only: true` hides write-capable AWS MCP tools. `endpoint` (https) overrides the AWS MCP
  endpoint. The profile must be least-privilege; `hades doctor` FAILs on root credentials.

## `<engine>/.hades/install.json` (written by `hades install`)

```json
{
  "version": 1,
  "installs": [
    {
      "scope": "user",
      "claude_dir": "C:/Users/me/.claude",
      "settings_file": "C:/Users/me/.claude/settings.json",
      "workspace": null,
      "autonomy": "guarded",
      "engine": "C:/Users/me/git/hades",
      "node": "C:/Program Files/nodejs/node.exe",
      "engine_version": "2.0.0",
      "source": "C:/Users/me/git/hades",
      "vault": "C:/Users/me/git/my-vault",
      "installed_at": "2026-10-31T09:00:00Z",
      "files": [ { "path": "C:/Users/me/.claude/agents/hades/hades-tech-lead.md", "rel": "agents/hades/hades-tech-lead.md", "kind": "agent", "name": "hades-tech-lead", "sha256": "..." } ],
      "settings_added": { "hooks": [], "deny": [], "allow": [], "keys": [] }
    }
  ]
}
```

One record per scope and Claude directory. `settings_added` lists exactly what HADES added to
`settings.json`, so `--uninstall` removes only that; `hades doctor` compares `files` with disk and
with a fresh render of the engine sources (rendered with the recorded `node`, the Node binary that ran
the install and that the agents' MCP servers and the guard hook use). `workspace` is set for project
scope; `autonomy` is what a later `hades install` without `--autonomy` keeps.

## `registry.json` (vault root, schema version 3)

```json
{
  "version": 3,
  "organizations": {
    "acme": {
      "org_dir": "organizations/acme",
      "root_path": "C:/Users/me/git/acme",
      "description": "Acme products",
      "aliases": ["acme-inc"],
      "created": "2026-10-31"
    }
  },
  "teams": {
    "portal": {
      "organization": "acme",
      "type": "main",
      "project_path": "C:/Users/me/git/acme/portal",
      "team_dir": "organizations/acme/teams/portal",
      "description": "Customer portal",
      "aliases": ["acme-portal"],
      "status": "active",
      "created": "2026-10-31"
    }
  }
}
```

- Team names are kebab-case and unique across organizations; aliases are unique too.
- `type` is `main` (owns a core product) or `sub` (secondary product of the organization). Both
  have the full team roster.
- Paths use forward slashes. `team_dir` and `org_dir` are relative to the vault.
- Version 2 registries (HADES v1) also had `vault`, `git_root` and `hierarchy` keys; `hades migrate`
  moves `vault` and `git_root` into `hades.config.json` and drops `hierarchy`.

## `team.json` (`<team_dir>/team.json`)

The machine-readable half of `TEAM.md`. `hades gate` and the deploy stage read it. Changed only by
`hades team set` and `hades detect --write`.

```json
{
  "team": "portal",
  "projects": [
    {
      "path": ".",
      "stack": ["node", "typescript", "react"],
      "commands": {
        "install": "npm ci",
        "build": "npm run build",
        "lint": "npm run lint",
        "types": "npx tsc --noEmit",
        "test": "npm test",
        "run": "npm run dev",
        "format": "npx prettier --check ."
      }
    }
  ],
  "environments": {
    "test": { "url": "", "deploy": "", "health": "", "rollback": "", "via_push": false, "notes": "" },
    "live": { "url": "", "deploy": "", "health": "", "rollback": "", "via_push": false, "notes": "" }
  },
  "branch_strategy": "current-branch",
  "security": { "semgrep_config": "p/default", "dast_live": "baseline", "dast_test": "full" }
}
```

- `projects[].path` is relative to the team's `project_path` (`.` = the project root). A workspace
  of several repositories has one entry per repository.
- Empty command = not applicable; the gate step is reported as `n/a`, never as passed.
- An environment is **configured** when `deploy` is non-empty or `via_push` is `true`.
  `via_push: true` means deploying requires `git push` (CI deploys on push); HADES never pushes, so
  such a deploy is recorded as `pending-push` (with or without a `deploy` command).
- `deploy`, `health` and `rollback` are shell command lines run from the project root. `health`
  must exit 0 when the system is healthy (for example `curl -fsS https://host/health`).
  Credentials are referenced by environment-variable or profile name in `notes`, never written here.
- Shell values are checked with the guard's `checkShell` when set and before the CLI runs them.
- `branch_strategy`: `current-branch` | `feature-branch`. `security.semgrep_config`: a Semgrep
  registry config (`p/...`) or a rules path relative to the project (default `p/default`).
  `security.dast_live`: `baseline` | `none`; `security.dast_test`: `baseline` | `full` | `api` | `none`.

## Task folder (`<team_dir>/tasks/<id>-<slug>/`)

`<id>` is `<team>-<NNN>`; numbering continues after the highest existing record, including HADES v1
single-file records (`tasks/<id>-<slug>.md`, optional `tasks/<id>-artifacts/`). `hades task adopt <id>`
turns such a record into a v2 folder `tasks/<id>-<slug>-v2/` and never touches the v1 files.

| File | Writer | Contents |
|---|---|---|
| `README.md` | PM | request (verbatim), size, plan summary, Decisions, Gates, defects, deploy, commits, usage, Lessons, Learning, Outcome |
| `state.json` | CLI | stage machine, rounds, models, commits, deploy, usage |
| `defects.json` | CLI | defects from QA, security, review and deploy |
| `work-plan.draft.json` | tech-lead (Write) | plan draft, input of `hades task plan <task> --from <file>` |
| `work-plan.json` | CLI (`hades task plan`) | validated work items |
| `gates.json` | CLI (`hades gate`) | gate runs with evidence |
| `01-business-solution.md` | business-analyst | actors, requirements, `AC-n`, assumptions |
| `02-technical-solution.md` | software-architect | AC map, contracts, data model, test and deploy strategy |
| `03-work-plan.md` | tech-lead | waves, rationale, `## Integration review` (M, L) |
| `04-ux-design.md` | frontend-engineer | flows, screens, states, accessibility (user-facing work) |
| `04-model-plan.md` | aiml-data-engineer | L tasks with AI/ML/data scope: models, prompts, data contracts, eval set and metrics; written in design after `02`, before planning |
| `05-impl-<role>.md` | each engineer | what changed, how verified |
| `06-test-plan.md` | qa-engineer | `TC-n` mapped to `AC-n` |
| `07-qa-report.md` | qa-engineer | `## Round n` per round |
| `08-deployment.md` | devops-engineer | `## Deploy n` per deploy |
| `09-security-report.md` | cybersecurity-engineer | `## Round n` per round |

Every stage file starts with `## Summary` (at most 10 lines) so downstream roles can read only the
summary. Gate logs are written outside the vault, to `<engine>/.hades/logs/<task-id>/`.

Acceptance criteria are numbered `AC-1`, `AC-2`, ... in `01-business-solution.md`; test cases
`TC-1`, ... in `06-test-plan.md`; work items `W1`, ... in `work-plan.json`; defects `D1`, ... in
`defects.json`. The CLI checks coverage by these IDs: AC -> work item at planning (`task plan`),
AC -> test case before `qa` starts (`task coverage`).

### Task `README.md` sections

Frontmatter `id`, `team`, `organization`, `title`, `size`, `opened`; then the headings
`## Request (verbatim)`, `## Decisions` (numbered assumptions and choices: intake plus every role's
`DECISIONS` line), `## Lessons` (every role's `LESSONS` line; the knowledge-curator reads this
section), `## Plan summary`, `## Gates` (G1-G9 table: status, evidence), `## Defects summary`,
`## Deploy`, `## Commits`, `## Usage`, `## Learning` (vault files the learning loop changed),
`## Outcome`. A task adopted from a v1 record (`hades task adopt`) also has a `Legacy` line linking
the v1 record and its `<id>-artifacts/` folder.

### `state.json`

```json
{
  "id": "portal-012",
  "team": "portal",
  "organization": "acme",
  "title": "Password reset by email",
  "size": "M",
  "status": "open",
  "opened": "2026-10-31T09:00:00Z",
  "closed": null,
  "stage": "analysis",
  "stages": {
    "intake":   { "status": "done", "at": "2026-10-31T09:00:00Z", "note": "" },
    "analysis": { "status": "running", "at": "2026-10-31T09:01:00Z", "model": "opus" },
    "design":   { "status": "pending" },
    "planning": { "status": "pending" },
    "build":    { "status": "pending" },
    "qa":       { "status": "pending" },
    "release":  { "status": "pending" },
    "deploy":   { "status": "pending" },
    "security": { "status": "pending" },
    "close":    { "status": "pending" }
  },
  "rounds": { "qa": 0, "security": 0 },
  "commits": [ { "repo": "C:/Users/me/git/acme/portal", "hash": "abc1234", "summary": "feat(auth): ..." } ],
  "deploy": { "env": "test", "url": "https://test.example.com", "at": "2026-10-31T10:00:00Z", "note": "health 200 after 40s" },
  "usage": null
}
```

- Stage status: `pending`, `running`, `done`, `skipped`, `failed`, `blocked`. Task status: `open`,
  `done`, `blocked`. `stage` = the first stage not `done` or `skipped` (`null` when complete).
- `deploy.env`: `test`, `live`, `none`, `pending-push`; `url` may be empty; `note` only when given.
- `usage` (written by `hades usage --task`):

```json
{
  "window": { "start": "2026-10-31T09:00:00Z", "end": "2026-10-31T11:30:00Z", "open": false },
  "by_model": { "<model id>": { "input_tokens": 0, "output_tokens": 0, "cache_creation_tokens": 0, "cache_creation_1h_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0, "messages": 0, "cost_usd": 0 } },
  "totals": { "input_tokens": 0, "output_tokens": 0, "cache_creation_tokens": 0, "cache_creation_1h_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0, "messages": 0 },
  "cost_usd_estimate": 0,
  "unpriced_models": [],
  "sessions": 3,
  "session_filter": null,
  "files_scanned": 12,
  "note": "estimate; edit lib/core/pricing.json; every session active inside the window is counted",
  "computed_at": "2026-10-31T11:31:00Z"
}
```

`cost_usd` is `null` for a model without a price in `lib/core/pricing.json`.

### `defects.json`

```json
{
  "defects": [
    {
      "id": "D1",
      "title": "Reset link accepted after expiry",
      "severity": "high",
      "source": "qa",
      "owner": "backend-engineer",
      "status": "open",
      "round": 0,
      "repro": "1. request reset 2. wait 31 min 3. open link -> password form shown",
      "evidence": "07-qa-report.md#round-1",
      "refs": ["src/auth/reset.ts:42"],
      "history": [ { "at": "2026-10-31T10:00:00Z", "status": "open", "by": "qa-engineer", "note": "" } ]
    }
  ]
}
```

- Severity: `critical`, `high`, `medium`, `low`. QA "blocker/major" = `critical`/`high`.
- Source: `qa` (QA testing), `security` (cybersecurity testing), `review` (tech-lead integration
  review, M and L tasks), `deploy` (failed deploy or health check).
- Status: `open`, `fixed`, `verified`, `reopened`, `blocked`, `wontfix`. Flow: `open -> fixed ->
  verified`, or `fixed -> reopened -> fixed ...`. Each move to `fixed` increments `round`; a defect
  reopened after round 3 becomes `blocked`. `wontfix` needs a reason. Transitions: `docs/cli.md`.
- Owner is a role name: `backend-engineer`, `frontend-engineer`, `aiml-data-engineer`, `devops-engineer`, `tech-lead`.
- Gate rule: `qa` and `security` cannot pass while a `critical` or `high` defect of that source is
  `open`, `fixed` (unverified) or `reopened`; a task cannot close `done` while any critical/high
  defect is one of those or `blocked`.

### `work-plan.draft.json` and `work-plan.json`

The tech lead writes `<task folder>/work-plan.draft.json` and runs
`hades task plan <task> --from <task folder>/work-plan.draft.json`; the CLI validates it
(`docs/cli.md`, Plan validation) and stores `work-plan.json`. Same shape:

```json
{
  "items": [
    {
      "id": "W1",
      "title": "Reset token table and repository",
      "owner": "backend-engineer",
      "wave": 1,
      "depends_on": [],
      "project": ".",
      "files": ["src/db/migrations/0012_reset_tokens.sql", "src/auth/resetRepo.ts"],
      "acceptance": ["AC-1", "AC-3"],
      "done_when": "migration applies and resetRepo unit tests pass",
      "status": "todo",
      "at": "2026-10-31T09:30:00Z"
    }
  ]
}
```

- Stored items are normalised: `depends_on`, `acceptance` default to `[]`, `project` to `.`, file
  paths to forward slashes, `status` to the previous plan's status or `todo`.
- `status`: `todo`, `doing`, `done`; `at` = time of the last `hades task item` update.
- `owner`: `backend-engineer`, `frontend-engineer`, `aiml-data-engineer`, `devops-engineer` or `tech-lead`.

### `gates.json`

```json
{
  "runs": [
    {
      "preset": "build",
      "at": "2026-10-31T09:40:00Z",
      "head": "abc1234",
      "dirty": true,
      "repos": { ".": { "head": "abc1234", "dirty": true } },
      "ok": false,
      "steps": [
        { "project": ".", "step": "build", "status": "pass", "ms": 8123, "cmd": "npm run build", "log": ".hades/logs/portal-012/root-build-1761903600000.log" },
        { "project": ".", "step": "test", "status": "fail", "ms": 20111, "cmd": "npm test", "note": "exit 1", "tests": { "passed": 41, "failed": 2 }, "log": "...", "excerpt": "FAIL src/auth/reset.test.ts ..." },
        { "project": ".", "step": "lint", "status": "n/a" },
        { "project": ".", "step": "sast", "status": "pass", "ms": 30500, "log": "...", "report": "...", "counts": { "critical": 0, "high": 0, "medium": 2, "low": 1 }, "top": ["medium rule-id src/x.ts:10"], "config": "p/default" },
        { "project": ".", "step": "deps", "status": "pass", "ms": 9000, "log": "...", "report": "...", "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0 }, "top": [], "offline": true }
      ]
    }
  ]
}
```

- Run: `preset` (`build`, `precommit`, `predeploy`, `security`, `full`, `custom` for `--only`,
  `dast`), `only` (steps of an `--only` run), `mode` and `target` (DAST runs), `head`/`dirty` of the
  first project, `repos` = `{head, dirty}` per project path, `ok`.
- Step: `project` (absent for `dast`), `step`, `status` (`pass`, `fail`, `n/a`, `error`), `ms`,
  `cmd` (command steps), `note` (exit code, timeout, `blocked by the guard (<rule id>)`, missing tool), `tests`
  (`{passed, failed}` when a test summary was recognised), `counts` and `top` (scanner findings by
  severity, first 5), `report` (scanner JSON), `config` (`sast`), `offline` (`deps` used the cached
  DB), `excerpt` (failing steps only), `mode`/`target` (`dast`). Paths inside the engine are stored
  engine-relative.
- A run is `ok` only when no step is `fail` or `error`. A run older than the last code change is
  stale (`head`, `dirty`).

## Vault: learned technology knowledge

| File | Contents |
|---|---|
| `<vault>/company/playbooks/tech/<tech>.md` | learned technology playbook (`playbooks/learn-technology.md`): detection, commands, deploy, pitfalls, sources with versions and date |
| `<vault>/company/playbooks/stacks.json` | learned fingerprints, same schema as the engine's `playbooks/stacks.json` (an array of stacks; schema in `lib/core/detect.mjs`). `hades detect` merges it over the engine file when a vault exists |

Generic, client-free entries are also listed as *Engine upstream candidates* in
`<vault>/company/knowledge/lessons.md`; contributing them to the engine is the owner's choice.
