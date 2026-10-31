# HADES

HADES is an autonomous software company that runs inside [Claude Code](https://code.claude.com).
You state business requirements. A Project Manager (your main Claude Code session) runs them
through role agents: business analyst, architect, tech lead, backend, frontend, AI/ML/data and QA
engineers, DevOps and cybersecurity. Together they analyse, design, plan, build, test, commit
locally, deploy, security-test, fix what they find, learn and report. A stage passes only on tool
evidence (builds, tests, scanners, health checks), never on an agent's word. HADES never pushes:
you review the local commits and push them yourself. It can also be exported to other coding
agents (Codex, Cursor, Gemini CLI, GitHub Copilot, Devin, Cline, OpenCode, any `AGENTS.md` tool),
with the gaps listed below.

**The name.** This repository is **hades-vault**: two parts that live in one folder.

- **HADES** (the `hades` CLI, the `hades-<role>` agents, the `/hades` skills, the guard hook,
  policies, playbooks and templates) is the agentic system: the shareable, open-source platform in
  this repository.
- **The vault** is your private, local knowledge base: registry, organizations, teams, knowledge and
  task records. Its default location is `.vault/` inside this folder. It is **git-ignored** by this
  repository and has **its own git repository**, so your data is never committed with (or published
  as part of) the platform. Back it up to a **private** remote of your own. A vault elsewhere
  (`hades init --vault <path>`) still works.

Status: version 2.0.0 (unreleased changes in [CHANGELOG.md](CHANGELOG.md)) · License: MIT ·
Node.js 22 or newer · Windows, macOS, Linux.

## Contents

1. [What you get](#what-you-get)
2. [How it saves tokens and stays accurate](#how-it-saves-tokens-and-stays-accurate)
3. [Quick start](#quick-start)
4. [Requirements](#requirements)
5. [Installation](#installation)
6. [Usage with Claude Code](#usage-with-claude-code)
7. [Usage with other coding agents](#usage-with-other-coding-agents)
8. [Configuration reference](#configuration-reference)
9. [Safety model and limits](#safety-model-and-limits)
10. [Vendored tools](#vendored-tools)
11. [Project layout](#project-layout)
12. [Upgrading and migrating from v1](#upgrading-and-migrating-from-v1)
13. [Troubleshooting and FAQ](#troubleshooting-and-faq)
14. [Contributing, security, license, acknowledgements](#contributing-security-license-acknowledgements)

## What you get

### The organisation

```text
Owner ................. states requirements, reviews commits, pushes
Project Manager ....... the main Claude Code session (/hades): orchestrates, commits, reports
Company staff ......... business-analyst  software-architect  devops-engineer  cybersecurity-engineer
  (one each, shared by every team)
Team roles ............ tech-lead  backend-engineer (DB + backend)  frontend-engineer (UI/UX + frontend)
  (every team)          aiml-data-engineer  qa-engineer (manual + automation)
Helpers ............... scout (read-only lookups)  knowledge-curator (learning loop)
```

Structure: organizations -> teams (`main` or `sub`, same roster) -> projects (git repositories).
The roles are Claude Code subagents named `hades-<role>` ([`agents/`](agents/README.md)). A role
with no work in a task is never spawned. Two repositories work together:

| Repository | Visibility | Contents |
|---|---|---|
| engine: HADES (this repository, `hades-vault`) | public, MIT | agents, skills, policies, playbooks, CLI, guard hook, templates, vendored tools |
| vault (yours, `<engine>/.vault` by default) | **private**, git-ignored by the engine, its own repository | registry, organizations, teams, knowledge, task records |

Your code stays in your project repositories. The engine repository never holds client data: the
vault folder inside it is git-ignored (`hades doctor` fails if it is not).

### The pipeline

```text
requirements
  -> intake -> analysis -> design -> planning -> build -> qa <-> fix -> release (local commit)
  -> deploy || security <-> fix -> redeploy -> close (learn, usage, report)
  -> you review the commits and push
```

| Stage | Owner | Passes on |
|---|---|---|
| intake | PM | task folder in the vault, size S, M or L |
| analysis | business-analyst | acceptance criteria `AC-n` |
| design | software-architect; aiml-data-engineer (model plan, L) | AC -> component map, contracts, deploy strategy |
| planning | tech-lead (S: the PM) | work plan accepted by `hades task plan` (every AC covered, no file overlap inside a wave) |
| build | frontend UX design, then engineers in parallel waves; QA writes the test plan | `hades gate --preset build`; integration review (M, L) |
| qa | qa-engineer | every AC has a passing test case; no open critical/high defect |
| release | PM | `hades gate --preset precommit` (build, test, secrets), local commit |
| deploy | devops-engineer | test environment first; health check; rollback recorded |
| security | cybersecurity-engineer | gitleaks, semgrep, trivy, manual review, ZAP; no open critical/high defect |
| close | PM, knowledge-curator | knowledge filed in the vault, token usage recorded, final report |

Defects from QA, review, security or deploy go back to the owning role, at most 3 fix rounds per
defect. After that the defect is `blocked`, the task continues where safe, and the report says so.
Sizes set the depth: S (copy, config, one obvious file), M (feature inside existing patterns), L
(new product or area, schema or API change, auth, money, tenancy, new AI behaviour). When unsure,
HADES picks the larger size. Details: [`HADES.md`](HADES.md), [`docs/architecture.md`](docs/architecture.md).

### What "fully automated" means

- After you state the requirements, HADES asks no questions. Ambiguity becomes a recorded
  assumption, listed in the report.
- Role agents never show permission prompts. The main session runs without prompts only in a
  headless run (`hades run`) or after `hades install --autonomy full`. The default (guarded)
  install still prompts for the PM's file edits and most commands, so someone must be at the keyboard.
- It ends with local commits and a report. It never pushes, opens pull requests or publishes packages.

Limits: it deploys only to environments you configure (with none, it prepares the deploy
configuration and records *not provisioned*; a deploy that needs a push is recorded as
`pending-push`). A missing credential is a recorded blocker, never a workaround. A defect still open
after 3 rounds is reported as `blocked`. A change can pass every gate and still be wrong in
production: read the diff before you push.

## How it saves tokens and stays accurate

- Native subagents with short, static role prompts; a role with no work is not spawned.
- File handoffs: a spawn prompt is at most 15 lines of paths, a return at most 8 lines, and every
  stage file starts with a 10-line `## Summary` that downstream roles read instead of the whole file.
- `hades gate` reduces build, test and scanner output to one line per step plus the first failure;
  full logs stay on disk.
- Symbol-level code navigation (Serena) instead of whole-file reads; lookups on the cheapest model (scout).
- Model routing: strong models for analysis, architecture, planning and security; fast models for
  implementation, with escalation on repeated failures.
- Deterministic work (stack detection, plan validation, coverage, gates, guard) runs in code and
  costs no model tokens.
- Independence: QA does not trust engineers, security does not trust QA, and the CLI refuses to
  pass a stage with open critical/high defects.
- `hades usage` records tokens and estimated cost per task ([`docs/token-economy.md`](docs/token-economy.md)).

## Quick start

For Claude Code on macOS or Linux, with `~/code` as the workspace that holds your projects
([Installation](#installation) explains each step and has the PowerShell lines):

```bash
mkdir -p ~/code && cd ~/code
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades-vault.git
cd hades-vault
node bin/hades.mjs init                  # vault: ~/code/hades-vault/.vault, workspace: ~/code
node bin/hades.mjs tools setup
node bin/hades.mjs install
node bin/hades.mjs doctor
```

Then start `claude` in `~/code` and onboard an existing project at `~/code/acme/portal`:

```text
/hades-new-team portal acme/portal --org acme
/hades portal Customers can reset their password by email
```

For another coding agent, run `node bin/hades.mjs export <target>` instead of `install`
([Usage with other coding agents](#usage-with-other-coding-agents)).

## Requirements

| Requirement | Needed for |
|---|---|
| Node.js 22 or newer | the CLI and the guard hook (no npm dependencies). The REA reverse-engineering server needs `^22.19.0`, `^24.11.0` or `>=26` |
| git | everything; the vendored tools are git submodules |
| Claude Code 2.1.271 or newer | the runtime. `hades doctor` warns on older versions; update with `claude update` |
| [uv](https://docs.astral.sh/uv/) | Serena, Semgrep and the AWS MCP proxy (uv fetches Python 3.12) |
| Docker (optional) | ZAP dynamic scans; fallback for some scanners |
| AWS CLI v2 (optional) | AWS deploys and the `hades doctor` profile check |

- **Windows** (PowerShell or Git Bash): native Windows has no Claude Code sandbox, so the guard hook
  is the main boundary. For OS-level isolation run HADES in **WSL2** (recommended), a VM or a dev
  container. Set `git config --global core.longpaths true` before cloning. ZAP needs Docker Desktop
  with Linux containers.
- **macOS** and **Linux**: Claude Code's sandbox is available. On Linux, Playwright may need
  `npx playwright install-deps chromium` (as root) once, and the ZAP report folder must be writable
  by uid 1000.

## Installation

The examples use a workspace folder that holds the engine and your projects: `~/code` on
macOS/Linux, `C:\code` on Windows. The engine is cloned to `~/code/hades-vault` (`C:\code\hades-vault`)
and the vault lives inside it at `.vault/`. Every `node bin/hades.mjs ...` line runs from the engine
folder.

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
git -C .vault add -A && git -C .vault commit -m "Initial vault"
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
[Safety model and limits](#safety-model-and-limits) first. To undo:

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

## Usage with Claude Code

Claude Code is the reference platform: everything in this README works there. Start it in the
workspace (`~/code`, or `C:\code` on Windows):

```bash
cd ~/code
claude
```

Lines in `text` blocks below are typed into Claude Code. Shell commands run from the engine folder
and work unchanged in PowerShell, except empty values (see the [FAQ](#troubleshooting-and-faq)).

### Onboard an existing project (once per project)

```text
/hades-new-team portal acme/portal --org acme "Customer portal"
```

Arguments: `<team-name> <project-path> [--org <org>] [--sub] [description]`. The path is absolute
or relative to the workspace and must exist. The skill registers the organization and team, detects
the stack, surveys the project with read-only scouts, fills `TEAM.md`, `CONTEXT.md`, `team.json`,
knowledge and role notes in the vault, and commits the vault. It moves any `CLAUDE.md`, `AGENTS.md`
and `.claude/` out of the project into the vault (one local project commit). Then check the
detected commands and correct them through the CLI, never by editing `team.json`:

```bash
node bin/hades.mjs detect ../acme/portal
node bin/hades.mjs team set portal command test "npm test -- --run"
node bin/hades.mjs team set portal command lint ""                  # "" = not applicable
node bin/hades.mjs team set portal branch-strategy feature-branch   # default: current-branch
```

### Run a requirement

```text
/hades portal Customers can reset their password by email. Links expire after 30 minutes.
```

Inside a registered project folder, `/hades <requirements>` finds the team from the current
directory. For a new product (greenfield), describe it and optionally name the organization:

```text
/hades acme A booking site for our two clinics
```

The PM creates the team and the project folder (`git init -b main`), the architect chooses the
stack, the tech lead scaffolds the repository, and DevOps adds CI and deploy configuration. You add
a remote and push the first commit yourself.

### Follow, resume and learn

```text
/hades-status
/hades-status portal-001
/hades portal continue portal-001
/hades-learn portal portal-001 The staging database is reset every night.
/hades-learn portal relearn
```

`/hades-status` shows teams, open tasks and blocking defects (read-only). `continue` resumes from
the stage `hades task show` reports. `/hades-learn` re-runs the learning loop with your notes;
`relearn` refreshes a team's knowledge from the project. From a shell: `node bin/hades.mjs status`
and `node bin/hades.mjs task show portal-001`.

### Headless runs (no prompts)

```bash
node bin/hades.mjs run "Customers can reset their password by email" --team portal --max-budget-usd 20
node bin/hades.mjs run "Customers can reset their password by email" --team portal --dry-run
```

`hades run` starts `claude -p "/hades [<team>] <requirements>" --permission-mode bypassPermissions`
in the workspace. Flags: `--team`, `--model <alias>` (the PM session), `--max-budget-usd <n>`,
`--max-turns <n>`, `--dry-run` (prints the command only). It prints one line per tool call and the
final result with its cost, and saves the raw stream to `<engine>/.hades/runs/<timestamp>.jsonl`.
The guard hook and deny rules still apply.

### Configure environments

HADES deploys to `test` when it is configured and reachable, otherwise to `live` under stricter
preconditions. Values are shell command lines run from the project root; the guard refuses
dangerous ones. Name credentials (environment variables, profiles) in `notes`; never store values.

```bash
node bin/hades.mjs team set portal env test url "https://test.portal.example.com"
node bin/hades.mjs team set portal env test deploy "npm run deploy:test"
node bin/hades.mjs team set portal env test health "curl -fsS https://test.portal.example.com/health"
node bin/hades.mjs team set portal env test rollback "npm run rollback:test"
node bin/hades.mjs team set portal env test notes "needs DEPLOY_TOKEN, AWS profile hades-deploy"
node bin/hades.mjs team set portal env live via_push true   # CI deploys on push: recorded as pending-push
node bin/hades.mjs team set portal security dast_test full
```

### AWS (only if a team deploys to AWS)

1. Create a least-privilege IAM role or IAM Identity Center permission set scoped to the team's
   resources (no `*` actions or resources, no IAM user keys). Never use the root user.
2. Configure a named profile and sign in yourself:

   ```bash
   aws configure sso --profile hades-deploy
   aws sso login --profile hades-deploy
   ```

3. Add it to `hades.config.json` (you edit this file; agents cannot):

   ```json
   { "aws": { "profile": "hades-deploy", "region": "eu-west-1", "read_only": false } }
   ```

4. Check it: `node bin/hades.mjs doctor --aws-profile hades-deploy`. Root credentials are a FAIL.

The DevOps engineer uses this profile through the AWS MCP server (`hades mcp aws`) and the AWS CLI.
HADES never reads credential files and never creates IAM users or keys.

### The final report

Outcome first (`DONE` or `BLOCKED`), then: what was built; the environment and health-check result
(`pending-push` means your push completes the deploy); gate, QA, deploy and security evidence with
file pointers; blocked and accepted defects; per-repository commits with review and push commands;
token usage; numbered assumptions; the task folder. The task folder in the vault keeps everything:
`README.md` (Decisions, Gates, Lessons, Outcome), stage files `01`-`09`, `gates.json`, `defects.json`.

### Review and push

HADES only commits locally, in the project repositories and the vault. For each repository in the
report:

```bash
git -C ../acme/portal log --oneline -5
git -C ../acme/portal show --stat <hash>
git -C ../acme/portal diff <hash>~1 <hash>
git -C ../acme/portal push        # yours to run; feature-branch: push -u origin hades/<task-id>-<slug>
git -C .vault push               # your private vault remote, if any
node bin/hades.mjs usage --task portal-001   # tokens and estimated cost of the task
```

Do not push commits the report marks do-not-push (an unresolved security defect).

## Usage with other coding agents

`hades export <target>` renders the same company for another agent: the PM procedure as its skill
or command, the role agents in its subagent format, the MCP servers in its MCP configuration, and
the guard as its pre-tool hook, each only where the platform documents a format. The formats come
from each vendor's documentation (checked 2026-10-31); the exports were not run against the
platforms themselves. Full details: [`docs/other-agents.md`](docs/other-agents.md).

Do steps 1, 2, 3 and 5 of [Installation](#installation), then export instead of (or besides) `install`
(without `install`, `doctor` WARNs that nothing is installed for Claude Code; that is expected):

```bash
node bin/hades.mjs export codex --dry-run   # lists what it would write; writes nothing
node bin/hades.mjs export codex             # into the workspace; --scope user = the agent's home folder
```

Targets: `agents-md`, `codex`, `cursor`, `gemini`, `copilot`, `windsurf` (alias `devin`), `cline`,
`opencode`; `roo` and `aider` fall back to `agents-md` with a note. The export prints what it wrote,
notes and a `todo:` list. Generated files carry `hades-generated: true` and are updated by later
exports. Any other file at the same path is a `CONFLICT` (exit 2) and stays as it is unless you pass
`--force` (a `.hades-backup-<timestamp>` copy is kept). JSON configuration is merged. Export into
the workspace, never into a project folder, and start the agent in the workspace.

### Support matrix

| Platform | Role subagents | Guard | Headless | Support |
|---|---|---|---|---|
| Claude Code | native: per-agent model, tools, MCP | hook + deny rules + role write scopes, every mode and subagent | `hades run` | **Full** |
| OpenAI Codex | `.codex/agents/*.toml`; model not mapped | PreToolUse hook, after `/hooks` trust | `codex exec` | **Good** |
| Cursor | `.cursor/agents/*.md`; read-only scout | shell, reads, MCP, writes, deletes; fail-closed | `agent -p` | **Good** |
| Gemini CLI | per-agent MCP and turn limits | BeforeTool hook | `gemini -p` | **Good** |
| GitHub Copilot (CLI, VS Code) | `.agent.md` with tools and per-agent MCP | PreToolUse in Copilot CLI and the VS Code Copilot harness | `copilot -p` | **Good** |
| Devin (formerly Windsurf) | experimental; only `sonnet` roles keep their model | PreToolUse hook | `devin -p` | **Good** |
| OpenCode 1.x | subagents with permission denies | plugin + `git push` deny | `opencode run` | **Good** |
| OpenCode 2.x | as 1.x | **none** (the `git push` deny only if 2.x still reads the 1.x `permission` key; not verified) | `opencode run` | **Basic** |
| Cline | none: single-agent mode | file hook (extension and CLI); none in the VS Code extension on native Windows | `cline` CLI | **Basic** |
| Roo Code (shut down), Aider, any AGENTS.md tool | none: single-agent mode | **none** | the tool's own | **Basic** |

**Full**: everything HADES relies on is enforced by the platform. **Good**: PM procedure, separate
role agents, MCP servers and the guard hook work; typical gaps are one model for every role, all MCP
catalogs in every session and no role write scopes. **Basic**: one agent plays every role, and
nothing blocks a push or a secret read mechanically except the platform's own approvals.

### Quick setup per platform

`~/code` is the workspace, `~/code/hades-vault` the engine, `~/code/hades-vault/.vault` the vault and
`portal` an onboarded team. Run
`node bin/hades.mjs export <target>` from the engine folder, do the steps under "Before first use",
then start the agent in the workspace and type the command. Onboard projects with
`/hades-new-team ...` as in Claude Code (`$hades-new-team ...` in Codex).

| Agent | Target | Before first use | Then type |
|---|---|---|---|
| OpenAI Codex (CLI, IDE extension) | `codex` | Accept the trust prompt (or set `trust_level = "trusted"` for the folder under `[projects."<workspace>"]` in `~/.codex/config.toml`). Run `/hooks` and trust the HADES guard, again after any export that changes it. | `$hades portal <requirements>` |
| Cursor (editor, `agent` CLI) | `cursor` | Trust the workspace (CLI: `--trust`). Enable the four MCP servers: turn them on in Customize, or `agent mcp enable serena` (then `rea`, `playwright`, `aws`). Settings > Agents > Approvals & Execution: Auto-review or Allowlist. With HADES also installed for Claude Code, turn off Settings > Agents > Third-Party Imports. | `/hades portal <requirements>` |
| Gemini CLI | `gemini` | Run `gemini trust` in the workspace. In `gemini`: `/hooks panel` lists `hades-guard`, `/agents` the `hades-*` agents, `/commands list` shows `/hades`. | `/hades portal <requirements>` |
| GitHub Copilot (CLI, VS Code) | `copilot` | VS Code: keep `chat.useAgentSkills` on and the default **Copilot** harness (the guard does not run in the Local harness; there, also enable the **Run Subagent** tool). Copilot CLI: `/skills` and `/agent` list what was exported. | `/hades portal <requirements>` |
| Devin (formerly Windsurf) | `windsurf` | Trust the workspace (hooks do not run in Restricted Mode); `/hooks` lists the guard. With HADES also installed for Claude Code, set `read_config_from.claude` to `false`. | `/hades portal <requirements>` |
| Cline | `cline`, then `cline --scope user` (MCP servers; Cline has no project MCP file) | VS Code extension: Settings > Features > **Enable Hooks** (no effect on native Windows). | `/hades portal <requirements>` |
| OpenCode | `opencode` | Optional: `model: <provider/model>` in `.opencode/agents/hades-<role>.md` (otherwise every role uses the session model). | `/hades portal <requirements>` |
| Roo Code, Aider, other AGENTS.md tools | `agents-md` | Register the MCP servers by hand where the tool supports MCP: command = your absolute Node path, args = `<engine>/bin/hades.mjs mcp serena` (and `rea`, `playwright`, `aws`). Aider: start it with `--read AGENTS.md --no-auto-commits`. Roo Code: servers in `.roo/mcp.json`, deny `git push` in `roo-cline.deniedCommands`. | `hades portal <requirements>` |

Unattended runs: pick the line for your agent and run it in the workspace (`cd ~/code`). In
PowerShell, write the paths out (`C:\code`, `C:\code\hades-vault\.vault`): PowerShell does not expand `~` in
arguments to other programs. These lines follow each vendor's documentation and were not run here.

```bash
codex exec -C ~/code --skip-git-repo-check --sandbox workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=true --add-dir ~/code/hades-vault/.vault --add-dir ~/code/hades-vault/.hades '$hades portal <requirements>'   # Codex
agent -p "/hades portal <requirements>" --workspace ~/code --trust --approve-mcps --force --output-format stream-json   # Cursor
gemini -p "/hades portal <requirements>" --approval-mode=yolo --output-format json   # Gemini CLI
copilot -p "/hades portal <requirements>" -s --no-ask-user --allow-tool='read, write, shell(node:*), shell(git:*), serena, playwright' --deny-tool='shell(git push)'   # Copilot CLI
devin -p "/hades portal <requirements>" --permission-mode accept-edits   # Devin CLI
cline --auto-approve true -c ~/code "/hades portal <requirements>"   # Cline CLI
opencode run --command hades --auto "portal <requirements>"   # OpenCode
```

- **Codex**: `workspace-write` keeps `.git` read-only, so with `approval_policy="never"` the local
  commits fail (inferred from the docs, not tested): commit in an interactive session where you
  approve them, or use `--sandbox danger-full-access` only inside a VM or container. The sandbox has
  no network by default; the line turns it on for gates, installs and deploys. `--skip-git-repo-check`
  lets `codex exec` start in the workspace, which is not a git repository. Keep `$hades` in single
  quotes.
- **Gemini CLI** targets Code Assist Standard/Enterprise and paid API keys. Antigravity CLI is not
  covered; `export agents-md` gives it the procedure in single-agent mode. A user policy in
  `~/.gemini/policies/hades.toml` can deny `git push` as a second layer
  ([example](docs/other-agents.md#gemini-cli)).
- **Copilot**: the guard runs in Copilot CLI and the VS Code Copilot harness, not in VS Code's Local
  harness or the cloud agent.
- **Devin**: for unattended runs, put `permissions.allow` for the `hades` and `git` commands you
  approve and `"deny": ["Exec(git push)"]` in `.devin/config.json`.
- **Cline**: never use `--yolo`; it turns hooks off. The CLI runs the guard from
  `.cline/hooks/PreToolUse.sh`, the VS Code extension from `.clinerules/hooks/PreToolUse`. On native
  Windows the extension runs no file hooks, so the guard is inactive there (use WSL, or keep approvals
  on), and how the CLI runs a `.sh` hook on native Windows is not documented.
- **OpenCode**: the guard is a 1.x plugin. OpenCode 2 does not run 1.x plugins, so on 2.x the guard is
  off; the `git push` deny is written in the 1.x `permission` format, and whether 2.x still reads it
  is not verified. Not verified either: whether the plugin also runs for MCP calls and inside
  subagent sessions.
- **Roo Code, Aider, generic tools**: no guard. Keep approvals on, and never run them unattended
  outside a VM or container.

To remove an export, delete the files it listed (each carries `hades-generated: true`), the HADES
block in `AGENTS.md`/`GEMINI.md` and in Codex's `config.toml`, and the HADES entries (`serena`, `rea`,
`playwright`, `aws`, the `guard.mjs` hook; in `opencode.json` also the `git push` denies and the
vault and engine `external_directory` entries) from the merged JSON files. The
`.hades-backup-<timestamp>` copies next to them hold earlier versions of those files. There is no
`export --uninstall`.

### Single-agent mode

Where a platform has no custom role agents (Cline, Roo Code, Aider, generic AGENTS.md tools), one
agent plays each role in turn. Before each stage it reads that role's prompt from
`<engine>/agents/hades-<role>.md` and follows its rules and write scope. The CLI, gates, defect loop
and coverage rules are unchanged. Run QA, integration review and security in a **fresh session**
(Cline: `/newtask`), so the reviewer is not the author.

### Trade-offs outside Claude Code

- **One model for every role** (Devin keeps `sonnet` roles; its other roles get Devin's default
  subagent model): either everything costs the strong model's price, or analysis and security run on
  a weaker one. Set `model` per agent file by hand where the platform allows it; a later export
  replaces a file that still carries `hades-generated: true`, so re-apply it, or delete that marker
  line to keep the file (the export then reports it as a `CONFLICT` and leaves it alone).
- **All MCP catalogs in every session** on Codex, Cursor, Devin, OpenCode and Cline: more context
  on every turn.
- **No role write scopes and no `hades install` deny rules**: no platform tells the hook which
  subagent is calling; use the platform's own deny lists above. Some hook payload fields are
  undocumented; the adapter tries common names and allows the call when none matches.
- **Single-agent mode** costs more tokens, adds context pressure on L tasks and loses the
  independent QA and security view. Prefer S and M tasks there.
- **Claude Code only**: `hades run`, `hades usage` (elsewhere the report says `Usage: n/a`) and
  `hades doctor`'s install checks.
- Exported hooks use the absolute Node path; when it has spaces (`C:\Program Files\nodejs`) they
  run `node` from PATH, so Node 22+ must be on the agent's PATH.

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
traces), `CLAUDE_CONFIG_DIR`. Full list: [`docs/cli.md`](docs/cli.md#environment-variables).

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

Schemas: [`docs/file-formats.md`](docs/file-formats.md). Every command: [`docs/cli.md`](docs/cli.md)
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
([`company/model-routing.md`](company/model-routing.md)).

### Guard policy

The guard's data rules (protected paths, secret patterns, paste hosts, command rules) live in
[`hooks/guard-policy.json`](hooks/guard-policy.json) and merge over built-in defaults (objects
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
agents, skills and hooks) cannot be tuned away. Rule ids: [`hooks/README.md`](hooks/README.md).

## Safety model and limits

Role agents run with `permissionMode: bypassPermissions`, no nested spawns and no questions. The
boundary is deterministic code that runs in every permission mode and inside subagents:

- **Guard hook** ([`hooks/guard.mjs`](hooks/README.md)), PreToolUse matcher
  `Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*`. It parses Bash,
  PowerShell and cmd syntax (wrappers, `-c`, encoded commands and `npm run` targets are re-scanned)
  and blocks: every `git push` form, history rewrites and destructive git; `gh pr create/merge` and
  releases; deleting or moving system folders, home, the workspace, vault, engine, registered
  projects and any `.git`; disk formatting, security settings and cloud `destroy`; download-and-execute;
  reads of `.env*` (not `.env.example`), keys and credential stores, and environment dumps; package
  publishing and paste hosts; edits to the guard, settings, installed agents and skills and the files
  `hades export` wrote; writes outside each role's scope; direct edits of the CLI's state files.
- **Deny rules** in `settings.json` (also in bypass mode): `git push` (three forms),
  `git reset --hard`, `git clean -f`, `git filter-branch`, `rm -rf /`, `rm -rf ~`, `gh pr create`,
  `gh release`, `npm publish`, `Read(**/.env)`.
- **Deploy policy**: test environment first. Live needs a green pre-deploy gate (build, test,
  secrets, SAST, dependencies), no open critical/high defect, a recorded rollback, a health check,
  a backup before data changes and backward-compatible migrations. A red health check rolls back.
- **Security testing**: active scans and fuzzing only on test or local targets; passive checks only
  against live. `hades gate --dast` refuses `full` and `api` against the live host, and against
  anything but the test host without `--i-own-this-target`.
- **Reverse engineering** (REA): only artefacts you built, artefacts you are licensed or authorised
  in writing to analyse, or open-source binaries whose licence permits it. Never DRM, licence or
  anti-cheat bypass, third-party key extraction or reproduction of proprietary code. Each use is
  recorded with artefact hash, origin and legal basis. This is policy, not technical enforcement.
- **Credentials** by environment-variable or profile name only; `hades doctor` fails on AWS root.

Limits:

- The guard reads shell text; it is not a sandbox. Obfuscated commands, compiled programs, build
  and test scripts, git hooks and `npm install` lifecycle scripts act outside its view. MCP tools
  other than Serena's are not matched. Network egress is not restricted.
- **Native Windows has no Claude Code sandbox.** For OS-level isolation use WSL2, a VM or a dev
  container with only the workspace mounted.
- When the guard itself fails, calls that mention a high-risk keyword (`push`, `rm`, `config`,
  `.env`, ...) are blocked and other calls pass with a warning. Input too complex to verify is
  blocked (`guard.limit`). A hook that cannot start blocks only where Claude Code honours
  `onFailure: block`.
- Prompt injection can still mislead a model within its allowed scope. Agents run with your credentials.

Turning autonomy down:

| Want | Do |
|---|---|
| Prompts again in the main session | `node bin/hades.mjs install --autonomy guarded`; stop using `hades run` |
| No deploys | leave environments empty, e.g. `node bin/hades.mjs team set portal env test deploy ""` |
| No live deploys | configure only `test`, or `node bin/hades.mjs team set portal env live via_push true` |
| No AWS changes | no `aws` profile, or `"read_only": true` and a read-only role |
| A stricter guard | a tuned policy file ([Guard policy](#guard-policy)) |
| Remove HADES from Claude Code | `node bin/hades.mjs install --uninstall` |

`HADES_GUARD=off` disables the guard for debugging: set it only in your own shell, never for an
unattended run. More: [`docs/autonomy-and-safety.md`](docs/autonomy-and-safety.md), [`SECURITY.md`](SECURITY.md).

## Vendored tools

Third-party tools are git submodules under `tools/`, pinned in
[`tools/tools.lock.json`](tools/tools.lock.json), and run as separate programs.

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

Supply-chain policy ([`docs/tools.md`](docs/tools.md), [`tools/README.md`](tools/README.md)):

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

### Moving an existing vault to `.vault`

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

### Migrating from HADES v1

v1 kept the framework inside the vault; v2 splits it into this engine and your vault.

1. Clone v2 and point it at the old vault (or first move the old vault to `<engine>/.vault`):
   `node bin/hades.mjs init --vault <v1-vault> --workspace <projects-folder>`.
2. Commit or stash the vault (files with uncommitted changes are skipped).
3. Preview, then migrate: `node bin/hades.mjs migrate --dry-run`, then `node bin/hades.mjs migrate`.
4. Run `node bin/hades.mjs install` and `node bin/hades.mjs doctor`.
5. Review and commit the vault yourself.
6. In Claude Code, per team: `/hades-learn <team> --migrate`.

Old v1 tasks resume with `/hades <team> continue <task-id>`: they are adopted into a v2 task folder
first, and the v1 files are never changed. Details: [`docs/migration-from-v1.md`](docs/migration-from-v1.md).

## Troubleshooting and FAQ

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

## Contributing, security, license, acknowledgements

**Contributing.** See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md): no runtime npm dependencies; Windows, macOS and Linux;
safety rules belong in `hooks/guard.mjs` with tests. Run `npm test` before a pull request.

**Security.** Report vulnerabilities privately with GitHub's
[Report a vulnerability](https://github.com/prasadm1022/hades-vault/security/advisories/new) button, as
described in [`SECURITY.md`](SECURITY.md). Never put details in a public issue. Report
vulnerabilities in a vendored tool to its maintainers.

**License.** [MIT](LICENSE) covers the HADES source in this repository only. The tools under
`tools/` are git submodules that keep their own licenses (MIT, Apache-2.0, LGPL-2.1,
GPL-3.0-or-later), with NOTICE and legal-notice files to keep when you redistribute them: see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Acknowledgements.** HADES builds on the projects it vendors:
[Serena](https://github.com/oraios/serena), [Playwright MCP](https://github.com/microsoft/playwright-mcp),
[REA](https://github.com/morluto/rea), [Gitleaks](https://github.com/gitleaks/gitleaks),
[Semgrep](https://github.com/semgrep/semgrep), [Trivy](https://github.com/aquasecurity/trivy),
[ZAP](https://github.com/zaproxy/zaproxy), [ccusage](https://github.com/ryoppippi/ccusage),
[AWS Agent Toolkit](https://github.com/aws/agent-toolkit-for-aws) and
[MCP Proxy for AWS](https://github.com/aws/mcp-proxy-for-aws). It runs on
[Claude Code](https://code.claude.com). Product names are trademarks of their owners.

**Documentation.** [Getting started](docs/getting-started.md) - [Architecture](docs/architecture.md) -
[CLI](docs/cli.md) - [File formats](docs/file-formats.md) - [Autonomy and safety](docs/autonomy-and-safety.md) -
[Token economy](docs/token-economy.md) - [Tools](docs/tools.md) - [Other coding agents](docs/other-agents.md) -
[Migration from v1](docs/migration-from-v1.md) - [Changelog](CHANGELOG.md)
