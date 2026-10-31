# Changelog

All notable changes to HADES. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added
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

## 2.0.0 - 2026-10-31

First open-source release. Breaking: the framework moved out of the vault into this engine;
migrate v1 vaults with `hades migrate` (`docs/migration-from-v1.md`).

### Added
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

### Changed
- v1 roles mapped to the v2 roster (security engineer -> cybersecurity engineer, senior QA -> QA
  engineer, senior AI/ML -> AI/ML/data engineer, full-stack and UI/UX -> backend and frontend
  engineers; new tech lead).
- Task records are folders with JSON state written only by the CLI.

### Removed
- v1 framework files in the vault (`company/roles`, `skills`, `workflow`, `templates`, `scripts`);
  `hades migrate` archives them to `archive/v1/`.
