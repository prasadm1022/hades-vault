---
id: {{TASK_ID}}
team: {{TEAM}}
organization: {{ORG}}
title: {{TITLE}}
size: {{SIZE}}
opened: {{DATE}}
---

# {{TASK_ID}} {{TITLE}}

<!-- PM record. Stage state: `hades task show {{TASK_ID}}`. Keep it compact: paths and IDs, not content. -->

## Request (verbatim)

## Decisions
<!-- Numbered assumptions and choices (intake, size reason, names chosen, model overrides); then one
     line per role return: `<stage>/<role>: <its DECISIONS line>` -->

## Lessons
<!-- One line per role return: `<stage>/<role>: <its LESSONS line>`; owner notes as `owner: ...`.
     The learning loop (knowledge-curator) files them. -->

## Plan summary
<!-- stages run or skipped (why), models per stage, waves (W# per wave), linked tasks -->

## Gates
| Gate | Status | Evidence |
|---|---|---|
| G1 Requirements | | |
| G2 Design & plan | | |
| G3 Build | | |
| G4 Tests | | |
| G5 Security | | |
| G6 UX | | |
| G7 Ops | | |
| G8 Docs | | |
| G9 Knowledge | | |

## Defects summary
In `defects.json` (`hades defect list {{TASK_ID}}`). Blocked or wontfix, with reason:

## Deploy
<!-- env (test|live|none|pending-push), URL, health result, rollback command; detail in 08-deployment.md -->

## Commits
<!-- pre-existing dirty files per repo (intake); then: repo | branch | hash | summary -->

## Usage
<!-- `hades usage --task {{TASK_ID}}`: tokens by model, estimated cost -->

## Learning
<!-- vault files changed by the learning loop (curator OUTPUT); upstream candidates -->

## Outcome
<!-- done | blocked: one paragraph; what the owner must do (review, push, provision, unblock) -->
