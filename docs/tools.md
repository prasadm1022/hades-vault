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
