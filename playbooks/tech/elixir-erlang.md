# Elixir / Erlang

## Detect
- Elixir: `mix.exs`, `mix.lock`; Phoenix: `:phoenix` dep, `lib/<app>_web/`; LiveView: `:phoenix_live_view`;
  Ecto: `priv/repo/migrations`; Nerves: `:nerves`. Umbrella: `apps/*/mix.exs`.
- Erlang: `rebar.config` (rebar3), `erlang.mk`, `*.app.src`. Versions: `.tool-versions` (asdf/mise), `elixir:` in mix.exs.
- Tools: `.formatter.exs`, `.credo.exs`, `.dialyzer_ignore.exs`, `.sobelow-conf`.

## Commands
| key | Elixir (mix) | Erlang (rebar3) |
|---|---|---|
| install | `mix deps.get` (new machine first: `mix local.hex --force`, `mix local.rebar --force`) | `rebar3 get-deps` |
| build | `mix compile --warnings-as-errors` | `rebar3 compile` |
| lint | `mix credo --strict` (if dep present); `mix xref graph --format cycles` (optional) | `rebar3 xref` |
| types | `mix dialyzer` (dialyxir; first run builds the PLT, minutes) | `rebar3 dialyzer` |
| test | `mix test` (stop early: `--max-failures 1`; rerun failures: `--failed`) | `rebar3 eunit` + `rebar3 ct` |
| run | `mix phx.server` (background) | `rebar3 shell` is a REPL: use a release instead |
| format | `mix format --check-formatted` | `rebar3 fmt --check` if the plugin is configured |

Ecto: `mix ecto.create`, `mix ecto.migrate`, `mix ecto.rollback`, `mix ecto.migrations`,
seeds `mix run priv/repo/seeds.exs` (see `databases.md`). Release: `MIX_ENV=prod mix release` in a
script; Phoenix assets: `mix assets.deploy`.

## Layout
`lib/<app>/` (contexts: business logic and Ecto schemas), `lib/<app>_web/` (router, controllers, live,
components), `config/{config,dev,test,prod,runtime}.exs` (`runtime.exs` reads env vars at boot),
`priv/repo/migrations`, `test/` mirroring `lib/` with `*_test.exs`, `test/support/` (`ConnCase`, `DataCase`).
Erlang: `src/`, `include/`, `test/` (`*_SUITE.erl` for Common Test), OTP application per directory.

## Testing
- ExUnit with `async: true` where tests do not share global state; Ecto SQL Sandbox isolates DB tests.
- Phoenix: `Phoenix.ConnTest` for controllers/JSON, `Phoenix.LiveViewTest` for LiveView; Mox for
  behaviour-based mocks; StreamData for property tests.
- Browser e2e: Wallaby or Playwright against `mix phx.server` (`../qa-automation.md`).
- Iterate: `mix test test/<app>/orders_test.exs:42`.

## Security
- `mix deps.audit` (mix_audit) and `mix hex.audit` (retired packages); trivy reads `mix.lock`.
- Phoenix SAST: `mix sobelow --exit medium` (if present); semgrep support for Elixir is limited.
- Review: `Ecto.Adapters.SQL.query` / `fragment` with interpolated input, `raw/1` in templates,
  `String.to_atom` on input (atom table exhaustion), missing `:protect_from_forgery`, open `check_origin`
  for sockets, secrets in `config/*.exs` instead of `runtime.exs` + env.

## Pitfalls
- Never `iex` / `iex -S mix` (interactive); one-off code: `mix run -e "IO.inspect(MyApp.Repo.aggregate(MyApp.Order, :count))"`.
- Native deps (bcrypt_elixir, argon2_elixir, exqlite) need a C compiler; on Windows install the build
  tools or run in the project's container, and record it.
- Tests need the database running (`config/test.exs`); compose service or local Postgres.
- First `mix dialyzer` is slow: run it in the background; cache `_build/*/dialyxir_*.plt`.
- `MIX_ENV` selects config and deps: tests run with `MIX_ENV=test` automatically; releases need `prod`.
- `mix deps.update --all` rewrites mix.lock: only when a work item asks.

## Small output
`mix compile` is quiet on success; `mix test --max-failures 1 2>&1 | tail -40`; `mix credo --strict --format oneline`.
