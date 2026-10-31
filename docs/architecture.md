# HADES architecture (v2)

HADES is an autonomous software company that runs inside Claude Code. The owner gives business
requirements; the company analyses them, designs a solution, plans and builds it, tests it, commits
locally, deploys it, security-tests it, fixes what it finds, learns and reports. Claude is the brain;
HADES is the organisation, process, tools, guards and memory around it.

Design goals, in priority order:

1. **Accuracy** - every claim is backed by evidence produced by a tool (gate results, test output,
   scanner reports), not by an agent's say-so. Independent roles check each other (QA does not trust
   engineers, security does not trust QA).
2. **Token economy** - the cheapest path that keeps accuracy (`token-economy.md`).
3. **Autonomy** - after the owner states the requirements, no human input is needed. Ambiguity is
   resolved by recorded assumptions, never by blocking questions.
4. **Safety** - autonomy is bounded by deterministic guards (hooks, deny rules), not by prompts: no
   pushes, no destructive git, no secret reads, scoped deploys, legal policy for reverse engineering
   (`autonomy-and-safety.md`).
5. **Any technology** - stacks are detected, commands are learned once and stored, unknown
   technologies are researched and turned into vault playbooks by the learning loop.

## 1. Two repositories

| Repository | Visibility | Contents |
|---|---|---|
| **engine** (`hades/`, this repo) | open source (MIT) | agents, skills, company policies, playbooks, CLI, hooks, templates, vendored tools (submodules), docs |
| **vault** (e.g. `my-vault/`) | private | the owner's company data: `registry.json`, organizations, teams, knowledge, learned playbooks, task records |

The engine never contains client data. The vault never contains engine code. `hades.config.json`
(git-ignored, written by `hades init`) connects them:

```json
{ "vault": "C:/Users/me/git/my-vault", "workspace": "C:/Users/me/git", "aws": { "profile": "hades-deploy", "region": "eu-west-1" } }
```

`HADES_VAULT` and `HADES_WORKSPACE` override the file. Without either, the vault defaults to
`<engine>/vault/` (git-ignored). Schema: `file-formats.md`.

## 2. Organisation chart

```
                     Owner (gives requirements, reviews, pushes)
                                      |
             Project Manager (the main Claude Code session; orchestrates, commits)
                                      |
   +------------- company staff (one of each, shared by every team) -------------+
   |  business-analyst   software-architect   devops-engineer   cybersecurity-engineer |
   +----------------------------------------------------------------------------------+
                                      |
   +------------------------- each project team (main | sub) ----------------------+
   |  project-manager (notes)  tech-lead  backend-engineer  frontend-engineer         |
   |  aiml-data-engineer       qa-engineer                                            |
   +----------------------------------------------------------------------------------+
   helpers: scout (read-only lookups), knowledge-curator (learning loop)
```

- **Company staff** are single agents that serve every organization and team. What they learn about a
  team is kept in that team's `agents/<role>.md`; what holds company-wide in the vault's
  `company/staff/<role>.md`.
- **Team roles** exist in every team. A role with no work in a task is not spawned, so a full roster
  costs nothing.
- The **Project Manager** is the main session. Claude Code subagents cannot spawn subagents, so
  orchestration lives in the main session (`skills/hades/SKILL.md`). The PM never reads or writes
  product code; it reads stage summaries and CLI output, spawns roles, commits and reports.

| Role | Agent (`agents/`) | Model | Writes |
|---|---|---|---|
| Business analyst | `hades-business-analyst` | opus | `01-business-solution.md` |
| Software architect | `hades-software-architect` | opus | `02-technical-solution.md` |
| Tech lead | `hades-tech-lead` | opus | greenfield skeleton, `03-work-plan.md`, `work-plan.draft.json`, integration review, glue defects (fix mode) |
| Backend engineer (DB + backend) | `hades-backend-engineer` | sonnet | code, migrations, tests, `05-impl-backend.md` |
| UI/UX + frontend engineer | `hades-frontend-engineer` | fable | `04-ux-design.md`, code, tests, `05-impl-frontend.md` |
| AI/ML/data engineer | `hades-aiml-data-engineer` | sonnet | `04-model-plan.md` (L), code, pipelines, evals, `05-impl-aiml-data.md` |
| QA engineer (manual + automation) | `hades-qa-engineer` | sonnet | `06-test-plan.md`, automated tests, `07-qa-report.md`, defects |
| DevOps engineer | `hades-devops-engineer` | sonnet | CI, deploy config, IaC, `08-deployment.md` |
| Cybersecurity engineer | `hades-cybersecurity-engineer` | opus | `09-security-report.md`, defects |
| Scout (helper) | `hades-scout` | haiku | nothing: returns up to 40 `key: value` facts with `path:line` |
| Knowledge curator (helper) | `hades-knowledge-curator` | sonnet | vault knowledge, skills, role notes, `CONTEXT.md`, learned playbooks |

