# Go

## Detect
- `go.mod` (module path, `go` directive = minimum version, optional `toolchain`), `go.sum`, `go.work`
  (multi-module workspace). Entry points: `main.go` or `cmd/<name>/main.go`.
- Frameworks/libraries in go.mod: gin, echo, chi, fiber, grpc, cobra (CLI), sqlc, ent, gorm.
- Lint config: `.golangci.yml`/`.golangci.yaml`; codegen: `//go:generate` lines, `sqlc.yaml`, `buf.yaml`.

## Commands
| key | command |
|---|---|
| install | `go mod download` |
| build | `go build ./...` (multi-package build only compiles and discards: safe check) |
| lint | `go vet ./...`; if configured: `golangci-lint run` (or `staticcheck ./...`) |
| types | n/a (compilation; `go vet` covers more) |
| test | `go test ./...` (fresh run, no cache: `-count=1`; race detector: `-race`, needs cgo + a C compiler) |
| run | `go run ./cmd/<name>` (background for servers) |
| format | `gofmt -l .` prints unformatted files but exits 0: gate on empty output, e.g. `test -z "$(gofmt -l .)"` in a script |

Also: `go mod tidy -diff` (Go 1.23+) fails when go.mod/go.sum need tidying; `go generate ./...` before
build when generated files are not committed. Single test: `go test ./internal/order -run 'TestCreate$' -v`.

## Layout
`cmd/<binary>/` (thin main), `internal/` (private packages, enforced by the compiler), `pkg/` only for
code meant for other modules, `api/` (OpenAPI/proto), `migrations/`. Tests beside code as `*_test.go`
(same package for white-box, `<pkg>_test` for black-box); fixtures in `testdata/` (ignored by the build).

## Testing
- Standard `testing` with table-driven tests and `t.Run`; `t.Parallel()` where safe; testify only if
  the project already uses it.
- HTTP: `net/http/httptest` (`httptest.NewRecorder`, `httptest.NewServer`). DB: testcontainers-go or a
  compose service; integration tests behind a build tag (`//go:build integration`, run with `-tags=integration`).
- Fuzzing: `go test -fuzz=FuzzParse -fuzztime=30s ./internal/parser` (one package at a time).
- Coverage: `go test -cover ./...` or `-coverprofile=cover.out` then `go tool cover -func=cover.out | tail -1`.

## Security
- `govulncheck ./...` (reachability-aware; run via `go run golang.org/x/vuln/cmd/govulncheck@latest ./...`).
  trivy reads `go.mod` and compiled binaries.
- Review: `database/sql` with string-built queries (use placeholders), `text/template` for HTML (use
  `html/template`), missing `http.Server` timeouts (`ReadHeaderTimeout`), unchecked `filepath.Join` with user
  input (use `os.Root` / `filepath.IsLocal`), `InsecureSkipVerify`, goroutine leaks on request cancel.
- gosec (`gosec ./...`) only if the project uses it; semgrep covers Go in the gate.

## Pitfalls
- Test results are cached (`(cached)`): use `-count=1` when the result depends on files, env or services.
- `-race` and cgo packages (sqlite3, some crypto) need gcc/clang; on Windows usually absent: skip `-race`
  there and record it, or use a pure-Go driver if the project already allows it.
- Private modules: `GOPRIVATE=<host>/<org>/*`; never set `GOFLAGS=-insecure` or `GONOSUMDB` broadly.
- Vendored deps (`vendor/` present): builds use it automatically; after go.mod changes run `go mod vendor`.
- `go install pkg@latest` changes the global bin dir; prefer `go run pkg@version` for one-off tools.
- Windows: binaries need `.exe` in `-o` paths; `GOOS`/`GOARCH` cross-compile works without cgo.

## Small output
`go build` and `go vet` are silent on success; `go test ./... 2>&1 | grep -v -e '^ok' -e 'no test files'`
leaves only failures; `-json` output with `| grep '"Action":"fail"'` for machine parsing.
