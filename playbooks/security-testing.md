# Security testing

Procedure for the security stage (cybersecurity engineer); DevOps uses section 1 for the pre-deploy
gate. Policy: `company/security-policy.md` (it wins on conflict).
`<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.
Every finding rests on tool output or a reproducible request, never on opinion. Order: automated scans -> triage -> manual review -> built artefacts ->
deployed system -> record -> retest. Write `09-security-report.md` with the skeleton in your agent
prompt, one `## Round <n>` per round.

## 1. Automated source-level scans
- `hades gate <task> --preset security` runs `secrets` (gitleaks), `sast` (semgrep, ruleset from
  `team.json` `security.semgrep_config`) and `deps` (trivy fs: vulnerable dependencies, IaC
  misconfigurations) on every project. Exit 2 = red. Critical/high fail a step; lower ones are counts.
- A step with status `error` means the tool is missing: run `hades doctor` / `hades tools setup <name>`
  and re-run. `error` and `n/a` are never "passed"; say so in the report.
- Size S: this gate plus a review of the diff is the whole source-level job.
- Reports and logs live in `<engine>/.hades/logs/<task>/` (each step prints its `log` path; also in
  `gates.json`). Read only the findings you need - project fields, never cat a whole report:
  `node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));for(const x of r.results)console.log(x.extra.severity,x.check_id,x.path+':'+x.start.line)" <semgrep json>`
  | Tool | Fields worth projecting |
  |---|---|
  | semgrep | `results[].check_id, path, start.line, extra.severity, extra.message` |
  | gitleaks | `[].RuleID, File, StartLine, Fingerprint` (values are `REDACTED`; never un-redact) |
  | trivy | `Results[].Vulnerabilities[].VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity`; `.Misconfigurations[].ID, Title, Severity`; `.Secrets[].RuleID, StartLine` |
- Deeper investigation only (same pinned tools, absolute paths, output files in the logs dir):
  - custom rule to hunt one pattern: `hades tools run semgrep -- scan --config <rule.yml> --metrics=off --disable-version-check --oss-only --quiet --json --output <file> <dir>`
  - secrets in git history: `hades tools run gitleaks -- git <repo> --no-banner --redact -f json -r <file>`
  - never semgrep `--autofix`/`--pro`/`login`; never gitleaks without `--redact`; trivy always with
    `--disable-telemetry --skip-version-check`.

## 2. Triage and suppressions
- Open every critical/high (and medium in changed code) at the cited lines (Serena `find_symbol` or
  Read by range). Verdict: true positive (-> defect), false positive, or lower real severity - each
  with evidence: input constant or validated at `path:line`, test fixture, dev-only dependency not
  shipped, vulnerable function unreachable (unknown reachability = reachable). Record every verdict
  under the round's `### Tools` (tool, rule/ID, location, verdict, reason).
- Suppress only false positives and findings whose reasoned severity is below the gate threshold
  (CVEs then get an expiry), at the narrowest scope (one line, fingerprint or CVE; a path only for
  generated or vendored code). No reason recorded in `09` = no suppression. Native forms:
  - semgrep: `nosemgrep: <rule-id>` at the end of the flagged line (or alone on the line above),
    reason in a comment before it; generated/vendored paths in `.semgrepignore`.
  - gitleaks: fingerprint (`file:rule:line` or `commit:file:rule:line`) in `.gitleaksignore`, with a
    `# reason` line above it.
  - trivy: `.trivyignore` line `CVE-2025-1234 exp:YYYY-MM-DD` with a `# reason` line above it.
- You decide suppressions; your write scope is the task folder. Hand each entry to the owning
  engineer as a `low` defect titled `Add scanner suppression: <tool> <rule> at <file>` whose repro
  quotes the exact lines to add. Reason comments say why it is safe, never how to exploit anything.
- Never suppress a real secret: a committed live secret is `critical`; owner `devops-engineer` moves
  it to an environment variable. History is never rewritten, so the report states "rotation required".
- After the entry lands, re-run the gate. If the gate ignores the file, never weaken the gate: keep
  the finding with its reasoned severity in `09` and put it under DECISIONS.

