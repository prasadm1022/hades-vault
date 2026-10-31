# Commit policy

## Who and when

- Only the PM commits. Roles leave changes in the working tree and list them in `OUTPUT` and their
  `05-impl-<role>.md`.
- **Release commit**: after QA passes (stage `release`). **Fix commits**: later, one per verified fix
  round (`fix(qa): ...` after a smoke run, `fix(security): ...`, `fix(deploy): ...`) and deploy
  configuration (`chore(deploy): ...`, committed before it is deployed: only committed HEAD ships).
  **Docs commit** (`docs(<scope>): ...`) when the release commit misses docs gate G8 requires.
  Never amend; every commit is new.
- Before every project commit: `hades gate <task> --preset precommit` ok. After: `hades task commit <task> --repo <path>`.

## Where

- Every git repository among the team's `team.json` `projects` that has task changes; each gets its
  own commit.
- The vault last (section Vault).

## Dirty tree

- At intake the PM records `git -C <repo> status --short` per repo and for the vault in README *Commits*.
- Tree clean at intake: stage the task's changes after reviewing `git status`.
- Tree dirty at intake: stage only task files by path (`git add -- <paths>`). Never `git add -A`,
  `git add .` or `git commit -a`. A file that was dirty before the task and also changed by it is
  not committed; it is listed in the report as mixed.
- Never stage secrets, `.env` files, build artefacts, logs, editor files, `CLAUDE.md`, `AGENTS.md`
  or `.claude/`. New artefact types go into `.gitignore`.
- Check: `git diff --cached --stat` matches the task's OUTPUT lists.
- Detached HEAD, or a merge, rebase or cherry-pick in progress: do not commit; record a blocker.

## Message

Follow the project's style (`git log --oneline -15`). Without one:

```
<type>(<scope>): <imperative summary, <= 72 chars>

<why, 1-5 lines; for security fixes the fix, not the exploit>

Task: <task-id>
Co-Authored-By: Claude <model> <noreply@anthropic.com>
```

`type`: feat, fix, refactor, perf, test, docs, chore, ci, security. `<model>` = the committing
session's model name. `Co-Authored-By:` is always added; `Task:` whenever a task exists.

## Branch strategy (`team.json` `branch_strategy`, set with `hades team set <team> branch-strategy <current-branch|feature-branch>`)

- `current-branch` (default): commit on the checked-out branch.
- `feature-branch`: before the release commit, `git switch -c hades/<task-id>-<slug>` (the working
  tree carries over); fix commits go to the same branch.
- Never switch to another existing branch, merge, delete branches or bypass hooks (`--no-verify`).
  A failing project hook is a red gate: the owning engineer fixes the cause.

## Never push

No `git push`, tag push or remote operation. The report gives, per repo:
`git -C <repo> log --oneline -<n>`, `git -C <repo> show --stat <hash>`, and the owner's
`git -C <repo> push` (plus the branch for `feature-branch`).

## Vault

Last, after `hades task close`, when the vault is a git repository: every vault file the task
changed - the task folder, `team.json` (changed by `hades team set` / `hades detect --write`), the
learning loop's files (curator OUTPUT), `registry.json` and organization or team scaffolding. Vault
clean at intake: `git -C <vault> add -A -- <team_dir> <org_dir> company registry.json`; dirty at
intake: `git -C <vault> add -A -- <paths>` for the changed paths under those, never the paths that
were dirty at intake (foreign changes stay uncommitted). Messages, with the same trailers (`Task:` only
for a task): `task(<task-id>): <title>` (task close), `learn(<team>): <line>` (`/hades-learn`),
`team(<team>): onboard ...` (`/hades-new-team`). Never push.
