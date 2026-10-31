# Tasks - {{TEAM}}

One folder per task: `<id>-<slug>/`, `<id>` = `{{TEAM}}-NNN`, created by
`hades task new {{TEAM}} --title "..."`. HADES v1 single-file records (`<id>-<slug>.md`) stay as history.

| File | Writer | Contents |
|---|---|---|
| `README.md` | PM | request, decisions (incl. assumptions), lessons, plan, gates, defects, deploy, commits, usage, learning, outcome |
| `work-plan.draft.json` | tech lead (S: PM) | the work plan draft that `hades task plan --from` validates |
| `state.json`, `defects.json`, `work-plan.json`, `gates.json` | CLI only | stages, defects, work items, gate evidence |
| `01-business-solution.md` ... `09-security-report.md` | role agents | stage deliverables, each starting with `## Summary` |

Status: `hades task list {{TEAM}} --open`, `hades task show <id>`. Formats: the engine's `docs/file-formats.md`.
`BACKLOG.md`: follow-ups and debt that are not tasks yet.
