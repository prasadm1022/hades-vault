# HADES

HADES is an autonomous software company for [Claude Code](https://code.claude.com). You state
business requirements; a Project Manager (your main Claude Code session) runs them through role
agents - business analyst, architect, tech lead, backend, frontend, AI/ML/data and QA engineers,
DevOps and cybersecurity - that analyse, design, plan, build, test, commit locally, deploy,
security-test, fix what they find, learn and report. Every stage passes on tool evidence (builds,
tests, scanners, health checks), not on an agent's word. HADES never pushes: you review the local
commits and push yourself.

## How it works

```
Owner ............ states requirements, reviews commits, pushes
Project Manager .. the main Claude Code session (/hades): orchestrates, commits, reports
Company staff .... business-analyst  software-architect  devops-engineer  cybersecurity-engineer
Each team ........ tech-lead  backend-engineer  frontend-engineer  aiml-data-engineer  qa-engineer
Helpers .......... scout (read-only lookups)  knowledge-curator (learning loop)

intake -> analysis -> design -> planning -> build -> qa <-> fix -> release (local commit)
       -> deploy || security <-> fix -> redeploy -> close (learn, usage, report)
```

| Stage | Owner | Evidence |
|---|---|---|
| analysis | business-analyst | acceptance criteria `AC-n` |
| design | software-architect, frontend-engineer (UX), aiml-data-engineer (model plan) | AC -> component map, contracts, deploy strategy |
| planning | tech-lead | work plan validated by `hades task plan` (every AC covered, no same-wave file overlap) |
| build | engineers in parallel waves | `hades gate --preset build`; integration review (M, L) |
| qa | qa-engineer | every AC has a passing test case; no critical/high defect open |
| release | PM | `hades gate --preset precommit` (build, test, secrets), local commit |
| deploy | devops-engineer | test environment first; health check, rollback recorded |
| security | cybersecurity-engineer | gitleaks, semgrep, trivy, manual review, ZAP; no critical/high open |
| close | PM, knowledge-curator | knowledge filed in the vault, token usage recorded, final report |

Code lives in your project repositories; everything HADES knows lives in a private **vault**
repository (registry, teams, knowledge, task records). The engine (this repository) holds no client
data. Details: [`docs/architecture.md`](docs/architecture.md).

## Why it is cheap and accurate

- Native subagents with short, static role prompts; a role with no work in a task is never spawned.
- File handoffs: a spawn prompt is at most 15 lines of paths, a return at most 8 lines; every stage
  file starts with a 10-line `## Summary` that downstream roles read instead of the whole file.
- `hades gate` reduces build, test and scanner output to one line per step plus the first failure;
  full logs stay on disk.
- Symbol-level code navigation (Serena) instead of whole-file reads; read-only lookups on the
  cheapest model (scout).
- Model routing: strong models for analysis, architecture, planning and security; fast models for
  implementation, with automatic escalation on repeated failures.
- Deterministic work (stack detection, plan validation, coverage, gates, guards) runs in code and
  costs no model tokens.
- Accuracy from independence: QA does not trust engineers, security does not trust QA, and the CLI
  refuses to pass a stage with open critical/high defects.
- `hades usage` records tokens and cost per task. More: [`docs/token-economy.md`](docs/token-economy.md).

## Safety model

- Agents run without permission prompts (`permissionMode: bypassPermissions`). The boundary is
  deterministic: a PreToolUse guard hook ([`hooks/`](hooks/README.md), matcher
  `Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*`) and
  `permissions.deny` rules, which apply in every permission mode and inside subagents. A guarded
  install allow-lists routine `hades` and `git` commands only; `hades run`, `install`, `migrate`,
  `tools` and `mcp` still prompt.
- Blocked: every `git push` form, history rewrites, destructive git, mass deletes of protected
  paths, secret-file reads and environment dumps, download-and-execute, package publishing, edits to
  the guard, settings and installed agents, writes outside each role's scope.
- Deploys prefer a test environment; a live deploy needs a green pre-deploy security gate, a
  rollback command and a health check. Active security scans are refused against live URLs. Reverse
  engineering only on artefacts you built or are licensed to analyse.
- Secrets by environment-variable or profile name only. `hades doctor` fails on AWS root
  credentials; use a least-privilege profile.
- **Limits.** The guard is a parser of shell text, not a sandbox: obfuscated commands, compiled
  programs, build scripts and MCP tools other than Serena's are outside it, and network egress is
  not restricted. **Native Windows has no Claude Code sandbox**; for stronger isolation run HADES in
  WSL2, a VM or a dev container. On its own internal errors the guard blocks calls that mention a
  high-risk keyword (`push`, `rm`, `config`, `.env`, ...) and lets other calls through with a
  warning; input too complex to verify is blocked (`guard.limit`); a hook that cannot start blocks
  only where Claude Code honours `onFailure: block`. Read the diff before you push. Details:
  [`docs/autonomy-and-safety.md`](docs/autonomy-and-safety.md), [`SECURITY.md`](SECURITY.md).

## Quick start

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades.git
cd hades
node bin/hades.mjs init --vault ../my-vault --workspace ..   # config + private vault scaffold
node bin/hades.mjs tools setup                               # pinned scanners and MCP servers
node bin/hades.mjs install                                   # agents, skills, guard hook, deny/allow rules
node bin/hades.mjs doctor                                    # fix every FAIL it prints
```

Then start Claude Code in your workspace (the folder given to `--workspace`, here the clone's
parent) and type, for an existing project at `<workspace>/acme/portal`:

```
/hades-new-team portal acme/portal --org acme   # onboard it (once); an absolute path works too
/hades portal Customers can reset their password by email
```

The path must exist: `/hades-new-team` stops on a missing folder (new products go through `/hades`).
The interactive `/hades` keeps Claude Code's normal permission prompts for the PM's file edits and
most commands (only the safe `hades` and `git` commands are pre-allowed). For a run with no prompts
use headless mode, `node bin/hades.mjs run "Customers can reset their password by email" --team portal`,
or install with `--autonomy full` ([`docs/autonomy-and-safety.md`](docs/autonomy-and-safety.md)).
The final report lists the local commits with review and push commands, deploy result, gate
evidence, open defects, assumptions and token usage. Step by step:
[`docs/getting-started.md`](docs/getting-started.md).

## Requirements

| Requirement | Why |
|---|---|
| Node.js 22 or newer | CLI and guard hook (zero npm dependencies) |
| git | everything; submodules for the vendored tools |
| Claude Code (recent; `hades doctor` checks the version) | the runtime |
| [uv](https://docs.astral.sh/uv/) | Serena, Semgrep and the AWS MCP proxy (Python 3.12 is fetched by uv) |
| Docker (optional) | ZAP DAST scans; fallback for some scanners |
| AWS CLI v2 (optional) | AWS deploys and the `hades doctor` profile check |

Windows (PowerShell or Git Bash), macOS and Linux.

## Project layout

```
HADES.md        operating protocol          docs/        architecture, CLI, formats, guides
agents/         role agents (hades-<role>)  skills/      /hades, /hades-new-team, /hades-learn, /hades-status
company/        binding policies            playbooks/   procedures read on demand, stacks.json
bin/, lib/      the hades CLI               hooks/       guard hook and policy
templates/      vault, org, team, task      tools/       vendored tools (git submodules, pinned)
tests/          node:test suites
```

## Vendored tools

Third-party tools are git submodules under `tools/`, pinned in `tools/tools.lock.json` (newest
release at least 14 days old), and run as separate programs. Policy: [`docs/tools.md`](docs/tools.md);
details: [`tools/README.md`](tools/README.md); licenses: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

| Tool | Used for | License |
|---|---|---|
| [Serena](https://github.com/oraios/serena) | symbol-level code navigation (MCP) | GPL-3.0-or-later (app), MIT (SolidLSP) |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | browser automation for QA and frontend | Apache-2.0 |
| [REA](https://github.com/morluto/rea) | reverse engineering of built artefacts (MCP) | MIT |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | secret scanning | MIT |
| [Semgrep CE](https://github.com/semgrep/semgrep) | static analysis | LGPL-2.1 |
| [Trivy](https://github.com/aquasecurity/trivy) | dependencies, IaC, containers, SBOM | Apache-2.0 |
| [ZAP](https://github.com/zaproxy/zaproxy) | dynamic testing (Docker image) | Apache-2.0 |
| [ccusage](https://github.com/ryoppippi/ccusage) | token and cost reports | MIT |
| [AWS Agent Toolkit](https://github.com/aws/agent-toolkit-for-aws) | official AWS skills and rules, read by path | Apache-2.0 |
| [MCP Proxy for AWS](https://github.com/aws/mcp-proxy-for-aws) | AWS MCP server with a named profile | Apache-2.0 |

## Documentation

[Getting started](docs/getting-started.md) - [Architecture](docs/architecture.md) -
[CLI](docs/cli.md) - [File formats](docs/file-formats.md) -
[Autonomy and safety](docs/autonomy-and-safety.md) - [Token economy](docs/token-economy.md) -
[Tools](docs/tools.md) - [Migration from v1](docs/migration-from-v1.md) - [Changelog](CHANGELOG.md)

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Report
vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) covers the HADES source in this repository only. The third-party tools under
`tools/` are git submodules that keep their own licenses (MIT, Apache-2.0, LGPL-2.1,
GPL-3.0-or-later, with NOTICE and legal-notice files to keep); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
