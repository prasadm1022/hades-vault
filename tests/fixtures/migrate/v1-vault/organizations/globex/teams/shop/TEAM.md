# Team shop (organization globex, main team)

| Field | Value |
|-------|-------|
| team | `shop` |
| project_path | `C:/Users/owner/git/globex/shop` |

## Projects
| Project (relative to project_path) | Remote | Default branch | Notes |
|---|---|---|---|
| . (monorepo, one git repo) | `https://example.invalid/globex/shop.git` | main | no root build |
| `api/` | (same repo) | main | Spring Boot API |
| `web/` | (same repo) | main | Next.js storefront |

## Commands
| Purpose | Directory | Command |
|---|---|---|
| build (api) | `api` | `mvn package` |
| test (api, all) | `api` | `mvn test` |
| install (web) | `web` | `npm install` then copy .env.example |
| build (web) | `web` | `npm run build` |
| run (web, dev) | `web` | `npm run dev` (port 3000) |
| test (web) | - | none configured |

## Legacy Claude files
Former project CLAUDE.md and launch config: `legacy/`.
