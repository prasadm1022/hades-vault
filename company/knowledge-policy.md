# Knowledge policy

Every task leaves the company better informed. The learning loop runs at `close` (and on demand via
`/hades-learn`): the knowledge-curator files what the task taught. Procedure:
`playbooks/knowledge-capture.md`. Vault paths below: `<vault>` = the vault root.

Inputs: the roles' `LESSONS` and `DECISIONS` lines (README Lessons and Decisions sections), defects and their rounds, plan
deviations, gate failures, waivers, assumptions that proved wrong.

## What goes where (team folder unless noted)

| Knowledge | File | Rule |
|---|---|---|
| Digest every role reads first | `CONTEXT.md` | <= 120 lines; rewritten, not appended; each fact points to its detail file |
| Lesson | `knowledge/lessons.md` | `- YYYY-MM-DD <task-id>: <what happened> -> <what to do next time>`; the most reusable ones under *Standing lessons* (<= 15) |
| Decision | `knowledge/decisions.md` | ADR: `### ADR-NNN <title> (YYYY-MM-DD, <task-id>)` with Context, Decision, Consequences; superseded ADRs marked, never deleted |
| Facts | `knowledge/architecture.md`, `conventions.md`, `domain.md`, `glossary.md` | correct in place; never append a contradiction |
| Repo facts | `projects/<name>.md` | what it is, quirks, artefacts, deploy |
| Repeatable procedure | `skills/<kebab-name>/SKILL.md` | frontmatter `name`, `description`; numbered steps with exact commands; <= 80 lines |
| Role guidance for this team | `agents/<role>.md` *Project notes* | one line per note, imperative |
| Commands, environments | `team.json` (through the CLI) and the `TEAM.md` summary | `hades detect --write`; `hades team set <team> command|env ...` |
| Follow-ups, debt | `tasks/BACKLOG.md` | one row per item, with source task |
| Company-wide staff guidance | `<vault>/company/staff/<role>.md` *Company notes* | true for every organization |
| New technology | `<vault>/company/playbooks/tech/<tech>.md`; fingerprint in `<vault>/company/playbooks/stacks.json` | via `playbooks/learn-technology.md`: detection, commands, deploy, pitfalls, sources with versions and date; `hades detect` merges the vault fingerprints over the engine's |

## Promotion

- True for more than one team of an organization -> `<org_dir>/knowledge/` or `<org_dir>/skills/`;
  the team file keeps a one-line pointer.
- True for every organization -> `<vault>/company/` (`knowledge/`, `staff/`, `playbooks/`).
- Cross-team contract changes -> `ORG.md` *Cross-team contracts*.
- Generic and client-free (a technology playbook, a `stacks.json` fingerprint, a policy flaw) ->
  also listed under *Engine upstream candidates* in `<vault>/company/knowledge/lessons.md`. Contributing
  it to the engine is the owner's choice; HADES never edits the engine during a task.

## Rules

- Facts only, each traceable to a task, file or command. No secrets, personal or customer data, logs,
  pasted code (cite `path:line` instead).
- Knowledge files are living documents: fix wrong statements, merge duplicates, prune stale lessons.
- Keep files scannable: headings and bullets; open by section, never wholesale.
- Projects stay clean: knowledge never goes into a project repo. Human-facing project docs (README,
  API docs) are updated with the change itself (gate G8), not by the learning loop.
- Quality bar: a new PM reading `CONTEXT.md` and the files it points to could run the next task
  without rediscovering anything this task learned.
- The loop ends with the README *Learning* section listing every vault file changed.
