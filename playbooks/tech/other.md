# Other technologies

For a stack no playbook covers. If the language or tool itself is new to you, follow
`../learn-technology.md` (it ends with a learned playbook, so the next team pays nothing).

## Find the real commands (in this order)
1. CI config: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`,
   `.circleci/config.yml`. CI is the most trustworthy record of install/build/test/lint commands and versions.
2. Task runners: `Makefile` (`make -n <target>` shows what a target runs), `justfile` (`just --list`),
   `Taskfile.yml` (`task --list`), `mise.toml` (`mise tasks`), `package.json` scripts, `scripts/`.
3. Environment definitions: `Dockerfile` `RUN` lines, `.devcontainer/devcontainer.json`, `flake.nix`
   (`nix flake check`), `devbox.json`, `.tool-versions`.
4. `README`/`CONTRIBUTING`/`docs/development*`. Treat them as hints: verify by running.
5. Polyglot repos: one team.json project per buildable unit; check each with `hades detect <dir>`.

## Quick reference (verify against the project before storing)
| Language / tool | Markers | Install | Build | Test | Lint / format |
|---|---|---|---|---|---|
| Dart (non-Flutter) | `pubspec.yaml` | `dart pub get` | `dart compile exe bin/<x>.dart` | `dart test` | `dart analyze`; `dart format --output=none --set-exit-if-changed .` |
| Swift (server/CLI) | `Package.swift` | `swift package resolve` | `swift build` | `swift test` | `swiftlint lint --quiet` |
| Haskell | `stack.yaml` / `*.cabal` | `stack setup` / `cabal update` | `stack build` / `cabal build all` | `stack test` / `cabal test all` | `hlint .` |
| OCaml | `dune-project`, `*.opam` | `opam install . --deps-only -y` | `dune build` | `dune test` | `dune build @fmt` |
| Clojure | `deps.edn` / `project.clj` | `clojure -P` / `lein deps` | `clojure -T:build uber` / `lein uberjar` | alias, e.g. `clojure -X:test` / `lein test` | `clj-kondo --lint src` |
| Zig | `build.zig` | n/a | `zig build` | `zig build test` | `zig fmt --check .` |
| Gleam | `gleam.toml` | `gleam deps download` | `gleam build` | `gleam test` | `gleam format --check` |
| Julia | `Project.toml` | `julia --project=. -e "using Pkg; Pkg.instantiate()"` | n/a | `julia --project=. -e "using Pkg; Pkg.test()"` | - |
| R | `DESCRIPTION` / `renv.lock` | `Rscript -e "renv::restore(prompt = FALSE)"` | `R CMD build .` | `Rscript -e "devtools::test()"` | `Rscript -e "lintr::lint_package()"` |
| Perl | `cpanfile` / `Makefile.PL` | `cpanm --installdeps .` | `perl Makefile.PL && make` | `prove -lr t` | `perlcritic lib` |
| Lua | `*.rockspec` | `luarocks install --only-deps <rockspec>` | n/a | `busted` | `luacheck .` |
| Crystal | `shard.yml` | `shards install` | `shards build` | `crystal spec` | `crystal tool format --check` |
| Solidity | `foundry.toml` / `hardhat.config.*` | `forge install` / `npm ci` | `forge build` / `npx hardhat compile` | `forge test` / `npx hardhat test` | `forge fmt --check`; security: slither |
| Shell | `*.sh`, `bin/` | n/a | n/a | `bats test/` | `shellcheck <files>` |
| PowerShell | `*.ps1`, `*.psd1` | `Install-Module <m> -Scope CurrentUser -Force` | n/a | `Invoke-Pester -Path tests -CI` | `Invoke-ScriptAnalyzer -Path . -Recurse` |

## No source, or legacy
- Only binaries / closed artefacts: reverse engineering within policy, `../reverse-engineering.md`.
- Legacy stacks (COBOL, VB6, old PHP/Java): first make the existing build reproducible exactly as it is
  (container or recorded toolchain), add characterization tests around the code to change, then change it.

## Rules
- A command enters team.json only after it ran non-interactively with the expected exit code.
- Unverifiable commands (missing toolchain, OS-specific, needs hardware): leave the team.json step empty
  (gate reports `n/a`) and record why under DECISIONS. Never mark them as passed.
- Security for unlisted ecosystems: trivy and semgrep still run in the gate; add the ecosystem's own
  auditor if one exists (find it in step 2 of `../learn-technology.md`).
