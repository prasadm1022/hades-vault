# Model routing

Route by the kind of work: judgement-heavy stages get the strongest reasoning, routine
implementation gets a fast model with automatic escalation, lookups get the cheapest model.
The defaults are in each agent's frontmatter; a vault can override them per role in
`company/staff/<role>.md` or a team's `agents/<role>.md` (a `model: <name>` line at the start of a
line under *Overrides*; the team file wins). The PM collects them at intake (Grep `^model:`),
records them in the task README Decisions and passes that model on every spawn of the role;
escalation applies on top, never below the override.

| Role / work | Default | Why |
|---|---|---|
| Project manager (main session) | the session model | orchestration; reads summaries only |
| Business analyst | `opus` | requirement mistakes are the most expensive mistakes |
| Software architect | `opus` | design decisions drive everything downstream |
| Tech lead (scaffold, plan, integration review) | `opus` | work breakdown and contracts decide parallel success |
| Backend engineer | `sonnet` | well-specified implementation against a plan and tests |
| AI/ML/data engineer (model plan, build) | `sonnet` | same; evals keep it honest |
| Frontend engineer (UI/UX + frontend) | `fable` | owner rule: UI/UX work runs on Fable; never escalated |
| QA engineer | `sonnet` | executes a written plan; evidence comes from tools |
| DevOps engineer | `sonnet` | scripted deploys with health checks |
| Cybersecurity engineer | `opus` | adversarial reasoning; false negatives are costly |
| Scout (read-only lookups) | `haiku` | find files, symbols, facts; no judgement |
| Knowledge curator (learning loop) | `sonnet` | summarising and filing |

## Escalation (never silent downgrades)

The PM sets `model: opus` on a spawn (frontend-engineer excepted) when:
- the same defect comes back for a second fix round, or a gate stays red after one fix attempt;
- the work item touches authentication, authorisation, payments, multi-tenancy, data deletion or
  data migration of production data;
- the task is size L and the item is on the critical path;
- a role returned `partial` or `blocked` and is re-spawned once with a sharper assignment.

The PM records the model used per stage (`hades task stage ... --model <m>`), so cost and accuracy
can be compared across tasks with `hades usage`.

## Effort

Agents set `effort` in frontmatter: `low` for the scout, `medium` for implementation roles and the
curator, `high` for the analyst, architect, tech lead and cybersecurity engineer.
