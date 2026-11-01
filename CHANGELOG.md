# Changelog

All notable changes to HADES. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

Nothing yet.

## 2.0.0 - 2026-11-01

First open-source release. Breaking: the framework moved out of the vault into this engine;
migrate v1 vaults with `hades migrate` (`docs/migration-from-v1.md`).

### Changed (layout and naming)
- The repository is renamed **hades-vault** (`https://github.com/prasadm1022/hades-vault`;
  `package.json` name `hades-vault`, the CLI stays `hades`): HADES, the shareable agentic platform,
  plus your vault, the private local knowledge base. Clone it into `~/code/hades-vault`.
- The default vault is `<engine>/.vault` (was `<engine>/vault`; the docs recommended a sibling
  `../my-vault`). The engine's `.gitignore` ignores `/.vault/` and `/vault/`; `hades init` without
  `--vault` scaffolds `.vault/` and always makes a vault inside the engine its own git repository.
  Back it up after a first commit (`git -C .vault add -A && git -C .vault commit -m "Initial vault"`,
  then `git -C .vault remote add origin <private-url>` and `push -u origin HEAD`). A custom vault
  (`hades init --vault <path>`, `HADES_VAULT`, `hades.config.json`) still works.
- Relative `vault`/`workspace` paths in `hades.config.json` resolve against the engine folder (CLI
  and guard); `hades init` stores a vault inside the engine as `".vault"`, so renaming the engine
  folder keeps it.
- Backward compatible: without a configured vault, a legacy `<engine>/vault` holding a
  `registry.json` is still used while `<engine>/.vault` does not exist; `hades doctor` WARNs.
- `hades doctor` checks the vault location: a vault inside the engine that the engine repository
  does not git-ignore is a FAIL.
- Guard: a vault inside the engine is the vault, not engine code. Role agents write it as before;
  state files, mass deletes and Serena `activate_project` stay blocked; `scope.engine` and
  self-protection still cover every other engine file; the engine's `*credentials*.md` secret-name
  exemption no longer extends to a vault inside it. Tests: `tests/hooks/guard-engine-vault.test.mjs`.
- `HADES_DEFAULT_VAULT` replaces the built-in default (the test helpers point it at a missing folder,
  so no test reaches a real vault).
- Migration: move the vault folder (with its `.git`) to `<engine>/.vault` and run
  `hades init --vault .vault` (or set `"vault": ".vault"` in `hades.config.json` by hand), then
  `hades install`; or keep it where it is. Rename the engine folder from a terminal with no agent
  session open and re-run `install` (and `export`) right after the rename.
- Relative `--vault`/`--workspace` flags and a relative `HADES_VAULT`/`HADES_WORKSPACE` resolve
  against the engine folder, like the config values (`hades init --vault .vault` from any folder is
  `<engine>/.vault`). `hades init` refuses the engine folder itself (any letter case), notes when it
  repoints away from a vault that still holds a registry, and runs `git init` in an existing vault
  inside the engine (or git-ignored by its surrounding repository) that has no repository of its own
  (`"git": "repo"` for a vault that already is one).
- `hades doctor`: the git-ignore check also holds before `.vault` exists (fresh clone); a vault
  inside the engine that is not its own git repository is a FAIL ("vault repository"); git missing
  is a WARN instead of an OK; vault notes that still name an old engine folder are a WARN
  ("vault notes").
- Guard hardening for the vault inside the engine: Windows 8.3 short names (`VAULT~1`,
  `HADES-~1`) are expanded before deletes, moves and Serena roots are judged; `<engine>/.vault` and
  `<engine>/vault` stay protected when `hades.config.json` names a vault without `registry.json`
  (the guard then uses the default vault that has one and warns on allowed calls); `git stage -f`,
  `git update-index --add|--cacheinfo|--index-info` (`git.force`) and `git stash -a|--all`
  (`git.discard`) are blocked; new rule `git.vault` blocks `add`/`stage`/`update-index`/`commit` of
  vault paths from any repository other than the vault's own; `<engine>/.gitignore` is
  self-protected; the vault's `registry.json` is CLI-only (`state.direct-edit`);
  `<vault>/organizations` and `<vault>/company` cannot be deleted; Serena `activate_project` inside
  the engine or a vault is refused except for a vault team folder or a registered project.

