# Launch kit

Copy for making the repository public: the GitHub About fields, the social preview and draft posts.
Everything here describes what the repository does today; recheck each list's rules on the day you
submit, because they change.

## GitHub About box

**Description** (the gear icon next to "About" on the repository page):

> Open-source autonomous AI software company for Claude Code. A team of AI agents (business analyst, architect, backend, frontend, QA, DevOps, security) takes a requirement through design, build, tests, security scans and local commits. Multi-agent coding with guard hooks; exports to Codex, Cursor, Gemini CLI and Copilot.

**Website:** leave empty, or point it at the README (`https://github.com/prasadm1022/hades-vault#readme`).

**Topics** (GitHub allows 20):

```text
claude-code, claude, anthropic, ai-agents, multi-agent, multi-agent-systems, autonomous-agents,
ai-software-company, agentic-ai, agentic-coding, ai-coding, coding-agent, claude-code-subagents,
subagents, llm, sdlc, software-engineering, devops, code-generation, mcp
```

Optional, so the npm metadata matches: the `keywords` in `package.json` can take the same terms
(the package is `private`, so this affects nothing published).

## Social preview

GitHub does not use the animated README hero for link previews. Upload a static image under
**Settings > General > Social preview**:

- PNG (or JPG), **1280x640**, under 1 MB.
- Export one frame of `docs/assets/hades-hero.svg` (its canvas is already 1280x640). For example,
  open the SVG in a browser window sized to 1280x640 and take a screenshot when the head faces the
  viewer, or render it with any SVG-to-PNG tool. Keep the name and tagline legible (WCAG AA contrast on the dark
  background).
- The preview controls how links look on X, LinkedIn, Slack, Discord and Reddit (Hacker News
  shows no link previews); it does not affect search ranking.

## Before you announce

- Repository public, description, topics and social preview set.
- Private vulnerability reporting enabled (see the publishing checklist in
  [`getting-started.md`](getting-started.md)).
- CI green on the default branch.
- The quick start in the README run once on a clean machine.
- No `.vault/`, `hades.config.json`, `.hades/` or `.tools-bin/` in the published history
  (`git ls-files` lists none of them, and
  `git log --all --oneline -- .vault vault hades.config.json .hades .tools-bin` prints nothing).

Never buy stars or ask people to upvote: GitHub and Hacker News both penalise it.

## Show HN

Post Tuesday to Thursday, US morning, and stay in the thread to answer questions. No ALL-CAPS
emphasis, exclamation marks or superlatives in the title.

**Title**

```text
Show HN: HADES – an open-source AI software company built on Claude Code
```

**URL:** `https://github.com/prasadm1022/hades-vault`

**Text**

```text
HADES turns a Claude Code session into a small software company. You state a requirement; the main
session acts as project manager and runs it through role subagents: business analyst, architect,
tech lead, backend, frontend, AI/ML/data and QA engineers, DevOps and security.

A few design choices I'd like feedback on:

- A stage passes on tool evidence, not on an agent's word: build/test/scanner gates, acceptance
  criteria mapped to passing test cases, health checks, and no open critical/high defects.
- Safety is code, not prompt text: a PreToolUse guard hook plus deny rules block git push,
  destructive git, secret reads and publishing, in every permission mode and inside subagents.
  It ends with local commits and a report; you review and push.
- Token use: file handoffs of at most 15 lines, one-line gate output, Serena for symbol-level
  navigation, and model routing per role.
- Pinned open-source tools as submodules: Gitleaks, Semgrep, Trivy, ZAP, Playwright MCP, Serena.
- `hades export` renders the same setup for Codex, Cursor, Gemini CLI, Copilot, Devin, Cline and
  OpenCode (formats from vendor docs; Claude Code is the only fully supported platform).

Limits: the guard reads shell text and is not a sandbox (use WSL2/VM/container for isolation), and a
change can pass every gate and still be wrong, so you still read the diff.

MIT licensed, Node 22, zero npm dependencies in the CLI. Happy to answer questions.
```

## Reddit

Best fit: r/ClaudeAI and r/ClaudeCode. r/opensource and r/SideProject also work. Read each
subreddit's self-promotion rules first; on r/programming lead with a technical write-up rather than
the repository link. r/LocalLLaMA is about local models and HADES needs Claude, so skip it.