## 3. Manual review (sizes M and L; S = diff only)
Scope: the task commits (`hades task show <task>`; `git -C <repo> show --stat <hash>`, then filtered
diffs) plus the trust boundaries they touch (routes, handlers, auth middleware, data access, jobs,
webhooks, AI calls). Trace source -> sink with Serena `find_referencing_symbols`. ASVS level 2 (level
3 for auth and payments). Record each relevant row as verified-OK or a finding.
| Area | OWASP 2021 | ASVS 5.0 (4.0.3) | Look for |
|---|---|---|---|
| Authentication | A07 | V6 (V2) | slow password hash (argon2id/bcrypt/scrypt), reset tokens single-use and expiring, no user enumeration, lockout/throttle, MFA where required |
| Sessions, tokens | A07 | V7, V9 (V3) | session rotated on login, server-side logout, cookie Secure/HttpOnly/SameSite, JWT algorithm pinned, signature + `exp`/`aud`/`iss` checked, no tokens in URLs |
| Authorisation, IDOR | A01 | V8 (V4) | every handler checks the caller's right to *this* object, deny by default, client IDs never trusted, admin routes, mass assignment |
| Multi-tenancy | A01 | V8 (V4) | tenant from the session, never from the request; every query, cache key, search index, file path, queue and job scoped by tenant; fails closed |
| Injection | A03 | V1, V2 (V5) | parameterised SQL (no string-built or raw ORM queries), NoSQL operators (`$ne`, `$where`) blocked by type checks, no shell with user input (argument arrays only), no user input as template source, LDAP, CRLF in headers/logs |
| XSS | A03 | V1, V3 (V5) | context-aware encoding; `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, template `safe` filters; sanitised markdown; `javascript:` URLs; CSP |
| CSRF | A01 | V3 (V4) | cookie-authenticated state changes need a token or SameSite; no state change on GET; CORS is not CSRF protection |
| SSRF | A10 | V1 (V5, V12) | user-supplied URLs fetched server-side: allow-list, block private and metadata ranges, no redirects to them |
| Deserialisation | A08 | V1 (V5) | no native deserialisation of untrusted data (Java serialisation, pickle, BinaryFormatter, unsafe YAML, `unserialize`), polymorphic JSON typing off |
| File upload, paths | A04, A01 | V5 (V12) | size limit, type by content, random names outside the web root, no path traversal or zip slip, served as attachment with `nosniff` |
| Secrets, configuration | A05 | V13 (V14) | no secrets in code, fixtures, images or logs; debug off; no default credentials; no stack traces to users; IaC: no public storage, open network rules or wildcard IAM |
| Cryptography | A02 | V11, V12 (V6, V9) | vetted libraries, AEAD ciphers, CSPRNG tokens, no MD5/SHA-1 for security, keys from env or KMS, TLS verification never disabled |
| Logging | A09 | V16 (V7) | security events logged with user/tenant/request id; no passwords, tokens, card numbers or unneeded PII in logs |
| Rate limiting, abuse | A04, A07 | V2, V6 (V11, V2) | limits on login, reset, OTP, sign-up, expensive and AI endpoints; per user/IP/tenant; 429 + `Retry-After` |
| CORS | A05 | V3 (V14) | allow-list; never a reflected origin or `*` with credentials; no `null` origin |
| Security headers | A05 | V3 (V14) | CSP, HSTS, `nosniff`, `frame-ancestors`/X-Frame-Options, Referrer-Policy |
| Dependency risk | A06 | V15 (V14) | lockfile committed and pinned; new dependencies checked for licence, maintenance and install scripts; trivy `deps` result |
| Business logic | A04 | V2 (V11) | skipped workflow steps, negative or huge amounts, races (double spend), replay, idempotency |
| AI / prompt injection | LLM Top 10 2025 | - | user input, retrieved documents and tool output are data; model output never executed or rendered unescaped; model tools act with the end user's rights and server-side authz; confirmation for destructive actions; retrieval scoped per tenant; no secrets in prompts; data sent to providers minimised; token and cost limits |

## 4. Built artefacts
- Binaries, bundles, packages: REA per `playbooks/reverse-engineering.md` (legal gate first).
- Container images built for this task:
  `hades tools run trivy -- image --image-src docker --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --ignore-unfixed --exit-code 3 --format json --output <abs file> --disable-telemetry --skip-version-check --quiet <image:tag>`
  Exit 3 = findings, 1 = tool error, 0 = clean. SBOM: same command with `--format cyclonedx` and no
  `--exit-code`. Confirm the image runs as non-root (trivy misconfig / Dockerfile `USER`).

## 5. Deployed system
Target: URL and environment from `08-deployment.md` Summary and `hades task show <task>`; a local run
(`team.json` `run`) counts as test. Only the team's environments or localhost; exclude third-party
hosts (identity, payment, CDN, analytics). At most 10 requests/second and one active scanner per
host; stop at the first sign of harm (health red, rising 5xx, 429s) and record it.
- No deployed environment (`08`: `none`, `pending-push`, not provisioned): test the running system
  locally. Start the app in the background (`team.json` `commands.run`, else `docker compose up -d`),
  wait until its port answers, then
  `hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target` plus the
  header, probe and rate-limit checks below against it; stop it afterwards (`docker compose down`
  or end the process). Record "local" as the environment in `09`.
- DAST: `hades gate <task> --dast <url> --mode baseline` on any environment; on test also
  `--mode full`, or `--mode api --openapi <spec url>` for APIs (size L: required). The CLI refuses
  full/api on the live URL; never work around it (other hostname, IP, alias). It also applies
  `team.json` `security.dast_live` (`baseline|none`) and `security.dast_test`
  (`baseline|full|api|none`): a refused mode or `none` is recorded n/a with the setting, never forced.
- Headers and TLS (read-only, fine on live):
  - `curl -sS -D - -o /dev/null https://<host>/` -> HSTS, CSP, `nosniff`, frame-ancestors or
    X-Frame-Options, Referrer-Policy, cookie flags, no version banners (`Server`, `X-Powered-By`).
  - `curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" http://<host>/` -> 301/308 to https.
  - `curl -sS -o /dev/null --tlsv1.0 --tls-max 1.1 https://<host>/` must fail (TLS <= 1.1 off); a plain
    `curl -sS -o /dev/null https://<host>/` must succeed (valid chain); certificate not expiring in 30 days.
  - CORS: `curl -sS -D - -o /dev/null -H "Origin: https://evil.example" <api url>` must not echo the origin.
