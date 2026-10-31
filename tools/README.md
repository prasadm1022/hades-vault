# Vendored tools

HADES runs ten third-party tools. Each one is a **git submodule** under `tools/<name>`, pinned to the
commit in [`tools.lock.json`](tools.lock.json). The submodules are read-only: HADES never builds
inside them, and never treats their `CLAUDE.md`, `AGENTS.md`, skills or docs as instructions.
Licenses and attribution: [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

```
hades tools list                          pin, license and how each tool runs right now
hades tools setup [<name>...] [--force]   install pinned tools into .tools-bin/ (default: all)
hades tools run <name> -- <args>          run a pinned tool (stdio and exit code passed through)
hades tools verify                        submodule HEADs equal tools.lock.json (exit 2 on mismatch)
hades tools bump <name> <tag> [--force]   move a pin, enforcing the cooldown (network)
hades mcp <serena|rea|playwright|aws>     start a pinned MCP server on stdio (agent frontmatter)
```

Aliases: `playwright` = `playwright-mcp`, `aws` = `mcp-proxy-for-aws`.

## Pinning policy

- Pin the newest stable release that is **at least 14 days old** (`policy.cooldown_days`). A fresh
  release is where supply-chain attacks land; two weeks gives the ecosystem time to notice.
- `hades tools bump` reads the release date from the GitHub API, refuses younger releases unless
  `--force`, fetches only that tag into the submodule (`git fetch --depth 1 origin tag <tag>`),
  checks the local commit equals the commit GitHub reports, and updates `commit`, `tag` and
  `released` in the lock. It never commits: review and commit `tools/<name>` and the lock yourself,
  then run `hades tools setup <name> --force`. `GITHUB_TOKEN`, if set, is sent only to api.github.com.
- `hades tools verify` checks every submodule HEAD against the lock (`git -C tools/<name> rev-parse HEAD`).

## How a tool is resolved

`resolveTool` (in `lib/core/tools.mjs`) tries, in order:

1. **`HADES_TOOL_<NAME>`** (for example `HADES_TOOL_PLAYWRIGHT_MCP`): absolute path to an
   executable, or a `.mjs`/`.js` file that is run with the current Node. For tests and for owners
   with their own build.
2. **`.tools-bin/<name>/install.json`**, written by `hades tools setup`. Ignored (stale) when its
   tag or commit differs from the lock, so a bump never silently runs an old build.
3. **A binary on `PATH` at the pinned version** (gitleaks, trivy, semgrep, ccusage only: their
   version is cheap to ask). On Windows `.cmd`/`.bat` shims are skipped (they need a shell).
4. **The pinned runner**: `uvx` (from the vendored source, or `<pkg>==<version>`), `npx -y
   <pkg>@<version>` with install scripts disabled, or the pinned Docker image if Docker is running.

Otherwise the error ends with `run: hades tools setup <name>`. Tools never run through a shell;
arguments are passed as an array. Docker forms: `runTool` and `hades tools run` bind-mount the
working directory (at `/src`, or `/zap/wrk` for ZAP; Trivy's cache at `/cache`), so pass paths
relative to it; a bare `resolveTool(ctx, name)` returns `docker run ... <image> [cmd]` with no
mounts, and the caller (the gate) inserts its own `-v`/`-w` after `run`. Runtime state:

| Path (engine root, git-ignored) | Contents |
|---|---|
| `.tools-bin/<name>/` | installed tool + `install.json` (tag, commit, kind, entry, checksum or integrity) |
| `.tools-bin/trivy-cache/` | Trivy vulnerability DB and checks cache |
| `.tools-bin/playwright-browsers/` | Chromium for Playwright MCP (`PLAYWRIGHT_BROWSERS_PATH`) |
| `.hades/serena-home/` | Serena config, logs and language servers (`SERENA_HOME`) |
| `.hades/playwright/<project>/` | Playwright MCP screenshots and other output |

Environment knobs: `HADES_DOCKER=0|1` forces Docker detection; `HADES_ENGINE_ROOT` (tests only).
Downloads use Node's own HTTPS client (no proxy support), only from github.com and
*.githubusercontent.com, with a size cap.

---

## rea - reverse engineering

- **What / why**: REA (`rea-agents`) analyses binaries, Electron/JS bundles, .NET, Go and Rust
  artefacts over MCP. The cybersecurity engineer uses it on artefacts HADES built (and the
  architect for interoperability research), within `company/security-policy.md`.
- **Pin**: `rea-agents-6.5.0` (npm `rea-agents@6.5.0`). **License**: MIT; bundled parts keep their
  own licenses (`THIRD_PARTY_NOTICES.md`, `licenses/` in the submodule).
- **How HADES runs it**: the **pinned npm package** on every OS, installed with
  `npm install --prefix .tools-bin/rea --ignore-scripts rea-agents@6.5.0` after
  `npm view rea-agents@6.5.0 version dist.integrity` confirms the version exists (the integrity
  is printed and stored). Why: the Windows native addon (`rea-windows-x64.node`) only ships in
  the npm tarball, and a source build on Windows cannot spawn any engine; one recipe on all OSes
  is simpler to trust. On macOS/Linux, `hades tools setup rea --from-source` builds the vendored
  tree instead (copy to `.tools-bin/rea/src`, `HUSKY=0 npm ci --ignore-scripts`, `npm run compile`,
  telemetry of the build tools off).
- **MCP**: `node <rea>/scripts/rea.mjs mcp` with `REA_MCP_INPUT_SCHEMA_PROFILE=compact` (about 40%
  smaller tool catalog) and `REA_LOG_LEVEL=warn`; `GHIDRA_INSTALL_DIR` and `JAVA_HOME` pass through.
  Fallback: `npx -y rea-agents@6.5.0` with `npm_config_ignore_scripts=true`.
- **Windows**: needs the npm package (above). Ghidra support on Windows is experimental and
  read-only; GDB, process capture and reference-source import are not available.
- **Node**: rea declares `^22.19.0 || ^24.11.0 || >=26`; setup warns on older Node.
- **Safety**: `--ignore-scripts` (skips frida's prebuild download, so Frida tools are unavailable).
  Never run `rea setup`, `rea update`, `install.sh` or `@latest`. There is no server-side tool
  allowlist: agents deny the foreign-code, device and console tools in their frontmatter. REA is
  not a sandbox: analyse untrusted third-party binaries in a VM or container.

## serena - symbol-level code navigation

- **What / why**: language-server-backed MCP server: find symbols, references, and edit by
  symbol instead of reading whole files. Every engineering role uses it; it is the biggest
  token saver after the stage summaries.
- **Pin**: `v2.0.0`. **License**: GPL-3.0-or-later (application) and MIT (SolidLSP). HADES only
  starts it as a separate process.
- **How HADES runs it**: **from the vendored source**. `hades tools setup serena` runs
  `uv sync --project tools/serena --frozen --no-dev --no-editable --python 3.12` with
  `UV_PROJECT_ENVIRONMENT=.tools-bin/serena/venv`: the exact dependency set of the vendored
  `uv.lock` (with hashes), installed outside the submodule. Without setup, `hades mcp serena` uses
  `uvx -p 3.12 --from tools/serena serena` (ignores the lock; first start resolves from PyPI).
- **MCP**: `serena start-mcp-server --context claude-code [--project <dir>] --agent-interface tools
  --enable-web-dashboard False --enable-gui-log-window False --open-web-dashboard False
  --mode no-memories --log-level WARNING`. `--project` (absolute) only when `hades mcp serena
  --project <dir>` pins one; the agents start Serena without a project (never `--project-from-cwd`)
  and call `activate_project` with the absolute `<Project>` path before the first symbol tool.
  Env: `SERENA_USAGE_REPORTING=false` (no usage ping), `SERENA_HOME=.hades/serena-home`.
- **Config**: `hades mcp serena` seeds `.hades/serena-home/serena_config.yml` once: tools interface
  (not the Python REPL), dashboard and GUI off, `execute_shell_command` excluded,
  `base_modes: [editing]` (no "ask the user" mode), `trusted_project_path_patterns: []`,
  `line_ending: lf`, 30k-character answers. Serena keeps its project list there.
- **Writes**: `SERENA_HOME` (config, logs, language servers downloaded on first use of a
  language) and the project data folder `.hades/serena/<project folder>` (project.yml, cache;
  `project_serena_folder_location`). `hades mcp serena` creates that folder for every registered
  team project before launch; an unregistered project may get `<project>/.serena/`. Nothing else. Prefetch servers with
  `hades tools run serena -- download-ls-dependencies <lang>`.
- **Windows**: the dashboard would open a native window; it is disabled. Some language servers
  need extra runtimes (C#: .NET 10 + pwsh).
- **Safety**: a target repo's `.serena/project.yml` can re-enable tools; agents therefore also deny
  `mcp__serena__execute_shell_command` and `mcp__serena__serena_repl`.

## ccusage - token and cost reports

- **What / why**: reads Claude Code session logs and reports tokens and cost; `hades usage`
  records every task's usage so regressions are visible.
- **Pin**: `v20.0.34`. **License**: MIT (`apps/ccusage/LICENSE`).
- **How HADES runs it**: the **pinned npm package** `ccusage@20.0.34` installed with
  `--ignore-scripts` into `.tools-bin/ccusage` (the version is confirmed with `npm view` first).
  v20 is a Rust binary shipped as per-platform optional npm packages; a source build needs cargo,
  a C toolchain and a pricing snapshot, which is not practical here. Fallback: `npx -y ccusage@20.0.34`.
- **Use**: always pass `--offline` on report commands (`claude daily|session|blocks --json
  --offline`); otherwise every run fetches pricing from GitHub. Pass an explicit `--config` so a
  project's `.ccusage/ccusage.json` cannot change prices. `LOG_LEVEL=0` is set. Never use `--jq`.

## semgrep - static analysis (SAST)

- **What / why**: the `sast` gate step and the cybersecurity engineer's source review.
- **Pin**: `v1.181.0`. **License**: LGPL-2.1 (engine). Registry rules (`p/...`) have their own terms
  and are downloaded at run time, never vendored.
- **How HADES runs it**: the **pinned PyPI wheel** `semgrep==1.181.0` in a private venv
  (`.tools-bin/semgrep/venv`, Python 3.12), with dependency versions constrained by the vendored
  `tools/semgrep/cli/uv.lock` when `uv export` can read it. A source build needs a forked OCaml
  toolchain and is not practical. If the wheel cannot be installed (for example no Windows wheel)
  and Docker runs, setup pulls `semgrep/semgrep:1.181.0` and pins its digest. Without setup:
  `uvx --from semgrep==1.181.0 semgrep`, then the image.
- **Env** (every form): `SEMGREP_SEND_METRICS=off`, `SEMGREP_ENABLE_VERSION_CHECK=0`,
  `SEMGREP_MCP_DISABLE_TRACING=true`, and `SEMGREP_APP_TOKEN` removed.
- **Use**: `scan --config <local rules or p/...> --metrics=off --disable-version-check --oss-only
  --json -o <file>`; never `--autofix`, `--pro*`, `--secrets`, `login`, `ci` or `--trace`. Prefer
  explicit file targets over `--baseline-commit` (it can `git reset --hard` a clean repo).
- **Windows**: the 1.181.0 wheel installs and runs natively on Windows x64 (verified); setup
  still falls back to Docker on platforms without a wheel.

## gitleaks - secret scanning

- **What / why**: the `secrets` gate step (pre-commit, pre-deploy, security).
- **Pin**: `v8.30.1`. **License**: MIT.
- **How HADES runs it**: the **official release binary**. Setup downloads
  `gitleaks_8.30.1_checksums.txt` and the platform archive (`gitleaks_8.30.1_windows_x64.zip`,
  `..._linux_x64.tar.gz`, `..._darwin_arm64.tar.gz`, ...) from the GitHub release, checks the
  archive's SHA-256 against the checksums file **before extracting** (mismatch = refuse), extracts
  with `tar`, and checks `gitleaks version`. A source build needs Go, which HADES does not
  require. If the download is impossible and Docker runs: `ghcr.io/gitleaks/gitleaks:v8.30.1`
  (pinned by digest, `--network none`).
- **Use**: `dir <path>` or `git --staged` with `--no-banner --redact -f json -r <file>
  --exit-code 2` (2 = leaks, 1 = error). Never `-v` (prints findings to stdout), never untrusted
  `--log-opts` (passed verbatim to `git log`), never `--diagnostics=http`.
- **Windows**: extraction uses `%SystemRoot%\System32\tar.exe` (Windows 10 1803+), not a GNU tar
  from Git for Windows that cannot read zip files.

## trivy - dependencies, IaC, containers, SBOM

- **What / why**: the `deps` gate step; the DevOps and cybersecurity engineers' image and IaC scans.
- **Pin**: `v0.76.0`. **License**: Apache-2.0 (keep `LICENSE` and `NOTICE`).
- **How HADES runs it**: the **official release binary**, same procedure as gitleaks
  (`trivy_0.76.0_checksums.txt`, `trivy_0.76.0_windows-64bit.zip`, `..._Linux-64bit.tar.gz`,
  `..._macOS-ARM64.tar.gz`; Windows is amd64 only). Docker fallback: `aquasec/trivy:0.76.0`.
  Cosign signature verification is not done (no cosign); the checksum file comes from the same
  release over TLS. Never use v0.69.4 (reported compromised release).
- **Env** (every form): `TRIVY_CACHE_DIR=.tools-bin/trivy-cache`, `TRIVY_DISABLE_TELEMETRY=true`
  and `TRIVY_SKIP_VERSION_CHECK=true` (both are needed to stop the check.trivy.dev call),
  `TRIVY_RUN_AS_PLUGIN` removed.
- **Vulnerability DB**: the first scan downloads the DB (OCI image from mirror.gcr.io / ghcr.io)
  into the cache; warm it with `hades tools run trivy -- image --download-db-only`. Later scans can
  pass `--skip-db-update --skip-java-db-update --skip-check-update --offline-scan`.
- **Use**: `fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --exit-code 3 --format
  json --output <file> --ignorefile= --config= --secret-config= --list-all-pkgs=false` (empty
  values written as `--flag=` so they survive Windows argument handling). Never plugins,
  `--enable-modules`, `--server`, `--insecure` or untrusted templates. Terraform remote modules
  are downloaded during IaC scans and cannot be disabled from the CLI.

## playwright-mcp - browser automation

- **What / why**: QA and frontend engineers drive a real browser over MCP (navigate, click,
  assert, screenshot); the cybersecurity engineer uses it for authenticated probes.
- **Pin**: `v0.0.83` (npm `@playwright/mcp@0.0.83`). **License**: Apache-2.0.
- **How HADES runs it**: **from the vendored package files**. The repository is a thin wrapper:
  the server code is the prebuilt `playwright-core` it depends on. Setup copies the vendored
  `package.json`, `package-lock.json` (sha512-pinned `playwright-core`) and `cli.js` into
  `.tools-bin/playwright-mcp`, runs `npm ci --omit=dev --ignore-scripts`, then
  `node cli.js install-browser chromium` (the browser build matching that `playwright-core`) into
  `.tools-bin/playwright-browsers`. Fallback: `npx -y @playwright/mcp@0.0.83`.
- **MCP**: `--headless --isolated --browser chromium --no-webmcp --output-dir
  .hades/playwright/<project> --image-responses omit --console-level error --caps testing`.
  Isolated = profile in memory, so parallel agents do not collide and no login persists.
- **Safety**: not a security boundary. `browser_run_code_unsafe` cannot be disabled by a flag:
  agents deny it. Never `--extension`, `--cdp-endpoint`, `--no-sandbox`, `--allow-unrestricted-file-access`,
  `--host 0.0.0.0`. Linux may need `npx playwright install-deps chromium` (root) once.

## zaproxy - dynamic testing (DAST)

- **What / why**: `hades gate --dast`: baseline (passive) scans of live systems, full/API (active)
  scans of test environments only.
- **Pin**: `v2.17.0`. **License**: Apache-2.0 (Paros-derived files: Clarified Artistic License; keep
  `LICENSE` and `LEGALNOTICE.md`, which lists the bundled libraries and their licenses).
- **How HADES runs it**: the **pinned Docker image** `zaproxy/zap-stable:2.17.0`, pulled by setup and
  then run by digest. The packaged scan scripts (`zap-baseline.py`, `zap-full-scan.py`,
  `zap-api-scan.py`) only work inside the image, and a source build needs Gradle plus about 50
  add-on downloads. No Docker = no DAST (the gate reports the step as `error`).
- **Invocation**: `hades tools run zaproxy -- zap-baseline.py -t <url> -s -J zap.json -z "-silent"`
  from the report directory (mounted at `/zap/wrk`). `ZAP_SILENT=true` is set and callers also pass
  `-z "-silent"`, so ZAP makes no update or add-on requests. `--add-host
  host.docker.internal:host-gateway` lets the container reach services on the host. The ZAP API
  port is never published (`-p`), and `--hook` / `-u` are never used.
- **Windows**: needs Docker Desktop with Linux containers. On Linux the mounted report directory
  must be writable by the container's `zap` user (uid 1000).

## aws-agent-toolkit - official AWS skills and rules

- **What / why**: AWS's own skills (`skills/core-skills/<name>/SKILL.md`: aws-deployment, aws-cdk,
  aws-cloudformation, aws-iam, aws-security, ...) and rules (`rules/`). The DevOps engineer reads
  them on demand through `playbooks/aws.md`; nothing is installed into Claude Code.
- **Pin**: commit `44ba1a5` (the repository publishes no tags). **License**: Apache-2.0 (keep `NOTICE`).
- **How HADES runs it**: it does not; it is data. HADES does **not** run its setup guide
  (`setup-instructions/setup.md` installs the AWS CLI with a piped script, runs `aws login` and an
  interactive wizard, and rewrites MCP config files), nor its plugin hooks. The plugin's
  `aws-mcp` server definition is replaced by `hades mcp aws` below.

## mcp-proxy-for-aws - the AWS MCP server

- **What / why**: a local stdio proxy that signs requests with SigV4 using a named AWS profile and
  forwards them to the managed AWS MCP server (`https://aws-mcp.us-east-1.api.aws/mcp`). It gives
  the DevOps engineer AWS documentation, API calls and the toolkit's agent tools.
- **Pin**: `v1.7.0`. **License**: Apache-2.0 (keep `LICENSE` and `NOTICE`).
- **How HADES runs it**: **from the vendored source**: `uv sync --project tools/mcp-proxy-for-aws
  --frozen --no-dev --no-editable --python 3.12` into `.tools-bin/mcp-proxy-for-aws/venv`, i.e. the
  exact dependency closure of the vendored `uv.lock` (the same closure upstream freezes into
  `mcp-proxy-for-aws-cli`). Python 3.12 instead of the repository's `.python-version` (3.10, end of
  life in October 2026). Fallback: `uvx -p 3.12 --from tools/mcp-proxy-for-aws mcp-proxy-for-aws`.
- **Configuration** (`hades.config.json`):

  ```json
  { "aws": { "profile": "hades-deploy", "region": "eu-west-1" } }
  ```

  `profile` (or a list) falls back to `AWS_PROFILE`; without one, `hades mcp aws` prints one line to
  stderr and exits 1, so the server is simply unavailable. Optional: `"read_only": true` (adds
  `--read-only`: write-capable tools hidden), `"endpoint"` (https only).
- **MCP**: `mcp-proxy-for-aws <endpoint> --profile <p> [--metadata AWS_REGION=<region>]
  [--read-only] --disable-telemetry --log-level ERROR`, with `AWS_MCP_PROXY_PROFILES=<p>` (which
  upstream gives precedence over `--profile`). The configured region is sent as metadata (where
  the server operates); it is never passed as `--region`, which is the SigV4 signing region and
  must match the endpoint.
- **Credentials**: HADES never reads AWS credential or config files; the proxy (boto3) does, for
  the named profile only. Use a least-privilege profile: it is the real boundary for what the
  DevOps engineer can change. Sign in with `aws login --profile <p>` or `aws sso login` yourself.
