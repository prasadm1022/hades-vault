# Ruby

## Detect
- `Gemfile`, `Gemfile.lock` (incl. `BUNDLED WITH` version), `.ruby-version` / `.tool-versions`, `*.gemspec`.
- Rails: `bin/rails`, `config/application.rb`; Sinatra/Rack: `config.ru`; Hanami: `config/app.rb`.
- Tests: `spec/` + `.rspec` (RSpec) or `test/` (Minitest). Lint: `.rubocop.yml`. Types: `sorbet/`, `Steepfile`.

## Commands (Rails 7.2+ ships `bin/rubocop` and `bin/brakeman` binstubs)
| key | command |
|---|---|
| install | `bundle install` (CI: `bundle config set --local frozen true` first, so Gemfile.lock is not rewritten) |
| build | Rails: `bin/rails zeitwerk:check` (autoload check); assets: `SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile` in a script |
| lint | `bundle exec rubocop --format simple` |
| types | Sorbet `bundle exec srb tc` / Steep `bundle exec steep check` if configured, else n/a |
| test | `bundle exec rspec` or `bin/rails test` (system tests: `bin/rails test:system`) |
| run | `bin/rails server` / `bin/dev` (background) |
| format | as lint (`rubocop` covers layout); `standardrb` projects: `bundle exec standardrb` |

Database (Rails): test DB `RAILS_ENV=test bin/rails db:prepare` (in a script or env), migrate
`bin/rails db:migrate`, status `bin/rails db:migrate:status`, undo `bin/rails db:rollback`, seed
`bin/rails db:seed`. Commit `db/schema.rb` (or `structure.sql`) with every migration. See `databases.md`.

## Layout
Rails: `app/{models,controllers,views,jobs,mailers,services}`, `config/routes.rb`, `db/migrate`,
`lib/`, `spec/{models,requests,system}` or `test/{models,controllers,integration,system}`,
factories in `spec/factories` / fixtures in `test/fixtures`. Gems: `lib/<gem>/`, `spec/`.

## Testing
- RSpec (request specs over controller specs) or Minitest; FactoryBot; WebMock/VCR for outbound HTTP.
- System tests: Capybara with headless Chrome (Selenium or Cuprite); keep them few and stable.
- Iterate: `bundle exec rspec spec/requests/orders_spec.rb:42`, `bin/rails test test/models/order_test.rb:42`.
- Jobs: test adapter (`ActiveJob::Base.queue_adapter = :test`) and `perform_enqueued_jobs`.

## Security
- `bundle exec brakeman -q --no-pager` (Rails SAST); `bundle exec bundle-audit check --update` if the
  gem is present. trivy reads `Gemfile.lock`.
- Review: `find_by_sql`/`where("... #{x}")` interpolation, `permit!` / missing strong params, `html_safe`/`raw`,
  `send`/`constantize` on params, `skip_before_action :verify_authenticity_token`, open redirects
  (`redirect_to params[...]`), `YAML.load`/`Marshal.load` on input, secrets outside credentials/env.

## Pitfalls
- Never `bin/rails console`, `irb` or `rails credentials:edit` (interactive): use
  `bin/rails runner 'puts Order.count'`; secrets come from env vars named in the project config.
- Leftover `binding.pry` / `debugger` hangs the test run: grep before running suites.
- Spring preloader (older apps) serves stale code: `DISABLE_SPRING=1`.
- `bundle update` rewrites the lockfile: only when a work item asks. New platform for deploy:
  `bundle lock --add-platform x86_64-linux` (lockfile change, in scope only for deploy work).
- Windows: native gems need the RubyInstaller DevKit (MSYS2); if a gem cannot build, run in the project's
  Docker/devcontainer if it has one and record it.
- `db:reset`/`db:drop`/`db:schema:load` destroy data: local or throwaway databases only.

## Small output
`rspec --format progress --fail-fast`; `rubocop --format simple` (or `--format quiet` to print nothing
when clean); `bin/rails test 2>&1 | tail -30`; `brakeman -q`.
