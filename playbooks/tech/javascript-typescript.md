# JavaScript / TypeScript

## Detect
- `package.json`. Package manager: `packageManager` field, else lockfile: `package-lock.json` npm,
  `pnpm-lock.yaml` pnpm, `yarn.lock` yarn (`.yarnrc.yml` = Yarn 2+), `bun.lock`/`bun.lockb` bun.
- Deno: `deno.json(c)`. TypeScript: `tsconfig*.json`. Node version: `.nvmrc`, `.node-version`, `engines`.
- Frameworks: `next.config.*`, `nuxt.config.*`, `angular.json`, `svelte.config.*`, `vite.config.*`,
  `astro.config.*`, `nest-cli.json`; `express`/`fastify`/`hono` in dependencies.
- Monorepo: `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json` (one team.json project per app,
  or the runner: `npx turbo run test`, `npx nx run-many -t test`).

## Commands (npm shown; pnpm `pnpm <script>` / `pnpm exec`, yarn `yarn <script>`, bun `bun run` / `bunx`)
| key | command |
|---|---|
| install | `npm ci --no-audit --no-fund`; pnpm `pnpm install --frozen-lockfile`; yarn 2+ `yarn install --immutable` (v1 `--frozen-lockfile`); `bun install --frozen-lockfile`; `deno install` |
| build | `npm run build`; `deno task build` |
| lint | `npm run lint`, or `npx eslint . --quiet`; Biome `npx biome ci .`; `deno lint` |
| types | `npx tsc --noEmit`; Vue `npx vue-tsc --noEmit`; Svelte `npx svelte-check`; Astro `npx astro check`; `deno check <entry>` |
| test | runner directly, run-once: `npx vitest run`, `npx jest --ci`, `node --test`, `bun test`, `deno test`, Angular `npx ng test --watch=false` |
| run | `npm run dev` / `npm start` (background only) |
| format | `npx prettier --check .`; `deno fmt --check` |

Read `scripts` in package.json first: prefer the project's script names for build/lint, but call the
test runner directly when `scripts.test` starts watch mode (`vitest`, `jest --watch`, `ng test`).

## Layout
`src/`, colocated `*.test.ts`/`*.spec.ts` or `__tests__/`, e2e in `e2e/` or `tests/`. Next.js: `app/`
(App Router) or `pages/`, static in `public/`. NestJS: `src/<feature>/<feature>.{module,controller,service}.ts`,
unit `*.spec.ts`, e2e `test/*.e2e-spec.ts`. Monorepos: `apps/*`, `packages/*`.

## Testing
- Unit: Vitest (Vite projects), Jest (older/Nest/RN), `node:test` (libraries). Components: Testing Library.
- API: supertest against the app instance (Nest `Test.createTestingModule`). Mock HTTP with MSW or nock.
- E2E: Playwright `npx playwright test --reporter=line`; browsers once: `npx playwright install chromium`
  (Linux CI also `--with-deps`, needs root). Patterns: `../qa-automation.md`.
- One file while iterating: `npx vitest run src/x.test.ts`, `npx jest src/x.test.ts`, `-t "<name>"`.

## Security
- `npm audit --omit=dev --audit-level=high`; `pnpm audit --prod --audit-level high`. trivy reads all lockfiles.
- Review: `dangerouslySetInnerHTML`/`v-html`/`innerHTML`, `eval`/`new Function`, SSRF in server fetches,
  prototype pollution in deep merges, secrets in client bundles (only `NEXT_PUBLIC_`/`VITE_` vars ship to
  browsers, so never put secrets there), CORS and cookie flags.
- New dependency: check weekly downloads, maintainer, install scripts; prefer the platform API.

## Pitfalls
- `npx <bin>` runs a same-named registry package when the bin is not in `node_modules/.bin` (the `tsc`
  package is not TypeScript, and `--no-install` does not reliably stop it). Check the bin exists, or name
  the package: `npx -p typescript tsc --noEmit`.
- Solution-style root tsconfig (`"files": []` + `references`, Vite templates) checks nothing with
  `tsc --noEmit`: use `npx tsc -b` or `npx tsc --noEmit -p tsconfig.app.json`.
- npm runs scripts with cmd.exe on Windows: `rm -rf`, `VAR=x` and `&` in scripts break; use the
  project's cross-platform helpers (rimraf, cross-env) if already present.
- Telemetry/prompts: set `NEXT_TELEMETRY_DISABLED=1`, `NG_CLI_ANALYTICS=false`; Angular Karma needs
  `--browsers=ChromeHeadless`. `next build` also type-checks: run it once, not in every loop.
- Dev servers keep running and lock `node_modules` on Windows (EPERM on `npm ci`): stop them first.
- Mixed ESM/CJS: check `"type"` in package.json and `module`/`moduleResolution` in tsconfig before
  adding imports; Jest needs a transform for ESM/TS (ts-jest or @swc/jest).
- Do not switch package managers or regenerate lockfiles; the lockfile in the repo decides.

## Small output
`npm ci --no-audit --no-fund --loglevel=error`; `vitest run --reporter=dot`; `jest --ci --silent`;
`eslint --quiet`; `tsc --noEmit --pretty false 2>&1 | head -30`; `playwright test --reporter=line`.
