# Token economy

HADES takes the cheapest path that keeps accuracy. The rule behind every mechanism below: a model
reads a short pointer by default and the full detail only when it needs it, and nothing a script can
decide is left to a model. Detail stays on disk, so accuracy does not depend on what was trimmed.

## Mechanisms

| Mechanism | Where | Saves | Why accuracy holds |
|---|---|---|---|
| Native subagents with short, static role prompts | `agents/*.md` | the role prompt is a cacheable system prompt, not a file re-read every spawn | each role still gets its full procedure; rarely needed detail sits in playbooks |
| No spawn without work; depth per size | `HADES.md`, `company/pipeline.md` | an S task skips the tech lead and runs short notes instead of full documents | size is raised, never lowered, when a role finds more risk |
| Handover <= 15 lines of paths, never pasted content | `company/handover.md` | no copies of earlier outputs inside prompts | the agent opens the files itself |
| Return contract: 8 lines (scout: up to 40 `key: value` facts with `path:line`; curator: absolute vault paths) | `company/handover.md`, `agents/hades-scout.md` | the PM's context grows by a few lines per spawn | claims are verified through files and the CLI, never trusted |
| `## Summary` (<= 10 lines) at the top of every stage file | `company/handover.md`, `skills/hades/SKILL.md` | the PM and downstream roles read summaries, not whole documents | sections are opened by name when needed |
| Team `CONTEXT.md` digest (<= 120 lines) pointing to knowledge sections | `company/knowledge-policy.md` | roles stop reading every knowledge file | each fact points to its detail file |
| Playbooks read on demand by path, never installed | `playbooks/`, `docs/architecture.md` section 5 | no procedure costs tokens until a role needs it | the agent prompt names the playbook for each situation |
| Per-agent MCP servers | `agents/README.md` | tool catalogs load only in roles that use them; REA uses its compact schema (about 40% smaller); Playwright omits image payloads | the roles that need the tools have them |
| `omitClaudeMd: true` on agents | `agents/*.md` | a project's `CLAUDE.md` is not injected into every spawn | team knowledge lives in the vault, read through `CONTEXT.md` |
| `hades gate`: one line per step, test and finding counts, a <= 25-line first-failure excerpt, <= 30 lines in total | `lib/core/gate.mjs` | a 5,000-line build log becomes a few lines | full logs and reports stay in `<engine>/.hades/logs/<task>/`; excerpts are picked by failure patterns of each ecosystem |
| Compact CLI output (`task show`, `status` <= 40 lines, `defect list` one line each) | `lib/commands/` | agents read state instead of JSON files | `--json` gives everything when needed |
| Symbol-level code navigation | `playbooks/code-navigation.md` (Serena) | find and edit symbols instead of reading whole files | language servers resolve references exactly |
| Read-only lookups on the cheapest model | `hades-scout` (haiku, low effort) | judgement models do not spend turns searching | facts come with `path:line` for checking |
| Model routing with escalation | `company/model-routing.md` | fast models for well-specified implementation, QA and DevOps | strong models for analysis, architecture, planning, security; escalation on a second fix round, auth/money/tenancy work, L critical path |
| Deterministic code for non-judgement work | `lib/core/detect.mjs`, `task.mjs`, `gate.mjs`, `hooks/guard.mjs` | detection, plan validation, coverage, defect rounds, gates and safety cost zero model tokens | code is tested (`tests/`) and gives the same answer every time |
| Learn once | `hades detect`, `hades team set`, `playbooks/learn-technology.md` | commands and technology knowledge are discovered once and stored in `team.json` and the vault | the learning loop corrects stale facts in place |

## Measuring

```sh
hades usage --task portal-012                # tokens by model and estimated cost for the task window
hades usage --task portal-012 --session <id> # only given sessions (parallel work inflates the window)
hades usage --since 2026-10-01               # daily report (ccusage, offline prices); default last 7 days
hades run "<requirements>" --max-budget-usd 20
```

- `hades usage --task` reads Claude Code transcripts, subagents included, between the task's
  `opened` and `closed` times and stores the result in `state.usage` (`file-formats.md`). Every
  session active in that window counts; `--session` narrows it.
- Costs are estimates from `lib/core/pricing.json`; unknown models are reported as tokens only.
- The PM records the model per stage (`hades task stage ... --model <m>`), so tasks can be compared
  by model, stage and size. Compare cache-read against input tokens: a low cache share means prompts
  are not stable.