**Title**

```text
I built HADES: Claude Code subagents organised as a software company (analysis -> build -> QA -> security -> local commits)
```

**Body**

```text
HADES is an open-source (MIT) layer on top of Claude Code. You type
/hades <team> <requirement> and your main session becomes a project manager that runs the work
through role subagents: business analyst, architect, tech lead, backend, frontend, AI/ML/data, QA,
DevOps and cybersecurity.

What makes it different from a single session:
- Acceptance criteria first, then a validated work plan, then parallel build waves.
- QA and security are separate agents; a stage only passes on gate evidence (build, tests,
  Gitleaks, Semgrep, Trivy, ZAP on test targets), never on an agent's claim.
- A deterministic guard hook blocks git push, destructive git and secret reads. It commits locally
  and you push.
- Team knowledge and task records live in a private, git-ignored vault.
- Token usage per task is recorded (hades usage).

It also exports to Codex, Cursor, Gemini CLI, Copilot, Devin, Cline and OpenCode, with the gaps
documented in a support matrix.

Repo: https://github.com/prasadm1022/hades-vault

Feedback on the pipeline and the guard rules is very welcome.
```

## X / LinkedIn

Attach a screen recording of the README hero or a short terminal demo. Tag @AnthropicAI and
@claudeai on X.

**X (single post)**

```text
HADES is open source: an AI software company for Claude Code.

One requirement in -> analyst, architect, engineers, QA, DevOps and security subagents -> tested,
security-scanned local commits out. A guard hook blocks git push; you review and push.

https://github.com/prasadm1022/hades-vault
```

**LinkedIn**

```text
I've open-sourced HADES, an autonomous AI software company that runs inside Claude Code.

You state a business requirement. A project manager agent runs it through a team of role agents:
business analyst, software architect, tech lead, backend, frontend, AI/ML/data and QA engineers,
DevOps and cybersecurity. Each stage passes only on tool evidence: builds, tests, Gitleaks,
Semgrep, Trivy, ZAP and health checks.

It never pushes. A deterministic guard hook and deny rules block pushes, destructive git and secret
reads, and the run ends with local commits and a report for you to review.

It also exports to OpenAI Codex, Cursor, Gemini CLI, GitHub Copilot, Devin, Cline and OpenCode.

MIT licensed: https://github.com/prasadm1022/hades-vault
```

## dev.to article

A long "How I built..." post with the main phrase in the title, for example "How I built an
autonomous AI software company on Claude Code subagents". Cover the pipeline, the evidence gates, the
guard hook and the token economy, and link back to the repository.

## Product Hunt

Launch at 12:01 PT. Use the social preview image as the gallery thumbnail and the X post as the
tagline source.

## Awesome lists

| List | URL | How to submit |
|---|---|---|
| awesome-claude-code | https://github.com/hesreallyhim/awesome-claude-code | Web issue form only (`recommend-resource.yml`), submitted by a human, not a pull request and not the `gh` CLI. The repository must be at least 14 days old with active development, or have 100+ stars. One recommendation at a time; a one-line description with no sales pitch and no emojis. Fitting categories: agent orchestrators, workflows. Rules: its `CONTRIBUTING.md`. |
| awesome-claude-code-subagents | https://github.com/VoltAgent/awesome-claude-code-subagents | Accepts submissions; follow its contributing guide. |
| awesome-ai-agents | https://github.com/e2b-dev/awesome-ai-agents | Probably a pull request; read its README for the process first. |

Not yet checked (read each list's rules before submitting):

- https://github.com/kyrolabs/awesome-agents
- https://github.com/ComposioHQ/awesome-claude-skills
- https://github.com/travisvn/awesome-claude-skills
- https://github.com/VoltAgent/awesome-agent-skills
- https://github.com/jqueryscript/awesome-claude-code

One-line description for lists (no pitch, no emojis):

```text
HADES: runs a requirement through Claude Code role subagents (analysis, design, build, QA, deploy, security) with evidence gates and a guard hook; commits locally.
```

## After launch

Keep shipping visible updates (CHANGELOG entries, releases) and answer issues quickly; a soft launch
to a small group before the public posts helps catch setup problems.
