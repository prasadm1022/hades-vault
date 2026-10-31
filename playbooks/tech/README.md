# Technology playbooks

`<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.
One file per ecosystem. Open the files for the stacks in `<Team folder>/team.json` (`projects[].stack`)
and read only the sections you need. No match, or the tool is new to you: `../learn-technology.md`.
Learned playbooks in `<vault>/company/playbooks/tech/<tech>.md` extend these and win on conflict for
their technology; learned fingerprints in `<vault>/company/playbooks/stacks.json` are merged over
`<engine>/playbooks/stacks.json` by `hades detect`.

| File | Detected by | Typical stacks |
|---|---|---|
| `javascript-typescript.md` | package.json, npm/pnpm/yarn/bun lockfiles, deno.json, tsconfig.json | Node, Deno, Bun; React, Next.js, Vue, Nuxt, Angular, Svelte; NestJS, Express, Fastify |
| `python.md` | pyproject.toml, uv.lock, poetry.lock, requirements*.txt, setup.py, manage.py | Django, FastAPI, Flask; uv, poetry, pip; pytest, ruff, mypy |
| `jvm.md` | pom.xml, build.gradle(.kts), build.sbt, mvnw, gradlew | Java, Kotlin, Scala; Spring Boot, Quarkus, Micronaut; JUnit |
| `go.md` | go.mod, go.work | net/http, Gin, Echo, chi, gRPC; CLIs |
| `rust.md` | Cargo.toml, Cargo.lock, rust-toolchain.toml | Axum, Actix, Tokio, Tauri, WASM; CLIs |
| `dotnet.md` | *.sln, *.slnx, *.csproj, *.fsproj, global.json | ASP.NET Core, Blazor, EF Core, MAUI; xUnit, NUnit, MSTest |
| `php.md` | composer.json, artisan, bin/console | Laravel, Symfony, WordPress; PHPUnit, Pest |
| `ruby.md` | Gemfile, .ruby-version, bin/rails | Rails, Sinatra, Hanami; RSpec, Minitest |
| `mobile.md` | pubspec.yaml, react-native/expo in package.json, *.xcodeproj, Package.swift, com.android.application | Flutter, React Native/Expo, Swift/iOS, Kotlin/Android |
| `cpp-c.md` | CMakeLists.txt, Makefile, meson.build, configure.ac, vcpkg.json, conanfile.*, MODULE.bazel | C, C++; CMake, Make, Meson, Bazel; GoogleTest, Catch2 |
| `data-ml.md` | dbt_project.yml, *.ipynb, Airflow DAGs, dvc.yaml, ML/LLM libraries in deps | SQL, dbt, Spark, Airflow, notebooks, PyTorch, scikit-learn, LLM apps and evals |
| `infra.md` | Dockerfile, compose.yaml, k8s manifests, Chart.yaml, *.tf, Pulumi.yaml, cdk.json, template.yaml, serverless.yml | Docker, Compose, Kubernetes, Helm, Terraform/OpenTofu, Pulumi, SAM, CDK, CloudFormation |
| `web-static.md` | index.html without server code, hugo.toml, _config.yml, mkdocs.yml, astro/eleventy/docusaurus config | HTML/CSS, Hugo, Jekyll, Eleventy, Astro, MkDocs, Docusaurus |
| `databases.md` | migration folders, schema.prisma, alembic.ini, db/migrate, DB services in compose | PostgreSQL, MySQL, SQLite, MongoDB, Redis; migration tools per ecosystem |
| `elixir-erlang.md` | mix.exs, rebar.config | Elixir, Phoenix, LiveView, Ecto; Erlang/OTP |
| `other.md` | anything else | method for unlisted stacks; quick reference for less common languages and task runners |

## Section structure (engine and learned playbooks)
`Detect` - `Commands` (keyed like team.json: install, build, lint, types, test, run, format) - `Layout`
- `Testing` - `Security` - `Pitfalls` - `Small output`. Learned playbooks add `Version`, `Sources`
and `Verified` lines under the title.

## Rules for every ecosystem
- Non-interactive only: `CI=true` in the environment, the tool's batch/no-input flag; never watch mode,
  REPLs, editors or prompts. A `run` command (dev server) starts in the background, is probed, then stopped.
- team.json commands run in the gate's shell on every OS: no `VAR=x cmd` prefixes, no `$(...)`, no
  bash-only syntax. Put environment needs in the project's config or scripts instead.
- Use the project's pins and wrappers (lockfiles, mvnw/gradlew, .nvmrc, .tool-versions, global.json,
  rust-toolchain.toml). Never upgrade toolchains, dependencies or lockfiles unless a work item says so.
- Prefer `hades gate`. Raw commands: run one test file while iterating, the full suite once at the end,
  and filter output (`2>&1 | tail -40`, `grep -E "error|FAIL"`).
- Slow first builds (JVM, Rust, C++, ML, mobile): Bash timeout up to 600000 ms, or run in the background.
- Windows: Git Bash `VAR=x cmd` = PowerShell `$env:VAR="x"; cmd`; wrappers are `.cmd`/`.bat`; CRLF
  breaks shell scripts in containers; dev servers and build daemons lock files, stop them before reinstalling.
- Vulnerable dependencies: gate step `deps` (trivy) reads the lockfiles of every ecosystem here; the
  ecosystem auditors in each playbook are second opinions. SAST: gate step `sast` (semgrep).
- Never commit build output, virtualenvs, node_modules, `.env` files or secrets.