### Added
- `hades tools patch <name> [--note <text>]` pins the commit checked out in `tools/<name>` (a branch
  pushed to the tool's fork) as a patch over the upstream release, recorded in
  `tools/tools.lock.json` as `patch` (`branch`, `base_tag`, `base_commit`, `commits`, `note`);
  `--drop` returns to the upstream base. It reports whether the patch takes effect (only tools set up
  from the vendored source). `tools verify` and `tools list` show patched pins; `tools bump` refuses
  them unless `--drop-patch`. `docs/tools.md`, Patching a tool.
- The vendored tools clone from forks under `github.com/prasadm1022` (`.gitmodules`), so pinned
  commits stay available if upstream rewrites or deletes them. `tools/tools.lock.json` keeps the
  upstream `repo`: `tools bump` checks releases there and fetches the new pin from upstream.
- `docs/reference.md`: installation details, configuration, model routing, guard policy, vendored
  tools, layout, upgrading and troubleshooting (moved from the README, which is now a short overview
  with token savings, a usage table and a FAQ). `CITATION.cff` for GitHub's "Cite this repository".
- `hades help` and the docs name HADES as a project by HadesVault.com; the README hero is an animated
  WebP (`docs/assets/hades-hero.webp`) with a static `social-preview.png`, built by
  `docs/assets/hero-tools/`.
- `hades export <target> [--dir <dir>] [--scope project|user] [--dry-run] [--force]` renders HADES for
  other coding agents: `codex`, `cursor`, `gemini`, `copilot`, `windsurf` (alias `devin`), `cline`,
  `opencode`, and `agents-md` for any AGENTS.md tool (`roo` and `aider` fall back to it with a note).
  The PM procedure becomes the agent's skill or command (single-agent mode where it has no custom
  agents), the roles its subagents (tools, MCP servers, turn limits and models mapped only where the
  platform documents them), the MCP servers its MCP configuration, the guard its pre-tool hook.
  Marked files are updated, other files kept unless `--force` (backup first), JSON configuration
  merged with a backup; conflicts exit 2. `docs/other-agents.md`: support matrix, setup per
  platform, limitations.
- Guard adapters: `hooks/guard.mjs --format codex|cursor|gemini|copilot|windsurf|cline|opencode` maps
  each platform's documented hook payload to the guard's checks (every file of a patch; shell commands
  as Bash and PowerShell where the Windows shell is undocumented) and answers in its contract; an
  unknown format blocks. Tests: `tests/hooks/guard-adapters.test.mjs`, `tests/cli/export.test.mjs`.
- `hades task adopt <v1-task-id> [--stage <stage>] [--size S|M|L]` turns a HADES v1 task record into a
  v2 task folder (`<id>-<slug>-v2/`) without touching the v1 files; `/hades <team> continue <task-id>`
  resumes v2 tasks and adopted v1 records (`docs/migration-from-v1.md`, Resuming a v1 task).
- `/hades-learn <team> --migrate`: the documented LLM pass after `hades migrate` (splits `.v1.md` role
  notes, removes `hades-migrate` markers, writes `CONTEXT.md`, fills `team.json`, never touches files
  with uncommitted changes that predate the migration).
- Tech lead fix mode for integration-glue defects it owns; QA smoke mode on the deployed test
  environment (size L); runtime security testing of a locally started app when nothing is deployed
  (`hades gate --dast http://localhost:<port> --mode full --i-own-this-target`).
- Publishing checklist in `docs/getting-started.md`; fallback private contact in `SECURITY.md`.

### Changed
- The guard also self-protects what `hades export` writes: other agents' instruction files
  (`<workspace>/AGENTS.md`, `GEMINI.md`), hook, MCP and permission configuration, and the HADES
  agents, skills, commands and plugins of every platform.
- A gate with nothing runnable is red (`GATE EMPTY`, exit 2; `--allow-empty` accepts it). Every
  command refuses unknown flags. `team.json` `security.dast_live`/`dast_test` are enforced by
  `hades gate --dast`.
- Guarded install allows only safe CLI subcommands and `git add/commit/status/diff/log/rev-parse`
  (plain and `git -C`); the docs now say exactly what still prompts and that a prompt-free run
  needs `hades run` or `--autonomy full`. The hook runs the absolute Node.js path with
  `onFailure: block`; so do the agents' MCP servers (`command: "{{NODE}}"`, rendered by
  `hades install`), and `hades doctor` checks that both Node binaries exist and are Node 22+.
- Agents start Serena without a project and call `activate_project` with the absolute `<Project>`
  path before the first symbol tool. The guard also blocks editor writes to `work-plan.json`
  (drafts are `work-plan.draft.json`); the vault `.gitignore` ignores lock and temp leftovers.