Defaults: `company/model-routing.md` and each agent's frontmatter. The PM escalates a spawn to a
stronger model (never a silent downgrade): a second fix round on the same defect, a gate still red
after one fix, auth/money/tenancy/data-deletion work, the critical path of an L task.

## 3. The pipeline

```
intake -> analysis -> design -> planning -> build -> qa <-> fix -> release (commit)
       -> deploy  ||  security (source level)  ->  security (DAST, after deploy) <-> fix
       -> QA verify -> fix commit -> redeploy -> re-verify -> close
```

| # | Stage | Owner | Output | Exit evidence |
|---|---|---|---|---|
| 0 | intake | PM | task folder, `README.md`, size | `hades task show` |
| 1 | analysis | business-analyst | `01` with `AC-n` (Given/When/Then) | `hades task coverage` lists every AC |
| 2 | design | software-architect; frontend-engineer (UX); aiml-data-engineer (model plan, L with AI/ML/data scope) | `02`, `04-ux-design.md`, `04-model-plan.md` | every AC in the `02` map; `04-*` before dependent work |
| 3 | planning | tech-lead (S: PM) | greenfield skeleton, `03`, `work-plan.json` | `hades task plan` exit 0 (every AC has a W) |
| 4 | build | engineers in waves; QA writes `06` in parallel; tech-lead integration review (M, L) | code, tests, `05-impl-<role>.md`, `06` | `hades gate --preset build` ok; review findings closed |
| 5 | qa | qa-engineer | `07`, defects | `hades task coverage` no gap before start; no critical/high QA defect open |
| 6 | release | PM | local commit(s) | `hades gate --preset precommit` ok; `hades task commit` |
| 7 | deploy | devops-engineer | `08`, CI and deploy config (greenfield) | health check green, or `none`/`pending-push` recorded |
| 8 | security | cybersecurity-engineer | `09`, defects | `--preset security` ok; DAST per policy; no critical/high open |
| 9 | close | PM + knowledge-curator | knowledge updates, usage, vault commit, report | README *Learning*, `hades task close` |

Stage CLI names: `intake analysis design planning build qa release deploy security close`. Source-level
security needs only the release commit, so it may start while deploy runs; DAST waits for the
deploy. Detail per stage and size: `company/pipeline.md`; gates G1-G9: `company/quality-gates.md`.

- **Coverage**: AC -> work item is checked at planning (`hades task plan`); AC -> test case
  before `qa` starts (`hades task coverage`).
- **Integration review** (M and L): after the last build wave the tech lead reviews the integrated
  change against `02` and the plan; findings are defects with `--source review`.
- **Model plan** (L with AI/ML/data scope): the aiml-data-engineer writes `04-model-plan.md` (models,
  prompts, data contracts, eval set and metrics) in design, after the architect, before planning.
- **Greenfield**: `hades team new` creates the project folder; in its planning spawn the tech lead
  scaffolds the repository (`git init -b main`, skeleton per `02`, one passing test) before writing
  the plan; DevOps adds CI and the deploy configuration in the deploy stage.
- **Defect loop**: sources `qa`, `security`, `review`, `deploy`. The owning engineer fixes, QA
  verifies; security defects are also redeployed and re-verified. At most 3 rounds per defect, then
  `blocked`; the task continues with what is safe and the report says so.
- **Deploy and security testing**: test environment when configured and reachable, else live with
  preconditions; active scans only against test (`company/deployment-policy.md`,
  `company/security-policy.md`).

## 4. Sizes

