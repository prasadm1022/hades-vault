# Team {{TEAM}} ({{TEAM_TYPE}} team, organization {{ORG}})

{{DESCRIPTION}}

| Field | Value |
|---|---|
| team | `{{TEAM}}` |
| aliases | {{ALIASES}} |
| organization | `{{ORG}}` (`{{VAULT}}/{{ORG_DIR}}`) |
| project_path | `{{PROJECT_PATH}}` |
| created | {{DATE}} |

Commands, environments, branch strategy and scan settings: `team.json` (changed only through the
CLI: `hades team set {{TEAM}} ...`, `hades detect --write`). Every role reads `CONTEXT.md` first.

## Projects
<!-- one row per repository/component; details in projects/<name>.md -->
| Path (relative to project_path) | What it is | Notes |
|---|---|---|
| . | | |

## Stack
<!-- languages, frameworks, databases, hosting; bullets -->

## Environments
<!-- summary only; commands live in team.json -->
| Env | URL | Mechanism | Status |
|---|---|---|---|
| test | | | not configured |
| live | | | not configured |

## Required reading
- `{{VAULT}}/{{ORG_DIR}}/ORG.md`; organization `knowledge/` on demand.
- `CONTEXT.md`, then `knowledge/`, `projects/`, `skills/` on demand.

## Sizing hints
- Auth, payments, tenancy, data deletion, schema migrations, new AI behaviour: L.

## Roster
Team roles (agents `hades-<role>`, team notes in `agents/<role>.md`):

| Role | Covers |
|---|---|
| project-manager | the main session; notes only |
| tech-lead | work plan, waves, integration review |
| backend-engineer | database + backend |
| frontend-engineer | UI/UX design + frontend |
| aiml-data-engineer | models, prompts, evals, data pipelines |
| qa-engineer | test plan, manual + automated tests, QA report |

Company staff serving this team (team notes in `agents/<role>.md`, company notes in
`{{VAULT}}/company/staff/<role>.md`): business-analyst, software-architect, devops-engineer,
cybersecurity-engineer.
