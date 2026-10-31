# QA automation and test execution

Procedure and tooling for the QA engineer (frontend engineers use sections 4 and 7-8 for browser
review). `hades` = the CLI line from your handover. Deliverable formats (`06-test-plan.md`,
`07-qa-report.md`) are in your agent prompt. No evidence, no pass.

## 1. Test plan from acceptance criteria (plan mode, during build)
- Every `AC-n` in `01-business-solution.md` gets >= 1 `TC-n`; each TC row names its AC IDs. Add
  negative (invalid, unauthorised, wrong tenant), boundary (empty, max, duplicate) and state cases
  (empty, loading, error, success) from 01's edge cases and 04's states; regression cases for the
  areas 02 marks as adjacent.
- Type per TC: unit / integration / API / e2e (automated) or manual (visual judgement, exploratory,
  one-off checks that cost more to automate than to run). Manual needs a one-line reason.
- `hades task coverage <task>` must report no AC without a TC before you finish the plan.

## 2. Automation first
- Regression lives in the project's own suites: find the harness from `team.json` `commands.test`
  and existing tests (Glob `**/*.{test,spec}.*`, `tests/`, `src/test/`, `e2e/`); copy the nearest
  test's conventions (naming, fixtures, factories, helpers). Never add a second framework at a layer
  that already has one. Stack idioms: `playbooks/tech/<ecosystem>.md`.
- Pyramid: rules and calculations -> unit; contracts, persistence, authz -> API/integration; one e2e
  per critical user journey, not per field.
- E2E: use the project's tool if present (`playwright.config.*`, `cypress.config.*`, `wdio.conf.*`,
  Detox/Espresso/XCUITest). A web app with UI ACs and no e2e harness -> Playwright Test is the
  default; adding it is a dependency change outside your write scope, so state it in `06` and under
  DECISIONS (`@playwright/test` at an exact version >= 14 days old, `e2e/` folder, `test:e2e` script,
  base URL from an env var, chromium project) for the PM to assign; until it lands, run those TCs
  through Playwright MCP (section 4).
- Stable tests: role/label/test-id locators (`getByRole`, `getByLabel`, `getByTestId`;
  `browser_generate_locator` turns an MCP snapshot ref into one), web-first assertions, no fixed
  sleeps, each test creates its own data. Run new e2e tests 3 times (`--repeat-each=3` in Playwright)
  before trusting them. A test is never weakened, skipped or deleted to get green.

## 3. The system under test
- QA stage (before deploy): run the app locally with `team.json` `commands.run` in the background,
  wait with `curl -sS --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null -w "%{http_code}\n" <url>`,
  stop it when done. After deploy (verify rounds): the test environment URL from `08-deployment.md`.
- Live is never a test environment (section 10).

## 4. Exploratory and manual UI testing (Playwright MCP)
Tools appear as `mcp__playwright__<tool>` (load deferred ones in one ToolSearch call). Sequence:
1. `browser_navigate(url)`.
2. Locate: `browser_find(text | regex)` for one element (cheapest), or `browser_snapshot` scoped with
   `target` / `depth`. Snapshots are the accessibility tree: prefer them to screenshots, always.
3. Act with the `target` ref from the snapshot: `browser_click`, `browser_type(text, submit)`,
   `browser_fill_form(fields)`, `browser_select_option(values)`, `browser_press_key(key)`,
   `browser_hover`, `browser_file_upload(paths)`, `browser_handle_dialog`, `browser_navigate_back`,
   `browser_tabs`.
4. Wait: `browser_wait_for(text | textGone | time)`, never long fixed waits.
5. Assert: `browser_verify_element_visible(role, accessibleName)`, `browser_verify_text_visible`,
   `browser_verify_value`, `browser_verify_list_visible` (testing capability); else a scoped snapshot.
6. Side effects: `browser_console_messages(level="error")`, `browser_network_requests(filter="/api/")`,
   then `browser_network_request(index, part)` for one request.
7. `browser_take_screenshot` only for visual or layout checks and evidence; cite the saved path.
8. `browser_close` at the end.
Rules: omit `filename` arguments (a relative name resolves against the project root and dirties the
tree; auto-named files go to the server's output dir). `browser_evaluate` only for read-only
measurements. Never `browser_run_code_unsafe`, `browser_annotate` or `browser_start_recording`.
Stay on the app's origins. Log in with test accounts named in team notes (credentials by env-var
name); never write a credential into a report, defect or test file.

