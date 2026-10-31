# HADES vault

Private company data for HADES: organizations, teams, knowledge, task records and security
findings. Keep it private. HADES commits it locally and never pushes; if you back it up to a
remote, make that remote private. By default the vault is `<engine>/.vault`: the engine repository
git-ignores it and it is its own git repository. To back it up, commit first, then add the remote:
`git -C <vault> add -A && git -C <vault> commit -m "Initial vault"`, then
`git -C <vault> remote add origin <private-url>` and `git -C <vault> push -u origin HEAD`.

Engine: `{{ENGINE}}` (policies in `company/`, formats in `docs/file-formats.md`).

| Path | Contents |
|---|---|
| `registry.json` | organizations, teams, aliases, project paths (written by the CLI) |
| `company/` | company-wide staff notes, lessons, learned technology playbooks |
| `organizations/<org>/` | `ORG.md`, `knowledge/`, `skills/`, `teams/<team>/` |
| `organizations/<org>/teams/<team>/` | `TEAM.md`, `CONTEXT.md`, `team.json`, `agents/`, `knowledge/`, `skills/`, `projects/`, `tasks/` |

Use: `/hades <team> <task>`, `/hades-new-team`, `/hades-learn`, `/hades-status` in Claude Code;
`node {{ENGINE}}/bin/hades.mjs status` from a shell.
