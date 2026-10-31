# Agents

Native Claude Code subagent definitions: the system prompts of the HADES company. `hades install`
renders `{{HADES_HOME}}` (engine path) and `{{HADES_VAULT}}` (vault path) and installs each file as
`hades-<role>`. The Project Manager is not an agent here: it is the main session, driven by the
`/hades` skill, and it spawns these agents with the handover prompt from `company/handover.md`.

| Agent | Role | Model | Effort | MCP servers | Writes |
|---|---|---|---|---|---|
| `hades-business-analyst` | Business analyst (staff) | opus | high | - | `01-business-solution.md` |
| `hades-software-architect` | Software architect (staff) | opus | high | serena, rea | `02-technical-solution.md` |
| `hades-devops-engineer` | DevOps engineer (staff) | sonnet | medium | aws | deploy config, CI, IaC, environments (`hades team set`), `08-deployment.md`, deploy defects |
| `hades-cybersecurity-engineer` | Cybersecurity engineer (staff) | opus | high | serena, rea, playwright | `09-security-report.md` (DAST on the deployed URL or the locally run app), security defects |
| `hades-tech-lead` | Tech lead | opus | high | serena | greenfield skeleton, `03-work-plan.md`, work plan (via `hades task plan`), integration review, review defects, glue and the glue defects it owns (fix mode) |
| `hades-backend-engineer` | Backend engineer (database + backend) | sonnet | medium | serena | code, migrations, seed, tests, `05-impl-backend.md` |
| `hades-frontend-engineer` | UI/UX + frontend engineer | fable | medium | serena, playwright | `04-ux-design.md`, code, tests, `05-impl-frontend.md` |
| `hades-aiml-data-engineer` | AI/ML/data engineer | sonnet | medium | serena | `04-model-plan.md` (L), code, pipelines, evals, `05-impl-aiml-data.md` |
| `hades-qa-engineer` | QA engineer (manual + automation) | sonnet | medium | serena, playwright | `06-test-plan.md` (smoke TCs marked), automated tests, `07-qa-report.md` (incl. L smoke rounds), QA defects |
| `hades-scout` | Read-only lookups (helper) | haiku | low | serena | nothing |
| `hades-knowledge-curator` | Learning loop (helper) | sonnet | medium | - | vault knowledge, skills, role notes, learned playbooks, `CONTEXT.md`; v1 migration pass (`/hades-learn <team> --migrate`) |

Common frontmatter: `permissionMode: bypassPermissions`, `omitClaudeMd: true`, `disallowedTools`
always includes `Agent` and `AskUserQuestion` (no nested spawns, no questions). Read-only roles
(architect, security, scout) also lose serena's edit tools; every serena user loses
`execute_shell_command`, `serena_repl` and memory writes; playwright users lose
`browser_run_code_unsafe`; REA users lose the debugger-console, instrumentation and device tools.
MCP servers are inline and launched through the CLI: `node {{HADES_HOME}}/bin/hades.mjs mcp <name>`,
with `command: "{{NODE}}"` (`hades install` renders the absolute Node binary that ran it). Serena
starts without a project: each serena user calls `activate_project` with the absolute `<Project>`
path before the first symbol tool.
`tests/prompts.test.mjs` checks frontmatter, body budgets (<= 110 lines), paths, CLI calls and tool names.

Every agent reads `<Team folder>/CONTEXT.md` and its role notes first, opens playbooks
(`{{HADES_HOME}}/playbooks/`) by path only when needed, and ends with the 8-line return contract
(exceptions: the scout returns up to 40 `key: value` facts; the curator's OUTPUT lists absolute
vault paths). Model defaults follow `company/model-routing.md`; the PM escalates per spawn, never downgrades.
