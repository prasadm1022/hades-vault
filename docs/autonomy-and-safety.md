# Autonomy and safety

HADES never asks you questions after the requirements. Whether Claude Code itself asks for
permission depends on how you run it: fully unattended (no prompts at all) needs `hades run` or
`hades install --autonomy full`; the default guarded install keeps Claude Code's normal prompts in
the main session except for the commands listed in section 1. Either way the boundary is
deterministic code (a hook and deny rules), not prompts. This page says what runs unattended, what
is blocked, and what is left to you. Threat model and reporting: [`SECURITY.md`](../SECURITY.md).

## 1. Permission model

| Who | Permission mode | Set by |
|---|---|---|
| Role agents (`hades-<role>`) | `bypassPermissions`: no prompts | each agent's frontmatter (`agents/`) |
| Main session (the PM), default | your normal mode: only the allow rules below skip the prompt; every other PM step still asks you (see *Guarded mode* below) | `hades install` (`--autonomy guarded`, the default of a first install; a re-install without `--autonomy` keeps the recorded autonomy) |
| Main session, one unattended run | `bypassPermissions` for that run only | `hades run "<requirements>"` (`claude -p --permission-mode bypassPermissions`) |
| Main session, always | `permissions.defaultMode: bypassPermissions` in user settings: every Claude Code session of this user, HADES or not | `hades install --autonomy full` (user scope only; ignored in project settings) |

### Guarded mode: what runs without a prompt

`hades install` (guarded) adds these `permissions.allow` rules; they matter only outside bypass mode:

| Rule | Covers |
|---|---|
| `Bash(node <engine>/bin/hades.mjs task *)`, `... defect *`, `... gate *`, `... team resolve *`, `... team set *`, `... team list*`, `... detect *`, `... status*`, `... usage *`, `... doctor*` | the PM's state, defect, gate, team and report commands |
| `Bash(git -C * add *)`, `Bash(git -C * commit *)`, `Bash(git -C * status*)`, `Bash(git -C * diff*)`, `Bash(git -C * log*)`, `Bash(git -C * rev-parse *)` and the plain forms (`Bash(git add *)`, ...) | intake status, the greenfield check, release, fix and vault commits |

An engine path with spaces is quoted in the rules and in every rendered CLI line
(`node "<engine>/bin/hades.mjs" ...`). Never allowed: `hades run`, `hades install`,
`hades migrate`, `hades tools`, `hades mcp`, and every `git push` form: the guard hook blocks push in any
form whatever the allow rules say, and the deny rules (section 3) block the plain forms again.

**What still prompts in guarded mode**: the PM's Write and Edit calls (the request file, the task
`README.md` Decisions, Lessons, Gates and Outcome after every return, the S-size work-plan draft),
every other shell command, and MCP tools. A guarded interactive `/hades` therefore asks you several
times per task and stalls while you are away. For a run with no prompts use `hades run` (one
unattended run) or `hades install --autonomy full` (every session); role agents never prompt in
either mode.

