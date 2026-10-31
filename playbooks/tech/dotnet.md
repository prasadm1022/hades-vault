# .NET (C#, F#)

## Detect
- `*.sln` / `*.slnx`, `*.csproj`, `*.fsproj`; `global.json` (pinned SDK), `Directory.Build.props`,
  `Directory.Packages.props` (central package versions), `packages.lock.json`, `nuget.config`,
  `.config/dotnet-tools.json` (local tools such as `dotnet-ef`).
- Project kind from the SDK attribute / packages: `Microsoft.NET.Sdk.Web` (ASP.NET Core), Blazor,
  `Microsoft.EntityFrameworkCore`, MAUI, Azure Functions, WPF/WinForms (`net*-windows`: Windows only).

## Commands (from the folder with the .sln, or pass the .sln/.csproj path)
| key | command |
|---|---|
| install | `dotnet restore` (`--locked-mode` when packages.lock.json exists); local tools: `dotnet tool restore` |
| build | `dotnet build --no-restore -c Release -nologo` |
| lint | `dotnet format --verify-no-changes` (slow; whitespace only: `dotnet format whitespace --verify-no-changes`) |
| types | n/a (compilation; analyzers run in build) |
| test | `dotnet test -c Release -nologo` (filter: `--filter "FullyQualifiedName~Orders"`) |
| run | `dotnet run --project src/<App>` (background); never `dotnet watch` |
| format | as lint; F#: `dotnet fantomas --check .` (if the tool is in the manifest) |

EF Core: `dotnet ef migrations add <Name> --project <Data> --startup-project <Api>`,
`dotnet ef database update`, idempotent script for deploys: `dotnet ef migrations script --idempotent -o migrate.sql`.

## Layout
`src/<Company>.<Product>.<Layer>/` projects (Api, Application, Domain, Infrastructure) and
`tests/<Project>.Tests/` mirroring them; solution at the root. ASP.NET Core: `Program.cs` (minimal
hosting), `Controllers/` or endpoint groups, `appsettings.{Environment}.json`, options bound from config;
secrets via environment variables (`Section__Key`) or user-secrets in development only.

## Testing
- xUnit (most common), NUnit, MSTest; mocks: NSubstitute or Moq (whichever the project uses).
- Integration: `WebApplicationFactory<Program>` (Microsoft.AspNetCore.Mvc.Testing) + Testcontainers or
  SQLite in-memory; Blazor components: bUnit.
- Browser e2e: Playwright for .NET (browsers: `pwsh bin/Debug/<tfm>/playwright.ps1 install`) or the
  team's JS Playwright suite (`../qa-automation.md`).
- Coverage: `dotnet test --collect:"XPlat Code Coverage"` (coverlet.collector).

## Security
- `dotnet list package --vulnerable --include-transitive`; NuGet audit warnings (NU1901-NU1904) appear
  on restore; treat NU1903/NU1904 (high/critical) as failures. trivy reads `packages.lock.json` and
  `*.deps.json` (enable `RestorePackagesWithLockFile` for full coverage).
- Review: raw SQL (`FromSqlRaw` with interpolation; use `FromSqlInterpolated`/parameters), missing
  `[Authorize]`/policy on new endpoints, `AllowAnyOrigin` with credentials, `BinaryFormatter`, XML
  readers with DTD processing, antiforgery disabled on form posts, detailed errors in production.

## Pitfalls
- `global.json` pins an SDK: if missing, install that SDK (feature band) rather than editing the pin.
- MSBuild node reuse and the compiler server keep files locked (Windows): `dotnet build-server shutdown`.
- `dotnet test --no-build` must use the same `-c` as the preceding build, or it tests stale binaries.
- Windows-only targets (`net*-windows`, WPF, WinForms) do not build on macOS/Linux: record n/a there.
- First-run noise and telemetry: set `DOTNET_NOLOGO=1`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`.
- `dotnet ef` needs the design package in the startup project and a buildable solution.
- Never `dotnet nuget push` (publishes packages).

## Small output
`-v q -nologo` on build/test (errors and warnings only); test logger
`--logger "console;verbosity=minimal"`; on failure read the `.trx` (`--logger trx`) with grep, not whole logs.
