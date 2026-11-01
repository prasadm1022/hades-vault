# Vendored tools

HADES runs ten third-party tools (scanners, MCP servers, usage reports). What each one does, how
HADES runs it on each OS and its hardening flags: [`tools/README.md`](../tools/README.md). Licenses:
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Commands: `hades tools list|setup|run|verify|bump`
([`cli.md`](cli.md)).

## Layout

- Each tool is a git submodule under `tools/<name>`, pinned to the commit in `tools/tools.lock.json`
  (`tag`, `commit`, `released`, `license`). Submodules are read-only data: HADES never builds inside
  them and never treats their docs, `CLAUDE.md`, `AGENTS.md` or skills as instructions (the guard
  blocks writes under `tools/`).
- `hades tools setup` installs each tool into `.tools-bin/<name>/` with an `install.json` (tag,
  commit, checksum or integrity); an install whose tag or commit differs from the lock is ignored.
- Submodules clone from forks under `github.com/prasadm1022` (`.gitmodules`), so a pinned commit
  stays available if upstream rewrites or deletes it. `repo` in the lock stays the upstream project:
  release dates and commits are checked there, and `tools bump` fetches from it. A fork need not be
  synced for a new pin: GitHub serves any commit of the upstream network from the fork.
- Tests never need the submodules; CI checks out without them.

## Update policy

1. Pin the newest stable release that is **at least 14 days old** (`policy.cooldown_days`). Fresh
   releases are where supply-chain attacks land; two weeks gives the ecosystem time to notice.
2. `hades tools bump <name> <tag>` checks the release date on the GitHub API (refuses younger
   releases unless `--force`), fetches only that tag, checks the commit equals what GitHub reports,
   and updates the lock. It never commits.
3. Review the upstream changelog and diff, run `hades tools setup <name> --force`, `npm test` and
   `hades tools verify`, update `THIRD_PARTY_NOTICES.md` if the license changed, then commit
   `tools/<name>` and `tools/tools.lock.json` together.
4. Never pin a release reported compromised; note it in `tools/README.md` (for example trivy v0.69.4).

## Patching a tool

The forks are yours, so a tool can carry local commits. HADES agents still cannot write under
`tools/` (the guard); the owner makes the change.

1. In `tools/<name>`: `git switch -c hades`, commit, `git push -u origin hades` (the fork).
2. `hades tools patch <name> [--note "<why>"]` records the pushed HEAD in the lock as `commit`,
   with `patch` = `{branch, base_tag, base_commit, commits, note}`; `tag` stays the upstream
   release it builds on. It refuses a dirty tree, a detached HEAD, a branch the fork does not have
   at that commit, and commits that do not build on the base.
3. `hades tools setup <name> --force`, `npm test`, then commit `tools/<name>` and
   `tools/tools.lock.json` together. `tools verify` and `tools list` show the patch.

A patch only changes what runs where setup uses the vendored source: serena and
mcp-proxy-for-aws (built from it), aws-agent-toolkit (read in place), playwright-mcp (its
package.json, package-lock.json, cli.js and index.js), and rea with `setup --from-source`.
gitleaks, trivy, semgrep, ccusage and zaproxy install the upstream release, so a patch there is
recorded but not run; `tools patch` says which applies.

`tools bump` refuses a patched tool. To carry a patch to a new release:
`hades tools bump <name> <tag> --drop-patch`, rebase the branch onto the new pin in
`tools/<name>`, push it (`--force-with-lease`), then `hades tools patch <name>` again.
`hades tools patch <name> --drop` returns to the upstream base. Modified files keep their
license; Apache-2.0 tools also need a change notice in each modified file.

## Supply-chain measures

- Exact pins only: commits for submodules, exact versions for npm and PyPI packages, digests for
  Docker images. No `latest`, no version ranges.
- Release binaries (gitleaks, trivy) are verified against the release's SHA-256 checksum file before
  extraction; a mismatch is refused.
- npm installs run with `--ignore-scripts`.
- serena and mcp-proxy-for-aws install from their vendored `uv.lock` with hashes
  (`uv sync --frozen`) into private virtual environments.
- semgrep is the exception: `uv pip install semgrep==<pinned version>` installs the wheel from PyPI
  into a private virtual environment. Its dependency versions are constrained by
  `tools/semgrep/cli/uv.lock` (`uv export --no-hashes` into a constraints file), but **without hash
  checks**, and the wheel itself is not hash-pinned. If `uv export` fails or yields no lines, the
  install proceeds unconstrained; `.tools-bin/semgrep/install.json` then lacks the
  "constrained by tools/semgrep/cli/uv.lock" source note. Only when the wheel cannot be installed
  and Docker runs does setup use the `semgrep/semgrep` image, pinned by digest.
- Downloads come only from github.com and `*.githubusercontent.com` with a size cap; `GITHUB_TOKEN` is
  sent only to api.github.com.
- Tools run without a shell, with arguments as arrays, telemetry and update checks off, and scanner
  configuration from the project disabled where it could weaken a scan.
- Docker forms mount only the directories a step needs; the ZAP API port is never published.
