# HADES guard

`guard.mjs` is a Claude Code **PreToolUse hook**: the deterministic safety boundary for HADES. HADES runs
role agents with `permissionMode: bypassPermissions`, and native Windows has no sandbox, so this hook is
what enforces the hard rules. Hooks run in every permission mode and inside subagents. The hook costs
no model tokens.

- Input: hook JSON on stdin (`tool_name`, `tool_input`, `cwd`, `agent_type` inside subagents).
- Block: exit 2 and one stderr line, `HADES guard: <rule id>: <reason>. <what to do instead>`. Claude
  sees the line and adapts.
- Allow: exit 0, no output.
- Zero dependencies, Node >= 22, ESM. Typical cost is a few ms on top of Node start-up (about 50 ms).

## Install

`hades install` writes this into the Claude Code settings (user or project scope):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*",
        "hooks": [{ "type": "command", "command": "\"<node>\" \"<engine>/hooks/guard.mjs\"", "timeout": 10, "onFailure": "block" }]
      }
    ]
  }
}
```

- `<node>` is the absolute path of the Node binary that ran `hades install` (`process.execPath`), quoted:
  a desktop app or IDE whose `PATH` has no `node`, or an old one, would otherwise make every guard
  call fail, and a hook that cannot start does not block. Re-run `hades install` after moving or
  removing that Node (for example `nvm uninstall`); `hades doctor` checks the registration, the matcher
  and that this Node exists and is Node 22 or newer. The agents' MCP servers run with the same Node
  (`command: "{{NODE}}"` in `agents/`, rendered by `hades install`).
- `"onFailure": "block"` asks newer Claude Code versions to block a call when the hook itself fails
  to run; older versions ignore the key.
- `Grep` is matched so greps (`path`, `glob`) cannot read through secret files.
- `mcp__serena__.*` is matched because Serena's editing tools (`replace_content`, `replace_in_files`,
  `create_text_file`, `replace_symbol_body`, `insert_*`, `rename_symbol`, `delete_lines`, ...) write
  files like `Edit` does, and its readers (`read_file`, `search_for_pattern`, ...) read like `Read`.

Permission rules (they matter only in default/auto modes; `bypassPermissions` ignores allow rules):
the deny list (`git push`, `git reset --hard`, `rm -rf /`, ...) and allow rules for routine steps
only: `node <engine>/bin/hades.mjs task|defect|gate|team resolve|team set|team list|detect|status|usage|doctor ...`
and `git [-C <repo>] add|commit|status|diff|log|rev-parse ...`. `hades run` (which starts a
`bypassPermissions` session), `install`, `migrate`, `tools` and `mcp` are not allow-listed, so a
guarded session asks before running them. An engine path with spaces is quoted in the rules exactly as
in the agents' CLI line (`node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs" task ...`).

## Other coding agents (`--format <platform>`)

