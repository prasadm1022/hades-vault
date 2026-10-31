# company/

The company's binding policies. Generic: they apply to every organization and team in any vault.
Roles read them by path when their work needs it; the vault holds what a company learns on top
(`company/`, organization and team folders).

| File | Read by | Contents |
|---|---|---|
| `pipeline.md` | PM | the stage contract behind the PM skill (`skills/hades/SKILL.md`, the operational source): owners, inputs, outputs, entry/exit and evidence; depth per size; parallelism; defect loop and round limits; blocked work; greenfield; multi-team tasks |
| `quality-gates.md` | PM, all roles | gates G1-G9 per stage, evidence commands, waivers |
| `handover.md` | PM | spawn prompt template, return contract, rules every role follows |
| `model-routing.md` | PM | default model per role, escalation, effort |
| `deployment-policy.md` | devops-engineer, PM | environment choice, live-deploy preconditions, rollback, credentials, AWS, not-provisioned projects |
| `security-policy.md` | cybersecurity-engineer, QA, PM | testing scope (source and deployed), rate limits, reverse-engineering legal policy, data handling, severity, disclosure |
| `commit-policy.md` | PM | who commits, release and fix commits, dirty trees, message format, branches, vault commit |
| `knowledge-policy.md` | knowledge-curator, PM | learning loop: what goes where, size limits, promotion team -> organization -> company, upstream |

Procedures (how to do a kind of work) are in `playbooks/`; formats and commands in `docs/`.
