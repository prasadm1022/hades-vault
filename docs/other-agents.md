# HADES with other coding agents

HADES is built for [Claude Code](https://code.claude.com), and that is where it works best.
`hades export <target>` renders the same company for other coding agents: the Project Manager
procedure as the agent's skill or command, the role agents in its subagent format, the MCP servers
in its MCP configuration, and the guard as its pre-tool hook. Each piece is exported only where the
platform documents a format for it; what is missing is listed below, per platform, without
softening.

Platform facts were checked against each vendor's documentation on 2026-10-31 (Sources at the end).
These products change often: re-run `hades export` after you upgrade one, and check the list of
uncertainties for your platform.

## Contents

- [Quick start](#quick-start)
- [Support matrix](#support-matrix)
- [What `hades export` writes](#what-hades-export-writes)
- [Setup per platform](#setup-per-platform): [Claude Code](#claude-code-reference) -
  [Codex](#openai-codex) - [Cursor](#cursor) - [Gemini CLI](#gemini-cli) -
  [GitHub Copilot](#github-copilot) - [Devin / Windsurf](#devin-formerly-windsurf) - [Cline](#cline) -
  [OpenCode](#opencode) - [Roo Code, Aider, any AGENTS.md tool](#roo-code-aider-and-any-agentsmd-tool)
- [The guard on other platforms](#the-guard-on-other-platforms)
- [Limitations: cost, accuracy, safety](#limitations-cost-accuracy-safety)
- [Sources](#sources)

## Quick start

Set HADES up as for Claude Code (clone, `init`, `tools setup`, `doctor`; see the
[README](../README.md#quick-start)), then export for your agent instead of (or besides) `install`:

```sh
node bin/hades.mjs export <target> --dry-run   # what it would write, nothing written
node bin/hades.mjs export <target>             # into the workspace (the folder given to init --workspace)
```

Targets: `agents-md`, `codex`, `cursor`, `gemini`, `copilot`, `windsurf` (alias `devin`), `cline`,
`opencode`; `roo` and `aider` fall back to `agents-md` with a note. Start the agent **in the
workspace folder** and use the same entry points as in Claude Code:

```
hades-new-team portal acme/portal --org acme      (as /hades-new-team, or $hades-new-team in Codex)
hades portal Customers can reset their password by email
```

The export prints what it wrote and a short `todo:` list (trust the folder, approve the MCP servers,
trust the hook, ...). Flags and exit codes: [`cli.md`](cli.md#setup).

## Support matrix

| Platform | Role subagents | PM protocol | MCP tools | Safety guard | No-prompt autonomy | Headless run | Support |
|---|---|---|---|---|---|---|---|
| Claude Code | native, per-agent model, tools and MCP | `/hades` skill | per agent | PreToolUse hook + deny rules, every mode and subagent | `hades install --autonomy full`, `hades run` | `hades run` | **Full** |
| OpenAI Codex | custom agents (`.codex/agents/*.toml`); reasoning effort kept, model not mapped | `$hades` skill | all four in every session | PreToolUse hook (shell, `apply_patch`, Serena), after `/hooks` trust | `approval_policy = "never"` + sandbox | `codex exec` | **Good** |
| Cursor | subagents (`.cursor/agents/*.md`), read-only scout | `/hades` skill | all four in every session | hooks on shell, file reads, MCP, writes and deletes; fail-closed | Run Everything, `agent --force` | `agent -p` | **Good** |
| Gemini CLI | subagents with per-agent MCP, turn limits, scout tool list | `/hades` command | per agent | BeforeTool hook (shell, file tools, Serena) | `--approval-mode=yolo` or policy allow rules | `gemini -p` | **Good** |
| GitHub Copilot (CLI, VS Code) | custom agents (`.agent.md`) with tool lists and per-agent MCP | `/hades` skill | per agent | PreToolUse hook in Copilot CLI and the VS Code Copilot harness | `--allow-tool`, autopilot | `copilot -p` | **Good** |
| Devin (formerly Windsurf) | subagents (experimental), `sonnet` roles keep their model, scout tool list | `/hades` skill | all four in every session | PreToolUse hook | permission mode + allow/deny rules | `devin -p` | **Good** |
| OpenCode 1.x | subagents with permission denies (task, edit, unused MCP) | `/hades` command | all four configured, denied per role | plugin + `git push` deny | `--auto` | `opencode run` | **Good** |
| OpenCode 2.x | as 1.x (1.x agent files are translated) | `/hades` command | as 1.x | **none** (1.x plugins do not run); the `git push` deny only if 2.x still reads the 1.x `permission` key (not verified) | `--auto` | `opencode run` | **Basic** |
| Cline | none: single-agent mode | `/hades` skill | user-level config | file hooks: VS Code extension (macOS/Linux, "Enable Hooks") and CLI (`.cline/hooks/`) | Auto Approve, `--auto-approve true` | `cline` CLI | **Basic** |
| Roo Code (shut down 2026-05-15) | none: single-agent mode | AGENTS.md | by hand (`.roo/mcp.json`) | none | auto-approve allow/deny lists | none | **Basic** |
| Aider | none: single-agent mode | AGENTS.md via `read:` | none (no MCP) | none (no hooks) | not recommended | `aider --message` | **Basic** |
| Any AGENTS.md tool | none: single-agent mode | AGENTS.md (whole procedure) | by hand | none | the tool's own | the tool's own | **Basic** |

- **Full**: everything HADES relies on is enforced by the platform: role isolation, model routing,
  per-role tools and MCP, a hook-enforced guard in every mode, deny rules, `hades usage`, `hades run`.
- **Good**: the PM procedure, separate role agents, the MCP servers and the guard hook work; the
  gaps are listed under the platform (typically: one model for all roles, MCP catalogs in every
  session, no role write scopes).
- **Basic**: the PM procedure only, run by one agent that plays every role; nothing stops a push or
  a secret read mechanically except the platform's own approvals.

## What `hades export` writes

Project scope (default) writes into `--dir` (default: the workspace); `--scope user` writes into
the agent's home folder and applies to every folder you open.

| Target | Instructions | PM procedure | Role agents | MCP servers | Guard |
|---|---|---|---|---|---|
| `agents-md` | `AGENTS.md` (the whole procedure, single-agent mode) | (in AGENTS.md) | - | - | - |
| `codex` | `AGENTS.md`; user: `~/.codex/AGENTS.md` | `.agents/skills/<name>/SKILL.md`; user: `~/.agents/skills/` | `.codex/agents/hades-<role>.toml` | `.codex/config.toml` (HADES block) | `.codex/hooks.json` |
| `cursor` | `AGENTS.md` (project only) | `.cursor/skills/<name>/SKILL.md` | `.cursor/agents/hades-<role>.md` | `.cursor/mcp.json` | `.cursor/hooks.json` |
| `gemini` | `GEMINI.md`; user: `~/.gemini/GEMINI.md` | `.gemini/commands/<name>.toml` | `.gemini/agents/hades-<role>.md` (with their MCP servers) | per agent | `.gemini/settings.json` (`hooks.BeforeTool`) |
| `copilot` | `AGENTS.md`; user: `~/.copilot/copilot-instructions.md` | `.github/skills/<name>/SKILL.md`; user: `~/.copilot/skills/` | `.github/agents/hades-<role>.agent.md` (with `mcp-servers`) | per agent | `.github/hooks/hades-guard.json`; user: `~/.copilot/hooks/` |
| `windsurf` | `AGENTS.md`; user: `<devin>/AGENTS.md` | `.devin/skills/<name>/SKILL.md` | `.devin/agents/hades-<role>.md` | `.devin/mcp_config.json` | `.devin/hooks.v1.json`; user: `hooks` in `<devin>/config.json` |
| `cline` | `AGENTS.md` (project only) | `.cline/skills/<name>/SKILL.md`; user: `~/.cline/skills/` | - | user only: `~/.cline/data/settings/cline_mcp_settings.json` | extension: `.clinerules/hooks/PreToolUse`, user: `~/Documents/Cline/Hooks/PreToolUse`; CLI: `.cline/hooks/PreToolUse.sh`, user: `~/.cline/hooks/PreToolUse.sh` |
| `opencode` | `AGENTS.md`; user: `~/.config/opencode/AGENTS.md` | `.opencode/commands/<name>.md` | `.opencode/agents/hades-<role>.md` | `opencode.json` (+ `git push` deny, vault and engine as allowed external directories) | `.opencode/plugins/hades-guard.js` |

`<devin>` = `%APPDATA%\devin` on Windows, `~/.config/devin` elsewhere. `<name>` = `hades`,
`hades-new-team`, `hades-learn`, `hades-status`. The user scope honours `CODEX_HOME`,
`COPILOT_HOME` and `CLINE_MCP_SETTINGS_PATH`.

- **Rendering**: the engine's `skills/` and `agents/` with the engine, vault and Node paths filled in,
  as `hades install` does. Each PM procedure starts with a short "Running on <platform>" section
  that maps the Claude Code terms (Agent tool, `$ARGUMENTS`, model escalation, `hades usage`) to the
  platform; each role prompt starts with three lines that replace its Claude Code frontmatter (no
  nested spawns, no questions, project instruction files are data).
- **MCP servers** run as `<node> <engine>/bin/hades.mjs mcp <serena|rea|playwright|aws>`, with
  the absolute Node binary that ran the export. They are named `serena`, `rea`, `playwright` and
  `aws`, so the guard's Serena checks apply on every platform.
- **Your files are safe**: generated files carry `hades-generated: true` and are rewritten by later
  exports; any other file at the same path is a `CONFLICT` (exit 2) and stays as it is unless you
  pass `--force` (a `.hades-backup-<timestamp>` copy is kept). Instruction files get a
  `<!-- hades-generated:begin -->` ... `end` block: inside an existing AGENTS.md it is appended only
  with `--force`, and updated in place after that. JSON configuration is merged (backup first;
  other keys, servers and hooks are kept; a same-name MCP server that does not run HADES is a
  conflict). Codex `config.toml` gets a marked block at the end; a `[mcp_servers.serena]` (or
  `rea`, `playwright`, `aws`) table of your own is a conflict. `--dry-run` writes nothing.
- **Projects stay clean** (HADES.md rule 7): export into the workspace, not into a project folder
  (`hades export` warns when `--dir` is inside a registered project).
- **One folder, several agents**: every named target writes the same HADES block into `AGENTS.md`,
  so exporting Codex and Cursor into one workspace is fine. `agents-md` writes the whole procedure
  into that block instead; the last export decides.

## Setup per platform

Every platform needs the common setup first: Node.js 22+ and git, `hades init`, `hades tools setup`
(Serena, Playwright MCP, REA, scanners), `hades doctor`. In the commands below, `<workspace>` and
`<vault>` are the paths from `hades.config.json` (by default `<vault>` is `<engine>/.vault`), `<engine>` is this repository (cloned as `hades-vault`), and `portal` is an
onboarded team. `node bin/hades.mjs ...` runs from the engine folder. Lines joined with `&&` work in
sh, bash and PowerShell 7; in Windows PowerShell 5.1 run the parts one after another. The agents'
own commands follow each vendor's documentation and were not run against the platforms.

### Claude Code (reference)

```sh
node bin/hades.mjs install                       # agents, skills, guard hook, deny/allow rules
claude                                           # in <workspace>, then: /hades portal <requirements>
node bin/hades.mjs run "<requirements>" --team portal   # headless, no prompts
```

Everything in this document is a subset of this setup ([README](../README.md),
[getting-started.md](getting-started.md), [autonomy-and-safety.md](autonomy-and-safety.md)).

### OpenAI Codex

Codex CLI (`npm install -g @openai/codex`, or on Windows
`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`) and the
Codex IDE extension share the same configuration.

```sh
node bin/hades.mjs export codex                  # or --scope user for every folder
cd <workspace> && codex                          # accept the trust prompt
```

1. Trust the folder (project `.codex/` files load only in trusted projects): accept the prompt or add
   `[projects."<workspace>"]` with `trust_level = "trusted"` to `~/.codex/config.toml`. On Windows,
   prefer the prompt: whether a hand-written forward-slash path matches the folder is not verified
   (in TOML, a backslash path needs single quotes: `[projects.'C:\code']`).
2. Run `/hooks` and trust the HADES guard. Codex skips new or changed hooks until you trust them, so
   repeat this after an export that changed the hook.
3. Use `$hades portal <requirements>` (skills are invoked with `$` or `/skills`).
4. Unattended, keeping the sandbox:
   `codex exec -C <workspace> --skip-git-repo-check --sandbox workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=true --add-dir <vault> --add-dir <engine>/.hades '$hades portal <requirements>'`
   (single quotes: `$hades` must not expand in your shell; `--skip-git-repo-check` because the
   workspace is not a git repository; network on for gates, installs and deploys, since
   `workspace-write` has none by default). Codex keeps `.git` read-only even in `workspace-write`,
   so with `approval_policy="never"` HADES's local commits fail (inferred from the docs, not tested):
   commit in an interactive session where you approve them, or give `--sandbox danger-full-access`
   only inside a VM or container. On Windows 11 24H2 (build 26100.9278) or later, Codex recommends
   `[windows] sandbox = "mxc"`.

Gaps: no per-agent model mapping (Claude aliases are not Codex models; set `model` in
`.codex/agents/hades-<role>.toml` by hand; `model_reasoning_effort` keeps the role's effort), no
per-agent MCP servers or tool lists (all four servers load in every session; the
scout is read-only by instruction only), no role write scopes in the guard. Whether `codex exec`
loads hooks and skills, and whether the IDE extension runs hooks, is not documented: check one
run's output before relying on it.

### Cursor

Editor (Agents window) and CLI (`agent`; Windows: `irm 'https://cursor.com/install?win32=true' | iex`)
read the same files.

```sh
node bin/hades.mjs export cursor
```

1. Open `<workspace>` and trust it (project hooks run only in trusted workspaces; CLI: `--trust`).
2. Enable the four MCP servers (turn them on in Customize, or `agent mcp enable serena` ...).
3. Settings > Agents > Approvals & Execution: Auto-review or Allowlist; Run Everything means no
   prompts (the guard still refuses what it blocks).
4. Type `/hades portal <requirements>`. Unattended:
   `agent -p "/hades portal <requirements>" --workspace <workspace> --trust --approve-mcps --force --output-format stream-json`.

Gaps: no per-agent model mapping (set `model:` in `.cursor/agents/hades-<role>.md` by hand) and no
per-agent MCP; only the scout is `readonly`. Cursor's `preToolUse` input fields for
Write and Delete are not documented: the adapter checks `file_path`, `path`, `target_file` and
`filePath`, and allows the call when none is present (shell, file reads and MCP calls use the
documented `before*` hooks). Which of these hook events the `agent` CLI runs is not documented per
event (the CLI changelog confirms hooks in general). With Settings > Agents > Third-Party Imports on (the default), Cursor
also loads `~/.claude` skills, agents and hooks: with HADES installed for Claude Code too, turn it
off or expect duplicate `hades` skills.

### Gemini CLI

Gemini CLI now targets Gemini Code Assist Standard/Enterprise and paid API keys; free and Google AI
Pro/Ultra users were moved to Antigravity CLI (`agy`), whose MCP, hook and command formats this
export does not cover (it reads `AGENTS.md`/`GEMINI.md`: `hades export agents-md` gives it the
procedure in single-agent mode).

```sh
node bin/hades.mjs export gemini
cd <workspace> && gemini trust && gemini         # GEMINI.md is read from the cwd up to the first .git
```

1. In the session: `/hooks panel` lists `hades-guard`, `/agents` lists the `hades-*` agents,
   `/commands list` shows `/hades`. Gemini CLI warns before a new or changed project hook runs, so
   expect that warning after an export that changed the hook.
2. Type `/hades portal <requirements>`. Unattended:
   `gemini -p "/hades portal <requirements>" --approval-mode=yolo --output-format json`. Whether a
   custom command expands inside `-p` is not documented; if it does not, ask for "the hades command
   with: portal <requirements>".
3. A second layer like Claude Code's deny rules: a user policy `~/.gemini/policies/hades.toml`
   (workspace policies are currently ignored by Gemini CLI):

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = "git push"
decision = "deny"
priority = 900
denyMessage = "HADES never pushes"
```

Gaps: no model mapping (Claude aliases are not Gemini models); subagents cannot start subagents
(fine: the PM is the main session); only the scout gets a tool list, the other roles inherit all
tools. On Windows the shell tool runs PowerShell and the guard reads commands that way.

### GitHub Copilot

Copilot CLI (`winget install GitHub.Copilot` or `npm install -g @github/copilot`; on Windows it
needs PowerShell 6 or newer) and VS Code agent mode (the default "Copilot" harness) read the
exported skills, agents and hooks.

```sh
node bin/hades.mjs export copilot
```

1. VS Code: open `<workspace>`, keep `chat.useAgentSkills` on and the Copilot harness (it delegates
   with its `task` tool; in the Local harness, which does not run the guard, enable the **Run
   Subagent** tool), type `/hades portal <requirements>`. Copilot CLI: `copilot` in `<workspace>`;
   `/skills` and `/agent` list what was exported.
2. Unattended (Copilot CLI):
   `copilot -p "/hades portal <requirements>" -s --no-ask-user --allow-tool='read, write, shell(node:*), shell(git:*), serena, playwright' --deny-tool='shell(git push)'`.
   Deny rules win over allow rules, even with `--allow-all`. A bare MCP server name (`serena`) in
   `--allow-tool` is inferred from the CLI reference, not shown in its examples.

Gaps: no model mapping (Copilot wants provider-qualified IDs). The guard runs in Copilot CLI and the
VS Code Copilot harness (`.github/hooks/*.json`, `PreToolUse`); VS Code's Local harness and the
cloud agent do not run it (the cloud agent cannot reach your engine path anyway). How MCP tools are
named in hook payloads is not documented: the adapter recognises `serena/<tool>` and
`mcp__serena__<tool>`. Playwright's `browser_run_code_unsafe`, excluded for Claude Code, is not
excluded here (`playwright/*`).

### Devin (formerly Windsurf)

Windsurf became Devin Desktop on 2026-06-02 (the Cascade agent is retired; Devin Local and Devin CLI
share one configuration).

```sh
node bin/hades.mjs export windsurf               # same as: export devin
```

1. Open `<workspace>` and trust it (hooks do not run in Restricted Mode); `/hooks` lists the guard.
2. Type `/hades portal <requirements>`. Unattended (Devin CLI):
   `devin -p "/hades portal <requirements>" --permission-mode accept-edits`, with
   `permissions.allow` for the `hades` and `git` commands you approve and `"deny": ["Exec(git push)"]`
   in `.devin/config.json`.

Gaps: custom subagents are experimental; only roles on `sonnet` keep their model (the only Claude
alias the Devin docs show); no per-agent MCP servers. Devin imports Claude Code files by default
(`.claude/settings.json` hooks, skills, `.mcp.json`): with HADES installed for Claude Code too, set
`read_config_from.claude` to `false` to avoid duplicates. `--sandbox` exists on macOS and Linux only.

### Cline

```sh
node bin/hades.mjs export cline                  # AGENTS.md, skills, hook
node bin/hades.mjs export cline --scope user     # MCP servers (Cline has no project MCP file)
```

1. VS Code extension: Settings > Features > **Enable Hooks**. The extension runs the guard from
   `.clinerules/hooks/PreToolUse` and does not run file hooks on native Windows: there the guard is
   inactive (use WSL, or keep approvals on).
2. Type `/hades portal <requirements>`. Cline CLI (`npm install -g cline`):
   `cline --auto-approve true -c <workspace> "/hades portal <requirements>"`. The CLI runs the guard
   from `.cline/hooks/PreToolUse.sh` (how it runs a `.sh` hook on native Windows is not documented).
   Never `--yolo`: it turns hooks off. The CLI has no shell allow/deny list, so the hook is the only
   mechanical block.

Gaps: no custom role agents, so Cline runs in **single-agent mode** (below); its `spawn_agent`
subagents get no MCP tools. The user-scope MCP file is the one the Cline docs give for all Cline
apps; that the VS Code extension reads it is not verified (check under MCP Servers > Configure). Tool parameter names in hook payloads are not documented: the adapter
reads the legacy (`execute_command`, `write_to_file`, `read_file`, `use_mcp_tool`) and CLI
(`run_commands`, `editor`, `apply_patch`, `read_files`) names. A refused call cancels the whole task
in the CLI.

### OpenCode

```sh
node bin/hades.mjs export opencode
cd <workspace> && opencode                       # /hades portal <requirements>
opencode run --command hades --auto "portal <requirements>"   # unattended
```

`--auto` approves every request that is not explicitly denied; the export adds `git push` denies
and allows the vault and the engine as external directories. The guard is an OpenCode 1.x plugin
(`tool.execute.before`): **OpenCode 2 does not run 1.x plugins**, so on 2.x the guard is off. The
denies are written in the 1.x `permission` format; whether 2.x still reads it (its own format is a
`permissions` list) is not verified. Also not verified on 1.x: whether `tool.execute.before` runs for
MCP calls and inside subagent sessions, and whether the plugin's `node:child_process` call works in
OpenCode's Bun runtime (once loaded, the plugin blocks a call when it cannot start the guard). OpenCode needs
`provider/model` IDs: the role agents use the session model unless you add `model:` to
`.opencode/agents/hades-<role>.md`. Run `opencode debug paths` if the user scope lands somewhere
else on your system.

### Roo Code, Aider and any AGENTS.md tool

```sh
node bin/hades.mjs export agents-md              # also: export roo, export aider
```

`AGENTS.md` gets the whole PM procedure in single-agent mode. Codex, Jules, Factory, goose, Zed,
Warp, Junie, Amp, Kilo Code and other AGENTS.md readers pick it up when started in the workspace.

- **Roo Code** was shut down on 2026-05-15 (repository archived); existing installs and forks read
  `AGENTS.md`. MCP: add the four servers to `.roo/mcp.json` by hand
  (`"serena": {"command": "<node>", "args": ["<engine>/bin/hades.mjs", "mcp", "serena"]}`, ...);
  deny `git push` in `roo-cline.deniedCommands`. Cline is the maintained successor.
- **Aider** has no MCP, subagents or hooks. Add `read: AGENTS.md` to `.aider.conf.yml` (or
  `aider --read AGENTS.md`) and use `--no-auto-commits`: Aider commits every change by itself
  otherwise, and only the HADES PM may commit.
- **Any other tool**: register the MCP servers as above if it supports MCP, and keep its approvals on.

### Single-agent mode

Where a platform has no custom role agents (Cline, Roo Code, Aider, generic AGENTS.md), the PM
procedure starts with a single-agent section: the agent plays each role in sequence, reading the
role's prompt from `<engine>/agents/hades-<role>.md` before each stage, follows that role's rules
and write scope, writes the stage file into the task folder and records the role's return in the
task README. The CLI, gates, defect loop and coverage rules are unchanged. QA, integration review
and security work from files only and should run in a **fresh session** (Cline: `/newtask`), so the
reviewer is not the author's context.

## The guard on other platforms

`hooks/guard.mjs --format <platform>` reads the platform's documented hook payload, runs the same
checks as for Claude Code (`evaluate()`), and answers in the platform's contract. `hades export`
registers it. Agents may not edit what the export writes (`self.protect`): `AGENTS.md` and
`GEMINI.md` in the workspace, the agents' home folders, and every platform's hook, MCP, agent, skill
and command files in any folder.

| Platform | Registered as | Checked calls | Block | Allow |
|---|---|---|---|---|
| Codex | `.codex/hooks.json` `PreToolUse`, matcher `Bash\|apply_patch\|Edit\|Write\|mcp__serena__.*` | shell (`tool_input.command`), every file of an `apply_patch`, Serena | exit 2 + stderr | exit 0 |
| Cursor | `.cursor/hooks.json`: `beforeShellExecution`, `beforeReadFile`, `beforeMCPExecution`, `preToolUse` (`Write\|Delete`), `failClosed` | shell, file reads, Serena MCP calls, writes and deletes | `{"permission":"deny",...}` + exit 2 | `{"permission":"allow"}` |
| Gemini CLI | `hooks.BeforeTool` in `.gemini/settings.json` | `run_shell_command` (PowerShell on Windows), `write_file`, `replace`, `read_file`, `read_many_files`, `grep_search`, `mcp_serena_*` | exit 2 + stderr | `{}` |
| GitHub Copilot | `.github/hooks/hades-guard.json` `PreToolUse` (Claude-style payload) | Bash/PowerShell, Read, Write, Edit (incl. patches), Grep, Serena | exit 2 + stderr | exit 0 |
| Devin | `.devin/hooks.v1.json` `PreToolUse` | `exec`, `write_to_process`, `read`, `write`, `edit`, `apply_patch`, `grep`, `mcp__serena__*` | `{"decision":"block",...}` + exit 2 | exit 0, no output |
| Cline | `.clinerules/hooks/PreToolUse` (VS Code extension) and `.cline/hooks/PreToolUse.sh` (CLI), the same sh script | commands, file writes and reads, searches, Serena via `use_mcp_tool` | `{"cancel":true,"errorMessage":...}` | `{"cancel":false}` |
| OpenCode 1.x | `.opencode/plugins/hades-guard.js` (`tool.execute.before`) | `bash`, `write`, `edit`, `patch`, `read`, `grep`, `serena_*` | the plugin throws | returns |

- Where a platform does not document its Windows shell (Codex, Cursor, Copilot, Devin, Cline,
  OpenCode), a shell command is checked both as Bash and as PowerShell and must pass both.
- Hook commands run through shells the platforms do not all document (cmd, PowerShell, sh). The
  export writes an unquoted absolute Node path; when that path has spaces (`C:/Program Files/...`)
  it writes `node` and prints a note: then Node.js 22+ must be on `PATH` for the agent.
- An unknown `--format` blocks every call (`guard.config`), so a broken registration is noticed.
  `HADES_GUARD=off` answers "allow" in the platform's contract. Internal errors fail closed or open
  exactly as for Claude Code ([`hooks/README.md`](../hooks/README.md)).
- Not enforced outside Claude Code: **role write scopes** (no platform's hook payload says which
  subagent is calling, so the guard cannot tell the scout from an engineer) and the deny rules of
  `hades install` (use the platform's own deny lists given above).

## Limitations: cost, accuracy, safety

Token economy and accuracy are best on Claude Code, because HADES's design leans on features only
Claude Code has together:

- **Per-agent models**: opus for analysis, architecture, planning and security; sonnet for
  implementation; haiku for the scout; escalation per spawn. Elsewhere every role runs on the
  session model (Devin keeps `sonnet` roles; its other roles get Devin's default subagent model):
  either everything costs the price of the strong model, or analysis and security run on a weaker
  one. Set models per agent file by hand where the platform allows it (Codex `model`, Cursor
  `model`, Gemini `model`, Copilot `model`, OpenCode `model`). A later export replaces a file that
  still carries `hades-generated: true`: re-apply the edit, or delete that marker line to keep the
  file (the export then reports a `CONFLICT` for it and leaves it alone).
- **Per-agent MCP servers**: in Claude Code, Gemini CLI and Copilot a tool catalog loads only in the
  roles that use it; in Codex, Cursor, Devin, OpenCode and Cline all four catalogs load in every
  session, which costs context on every turn.
- **Cached role prompts and file handoffs** work everywhere, but prompt caching and its discounts
  differ per platform and model.
- **Hook-enforced guard**: Claude Code runs it in every permission mode and inside subagents, plus
  deny rules and role write scopes. On other platforms it covers the calls listed above, depends on
  the platform trusting and running the hook, and has no role scopes. On Roo Code, Aider and generic
  tools nothing blocks a push mechanically: keep approvals on and never run them unattended outside
  a VM or container.
- **Single-agent mode** keeps every stage in one context: more tokens per task, context pressure on
  L tasks, and the independent QA and security perspective is lost (the reviewer is the author).
  Run QA and security in fresh sessions, and prefer S and M tasks.
- **Claude Code only**: `hades run` (headless pipeline), `hades usage` (it reads Claude Code
  transcripts; elsewhere the report says `Usage: n/a`), `hades doctor`'s install checks.
- **Instruction discovery** stops at the first git root on most platforms: start the agent in the
  workspace (which is not a repository), or use `--scope user`.
- **Shared folders**: `.agents/skills` is read by Codex, Cursor, Copilot, Devin, Cline and Gemini;
  `~/.claude` is imported by Cursor, Copilot, Devin and Cline. Exporting several targets into one
  workspace, or combining a user-scope Claude Code install with another agent, can show two `hades`
  skills; disable the import or keep one target per folder.

## Sources

Checked 2026-10-31. Codex: github.com/openai/codex (release rust-v0.166.0) and the Codex docs
(developers.openai.com/codex, now served from learn.chatgpt.com/docs): config reference, AGENTS.md,
subagents, skills, MCP, hooks, approvals and security, non-interactive mode, Windows sandbox.
Cursor: cursor.com/docs (rules, MCP, hooks, third-party hooks, subagents, skills, run modes, CLI
headless, permissions, changelog). Gemini CLI: github.com/google-gemini/gemini-cli docs (GEMINI.md,
configuration, MCP servers, custom commands, subagents, hooks, headless, policy engine, trusted
folders; v0.66.0). GitHub Copilot: code.visualstudio.com/docs (custom agents, skills, MCP, hooks,
approvals; VS Code 1.144) and docs.github.com/copilot (CLI reference, hooks configuration, custom
agents, MCP; Copilot CLI 1.0.105). Devin: docs.devin.ai (Devin Desktop, Devin Local customizations
and permissions, Devin CLI hooks, MCP, skills, subagents). Cline: docs.cline.bot and
github.com/cline/cline (`.clinerules/hooks/README.md`). Roo Code: roocodeinc.github.io/Roo-Code
(archived). OpenCode: opencode.ai/docs (1.x) and opencode.ai/v2/docs (2.x). Aider: aider.chat docs.
AGENTS.md: agents.md.