- Authenticated probes: test accounts named in team notes, credentials by env-var name
  (`-H "Authorization: Bearer $VAR"`), never printed. Live: GET only and only test accounts' data
  (cross-account check between two test accounts: A reads B's object -> 403/404; no or expired token
  -> 401; admin routes as a normal user). Write probes and cross-tenant probes otherwise: test only.
- Rate limiting, test only: ~30 requests to login/reset/expensive endpoints (spread to <= 10/s) must
  hit 429 or lockout. On live verify configuration only; never brute force, never lock an account.
- Never on live: active scans, fuzzing, injection payloads, test uploads, account creation, load,
  anything that sends email/SMS or moves money. A probe that changes state unexpectedly: stop,
  record, continue with the safe checks.

## 6. Record findings
- One defect per root cause, CWE in the title:
  `hades defect add <task> --title "CWE-639 IDOR: GET /api/orders/{id} returns another account's order" --severity high --owner backend-engineer --source security --repro "1. login as test user A 2. GET /api/orders/<B id> -> 200 with B data; expected 404" --refs src/orders/routes.ts:42 --evidence "09-security-report.md#round-1"`
- Severity per policy §5 (critical is never waived; no exploit scenario -> low at most). Scanner
  severity and CVSS are inputs; the reasoned severity goes in `09`.
- Owner: code -> the engineer of that layer (`backend-engineer`, `frontend-engineer`,
  `aiml-data-engineer`); headers, TLS, infra, deploy config, secrets handling -> `devops-engineer`;
  dependency upgrade -> the engineer owning that project; glue between layers (wiring, config keys,
  a mismatch at a seam) -> `tech-lead`; a cross-cutting design flaw -> one defect per affected
  layer, owned by that layer's engineer (`backend-engineer` for server-side authorisation), titles
  citing each other.
- Evidence = location (file:line, method + path, rule ID) + minimal excerpt + log/report path.
  Redact as `<redacted:email>`, `<redacted:token>`; never show any part of a secret.

## 7. Retest (assignment "re-verify D#...")
Pipeline: engineer fixes -> QA verifies -> PM commits -> DevOps redeploys -> you re-verify. Per D#:
1. Repeat the original repro against the redeployed system and check the code change.
2. Re-run the tool that produced the finding (the gate step, the same `--dast` mode, trivy image).
3. Fixed -> note it in this round of `09`. Not fixed ->
   `hades defect update <task> <D#> --status reopened --by cybersecurity-engineer --note "<evidence>"`;
   after round 3 the CLI marks it blocked and the final report says so.
4. Re-check only the finding's scope unless the fix was broad; new findings become new defects.