## 5. API testing
- Prefer the project's test client (supertest, REST Assured, httpx/pytest, WebApplicationFactory...)
  so the case becomes a regression test. Ad hoc: `curl -sS -X POST "$BASE/api/orders" -H "Content-Type: application/json" -H "Authorization: Bearer $QA_TOKEN" --data @<body.json> -w "\n%{http_code} %{time_total}s\n"`
  with bodies in files under the task folder (no shell quoting problems on Windows).
- Per endpoint: success shape against the contract in 02; 400 on invalid input; 401 without or with
  an expired token; 403/404 for another user's or tenant's object; 404 unknown ID; 409 or idempotent
  on repeats; pagination limits; error bodies without stack traces. Record request, status and a
  short body excerpt.

## 6. Test data
- Synthetic only. Create it through the project's seeds, factories or public API; prefix it
  (`qa-<task>-`) so cleanup is targeted; tear down in the test (after hooks) or at the end of the round.
- Touch only data you created. Never copy production data into tests or reports.

## 7. Cross-browser and responsive
- Run the project's configured browser projects (e.g. chromium, firefox, webkit) when the suite has
  them; the MCP browser is chromium.
- Widths with `browser_resize`: 375x812, 768x1024, 1280x800. Check navigation works, nothing is cut
  off, no horizontal scroll (`browser_evaluate(() => document.documentElement.scrollWidth > innerWidth)`).

## 8. Accessibility smoke
- Keyboard only: `browser_press_key("Tab")` through the flow; focus visible, logical order, no
  trap, Enter/Space activate, Escape closes dialogs (`document.activeElement` via `browser_evaluate`).
- Names: in the snapshot every input, button and link has an accessible name (`textbox "Email"`);
  a bare `textbox` or `img` without a name is a defect. One `h1`, ordered headings.
- Contrast and ARIA rules: run axe when the project has it (`@axe-core/playwright`, `jest-axe`,
  `axe-core`); otherwise record "contrast not measured". `browser_emulate_media` covers
  `reducedMotion`, `colorScheme`, `forcedColors`.

## 9. Performance smoke
- API: 10 sequential requests, `-w "%{time_total}"`, compare the median with 01's NFR targets.
- Page: `browser_evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }; })`;
  `browser_network_requests` for request count, N+1 patterns and oversized payloads.
- Load tests only with the project's own tool (k6, Locust, JMeter, Gatling) and only on test.

## 10. Live safety
Writes, sign-ups, orders, payments, emails/SMS, deletes, uploads and load happen on local or test
only. On live: read-only checks (health, page loads, navigation without submitting forms, GET APIs
with a test account's own data). If only live exists, run the destructive cases locally.
Smoke round (size L, after a deploy to test): only the TCs `06` marks `smoke`, against the test URL;
failures are defects as in section 11 (the PM commits the fix, DevOps redeploys, smoke again).

## 11. Defects
`hades defect add <task> --title "<symptom> on <screen/endpoint>" --severity <critical|high|medium|low> --owner <role> --source qa --repro "1. ... 2. ... 3. ... -> actual: ... (expected: ...); env <local|test URL>, commit <hash>, data <ids>" --refs <test file::name>,<suspect path:line> --evidence "07-qa-report.md#round-<n>"`
- Reproducible from the repro alone: numbered steps, exact input data, environment, commit.
- Severity by user impact: blocker = critical, major = high, minor = medium, trivial = low.
- Owner = the layer that fails (`backend-engineer`, `frontend-engineer`, `aiml-data-engineer`,
  `devops-engineer`); glue between layers (wiring, config keys, a seam mismatch) -> `tech-lead`; a
  failure needing changes in several layers -> one defect per layer, each owned by that layer's
  engineer, titles citing each other. One defect per root cause.
- Prefer a failing automated test as the reproduction; cite it in `--refs`.

## 12. Verifying fixes and the regression gate
1. `hades defect list <task> --open`; for each listed D#: re-run the repro and its regression test.
2. Pass: `hades defect update <task> <D#> --status verified --by qa-engineer --note "<evidence>"`.
   Fail: `--status reopened --note "<what still fails>"`.
3. Regression: `hades gate <task> --preset build` must exit 0, then the TCs adjacent to the fix.
   Record everything in the current round of `07-qa-report.md`.