`hades export <target>` registers the same guard in other agents' pre-tool hooks as
`<node> <engine>/hooks/guard.mjs --format <platform>` (`codex`, `cursor`, `gemini`, `copilot`,
`windsurf`, `cline`, `opencode`). `adaptInput()` maps the platform's documented payload to the inputs
`evaluate()` reads (shell commands, every file of a patch, file reads and writes, Serena MCP calls);
`adapterOutput()` answers in the platform's contract (exit 2, or its deny JSON). A shell whose Windows
dialect the platform does not document is checked as Bash and as PowerShell. An unknown `--format`
blocks every call (`guard.config`). The files the export writes (instruction files, hook and MCP
configuration, HADES agents, skills and commands of every platform) are self-protected like the
Claude settings. Role write scopes need the caller's agent name, which only Claude Code sends: they
are not enforced on other platforms. Contracts, coverage and gaps per platform:
[`docs/other-agents.md`](../docs/other-agents.md#the-guard-on-other-platforms). Tests:
`tests/hooks/guard-adapters.test.mjs`.

## What it enforces

Rule ids are prefixes (`git.*`, `fs.*`, ...). Data-driven rules live in `guard-policy.json`.

| Area | Rule ids | Blocks | Still allowed |
|---|---|---|---|
| a) git | `git.push` `git.rewrite` `git.discard` `git.force` `git.vault` `git.config` `git.dynamic` `git.internals` | every push form (incl. `--dry-run`, `git -C x push`, `hub push`, `gh-pages`, dashed `git-push` binaries); rebase, `commit --amend`, filter-branch/-repo, update-ref, reset to a commit (`HEAD~1`, `main~2`, `HEAD@{1}`, `@{u}`, short hashes, `origin/main`); `reset --hard`, `clean -f`, `checkout -- .`, `restore .`, `restore --staged --worktree .`, `read-tree -u`, `checkout-index -f`, `stash drop/clear`, `stash -a` / `stash push --all` (moves ignored files such as the vault out of the working tree), reflog expire, `gc --prune`; `branch -D`, `-f`; `add -f` / `stage -f`, `update-index --add\|--cacheinfo\|--index-info` (staging that bypasses `.gitignore`); `git.vault`: `add`/`stage`/`update-index`/`commit` with a pathspec inside the vault (or a default vault location, `<engine>/.vault`, `<engine>/vault`) from any repository other than the vault's own; abbreviated long options (`--har`, `--amen`, `--forc`) count as the full ones; global/system config; aliases, `include.path`, `includeIf`, `core.hooksPath` in any case and through `-c`, `--config-env[=]`, `git config` or `GIT_CONFIG_*` set in any syntax (`export`, `$env:`, `Set-Item`, prefix); command-valued keys and variables (`core.fsmonitor`, `core.pager`, `GIT_SSH_COMMAND`, ...) are scanned as commands; **any subcommand that is not a git builtin** (an alias, a `git-<name>` program) or is computed at run time, and git fed by `xargs` except read/add/commit; Write/Edit and shell writes inside `.git/` (hooks, config); writes to `~/.gitconfig`, `~/.config/git/` | status, diff, log, add, commit, branch -d, stash push, `restore --staged .`, targeted `checkout -- file`, `git lfs` (approved extension), `xargs git add` |
| a) hosting | `git.hosting` | `gh pr create/merge/...`, `gh release ...`, `gh repo create/delete/edit/...`, `gh gist create`, `gh api` writes, `glab ... create/merge/...`; `gh workflow run` except devops | `gh pr view`, `gh api` reads |
| b) filesystem | `fs.delete` `fs.git` `fs.device` | delete, move or recursive chmod/chown of: filesystem roots, system dirs, home (and `~/.ssh`, `~/.aws`, ...), the workspace, vault (and its `organizations/` and `company/` folders; also `<engine>/.vault` and a legacy `<engine>/vault` whatever the config says, so a stale config after an engine rename does not unprotect them), engine, any registered project or organization root, any ancestor of those (Windows 8.3 short names such as `VAULT~1` or `HADES-~1` are expanded first; a wildcard inside a short-name segment is refused), any `.git` (except `*.lock`); brace alternatives (`{vault,x}`, `.{git,x}`) and globs (expanded against the filesystem, every match checked; an invalid glob such as `[!z-a]` is refused); `find -delete` / `gci \| Remove-Item` whose filter matches everything (`-name '*'`, `-Filter *`, `-mtime -99999`, negations); targets that collapse to nothing (`rm -rf "$UNSET/"`); `rm` fed by `find`/`gci` pipes; deletes in inline code (`shutil.rmtree(r'C:\...')`, `rmSync(String.raw ...)`); writes to raw disks | deleting inside a project (`node_modules`, `dist`, `*.log`, `find -name '*.pyc' -delete`), temp dirs |
| b) system | `sys.disk` `sys.power` `sys.settings` `sys.forkbomb` `cloud.destroy` | format, diskpart, mkfs, `dd of=/dev/...`, Format-Volume; shutdown/reboot; Defender/firewall/registry (HKLM)/scheduled tasks/cron/`setx`/accounts; `terraform\|cdk\|pulumi destroy`, `aws s3 rb`, `aws s3 rm --recursive`, `aws cloudformation delete-stack`, RDS/DynamoDB/EKS/... deletes, `kubectl delete ns/pv/pvc` | deploys (`cdk deploy`, `aws s3 sync --delete`, `kubectl apply`, `helm upgrade`) |
| c) remote code | `rce.pipe` `rce.subst` `rce.download-exec` | downloader piped into a shell or interpreter (`curl \| sh`, `iwr \| iex`), `bash <(curl ...)`, `bash -c "$(curl ...)"`, variables holding downloads, running a file downloaded in the same command | `curl ... \| jq`, `curl \| python -m json.tool` |
| d) secrets | `secrets.file` `secrets.print` `secrets.env-dump` `secrets.env-print` | Read/Write/Edit/Grep and shell reads of `.env*` (not `.env.example\|sample\|template\|dist`), `*.pem\|key\|p12\|pfx\|jks\|keystore`, `id_*` keys (not `.pub`), `~/.ssh/*` (not `config`, `known_hosts`), cloud credential stores (`.aws/credentials`, SSO caches, gcloud, azure, docker, kube config), `.npmrc\|.pypirc\|.netrc`, `*credentials\|secrets\|password.{json,yaml,md,...}` outside the engine (also through braces, `$'..'`, globs that match a secret file, and PowerShell `'.e'+'nv'`); recursive readers whose search reaches a secret file their own filters do not exclude (`grep -r`, `rg --hidden\|-uu\|--no-ignore`, `rg -g .env`, `ack`, `findstr /s`, `git grep --no-index`, `gci -Recurse \| Select-String`, `find \| xargs cat`); `env`, `printenv`, bare `set`/`export -p`, `gci env:`; echoing secret-looking variables; `aws secretsmanager get-secret-value`, `aws configure export-credentials`, `ssm --with-decryption`, `kubectl get secret -o yaml`, printed tokens (`gh auth token`, `aws ecr get-login-password`) | `docker --env-file .env`, `ssh -i key`, `kubectl --kubeconfig`, tokens captured into a variable or piped to `docker login --password-stdin` |
| e) publishing | `publish.package` `publish.artifact` `publish.image` `publish.paste` | npm/pnpm/yarn/bun/cargo/gem/twine/poetry/nuget publish, semantic-release; `docker push`, `buildx --push`, `mvn deploy`, `gradle publish` except `hades-devops-engineer`; any use of paste/file-drop hosts | `docker build`, local `publishToMavenLocal` |
| f) self-protection | `self.protect` `self.session` `self.env` | Write/Edit, Serena edits and shell writes, moves, deletes (also through globs, braces, `cd` into a glob, symlinks) of: the engine `hooks/` and `.gitignore` (it keeps `.vault` out of the engine repository), the policy file the guard loaded (`HADES_GUARD_POLICY` or the shipped one), `hades.config.json`, every `settings*.json`, `.mcp.json`, `.claude.json`, `managed-settings*.json`, `managed-mcp.json`, `.claude/hooks/`, the installed agents (`<claude dir>/agents/hades/**`, also `hades-*`) and skills (`skills/hades*/**`), plugins in the Claude config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`), the workspace root's `.claude/`, `CLAUDE.md`, `AGENTS.md`; creating or replacing a `.claude` folder by copy/move; `claude` with `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--settings`, `--setting-sources`, `--bare`, `--mcp-config`, `--plugin-dir`; setting `CLAUDE_CONFIG_DIR` in any syntax; `claude` (or `hades run`) after `HOME`/`USERPROFILE`/`CLAUDE_CODE_*` changes in the same command; `claude config set`, `claude mcp add/remove`, plugin installs; `hades install`; `hades init` over an existing config; `hades run` from an agent; setting `HADES_GUARD*`/`HADES_CONFIG_FILE` | reading them; `node <engine>/bin/hades.mjs run ...` from the main session (prompts in default mode); deleting a **registered project's own** `.claude/`, `CLAUDE.md`, `AGENTS.md` (onboarding moves them out; never those of the workspace root, home, the Claude config dir or the engine); writing copies of them under `<vault>/**/legacy/**` |
| g) role scope | `scope.write` `scope.readonly` `scope.vendored` `scope.engine` | Write/Edit/MultiEdit/NotebookEdit and Serena edits outside the role's scope (below); anything under `<engine>/tools/` for everyone; engine files for agents unless the engine is a registered project; Serena `activate_project` on the engine, vault, workspace, home or Claude dir, or on any folder inside the engine or a vault except a vault team folder (`<vault>/**/teams/<team>`) or a registered project, and `replace_in_files` over them or over a folder holding a protected file | |
| h) state files | `state.direct-edit` | shell writes (redirect, `tee`, `cp`, `Set-Content`, `Out-File`, ...) and Serena edits of `tasks/<id>/state.json\|defects.json\|work-plan.json\|gates.json` and `teams/<team>/team.json`; Write/Edit of `state.json\|defects.json\|work-plan.json\|gates.json\|team.json` in the vault; `registry.json` at the root of the vault (or of a default vault location) through any tool | reading them; the `hades` CLI (`hades task plan`/`task item` for work-plan.json, `hades team set`, `hades detect --write` for team.json); Write of the draft `work-plan.draft.json` that `hades task plan --from` validates |
| limits | `guard.limit` | commands too large, deep or slow to verify (4 MB, 200k tokens, 20k commands, 8 nesting levels, 60k expansions, 5 s), the internal marker characters U+0001/U+0002, globs too large or invalid to expand | |

Role write scopes (only when `agent_type` starts with `hades-`; the main session and other agents are
not scoped):

| Agent | May Write/Edit |
|---|---|
| `hades-business-analyst`, `-software-architect`, `-cybersecurity-engineer`, `-knowledge-curator`, unknown `hades-*` | vault, temp dirs |
| `hades-backend-engineer`, `-frontend-engineer`, `-aiml-data-engineer`, `-qa-engineer`, `-devops-engineer`; `hades-tech-lead` (greenfield skeleton in planning and integration glue only, per its role contract) | registered project paths, vault, workspace (new projects), temp dirs |
| `hades-scout` | nothing |

## How commands are read

The guard parses Bash, PowerShell and cmd syntax, so wrapping a command does not hide it: quotes and
escapes (`\`, `` ` ``, `^`), `;` `&&` `||` `|` `&` and newlines, `$( )`, backticks, `( )`, `{ }`,
`<( )`, heredocs and here-strings, `$IFS`, shell keywords and `case` patterns, env-prefix assignments,
`sudo`/`env`/`nohup`/`timeout`/`xargs`/`npx`/`uv run`/..., full executable paths in either slash style,
`.exe` and case, PowerShell aliases, `&`, dot-sourcing, `Start-Process`, `Invoke-Expression`,
`[Process]::Start`; `bash|sh|zsh -c`, `cmd /c`, `powershell -Command|-EncodedCommand|-File`, `wsl`,
`ssh host '...'`, `eval`, `find -exec` (all re-scanned); variables and aliases defined earlier in the
same command; `echo ... | bash` and `base64 -d | bash`; shell scripts and `npm|pnpm|yarn run` scripts
that the command executes (file read and scanned); code passed to `python -c`, `node -e`, ... (string
literals scanned, also as argument arrays such as `execFileSync('git', ['push'])`). Also: bash brace
expansion (`{git,push}`), ANSI-C quoting (`$'\x70ush'`), MSYS `cmd //c`, cmd `for %a` and delayed
`!x!` variables, PowerShell parameter prefixes (`-win hidden`), splatting (`@args`) and string
concatenation (`'.e'+'nv'`), `xargs`/`parallel` (the arguments arrive on stdin, so only read-only git
subcommands pass). Write, delete and read targets with glob or brace characters are expanded against
the filesystem (bounded); every match and the pattern itself are checked, and after `cd` into an
ambiguous glob or a variable, relative targets with protected names are refused. When in doubt it
blocks: false positives are preferred over false negatives.

