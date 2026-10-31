# Security policy

Owner: cybersecurity-engineer. Procedures: `playbooks/security-testing.md`,
`playbooks/reverse-engineering.md`. Commands: `hades gate` (`docs/cli.md`). Report: `09-security-report.md`.

## 1. Source-level testing (every task)

| Area | How |
|---|---|
| Secrets | `secrets` step (gitleaks) over the working tree and the task commits |
| SAST | `sast` step (semgrep, `team.json` `security.semgrep_config`) |
| Dependencies, IaC, containers, SBOM | `deps` step (trivy fs); built images and SBOM with trivy when the task builds a container |
| Manual review | the task diff, against OWASP Top 10 and ASVS (level 2; level 3 for auth and payments) |

Manual review covers, each item verified OK or a finding: authentication (sessions, tokens, reset,
MFA); authorisation (object- and function-level, IDOR); tenant isolation; injection (SQL, NoSQL,
command, template, LDAP, header); XSS and output encoding; SSRF and outbound URL handling; path
traversal and uploads; deserialisation; crypto (algorithms, randomness, key handling, TLS
verification never disabled); secrets in code, config and logs; error handling and information
leaks; security logging without sensitive data; CSRF and CORS; rate limiting and abuse; dependency
trust; AI features (prompt injection, tool scope, data sent to models); IaC (public storage, open
network rules, wildcard IAM).

Scanner suppressions (`nosemgrep`, `.gitleaksignore`, `.trivyignore`) only by the cybersecurity
engineer, each with a reason comment, listed in `09`. Scanner severity is an input; the final
severity is reasoned in `09` (an unreachable vulnerable path is rated lower, with the reason).

## 2. Deployed-system testing

| Target | Allowed |
|---|---|
| live | passive only: `hades gate <task> --dast <url> --mode baseline`, header and TLS checks, authenticated read-only probes with test accounts. No state-changing requests, fuzzing, brute force or load. |
| test | baseline plus active: `--mode full`, `--mode api --openapi <url>`, fuzzing of changed endpoints, authorisation probes across two test accounts or tenants |
| local (app run from `team.json` `run` or `docker compose`) | as test; the target when no environment is deployed (`none`, `pending-push`, not provisioned) |

- DAST mode per environment: `team.json` `security.dast_live` (`baseline` | `none`) and
  `security.dast_test` (`baseline` | `full` | `api` | `none`), enforced by `hades gate --dast` (a
  mode above the setting is refused; `none` = no scan, recorded n/a); `security.semgrep_config`
  selects the SAST rules. Changed only with `hades team set <team> security <key> <value>`, with the
  reason in `09`.
- No deployed environment: the deployed-system round still runs, against the app started locally:
  `hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target`, the header
  checks and the authenticated probes; the app is stopped afterwards.
- Scope: only URLs of the team's environments or localhost. Exclude third-party hosts (identity
  providers, payment providers, CDNs, analytics) from scans.
- Rate limit: at most 10 requests/second and one active scanner per host. Stop at the first sign of
  harm (health check red, rising 5xx, 429s) and record it.
- Test accounts are named in team notes, credentials by env var; never real customer accounts.

## 3. Reverse engineering (REA)

Allowed artefacts:
- built by the company (this team's build outputs, release binaries of its own products);
- third-party artefacts the company is licensed or authorised in writing to analyse;
- open-source binaries whose licence permits it.

Never: bypassing DRM, licence checks, copy protection or anti-cheat; extracting third-party keys or
secrets; reproducing proprietary code; any artefact whose legal basis cannot be stated.

Every use gets a `## Reverse engineering` section in `09`: artefact (name, SHA-256), origin, legal
basis (own build, licence or authorisation reference, OSS licence), purpose, findings. No legal
basis -> do not analyse; record it and continue.

## 4. Data handling

- No customer or personal data in reports, defects, lessons, prompts or commit messages. Redact as
  `<redacted:email>`, `<redacted:token>`; never show part of a secret.
- Evidence = location (file:line, method + path, rule ID) plus a minimal excerpt.
- Raw scanner output stays in `<engine>/.hades/logs/<task>/` (local, not committed).
- Test data is synthetic. No code, findings or data go to external services beyond the tools' own
  rule and vulnerability-database downloads.

## 5. Severity

| Severity | Meaning | Handling |
|---|---|---|
| critical | trivially exploitable: RCE, authentication bypass, cross-tenant access, mass data exposure, a leaked live secret | blocks; never waived |
| high | exploitable with preconditions (an authenticated user, a specific config) for significant data exposure or privilege escalation; known-exploited dependency on a reachable path | blocks the stage |
| medium | limited impact or hard to exploit; defence-in-depth gaps | fix in the loop, or PM `wontfix` with reason + backlog |
| low | hardening and best practice | backlog |

Every finding states location, exploit scenario, impact, fix and evidence. No exploit scenario ->
low at most.

## 6. Disclosure

- Findings live only in the vault (`09`, `defects.json`) and the final report to the owner. Never
  in project files, issue trackers, pull requests or public channels.
- Commit messages describe the fix, not the exploit.
- Vulnerabilities in third-party components: recorded in `09` with advisory IDs; reporting upstream
  is the owner's decision.
