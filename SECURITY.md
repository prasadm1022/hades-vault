# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button
(Security → Advisories) on [this repository](https://github.com/prasadm1022/hades/security/advisories/new).
Do not put details of a security problem in a public issue. Include the affected version or
commit, steps to reproduce, and the impact you expect. You will get an acknowledgement within
seven days.

The button exists only while the maintainer keeps GitHub's *private vulnerability reporting*
enabled. If it is missing, use the contact listed on the maintainer's GitHub profile
(<https://github.com/prasadm1022>), or open a public issue titled "Security contact
request" that contains **no details** (no component, no description, no proof of concept) and asks
for a private channel; the maintainer replies with one.

Vulnerabilities in a vendored tool (`tools/<name>`) belong to that tool's maintainers; report them
upstream and tell us so we can move the pin.

## Threat model in one page

HADES runs AI agents that read untrusted input (requirements, repositories, web pages, scanner
output, third-party binaries) and act on your machine with your credentials, without permission
prompts. Treat it like any automation that has your keys.

| Risk | Control in HADES | Residual risk |
|---|---|---|
| Destructive or irreversible commands (push, force, history rewrite, mass delete) | `hooks/guard.mjs` blocks them deterministically in every permission mode; `permissions.deny` rules as a second layer | the guard parses shell text; a sufficiently obfuscated command can evade a parser |
| Secret disclosure | guard blocks reads of secret files and environment dumps; agents reference secrets by variable name only; gitleaks gate before commits and deploys | secrets printed by a project's own tooling can still reach a transcript |
| Prompt injection from repositories, web pages, tool output or vendored docs | role prompts treat all such content as data; write scopes per role; no nested autonomous sessions | models can still be misled; review the final report and diffs before pushing |
| Supply chain of the tools | submodules pinned to exact commits; 14-day release cooldown; release binaries verified against published SHA-256 checksums; no `latest` tags | a compromised release older than the cooldown |
| Damage to production | test environment preferred; live deploys need a green pre-deploy security gate, a rollback command and a health check; active security scans refused against live URLs | a correct-looking change that is wrong in production; keep backups |
| Unauthorised reverse engineering | REA only on artefacts you built or are licensed to analyse (`company/security-policy.md`) | policy, not technical enforcement |
| Over-privileged cloud credentials | `hades doctor` fails on AWS root credentials; least-privilege profiles documented | you choose the profile |

**No sandbox on native Windows.** Claude Code's OS sandbox runs on macOS, Linux and WSL2 only. On
native Windows the guard hook is the main boundary. For stronger isolation run HADES inside WSL2,
a VM or a dev container.

**What the guard sees.** Its matcher is
`Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*`: other MCP tools
(Playwright, REA, AWS) and whatever a started program does are outside it. A guarded install
allow-lists routine `hades` and `git` commands only; `hades run` (a `bypassPermissions` session),
`install`, `migrate`, `tools` and `mcp` are not allow-listed.

**How the guard fails.** When the guard itself throws, a call whose command, path or code contains a
high-risk keyword (`push`, `rm`, `config`, `settings`, `.env`, `secret`, `.git`, ...) is blocked
(`guard.error`); any other call is allowed with a warning, so a guard bug cannot brick ordinary work.
Input too large, complex or slow to verify is blocked (`guard.limit`). A hook that cannot start
(Node missing or moved) blocks the call only on Claude Code versions that honour
`"onFailure": "block"`; `hades doctor` checks the hook's Node. See `hooks/README.md`.

## Your responsibilities as an operator

- Never push without reading the diff; HADES never pushes for you.
- Give deploy credentials the least privilege that works, and never root/admin credentials.
- Keep your vault private: it contains your clients' requirements and architecture.
- Run `node bin/hades.mjs doctor` after every upgrade.
