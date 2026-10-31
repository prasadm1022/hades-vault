# Team portal (organization acme, main team)

| Field | Value |
|-------|-------|
| team | `portal` |
| organization | `acme` |
| team_type | main |
| project_path | `C:/Users/owner/git/acme/portal` |
| status | active |
| branch_strategy | current-branch |

## Projects
| Repo (relative to project_path) | Remote | Default branch | Notes |
|---|---|---|---|
| `portal-api` | `https://example.invalid/acme/portal-api.git` | main | Spring Boot API |
| `portal-web` | `https://example.invalid/acme/portal-web.git` | main | React + Vite |

## Commands
| Purpose | Directory | Command |
|---|---|---|
| build (skip tests) | `portal-api` | `mvn -q package -DskipTests` |
| build + test | same | `mvn -q package` |
| run (dev) | same | `mvn spring-boot:run` (port 8080) |
| single test class / method | `portal-api` | `mvn test -Dtest=ClassName` |
| verify test results | `portal-api` | `grep -l "FAILURE!\|Errors: [1-9]" target/surefire-reports/*.txt` |
| install | `portal-web` | `npm ci` |
| build | `portal-web` | `npm run build` (= `tsc -b && vite build`) |
| lint / type-check | `portal-web` | `npm run lint` |
| test | `portal-web` | `npm test` |
| dev | `portal-web` | `npm run dev` (port 5173) |

## Environments
| Name | How to reach | Who deploys | Notes |
|---|---|---|---|
| local | http://localhost:5173 | team | |

## Team roster
Roles present in `agents/`: all nine. Spawn missing roles from `company/roles/<role>.md`.