Agents also have `Agent` and `AskUserQuestion` disallowed (no nested spawns, no questions) and
`omitClaudeMd: true` (a project's `CLAUDE.md` is not loaded as instructions). Agents cannot run
`hades run`, `hades install`, change settings or the guard.

## 2. The guard hook

`hooks/guard.mjs` is a PreToolUse hook with the matcher
`Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*` (Serena's MCP tools read
and edit files). Hooks run in every permission mode and inside subagents. The installed hook command uses the
absolute path of the Node.js that ran `hades install` (quoted), not a `node` from `PATH`, and the
hook entry sets `"onFailure": "block"` (Claude Code versions that support it block the tool call
when the hook itself fails; older versions ignore the key). It parses Bash, PowerShell and cmd syntax
(wrappers, `-c`, encoded commands, scripts and `npm run` targets are re-scanned) and blocks with a
one-line reason. Summary (full table: [`hooks/README.md`](../hooks/README.md)):

| Area | Blocks |
|---|---|
| git | every push form; rebase, amend, filter-branch, reset to a commit; `reset --hard`, `clean -f`, `checkout -- .`, stash drop; force flags; global config and aliases; writes inside `.git/` |
| hosting | `gh pr create/merge`, releases, repo create/delete, `gh api` writes; `gh workflow run` (except DevOps) |
| filesystem | deleting or moving roots, system and home folders, the workspace, vault, engine, registered projects and any `.git` |
| system, cloud | disk formatting, shutdown, security settings, scheduled tasks; `terraform/cdk/pulumi destroy`, bucket and stack deletes, managed-database deletes |
| remote code | download piped into a shell or interpreter, running a file downloaded in the same command |
| secrets | reading `.env*` (not `.env.example`), keys, cloud credential stores, `.npmrc`/`.netrc`; environment dumps; printing secret values or tokens |
| publishing | package publish, `docker push` (except DevOps), paste hosts |
| self-protection | edits to `hooks/`, `hades.config.json`, Claude settings, installed agents and skills; `claude --dangerously-skip-permissions`; `hades install`, `hades run` from an agent |
| role scope | Write/Edit outside the role's scope (analysts and reviewers: vault only; engineers and the tech lead - skeleton and integration glue: projects, vault, workspace; scout: nothing); `<engine>/tools/` for everyone |
| state files | shell, editor and Serena writes to `state.json`, `defects.json`, `work-plan.json`, `gates.json`, `team.json` (the CLI writes them; the work plan draft is `work-plan.draft.json`) |

The CLI calls the same checker (`checkShell`) on the shell values of `team.json`: when they are set
(`hades team set`) and before `hades gate` runs a project command. The hook cannot see commands the
CLI runs itself, and `team.json` lives in the agent-writable vault. The default vault is
`<engine>/.vault`: inside the engine folder but git-ignored by the engine repository and its own git
repository, so the platform can be shared without the data. The guard treats it as the vault (role
agents may write it; state files and mass deletes stay blocked), never as an exemption for engine
files; `hades doctor` FAILs when a vault inside the engine is not git-ignored.

## 3. Deny rules

`hades install` adds `permissions.deny` rules, a second layer that also applies in bypass mode:
`git push` (three forms), `git reset --hard`, `git clean -f`, `git filter-branch`, `rm -rf /`,
`rm -rf ~`, `gh pr create`, `gh release`, `npm publish`, `Read(**/.env)`. `.env.*` files are left to
the guard (deny globs cannot exempt `.env.example`).

## 4. Deploy and security-testing policies

- **Deploy** ([`company/deployment-policy.md`](../company/deployment-policy.md)): test environment
  when configured and reachable, else live. Live needs a green `predeploy` gate (build, test,
  secrets, SAST, dependencies), no open critical/high defect, a recorded rollback, a health check, a
  backup before data changes and backward-compatible migrations; a red health check rolls back.
  `via_push` environments are never deployed by HADES (`pending-push`). Only recorded release
  commits are deployed.
- **Security testing** ([`company/security-policy.md`](../company/security-policy.md)): source level
  on every task; against live only passive checks (ZAP baseline, headers, TLS, read-only probes);
  active scans and fuzzing only on test or local. `hades gate --dast` refuses `full`/`api` against the
  live host and, without `--i-own-this-target`, against anything but the test host. At most 10
  requests per second; stop at the first sign of harm. Third-party hosts are excluded.
- **Reverse engineering**: only artefacts the company built, artefacts it is licensed or authorised
  in writing to analyse, or open-source binaries whose licence permits it. Never DRM, licence or
  anti-cheat bypass, third-party key extraction or reproduction of proprietary code. Each use is
  recorded with artefact hash, origin and legal basis. This is policy, not technical enforcement.
- **Findings** stay in the vault and the report; commit messages describe the fix, not the exploit.

## 5. Credentials and AWS

- Secrets are referenced by environment-variable or profile name only, never read, printed or
  committed. Missing credential = a recorded blocker, not a workaround.
- AWS: the profile in `hades.config.json` (`aws.profile`) is the real boundary of what the DevOps
  engineer can change. Use a least-privilege role scoped to the team's resources, short-lived (SSO,
  assumed roles); never root. `hades doctor` FAILs on root; a deploy that finds root runs read-only
  diagnostics and drafts the IAM policy for you. `read_only: true` hides write-capable AWS MCP tools.
- HADES never creates IAM users or access keys, never widens a policy to make a deploy pass, and
  never deletes data stores, backups or resources it did not create in the same task.

## 6. Residual risks

- The guard reads shell text: a sufficiently obfuscated command, a compiled program, a build or test
  script, a git hook or an `npm install` lifecycle script can act outside its view. MCP tools other
  than Serena's (Playwright, REA, AWS) are not matched. Network egress is not restricted beyond paste hosts and pipe-to-shell.
- Shell writes are not role-scoped (only editor tools are).
- Failure behaviour (`hooks/guard.mjs`): when the guard itself throws, a call whose command, path or
  code contains a high-risk keyword (`push`, `rm`, `config`, `settings`, `guard`, `.env`, `secret`,
  `.git`, ...) is blocked (`guard.error`); any other call is allowed with a warning, so a guard bug
  cannot brick ordinary work. Input too large, complex or slow to verify is blocked (`guard.limit`).
  A hook process that cannot start, crashes or times out blocks the call only where Claude Code
  honours `onFailure: block`; older versions let it through. `hades doctor` checks the hook's Node.
- **No sandbox on native Windows**: Claude Code's OS sandbox runs on macOS, Linux and WSL2. On native
  Windows the guard is the main boundary.
- Prompt injection from repositories, web pages or tool output can still mislead a model inside its
  allowed scope. Agents run with your credentials.
- **Other coding agents** (`hades export`, [`other-agents.md`](other-agents.md)): the guard runs as the
  platform's pre-tool hook where one is documented, without role write scopes or the deny rules of
  `hades install`; Roo Code, Aider, generic AGENTS.md tools and OpenCode 2 have no guard at all.
- A change can pass every gate and still be wrong in production. Review diffs before pushing; keep
  backups.

For stronger isolation run HADES in WSL2, a VM, or a dev container with only the workspace mounted,
and give deploy credentials only to the environments HADES may touch.

## 7. Turning autonomy down

| Want | Do |
|---|---|
| Prompts again in the main session | `hades install --autonomy guarded` (removes the `defaultMode` key HADES added; a bare `hades install` keeps the recorded autonomy); stop using `hades run` |
| No deploys | leave `team.json` environments empty (`hades team set <team> env test deploy ""`): DevOps prepares configuration and records *not provisioned* |
| No live deploys | configure only `test`, or set `via_push true` on live |
| No AWS changes | no `aws` profile, or `"read_only": true` and a read-only role |
| Stricter guard | edit `hooks/guard-policy.json` or point `HADES_GUARD_POLICY` at your own copy (owner only) |
| Remove HADES from Claude Code | `hades install --uninstall` (only what the install record lists) |

`HADES_GUARD=off` disables the guard for debugging; set it only in your own shell, never for an
unattended run.