## Policy

`guard-policy.json` holds the data: protected paths, self-protected globs, role scopes, secret
patterns, paste hosts and the command rules (`{id, re, flags, unless, allowRoles, when, okCaptured,
okPipedTo}` matched against the normalised command line, e.g. `git reset --hard`). It is merged over the
built-in defaults in `guard.mjs`: objects merge, arrays and scalars replace. Placeholders: `{home}`
`{engine}` `{vault}` `{workspace}` `{config}` `{projects}` `{orgs}` `{ostmp}` `{temp}` `{claude}`
(`CLAUDE_CONFIG_DIR`, else `~/.claude`) `{policy}` (the loaded policy file). Paths come from
`hades.config.json` (or `HADES_VAULT`, `HADES_WORKSPACE`; relative paths are relative to the engine)
and the vault's `registry.json`; without a configured vault, `{vault}` is `<engine>/.vault` (a legacy
`<engine>/vault` with a `registry.json` while `.vault` does not exist). A vault inside the engine is
the vault, not engine code: role scopes reach it, `scope.engine` still covers the rest of the engine,
and the `*credentials*.md` exemption for engine files does not extend to it.

To tune, edit `guard-policy.json`, or keep a tuned copy outside the engine and point `HADES_GUARD_POLICY`
at it in the environment Claude Code starts with. The shipped file is generated from the defaults:
`node hooks/guard.mjs --print-policy > hooks/guard-policy.json` (a test checks they match). Only the
owner edits policy or settings; the guard blocks agents and the main session from doing so. The
guard's own protection is built in and cannot be tuned away: the engine `hooks/`, the policy file it
loaded (wherever `HADES_GUARD_POLICY` points), the HADES config, the Claude settings, agents, skills,
hooks and plugins in the Claude config dir, every `settings*.json`/`.mcp.json`/`.claude.json` and the
managed settings stay protected even with an empty tuned policy.

