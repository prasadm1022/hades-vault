# Third-party notices

HADES is MIT-licensed (see `LICENSE`); that license covers the HADES source in this repository
only. It integrates the third-party tools below. They are
included as **git submodules** under `tools/`, pinned to the commits in `tools/tools.lock.json`.
HADES does not copy, modify or link their code: it runs them as separate programs (command-line
tools, MCP servers over stdio, or container images). Each tool remains under its own license,
whose full text is in the submodule at the paths listed. When you redistribute a tool (for
example a built binary or a packaged copy), you must follow that tool's license.

| Tool | Pinned version | License | License files (inside `tools/<name>/`) | How HADES uses it |
|---|---|---|---|---|
| [REA](https://github.com/morluto/rea) | `rea-agents-6.5.0` | MIT (bundled third-party parts under their own licenses, see its `THIRD_PARTY_NOTICES.md` and `licenses/`) | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `licenses/` | reverse engineering MCP server for the cybersecurity engineer and software architect |
| [Serena](https://github.com/oraios/serena) | `v2.0.0` | GPL-3.0-or-later (Serena application) and MIT (SolidLSP) | `LICENSE`, `LICENSES/` | symbol-level code navigation MCP server, run as a separate process |
| [ccusage](https://github.com/ryoppippi/ccusage) | `v20.0.34` | MIT | `apps/ccusage/LICENSE` | token and cost reports |
| [Semgrep CE](https://github.com/semgrep/semgrep) | `v1.181.0` | LGPL-2.1 (engine); rules from the Semgrep Registry have their own terms | `LICENSE`, `COPYRIGHT` | static application security testing |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | `v8.30.1` | MIT | `LICENSE` | secret scanning |
| [Trivy](https://github.com/aquasecurity/trivy) | `v0.76.0` | Apache-2.0 | `LICENSE`, `NOTICE` | dependency, IaC, container and SBOM scanning |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | `v0.0.83` | Apache-2.0 | `LICENSE` | browser automation MCP server for QA and frontend |
| [ZAP](https://github.com/zaproxy/zaproxy) | `v2.17.0` | Apache-2.0 (Paros-derived parts: Clarified Artistic License; bundled libraries under their own licenses, listed in `LEGALNOTICE.md`) | `LICENSE`, `LEGALNOTICE.md` | dynamic application security testing (container image) |
| [AWS Agent Toolkit](https://github.com/aws/agent-toolkit-for-aws) | commit `44ba1a5` | Apache-2.0 | `LICENSE`, `NOTICE` | official AWS skills and rules, read on demand by the DevOps engineer |
| [MCP Proxy for AWS](https://github.com/aws/mcp-proxy-for-aws) | `v1.7.0` | Apache-2.0 | `LICENSE`, `NOTICE` | local proxy that connects the AWS MCP server with a named AWS profile |

## Notes

- **GPL and LGPL tools.** Serena (GPL-3.0-or-later) and Semgrep CE (LGPL-2.1) are used only as
  separate programs that HADES starts and talks to through standard interfaces. HADES's own code
  stays MIT. If you ship a copy of Serena or Semgrep, its license terms apply to that copy.
- **Apache-2.0 NOTICE files.** Trivy, the AWS Agent Toolkit and MCP Proxy for AWS include `NOTICE`
  files. Keep them with any redistributed copy (Apache-2.0 section 4(d)).
- **ZAP legal notice.** ZAP is a fork of Paros Proxy, whose parts remain under the Clarified
  Artistic License, and it bundles libraries under their own licenses (Apache-2.0, LGPL, GPL with
  the classpath exception, EPL and others). `tools/zaproxy/LEGALNOTICE.md` lists them; keep it with
  any redistributed copy. HADES itself runs ZAP from its upstream container image and ships none
  of it.
- **Rules and data.** Scanner rule sets and vulnerability databases downloaded at run time
  (Semgrep Registry rules, the Trivy vulnerability DB, ZAP add-ons) are provided by their
  publishers under their own terms.
- **Trademarks.** Product names are trademarks of their owners. Their use here identifies the
  tools and implies no endorsement.
- **Reverse engineering.** REA's own `DISCLAIMER.md` limits use to lawful analysis of software you
  own or are authorized to examine. HADES enforces the same rule in `company/security-policy.md`.
