# Reference

Everything the [README](../README.md) leaves out: installation details, configuration, vendored
tools, layout, upgrading and troubleshooting. Step-by-step setup: [getting-started.md](getting-started.md).

## Installation

The examples use a workspace folder that holds the engine and your projects: `~/code` on
macOS/Linux, `C:\code` on Windows. The engine is cloned to `~/code/hades-vault` (`C:\code\hades-vault`)
and the vault lives inside it at `.vault/`. Every `node bin/hades.mjs ...` line runs from the engine
folder and works unchanged in PowerShell, except empty values (see [Troubleshooting](#troubleshooting)).

### 1. Clone the engine with its submodules

```bash
mkdir -p ~/code && cd ~/code
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades-vault.git
cd hades-vault
```

```powershell
git config --global core.longpaths true
New-Item -ItemType Directory -Force C:\code | Out-Null
Set-Location C:\code
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades-vault.git
Set-Location hades-vault
```

Optional: `npm test` runs the CLI test suite (no network, Docker or submodules needed).

### 2. Create the configuration and the vault

```bash
node bin/hades.mjs init
```

This writes `hades.config.json` in the engine (git-ignored) and, when the vault folder has no
`registry.json`, scaffolds the vault at `.vault/` from `templates/vault/` and runs `git init` in it:
the vault is its own repository, and the engine's `.gitignore` keeps it out of the engine
repository. Nothing is committed. The workspace defaults to the engine's parent folder
(`--workspace <path>` to change it). A vault inside the engine is stored in `hades.config.json` as
the relative path `.vault`, so moving or renaming the engine folder keeps it.

The vault holds your clients' requirements and architecture: keep it **private**. For a backup, add
a private remote yourself (never a public one) and push it when you like. `init` commits nothing, so
make the first vault commit before the first push (`git push` fails with "src refspec HEAD does not
match any" on a vault without commits). First check that `.vault` is its own repository: the first
command must print the `.vault` folder, not the engine folder (`hades doctor` checks this too, and
`hades init` fixes it).

```bash
git -C .vault rev-parse --show-toplevel
git -C .vault add -A
git -C .vault commit -m "Initial vault"
git -C .vault remote add origin <your-private-repository-url>
git -C .vault push -u origin HEAD
```

A custom location still works: `node bin/hades.mjs init --vault <path>` (or `HADES_VAULT`), for
example a vault on an encrypted drive. Existing vault folders are used as they are.

### 3. Set up the pinned tools

```bash
node bin/hades.mjs tools setup
node bin/hades.mjs tools list
```

`tools setup` installs every pinned tool into `.tools-bin/` (git-ignored). It needs network access.

| Tool | What setup does |
|---|---|
| serena, mcp-proxy-for-aws | `uv sync --frozen` from the vendored `uv.lock` (hash-checked) into a private virtual environment |
| semgrep | the pinned PyPI wheel into a private virtual environment; the pinned Docker image if no wheel installs |
| gitleaks, trivy | the official GitHub release binary, checked against the release's SHA-256 checksum file before extraction |
| rea, ccusage | the pinned npm package, installed with `--ignore-scripts` |
| playwright-mcp | `npm ci --ignore-scripts` from the vendored lock file, then the matching Chromium |
| zaproxy | pulls the pinned Docker image (**needs Docker**) |
| aws-agent-toolkit | nothing: it is data, read in place |

Without Docker the `zaproxy` line fails and the command exits 1; the other tools are still
installed. Install Docker later and run `node bin/hades.mjs tools setup zaproxy` (until then the
DAST step of a security gate reports `error`). Trivy downloads its vulnerability database on the
first scan; Serena downloads a language server the first time it meets a language.

### 4. Install into Claude Code

```bash
node bin/hades.mjs install --dry-run   # shows what it would change
node bin/hades.mjs install             # guarded (the default)
```

A guarded install writes to `~/.claude` (or `CLAUDE_CONFIG_DIR`):

- the 11 role agents into `~/.claude/agents/hades/` and the 4 skills (`/hades`, `/hades-new-team`,
  `/hades-learn`, `/hades-status`) into `~/.claude/skills/<name>/`, marked `hades-generated`;
- into `settings.json` (after a `settings.json.hades-backup-<timestamp>` copy): the guard as a
  PreToolUse hook, deny rules, and allow rules for routine `hades` subcommands (`task`, `defect`,
  `gate`, `team resolve|set|list`, `detect`, `status`, `usage`, `doctor`) and
  `git add|commit|status|diff|log|rev-parse`;
- a record in `<engine>/.hades/install.json`, which `doctor` and `--uninstall` use.

Everything else in the main session still prompts; `hades run`, `install`, `migrate`, `tools` and
`mcp` are never allow-listed. For a main session without prompts:

```bash
node bin/hades.mjs install --autonomy full
```

`--autonomy full` also sets `permissions.defaultMode: bypassPermissions` in your user settings. This
applies to **every** Claude Code session of your user, HADES or not. The guard hook and the deny
rules still block pushes, destructive git and secret reads. It works in user scope only. Read
[Safety model and limits](autonomy-and-safety.md) first. To undo:

```bash
node bin/hades.mjs install --autonomy guarded   # removes the defaultMode key HADES added
node bin/hades.mjs install --uninstall          # removes only what the install record lists
```

A later `install` without `--autonomy` keeps the recorded autonomy. Files without the
`hades-generated` marker are never overwritten. `--scope project --workspace <dir>` installs into
`<dir>/.claude` instead; Claude Code reads that only for sessions started in that folder.

### 5. Check the setup

```bash
node bin/hades.mjs doctor
```

One line per check, `OK|WARN|FAIL <check>: <detail> -> <fix>`; exit 2 on any FAIL. Fix every FAIL
and read every WARN:

```text
OK node: v22.13.1
WARN claude: 2.1.150 < 2.1.271: newer agent frontmatter (omitClaudeMd and others) is ignored -> claude update
OK tools: 10/10 submodules at pinned commits
```

### 6. Optional: put `hades` on your PATH

The agents and skills always call `node <engine>/bin/hades.mjs` by absolute path; a `hades` command
is only for your convenience. Pick one:

```bash
npm link                                                                  # option 1, in the engine folder
echo 'alias hades="node $HOME/code/hades-vault/bin/hades.mjs"' >> ~/.bashrc    # option 2 (zsh: ~/.zshrc)
```

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
Add-Content $PROFILE 'function hades { node C:\code\hades-vault\bin\hades.mjs @args }'
```

`npm link` also works on Windows; if PowerShell's execution policy refuses the npm shim, use the
function.

## Configuration reference

### `hades.config.json` (engine root, git-ignored, written by `init`, edited by you)

```json
{
  "vault": ".vault",
  "workspace": "/home/me/code",
  "aws": { "profile": "hades-deploy", "region": "eu-west-1", "read_only": false }
}
```

| Key | Meaning |
|---|---|
| `vault`, `workspace` | paths; a relative path is relative to the engine folder (`".vault"`, the default vault, git-ignored). Defaults: `<engine>/.vault` (a legacy `<engine>/vault` with a `registry.json` is still used while `.vault` does not exist) and the engine's parent folder. `HADES_VAULT` and `HADES_WORKSPACE` override them |
| `aws.profile` or `aws.profiles` | profile(s) for the AWS MCP server and doctor; default `AWS_PROFILE` |
| `aws.region` | where the AWS MCP server operates |
| `aws.read_only` | `true` hides write-capable AWS MCP tools |
| `aws.endpoint` | another AWS MCP endpoint (https only) |

Other environment variables: `HADES_GUARD_POLICY`, `HADES_LOCK_WAIT_MS`, `HADES_DEBUG=1` (stack
traces), `CLAUDE_CONFIG_DIR`. Full list: [`docs/cli.md`](cli.md#environment-variables).

### `team.json` (per team, in the vault)

Change it only with `hades team set` and `hades detect --write`:

| Command | Sets |
|---|---|
| `team set <team> command <install\|build\|lint\|types\|test\|run\|format> "<cmd>" [--project <rel>]` | project commands; `""` = not applicable (gate step `n/a`) |
| `team set <team> env <test\|live> <url\|deploy\|health\|rollback\|via_push\|notes> "<value>"` | environments |
| `team set <team> security <semgrep_config\|dast_live\|dast_test> <value>` | Semgrep config (default `p/default`); `dast_live` = `baseline\|none`; `dast_test` = `baseline\|full\|api\|none` |
| `team set <team> branch-strategy <current-branch\|feature-branch>` | where the PM commits |
| `team set <team> project add\|remove <rel>` | repositories inside the team's project folder |
| `detect <path> --write <team> [--overwrite]` | fills empty commands from stack detection |

Schemas: [`docs/file-formats.md`](file-formats.md). Every command: [`docs/cli.md`](cli.md)
or `node bin/hades.mjs <command> --help`.

### Model routing

| Role | Default model | Effort |
|---|---|---|
| business-analyst, software-architect, tech-lead, cybersecurity-engineer | `opus` | high |
| backend-engineer, aiml-data-engineer, qa-engineer, devops-engineer, knowledge-curator | `sonnet` | medium |
| frontend-engineer | `fable` (never escalated) | medium |
| scout | `haiku` | low |
| Project Manager | your session model | - |

The PM escalates a spawn to `opus` on a second fix round of the same defect, a gate still red after
one fix, work on auth, payments, tenancy, data deletion or production data migration, or the
critical path of an L task. To override a default, add a line `model: <name>` under `## Overrides`
in the vault: `organizations/<org>/teams/<team>/agents/<role>.md` (one team) or
`company/staff/<role>.md` (company staff); the team file wins
([`company/model-routing.md`](../company/model-routing.md)).

### Guard policy

The guard's data rules (protected paths, secret patterns, paste hosts, command rules) live in
[`hooks/guard-policy.json`](../hooks/guard-policy.json) and merge over built-in defaults (objects
merge; arrays and scalars replace). To tune them, keep a copy outside the engine and point
`HADES_GUARD_POLICY` at it in the environment Claude Code starts from:

```bash
cp hooks/guard-policy.json ~/hades-guard-policy.json
export HADES_GUARD_POLICY="$HOME/hades-guard-policy.json"
```

```powershell
Copy-Item hooks\guard-policy.json $HOME\hades-guard-policy.json
$env:HADES_GUARD_POLICY = "$HOME\hades-guard-policy.json"
```

The guard's own protection (its files, the loaded policy, the HADES config, the Claude settings,
agents, skills and hooks) cannot be tuned away. Rule ids: [`hooks/README.md`](../hooks/README.md).

## Vendored tools

Third-party tools are git submodules under `tools/`, pinned in
[`tools/tools.lock.json`](../tools/tools.lock.json), and run as separate programs.

| Tool | Pinned version | License | Used by |
|---|---|---|---|
| [Serena](https://github.com/oraios/serena) | `v2.0.0` | GPL-3.0-or-later (app), MIT (SolidLSP) | all engineering roles: symbol-level code navigation (MCP) |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | `v0.0.83` | Apache-2.0 | QA, frontend, security: browser automation (MCP) |
| [REA](https://github.com/morluto/rea) | `rea-agents-6.5.0` | MIT | security, architect: reverse engineering of built artefacts (MCP) |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | `v8.30.1` | MIT | gates, security: secret scanning |
| [Semgrep CE](https://github.com/semgrep/semgrep) | `v1.181.0` | LGPL-2.1 | gates, security: static analysis |
| [Trivy](https://github.com/aquasecurity/trivy) | `v0.76.0` | Apache-2.0 | gates, security, DevOps: dependencies, IaC, containers, SBOM |
| [ZAP](https://github.com/zaproxy/zaproxy) | `v2.17.0` | Apache-2.0 | security: dynamic testing (Docker image) |
| [ccusage](https://github.com/ryoppippi/ccusage) | `v20.0.34` | MIT | PM: token and cost reports |
| [AWS Agent Toolkit](https://github.com/aws/agent-toolkit-for-aws) | commit `44ba1a5` | Apache-2.0 | DevOps: official AWS skills and rules, read by path |
| [MCP Proxy for AWS](https://github.com/aws/mcp-proxy-for-aws) | `v1.7.0` | Apache-2.0 | DevOps: AWS MCP server with a named profile |

Supply-chain policy ([`docs/tools.md`](tools.md), [`tools/README.md`](../tools/README.md)):

- Pin the newest stable release that is **at least 14 days old**. Exact pins only: commits for
  submodules, exact versions for npm and PyPI, digests for Docker images.
- Release binaries (gitleaks, trivy) are checked against the release's SHA-256 checksum file before
  extraction. npm installs run with `--ignore-scripts`. Serena and the AWS proxy install from their
  vendored, hash-checked `uv.lock`. Semgrep is the exception: version-pinned but not hash-checked.
- Tools run without a shell, with telemetry and update checks off.
- `node bin/hades.mjs tools verify` checks that every submodule is at its pinned commit.
- `node bin/hades.mjs tools bump <name> <tag>` moves a pin: it refuses releases younger than 14 days
  (unless `--force`), checks the commit against GitHub and never commits. Then review the upstream
  changes, run `tools setup <name> --force`, `npm test` and `tools verify`, and commit `tools/<name>`
  with the lock file.

## Project layout

```text
HADES.md              operating protocol (read by the PM)
agents/               the 11 role agents (hades-<role>)
skills/               /hades, /hades-new-team, /hades-learn, /hades-status
company/              policies: pipeline, gates, handover, models, deploy, security, commits, knowledge
playbooks/            procedures read on demand by path; stacks.json = stack fingerprints
bin/hades.mjs, lib/   the zero-dependency CLI (lib/commands/export.mjs = other agents)
hooks/                guard.mjs and guard-policy.json
templates/            vault, organization, team, project and task scaffolds
tools/                vendored tools (git submodules) and tools.lock.json
docs/                 architecture, CLI, file formats, guides
tests/                node:test suites (no network, Docker or submodules needed)
.hades/, .tools-bin/  runtime state, logs, installed tools (git-ignored)
.vault/               your vault: private, git-ignored, its own git repository (created by init)
```

## Upgrading and migrating from v1

### Upgrading

```bash
git pull
git submodule update --init --recursive --depth 1
node bin/hades.mjs tools setup
node bin/hades.mjs install
node bin/hades.mjs doctor
```

`tools setup` installs missing tools and reinstalls those whose pin changed. `install` keeps your
recorded autonomy. If you use other agents, run `hades export <target>` again (for Codex, trust the
changed hook with `/hooks`).

<details>
<summary><strong>Moving an existing vault to <code>.vault</code></strong></summary>

The repository is now named `hades-vault` (`https://github.com/prasadm1022/hades-vault`) and the
default vault is `<engine>/.vault`. An existing setup keeps working:
a vault configured in `hades.config.json` stays where it is, and a legacy `<engine>/vault` is still
found (`hades doctor` warns). To adopt the new layout:

Run these steps from a terminal with no Claude Code (or other agent) session open: the installed
guard hook, the agents and the `settings.json` allow rules hold the absolute engine path, so after a
rename every session fails to start the hook (and with `"onFailure": "block"` every tool call is
blocked) until `install` runs again.

1. Optional: rename the engine folder to `hades-vault` and point the remote at the new URL
   (`git remote set-url origin https://github.com/prasadm1022/hades-vault.git`). Then, right away and
   before any agent session, run `node bin/hades.mjs install` from the renamed folder (and
   `node bin/hades.mjs export <target>` again for each other agent you use).
2. Move the vault folder (with its `.git`) to `<engine>/.vault`.
3. Point the config at it: `node bin/hades.mjs init --vault .vault` (a relative path is relative to
   the engine; stored as `.vault`), or edit `hades.config.json` to `"vault": ".vault"` by hand. `init`
   keeps the configured workspace as an absolute path; change it the same way if it moved. Then run
   `node bin/hades.mjs install` (the agents carry the absolute paths) and `node bin/hades.mjs doctor`,
   which checks that the engine repository git-ignores the vault, that the vault is its own git
   repository, and whether the vault's own notes (`CLAUDE.md`, `README.md`, `company/README.md`,
   `company/playbooks/README.md`) still name the old engine folder (replace that path by hand).

Until step 3, a `hades.config.json` that still names the old absolute vault path finds no
`registry.json`: the CLI stops with "no vault", and the guard keeps protecting `<engine>/.vault`
(and a legacy `<engine>/vault`) and warns on every allowed call.

</details>

<details>
<summary><strong>Migrating from HADES v1</strong></summary>

v1 kept the framework inside the vault; v2 splits it into this engine and your vault.

1. Clone v2 and point it at the old vault (or first move the old vault to `<engine>/.vault`):
   `node bin/hades.mjs init --vault <v1-vault> --workspace <projects-folder>`.
2. Commit or stash the vault (files with uncommitted changes are skipped).
3. Preview, then migrate: `node bin/hades.mjs migrate --dry-run`, then `node bin/hades.mjs migrate`.
4. Run `node bin/hades.mjs install` and `node bin/hades.mjs doctor`.
5. Review and commit the vault yourself.
6. In Claude Code, per team: `/hades-learn <team> --migrate`.

Old v1 tasks resume with `/hades <team> continue <task-id>`: they are adopted into a v2 task folder
first, and the v1 files are never changed. Details: [`docs/migration-from-v1.md`](migration-from-v1.md).

</details>
## Troubleshooting


**Doctor warns `claude: ... < 2.1.271: newer agent frontmatter ... is ignored`.** Older Claude Code
versions ignore agent settings HADES relies on (`omitClaudeMd` and others). Run `claude update`.

**The guard blocked a command I need.** The message is `HADES guard: <rule id>: <reason>. <what to
do instead>`; every block is logged in `<engine>/.hades/guard.log`. The agent usually adapts. If the
command is legitimate, run it yourself in your own terminal, or tune the policy
([Guard policy](#guard-policy)). Report false positives as an issue with the rule id.

**`GATE EMPTY (no commands configured ...)`.** No build, lint, types or test command is set. Run
`node bin/hades.mjs detect ../acme/portal --write portal`, or `team set portal command test "<cmd>"`.

**Serena symbol tools fail because no project is active.** Agents start Serena without a project
and must call `activate_project` with the absolute project path first; the guard refuses it on the
engine, vault, workspace, home or Claude folder. When you start the server by hand, pin a project:
`node bin/hades.mjs mcp serena --project <absolute-path>`.

**ZAP: `Docker is not available`, or the DAST step is `error`.** Start Docker (Windows: Docker
Desktop with Linux containers), then run `node bin/hades.mjs tools setup zaproxy`.

**REA warns about the Node version, or deep analysis is unavailable.** REA needs Node `^22.19.0`,
`^24.11.0` or `>=26`. Deep binary analysis needs Ghidra 12.1.x and JDK 21 (`GHIDRA_INSTALL_DIR`,
`JAVA_HOME`); other REA tools need JADX, WABT, pwntools or GNU objdump. HADES never installs these;
the report lists what was unavailable.

**Doctor FAILs: `profile ... uses ROOT credentials`.** Agents must never use the AWS root user.
Point the profile at a least-privilege role or SSO permission set and sign in again.

**Windows: `Filename too long` during clone or submodule checkout.** Run
`git config --global core.longpaths true`, then in the engine folder
`git submodule update --init --recursive --depth 1`.

**Doctor warns that project-level items in `<workspace>/.claude` override the install.** Same-name
skills or agents (often old HADES v1 copies) shadow the user-level install in that folder. Remove
them by hand, or install with `--scope project`.

**`timed out after 30s waiting for <file>.lock`.** Another `hades` command holds the lock, or a
crashed one left it. If no `hades` command is running, delete that `.lock` file. Locks older than
15 s are broken automatically; `HADES_LOCK_WAIT_MS` changes the wait.

**PowerShell: `team set ... ""` fails or sets nothing.** Windows PowerShell 5.1 drops empty
arguments to native programs. Write `'""'`: `node bin/hades.mjs team set portal command lint '""'`.
PowerShell 7.3 and newer pass `""` as an empty argument: keep `""` there (`'""'` would store two
quote characters).

**Two `hades` skills appear in Cursor, Devin or Copilot.** These agents also import `~/.claude`.
Turn the import off where possible (Cursor: Third-Party Imports; Devin: `read_config_from.claude`),
or keep one target per folder.

**`tools setup` cannot download behind a proxy.** HADES downloads release binaries with Node's own
HTTPS client, which has no proxy support. Put the pinned binary on PATH (gitleaks, trivy, semgrep
and ccusage are accepted at the pinned version), or point `HADES_TOOL_<NAME>` at an executable.

**Doctor FAILs on the guard hook's Node binary.** The Node that ran `install` was moved or removed
(for example by a version manager). Re-run `node bin/hades.mjs install` with the Node 22+ you use now.