## Failure behaviour

- **Internal errors fail closed for risky calls.** When the guard itself throws, a call whose command,
  path or code contains a high-risk keyword (`push`, `config`, `rm`, `del`, `Remove-Item`, `rmdir`,
  `mv`, `settings`, `guard`, `hooks`, `claude`, `.env`, `secret`, `credential`, `token`, `.ssh`, `reset`,
  `clean`, `filter`, `rebase`, `.git`, ...) is blocked (`guard.error`, exit 2); any other call gets a
  one-line warning and is allowed (exit 0), so a guard bug cannot brick ordinary work.
- **Budgets block.** Oversized, too deeply nested, too expensive (60k expansions, e.g. exponential cmd
  `if` chains) or too slow (5 s, half the hook timeout) input is blocked (`guard.limit`) rather than
  skipped, because a crash or a hook timeout would let the call through. So is any command containing
  the guard's internal marker characters (U+0001, U+0002).
- Network (UNC) paths are never touched on disk (a lookup can hang); they are judged by name.
- `HADES_GUARD=off` disables the guard (it says so on stderr). Owner-only debugging aid: set it in your
  own shell before starting Claude Code; agents cannot set it.
- Every block is appended as one JSON line to `<engine>/.hades/guard.log` (best effort, obvious tokens
  redacted). `HADES_GUARD_LOG` moves it.