- PM procedure: reads `CONTEXT.md`, its own notes and role model overrides; checks gate G8 (docs in
  the release commit); commits deploy configuration before it is deployed; caps QA and security
  stage rounds; S tasks spawn QA once; the vault commit includes `team.json` and every vault file
  the task changed.
- QA and security route cross-cutting failures to one defect per layer; `tech-lead` owns glue only.
- Task README heading `## Assumptions & decisions` renamed to `## Decisions`.
- `/hades-new-team` refuses a missing project path and moves Claude files in guard-compatible steps.
- `LICENSE` is the plain MIT text; the third-party license note moved to `README.md` and
  `THIRD_PARTY_NOTICES.md` (now listing the MCP Proxy for AWS `NOTICE` and ZAP's `LEGALNOTICE.md`,
  also in `tools/tools.lock.json`); `package.json` names the repository, homepage and issue tracker.
- `docs/tools.md` states how semgrep is installed and that its dependencies are not hash-checked.

### Fixed
- Guard on Windows: every path (engine, vault, workspace, config, policy, home, Claude folder,
  current folder, registered projects and organizations, file-tool and shell targets) is judged in
  long form. Paths with 8.3 short names (`C:/Users/RUNNER~1/...`) no longer block legitimate vault
  and project writes or defeat exemptions.
- Tests pass on every CI platform: the prompt path check treats the git-ignored `.vault` as a runtime
  path, and the Serena startup test compares real paths (macOS `/var` is `/private/var`).

### Added (v2 engine)
- Engine/vault split: an MIT engine (agents, skills, policies, playbooks, CLI, hooks, templates,
  vendored tools) and a private vault (registry v3, organizations, teams, knowledge, tasks), joined by
  `hades.config.json`.
- Native Claude Code subagents for every role: company staff (business analyst, software architect,
  DevOps engineer, cybersecurity engineer), team roles (tech lead, backend, frontend, AI/ML/data and
  QA engineers) and helpers (scout, knowledge curator); per-agent MCP servers.
- Pipeline with CLI stage names `intake analysis design planning build qa release deploy security
  close`, sizes S/M/L, defect loop with sources `qa`, `security`, `review`, `deploy` and a 3-round
  limit, integration review for M and L tasks, model/eval plan (`04-model-plan.md`) for L tasks with
  AI/ML/data scope, greenfield scaffolding by the tech lead.
- Zero-dependency `hades` CLI (Node >= 22): `init`, `install`, `doctor`, `org`, `team` (incl.
  `team set` for commands, environments, security, branch strategy and projects), `task`, `defect`,
  `gate`, `detect`, `tools`, `mcp`, `usage`, `status`, `migrate`, `run`.
- Evidence engine: `hades gate` presets (build, precommit, predeploy, security, full) with compact
  output, test and finding counts, logs outside the vault; DAST with ZAP and live/test target rules;
  AC -> work item -> test case coverage checks; work plan validation.
- Guard hook (`hooks/guard.mjs`) parsing Bash, PowerShell and cmd: blocks pushes, destructive git,
  protected deletes, secret reads, download-and-execute, publishing, self-modification and
  out-of-scope writes; deny rules installed as a second layer; `checkShell` applied to `team.json`
  commands by the CLI.
- Stack detection from `playbooks/stacks.json` for many ecosystems and monorepos; learned technology
  playbooks and fingerprints in the vault, merged over the engine's by `hades detect`.
- Vendored, pinned tools as git submodules with a 14-day release cooldown: Serena, Playwright MCP,
  REA, Gitleaks, Semgrep CE, Trivy, ZAP, ccusage, AWS Agent Toolkit, MCP Proxy for AWS.
- AWS support: official AWS skills read by path, AWS MCP server through `mcp-proxy-for-aws` with a
  least-privilege profile; `hades doctor` fails on root credentials.
- Token and cost reports per task (`hades usage --task`), headless runs (`hades run`).
- Documentation: getting started, architecture, CLI, file formats, autonomy and safety, token
  economy, tools, migration.

### Changed (from v1)
- v1 roles mapped to the v2 roster (security engineer -> cybersecurity engineer, senior QA -> QA
  engineer, senior AI/ML -> AI/ML/data engineer, full-stack and UI/UX -> backend and frontend
  engineers; new tech lead).
- Task records are folders with JSON state written only by the CLI.

### Removed
- v1 framework files in the vault (`company/roles`, `skills`, `workflow`, `templates`, `scripts`);
  `hades migrate` archives them to `archive/v1/`.
