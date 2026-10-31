# Getting started

From a fresh clone to a reviewed, pushed change. `hades` = `node <engine>/bin/hades.mjs`.

## 1. Prerequisites

Node.js 22+, git, Claude Code (recent), [uv](https://docs.astral.sh/uv/). Optional: Docker (ZAP
DAST scans), AWS CLI v2 (AWS deploys). A folder that holds your projects (the **workspace**).

## 2. Clone the engine

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades.git
cd hades
npm test            # optional: the CLI test suite (no network needed)
```

## 3. Create the vault

The vault is a private git repository holding your registry, teams, knowledge and task records.
Keep it outside the engine and never publish it.

```sh
hades init --vault ../my-vault --workspace ..
```

This writes `hades.config.json` (git-ignored), scaffolds the vault from `templates/vault/` and runs
`git init` in it (nothing is committed). Add a **private** remote to the vault if you want a backup.

## 4. Tools, install, doctor

```sh
hades tools setup                 # all pinned tools into .tools-bin/ (scanners, MCP servers)
hades install                     # agents, skills, guard hook and deny rules into ~/.claude
hades doctor                      # one line per check; fix every FAIL, read every WARN
```

`hades install` defaults to `--autonomy guarded`: role agents run without prompts, and in the main
session only the safe `hades` subcommands and `git add/commit/status/diff/log/rev-parse` (plain or
`git -C <repo>`) are pre-allowed. The PM's file edits and other commands still prompt, so an
interactive `/hades` needs you at the keyboard. For unattended runs use `hades run` or
`hades install --autonomy full`; read [`autonomy-and-safety.md`](autonomy-and-safety.md) first.
Re-run `hades install` and `hades doctor` after every engine update; a re-run without `--autonomy`
keeps the autonomy of the recorded install.

## 5. Onboard an existing project

Start Claude Code in the workspace and run, with the absolute path of an existing project (or a
path relative to the workspace; a missing folder is refused, never created):

```
/hades-new-team portal C:/work/acme/portal --org acme "Customer portal"
```

Arguments: `<team-name> <project-path> [--org <org>] [--sub] [description]`. The skill registers the
organization (if new) and the team, runs stack detection, surveys the project with read-only scouts,
fills `TEAM.md`, `CONTEXT.md`, `team.json`, knowledge and role notes, moves any `CLAUDE.md`,
`AGENTS.md` and `.claude/` files out of the project into the vault (one project commit, never
pushed) and commits the vault.

Check the detected commands and correct them through the CLI (never by editing `team.json`):

```sh
hades detect C:/work/acme/portal
hades team set portal command test "npm test -- --run"
hades team set portal command lint "" --project web      # "" = not applicable
hades team set portal branch-strategy feature-branch     # optional; default current-branch
```

## 6. Configure environments

HADES deploys to `test` when it is configured (`deploy` non-empty) and reachable, otherwise to
`live` under stricter preconditions; with neither it prepares the deploy configuration and records
*not provisioned*. Values are shell command lines run from the project root; the guard refuses
dangerous ones. Credentials by environment-variable or profile name only, in `notes`.

```sh
hades team set portal env test url "https://test.portal.example.com"
hades team set portal env test deploy "npm run deploy:test"
hades team set portal env test health "curl -fsS https://test.portal.example.com/health"
hades team set portal env test rollback "npm run rollback:test"
hades team set portal env test notes "needs DEPLOY_TOKEN, AWS profile hades-deploy"
hades team set portal env live via_push true      # CI deploys on push: recorded as pending-push
```

`hades team set portal security dast_test full` and `... semgrep_config p/default` tune the security
steps. Active scans never run against the live URL.

## 7. AWS (only if a team deploys to AWS)

1. Create a least-privilege role or IAM Identity Center permission set scoped to the team's
   resources (no `*` actions or resources, no IAM user keys). Never use the root user.
2. Configure a named profile for it and sign in yourself, for example
   `aws configure sso --profile hades-deploy` then `aws sso login --profile hades-deploy`.
3. Add it to `hades.config.json` (you edit this file; agents cannot):

   ```json
   { "aws": { "profile": "hades-deploy", "region": "eu-west-1", "read_only": false } }
   ```

4. `hades doctor --aws-profile hades-deploy` checks the identity; root credentials are a FAIL.

The DevOps engineer uses this profile through `hades mcp aws` and the AWS CLI. HADES never reads
credential files and never creates IAM users or keys.

## 8. Run a requirement

In Claude Code, from the workspace:

```
/hades portal Customers can reset their password by email. Links expire after 30 minutes.
```

Or headless, without permission prompts: `hades run "<requirements>" --team portal`
(`--dry-run` shows the command; `--max-budget-usd 20` caps spend). The PM never asks questions:
ambiguity becomes a recorded assumption. Follow progress with `hades task show portal-001` or
`/hades-status`; resume an interrupted task with `/hades portal continue portal-001` (the PM continues
from the stage `hades task show` reports). A HADES v1 task record is adopted into a v2 task folder
first (`hades task adopt`, see [`migration-from-v1.md`](migration-from-v1.md)); the v1 files stay untouched.

**Greenfield**: describe a product that does not exist yet, optionally naming the organization:
`/hades acme A booking site for our two clinics`. The PM creates the team and project folder
(`git init -b main`), the architect chooses the stack, the tech lead scaffolds the repository before
planning, and DevOps adds CI and deploy configuration. Without an environment the deploy is recorded
as *not provisioned* with steps for you (the cybersecurity engineer still tests the app it starts
locally); add a remote and push the first commit yourself.

## 9. Read the final report

Outcome first (`DONE` or `BLOCKED`), then: what was built; the environment and health result
(`pending-push` = your push completes the deploy); evidence for gates, deploy, QA and security with
file pointers; blocked and accepted defects; per-repo commits with review and push commands; token
usage; numbered assumptions; the task folder. Everything is also in the task folder:
`README.md` (Decisions, Gates, Lessons, Outcome), stage files `01`-`09`, `gates.json`,
`defects.json`.

## 10. Review and push

HADES only commits locally (project repos and the vault). For each repo in the report:

```sh
git -C <repo> log --oneline -5
git -C <repo> show --stat <hash>
git -C <repo> diff <hash>~1 <hash>      # read the change
git -C <repo> push                      # yours to run; with feature-branch: push -u origin hades/<task-id>-<slug>
git -C ../my-vault push                 # private vault remote, if any
```

Do not push commits the report marks do-not-push (an unresolved security defect).

## 11. Learn and measure

`/hades-learn portal portal-001 <notes>` re-runs the learning loop with your notes; `/hades-learn
portal relearn` refreshes a team's knowledge from the project. `hades usage --task portal-001` and
`hades usage --since 2026-10-01` show tokens and estimated cost ([`token-economy.md`](token-economy.md)).

## 12. Publishing checklist (maintainers of a public copy of the engine)

1. Enable private vulnerability reporting before the repository goes public: GitHub *Settings ->
   Code security -> Private vulnerability reporting*. `SECURITY.md` relies on its **Report a
   vulnerability** button; without it reporters fall back to the profile contact or a detail-free
   issue asking for a private channel.
2. Clone URLs in `README.md`, `CONTRIBUTING.md` and this page point at your repository.
3. `LICENSE` stays the unmodified MIT text, so GitHub detects it; third-party license notes belong
   in `THIRD_PARTY_NOTICES.md`.
4. `npm test` and `node bin/hades.mjs tools verify` pass on a fresh clone with submodules.
5. Never publish a vault.