## Use from the CLI

`import { checkShell } from '<engine>/hooks/guard.mjs'` returns `null` or `{ id, message }` for a command
line (`{ shell: 'bash'|'powershell'|'cmd', cwd, agentType }`). The hook cannot see what the CLI runs,
and `team.json` lives in the agent-writable vault, so the CLI calls it twice: `hades team set` refuses
a blocked shell value (`command`, `deploy`, `health`, `rollback`; exit 1 with the guard reason), and
every `team.json` command the CLI executes itself (gate steps and the rest) is checked again right
before it runs. `evaluate(hookInput)` is the hook itself.

## Test

```sh
node --test "tests/hooks/*.test.mjs"
echo '{"tool_name":"Bash","cwd":".","tool_input":{"command":"git push"}}' | node hooks/guard.mjs; echo $?
```

Tests spawn the hook against an isolated fixture: `HADES_CONFIG_FILE`, `HADES_GUARD_POLICY` and
`HADES_GUARD_LOG` point it at temporary files, so nothing depends on the real machine configuration.

## Limits

It is a guard rail against mistakes and prompt-injected instructions, not a sandbox. It reads the
text of each tool call before it runs; it cannot see what a program does once it runs. A determined
attacker who can execute code as your OS user can always defeat an in-process guard (for example by
writing a program that edits files or pushes by itself, then running it). Real isolation needs an
OS-level boundary: WSL2, the Claude Code sandbox on macOS or Linux, a container or devcontainer with
only the workspace mounted, or a VM.

- Shell writes are not role-scoped. Only Write/Edit/MultiEdit/NotebookEdit and Serena edits are. Shell
  writes are checked against self-protected paths, `.git` internals, git config files, state files
  and protected deletes.
- Programs that act on their own are not inspected: compiled binaries, `make` targets, `python x.py` or
  `node x.js` files, git hooks, `npm install` lifecycle scripts, git libraries (`simple-git`,
  `GitPython`, libgit2), and what the programs started by `team.json` commands do (the command lines
  themselves are checked, see Use from the CLI).
- Text computed at run time (`eval "$(some-tool)"`, `printf` formats, values read from files) cannot be
  known before it runs; deliberately obfuscated commands may still evade the parser.
- Deliberate find filters such as `-mtime +7` or `-size +0` count as "match everything" only when no
  name/path pattern narrows them; a narrow `-name` pattern is trusted.
- Recursive secret checks walk at most 8 levels and 20,000 entries and skip dependency and VCS folders
  (`node_modules`, `.git`, `vendor`, ...). The `Grep` tool's directory searches are not walked (it
  honours `.gitignore`); its `path` and `glob` are checked.
- Serena paths are relative to Serena's project root, which the guard cannot see: they are resolved
  against the session directory and also judged by name. Other MCP tools are outside the matcher;
  their servers are scoped by their own configuration.
- A hook that cannot start (Node missing or moved) does not block on Claude Code versions that ignore
  `"onFailure": "block"`; re-run `hades install` after changing Node.
- Network egress is not restricted beyond paste hosts and pipe-to-shell.