| Size | Examples | Depth |
|---|---|---|
| S | copy change, config tweak, obvious one-file bug | short BA and architect notes; PM plans one work item; targeted QA; security = scans + diff review |
| M | feature inside existing patterns, logic bug, new endpoint + screen | every stage at normal depth; integration review |
| L | new product or feature area, schema/API change, auth/money/tenancy/data retention, new AI behaviour | full depth: UX design, model/eval plan, integration review, active DAST on test |

When unsure, pick the larger size. A later role may raise the size, never lower it.

## 5. Install model

`hades install` renders the engine's agents and skills (`{{HADES_HOME}}`, `{{HADES_VAULT}}`) into the
Claude Code **user** directory (`~/.claude/agents/hades/`, `~/.claude/skills/<name>/`) or a
workspace's `.claude/`, and registers the guard hook and deny rules in `settings.json`. HADES is not
shipped as a Claude Code plugin because plugin agents ignore `mcpServers`, `hooks` and
`permissionMode` in their frontmatter, and HADES needs all three.

- **Per-agent MCP servers**: each agent declares only the servers its role needs (`agents/README.md`),
  launched through `<node> <engine>/bin/hades.mjs mcp <name>` (`<node>` = the absolute Node binary
  that ran `hades install`, as for the guard hook). Tool catalogs load only in those roles;
  the main session and the analyst load none.
- **Playbooks are not installed.** `playbooks/` (and `company/`) are read by path on demand, with the
  placeholders `<engine>` and `<vault>` defined at the top of each playbook. Only `agents/` and
  `skills/` use the rendered `{{HADES_HOME}}`/`{{HADES_VAULT}}`.
- **Other coding agents**: `hades export <target>` renders the same skills, agents, MCP servers and
  guard into another agent's formats (Codex, Cursor, Gemini CLI, GitHub Copilot, Devin, Cline,
  OpenCode, any AGENTS.md tool), only where that platform documents one (`other-agents.md`). Claude
  Code stays the reference platform: per-agent models, per-agent MCP and role write scopes exist only there.
- **AWS**: the DevOps engineer reads the official AWS Agent Toolkit (`tools/aws-agent-toolkit`) skills
  and rules by path through `playbooks/aws.md` (nothing from it is installed or run) and talks to the
  managed AWS MCP server through `mcp-proxy-for-aws` (`hades mcp aws`), signed with the configured
  least-privilege profile.

## 6. Files

```
engine/
  HADES.md                operating protocol (read by the PM at dispatch)
  agents/                 subagent definitions, installed as hades-<role>
  skills/                 /hades, /hades-new-team, /hades-learn, /hades-status
  company/                pipeline, quality gates, handover, model routing, deployment, security,
                          commit and knowledge policies
  playbooks/              read on demand by path, never installed: aws.md, code-navigation.md,
                          deployment.md, knowledge-capture.md, learn-technology.md, qa-automation.md,
                          reverse-engineering.md, security-testing.md, ui-ux-design.md,
                          tech/<ecosystem>.md; stacks.json = fingerprints -> commands (hades detect)
  templates/              vault/, organization/, team/, task/ scaffolds, project.md
  hooks/                  guard.mjs (PreToolUse safety boundary) + guard-policy.json
  bin/hades.mjs, lib/     zero-dependency Node CLI
  tools/                  vendored third-party tools (git submodules, read-only) + tools.lock.json
  docs/                   architecture, cli, file formats, getting started, autonomy and safety,
                          token economy, tools, migration
  tests/                  node:test suites (no network, Docker or submodules needed)
  .hades/, .tools-bin/    runtime state, logs, installed tools (git-ignored)

vault/
  registry.json           organizations, teams, aliases, project paths (schema version 3)
  company/                staff/<role>.md, knowledge/, playbooks/tech/<tech>.md, playbooks/stacks.json
  organizations/<org>/    ORG.md, knowledge/, skills/, teams/<team>/
    teams/<team>/
      TEAM.md             charter: projects, stack, commands, environments, roster
      team.json           machine-readable commands and environments (hades team set)
      CONTEXT.md          <= 120-line digest every role reads first
      agents/<role>.md    team notes per role
      knowledge/          architecture, conventions, domain, decisions, lessons, glossary
      skills/             team-learned skills
      projects/           one file per repository or component
      tasks/<id>-<slug>/  README.md, state.json, defects.json, work plan, gates, stage files
```
