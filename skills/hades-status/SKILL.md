---
name: hades-status
description: Show HADES organizations, teams, open tasks with their stage and open defects. Read-only.
argument-hint: "[team-or-org | task-id]"
---

# /hades-status

Read-only: change nothing.
- `$ARGUMENTS` is a task ID (`<team>-NNN`) -> `node {{HADES_HOME}}/bin/hades.mjs task show $ARGUMENTS`.
- Otherwise -> `node {{HADES_HOME}}/bin/hades.mjs status $ARGUMENTS`.

Present the output as one compact table (team, task, stage, open defects); add nothing it does not
say. On a non-zero exit, show the error line and suggest `node {{HADES_HOME}}/bin/hades.mjs doctor`.
