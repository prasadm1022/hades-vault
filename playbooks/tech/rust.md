# Rust

## Detect
- `Cargo.toml` (`[workspace]` = multi-crate), `Cargo.lock`, `rust-toolchain.toml` (pinned toolchain,
  installed automatically by rustup), `.cargo/config.toml`, `deny.toml`, `clippy.toml`, `rustfmt.toml`.
- Frameworks in Cargo.toml: axum, actix-web, tokio, sqlx, diesel, sea-orm, clap (CLI), tauri
  (`src-tauri/`), leptos/yew/dioxus, wasm-bindgen (`wasm-pack`, `trunk`).

## Commands
| key | command |
|---|---|
| install | `cargo fetch --locked` |
| build | `cargo build --locked --workspace` (release artefact: `--release`) |
| lint | `cargo clippy --locked --workspace --all-targets -- -D warnings` |
| types | `cargo check --locked --workspace --all-targets` (fastest compile check) |
| test | `cargo test --locked --workspace` (or `cargo nextest run` if `.config/nextest.toml` exists) |
| run | `cargo run -p <bin-crate>` (background for servers) |
| format | `cargo fmt --all --check` |

Feature flags: test the default set plus what CI tests (read `.github/workflows`); `--all-features` can
fail for mutually exclusive features. Single test: `cargo test -p <crate> <name_substring>`.

## Layout
`src/lib.rs` (logic) + thin `src/main.rs` or `src/bin/*.rs`; unit tests inside each file in
`#[cfg(test)] mod tests`; integration tests in `tests/*.rs` (public API only); benches in `benches/`;
examples in `examples/`; workspace members in `crates/*`. Errors: `thiserror` in libraries, `anyhow` in
binaries, unless the project chose otherwise.

## Testing
- Unit + integration + doc tests all run in `cargo test`. Async: `#[tokio::test]`.
- Property tests: proptest/quickcheck; snapshots: insta (`cargo insta test`, review with `cargo insta accept`
  only for intended changes); HTTP: `axum::Router` with `tower::ServiceExt::oneshot`, or reqwest against a
  spawned server; DB: `#[sqlx::test]` (creates a test DB per test, needs `DATABASE_URL`).
- Benchmarks (criterion) are never part of the gate.

## Security
- `cargo audit` (install once: `cargo install cargo-audit --locked`); `cargo deny check` if `deny.toml`
  exists (advisories, licenses, bans). trivy reads `Cargo.lock`.
- Review every new `unsafe` block (`grep -rn "unsafe" --include=*.rs src crates`), FFI boundaries,
  `unwrap()`/`expect()` on input-derived data in servers (panic = DoS), integer casts with `as` on
  untrusted sizes, SQL built with `format!` (use bind parameters / `query!`).

## Pitfalls
- First build compiles every dependency (minutes, `target/` can reach GBs): background + long timeout.
- Parallel cargo commands on one `target/` block ("Blocking waiting for file lock"): parallel agents use
  separate `CARGO_TARGET_DIR` values or run sequentially.
- Windows needs the MSVC build tools (`link.exe`); missing linker = install Visual Studio Build Tools
  (C++ workload), not the GNU toolchain, unless the project targets `-gnu`.
- A running binary is locked on Windows: stop the server before `cargo build`.
- `sqlx::query!` macros need `DATABASE_URL` or offline data (`.sqlx/`, created by `cargo sqlx prepare`).
- `cargo install` compiles from source (slow); `--locked` keeps the tool's own lockfile.
- `cargo update` rewrites Cargo.lock: only when a work item asks for dependency changes.

## Small output
`--message-format short` on `cargo check`/`clippy`/`build` (one line per diagnostic); `cargo test -q`;
`2>&1 | grep -E "^(error|warning: unused)|test result|panicked" | head -40`.
