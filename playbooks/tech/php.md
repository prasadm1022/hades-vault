# PHP

## Detect
- `composer.json`, `composer.lock`; PHP version from `require.php` / `config.platform.php`.
- Laravel: `artisan`, `laravel/framework`. Symfony: `bin/console`, `symfony.lock`, `config/bundles.php`.
  WordPress: `wp-config.php`, `wp-content/`. Drupal: `core/`, `web/core/`.
- Tools: `phpunit.xml(.dist)`, `pest` in require-dev, `phpstan.neon(.dist)`, `psalm.xml`, `pint.json`,
  `.php-cs-fixer(.dist).php`, `phpcs.xml(.dist)`, `rector.php`. Frontend assets (Vite) in `package.json`:
  `javascript-typescript.md`.

## Commands (call tools as `php vendor/bin/<tool>`: works in sh, cmd and PowerShell)
| key | command |
|---|---|
| install | `composer install --no-interaction --prefer-dist --no-progress` |
| build | `composer validate --strict` + `composer dump-autoload -o`; Symfony `php bin/console lint:container`; assets `npm run build` |
| lint | Laravel `php vendor/bin/pint --test`; `php vendor/bin/php-cs-fixer fix --dry-run --diff`; `php vendor/bin/phpcs` |
| types | `php vendor/bin/phpstan analyse --no-progress --memory-limit=1G` (Larastan on Laravel); `php vendor/bin/psalm --no-progress` |
| test | `php vendor/bin/phpunit`; Laravel `php artisan test`; Pest `php vendor/bin/pest` |
| run | `php artisan serve`; Symfony `php -S 127.0.0.1:8000 -t public` (background) |
| format | as lint |

Migrations: Laravel `php artisan migrate --force` (`--force` = no prompt), `migrate:status`,
`migrate:rollback`; Doctrine `php bin/console doctrine:migrations:migrate --no-interaction`,
`doctrine:migrations:diff`. See `databases.md`.

## Layout
Laravel: `app/Http/Controllers`, `app/Models`, `app/Services` (if used), `routes/{web,api}.php`,
`database/{migrations,factories,seeders}`, `resources/views`, `tests/{Unit,Feature}`.
Symfony: `src/{Controller,Entity,Repository,Service}`, `config/`, `templates/`, `migrations/`, `tests/`.
PSR-4 autoload from composer.json; one class per file; `declare(strict_types=1);` if the project uses it.

## Testing
- PHPUnit or Pest. Laravel feature tests with `RefreshDatabase` (SQLite in-memory or a test DB from
  `phpunit.xml` env), factories for data, `Http::fake()`/`Queue::fake()`/`Mail::fake()` for side effects.
- Symfony: `KernelTestCase`, `WebTestCase` + test client; Doctrine fixtures for data.
- Browser: Laravel Dusk (needs Chrome) or Playwright (`../qa-automation.md`).
- Iterate: `php vendor/bin/phpunit --filter testCreatesOrder` or `php artisan test --filter=OrderTest`.

## Security
- `composer audit` (Composer 2.4+); trivy reads `composer.lock`.
- Review: raw queries (`DB::raw`, `whereRaw`, string-built DQL) without bindings, mass assignment
  (`$guarded = []`), `{!! !!}` / `|raw` output, `unserialize` on input, file uploads stored under
  `public/`, missing authorization (policies/voters/middleware) on new routes, CSRF exemptions,
  `APP_DEBUG=true` / Symfony debug in production, `APP_KEY`/`APP_SECRET` only from env.

## Pitfalls
- Missing extensions (intl, pdo_pgsql, gd) fail install: `composer check-platform-reqs` lists them.
- Never `composer update` unless the work item says so (rewrites composer.lock); add packages with
  `composer require vendor/pkg --no-interaction` and keep the lockfile diff in scope.
- Laravel caches (`config:cache`, `route:cache`) make env changes invisible: `php artisan optimize:clear`
  in development; never cache config in tests.
- `migrate:fresh`/`db:wipe` drop every table: local or throwaway databases only.
- `php artisan tinker` is a REPL: use `php artisan tinker --execute="..."` or a test instead.
- PHPStan without enough memory dies silently: keep `--memory-limit`.
- Windows: `php` must be on PATH with the same version the project requires; path case matters on Linux hosts.

## Small output
`composer ... --no-progress -q`; `phpunit --no-progress --stop-on-failure` (PHPUnit 10+);
`phpstan --no-progress --error-format=raw`; `pint --test` lists only failing files.
