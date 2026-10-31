# Databases and migrations

## Detect
Migration folders and tool config (table below), DB services in `compose.yaml`, `DATABASE_URL`/`DB_*` names
in `.env.example`, drivers in deps (pg, psycopg, mysql2, mysqlclient, sqlite3, mongodb/mongoose, redis/ioredis).

## Migration tools (create / apply / status / revert)
| Ecosystem | Tool | Create | Apply | Status | Revert |
|---|---|---|---|---|---|
| Node | Prisma | `npx prisma migrate dev --name <x>` (local DB only) | `npx prisma migrate deploy` | `npx prisma migrate status` | forward-fix |
| Node | Drizzle | `npx drizzle-kit generate` | `npx drizzle-kit migrate` | - | forward-fix |
| Node | Knex | `npx knex migrate:make <x>` | `npx knex migrate:latest` | `npx knex migrate:list` | `npx knex migrate:rollback` |
| Node | TypeORM | `npx typeorm migration:generate <path>/<X> -d <ds>` | `npx typeorm migration:run -d <ds>` | `migration:show -d <ds>` | `migration:revert -d <ds>` |
| Python | Alembic | `alembic revision --autogenerate -m "<x>"` | `alembic upgrade head` | `alembic current`; drift: `alembic check` | `alembic downgrade -1` |
| Python | Django | `python manage.py makemigrations` | `python manage.py migrate --noinput` | `showmigrations` | `migrate <app> <previous>` |
| JVM | Flyway | file `V<n>__<desc>.sql` | `flyway migrate` (Spring Boot: on startup) | `flyway info` | forward-fix |
| JVM | Liquibase | changeset in changelog | `liquibase update` | `liquibase status` | `liquibase rollback-count --count=1` |
| .NET | EF Core | `dotnet ef migrations add <X>` | `dotnet ef database update` | `dotnet ef migrations list` | `dotnet ef database update <Previous>` |
| Ruby | Rails | `bin/rails g migration <X>` | `bin/rails db:migrate` | `bin/rails db:migrate:status` | `bin/rails db:rollback` |
| PHP | Laravel | `php artisan make:migration <x>` | `php artisan migrate --force` | `migrate:status` | `migrate:rollback` |
| Go | golang-migrate | `migrate create -ext sql -dir db/migrations -seq <x>` | `migrate -path db/migrations -database "$DATABASE_URL" up` | `... version` | `... down 1` |
| Go | goose | `goose -dir db/migrations create <x> sql` | `goose -dir db/migrations postgres "$DATABASE_URL" up` | `... status` | `... down` |
| Rust | sqlx / diesel | `sqlx migrate add -r <x>` / `diesel migration generate <x>` | `sqlx migrate run` / `diesel migration run` | `sqlx migrate info` / `diesel migration list` | `sqlx migrate revert` / `diesel migration revert` |
| Elixir | Ecto | `mix ecto.gen.migration <x>` | `mix ecto.migrate` | `mix ecto.migrations` | `mix ecto.rollback` |
| MongoDB | migrate-mongo | `npx migrate-mongo create <x>` | `npx migrate-mongo up` | `npx migrate-mongo status` | `npx migrate-mongo down` |

## Safe migration rules
- Never edit an applied migration; add a new one. One concern per migration; schema and data migrations separate.
- Parallel work items must not create colliding migration numbers/timestamps: the tech lead assigns order.
- Expand -> migrate -> contract: add new structures, dual-write/backfill, switch reads, remove old ones in a
  later release. Never rename or drop a column in the release that stops using it.
- PostgreSQL: `SET lock_timeout = '5s'` before DDL on busy tables; `CREATE INDEX CONCURRENTLY` (outside a
  transaction: Rails `disable_ddl_transaction!`, Django `AddIndexConcurrently` + `atomic = False`, Alembic
  `autocommit_block()`); FKs and CHECKs as `NOT VALID` then `VALIDATE CONSTRAINT`; NOT NULL via a validated
  `CHECK (col IS NOT NULL)` first (PG 12+ then skips the scan); `ADD COLUMN ... DEFAULT <constant>` is instant (PG 11+).
- MySQL: DDL commits implicitly (a failed multi-step migration leaves partial state): one DDL per migration;
  prefer `ALGORITHM=INSTANT` / `INPLACE, LOCK=NONE` where supported.
- SQLite: limited `ALTER TABLE` (tools rebuild the table); foreign keys are off unless `PRAGMA foreign_keys=ON`.
- MongoDB: version documents (`schemaVersion`), migrate lazily on read plus a batched backfill; large index
  builds off-peak. Redis: version key prefixes for format changes; `SCAN`, never `KEYS`, in shared instances.
- Backfills in batches with a bounded transaction size; never one statement over a large table.
- Destructive steps (drop, truncate, delete data) need a backup and a recorded rollback; on live data they
  make the work item opus-escalated (`../../company/model-routing.md`).
- Verify every migration: apply on an empty DB, apply on a DB with representative data, run the app's
  tests, and revert (where the tool supports it) then re-apply.

## Seeding and test data
- Seeds are idempotent (upserts), deterministic and synthetic: never copies of production data or PII.
- Commands: `npx prisma db seed`, `python manage.py loaddata <fixture>`, `bin/rails db:seed`,
  `php artisan db:seed --force`, `mix run priv/repo/seeds.exs`; test data via factories, not shared seeds.
- Throwaway DB: Testcontainers, or `docker run -d --rm --name <app>-pg -e POSTGRES_PASSWORD -p 5432:5432 postgres:<major>`
  (value from env); compose service from the project if one exists.

## Security
- Parameterised queries only; least-privilege app user (no DDL rights at runtime where the platform allows).
- Connection strings and passwords by env-var name (`PGPASSWORD`, option files), never on the command line
  or in migration files; TLS to managed databases.
- Never print full tables or dumps: they may hold personal data.

## Pitfalls and small output
- `prisma migrate dev`/`reset`, `migrate:fresh`, `db:reset`, `ecto.reset`, `dotnet ef database drop` drop data: local only.
- Queries: `psql -X -q -A -t -v ON_ERROR_STOP=1 -c "<sql>"`, `mysql -B -N -e "<sql>"`, `mongosh --quiet --eval "<js>"`,
  always with `LIMIT` / projections / counts.
