# Contributing to HADES

Thanks for helping. HADES is small on purpose: a protocol, role prompts, playbooks and a
zero-dependency CLI around Claude Code. Contributions that keep it small, accurate and cheap to
run are the most welcome.

## Ground rules

- **No runtime npm dependencies.** The CLI and hooks use Node's standard library only (Node >= 22).
- **Cross-platform.** Windows (PowerShell and Git Bash), macOS and Linux. Use forward slashes and
  `run(cmd, args)` from `lib/core/util.mjs`; never build shell strings from input.
- **Token economy.** Every line in `agents/`, `skills/` and `company/handover.md` is paid on every
  run. Prefer fewer, more precise words. Put rarely needed detail in `playbooks/`, which agents
  open on demand.
- **Evidence over claims.** If a role can verify something with a command, the prompt should say
  which command, and the CLI should record the result.
- **Safety rules are code.** Anything that must never happen belongs in `hooks/guard.mjs` (with
  tests), not only in a prompt.
- **No private data.** Examples use neutral names (acme, portal). Never commit a vault (`.vault/` and `vault/` are git-ignored; keep it that way).

## Development

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/prasadm1022/hades-vault.git
cd hades-vault
npm test
node bin/hades.mjs doctor
```

Tests use `node:test` and must not need network, Docker or your machine's configuration.

## What to contribute

- **Technology playbooks** (`playbooks/tech/*.md`) and fingerprints (`playbooks/stacks.json`) for
  stacks HADES does not know yet, with tests in `tests/cli/detect.test.mjs`.
- **Deploy recipes** (`playbooks/deployment.md`) for more platforms.
- **Guard rules** with matching allow and block tests.
- **Tool pin updates** with `node bin/hades.mjs tools bump <name> <tag>` (respects the 14-day
  cooldown) and an updated `THIRD_PARTY_NOTICES.md` if the license changed.

## Pull requests

One topic per pull request. Describe what changed, why, and how you verified it (test output).
Update `CHANGELOG.md` under *Unreleased*.
