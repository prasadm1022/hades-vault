# Deployment policy

Owner: devops-engineer. Procedure: `playbooks/deployment.md`; AWS: `playbooks/aws.md`.
Environment data: `team.json` `environments` (`docs/file-formats.md`). Record every deploy in
`08-deployment.md` (`## Deploy n`) and with `hades task deploy`.

## 1. Choose the environment

1. `test` configured (`deploy` non-empty or `via_push: true`) and reachable -> deploy to **test**
   (`via_push`: pending-push, below).
2. Else `live` configured and reachable -> deploy to **live** (section 3 applies; `via_push`: pending-push).
3. Else -> **not provisioned** (section 6).

Reachable = a preflight passes: the env-var and profile names listed in the environment's `notes` are
set (checked by name, never printed), and the target answers (the URL responds with any HTTP status,
or the platform CLI can describe the target). A configured but unreachable environment is recorded
in `08` with the failing check.

With a test environment, HADES stops at test. Promotion to live happens only in a task whose
request asks for it, under section 3.

`via_push: true`: do not deploy. Verify what can be verified locally (build, CI workflow syntax,
IaC synth/validate), record `hades task deploy <task> --env pending-push`, and write in `08` the push
the owner must make and what the pipeline will then do. Never trigger remote CI by any other means.

## 2. Every deploy

- Deploy the recorded release commit(s), never uncommitted changes. Deploy configuration changed
  during the deploy stage is validated without deploying, committed by the PM
  (`chore(deploy): ...`) and then deployed as the new HEAD.
- Run `deploy` from the project root; output to `<engine>/.hades/logs/<task>/`, never into the vault.
- Run `health` (exit 0 = healthy) with retries for up to 5 minutes. Red -> run `rollback`, rerun
  `health`, record both, and record the cause as a defect for the owning role
  (`hades defect add ... --source deploy`); the PM runs the defect loop (fix, fix commit, redeploy).
- `08` records: environment, commit hashes, commands with exit codes, one health line, rollback
  command, migrations and backups, new resources and their monthly cost estimate.
- Then `hades task deploy <task> --env <test|live> --url <url>`.
- Environment facts established or corrected (url, deploy, health, rollback, via_push, notes) go into
  `team.json` with `hades team set <team> env <test|live> <field> <value>`. Shell values (deploy,
  health, rollback) are checked by the guard; a refused value is fixed, never worked around.
- The CLI checks every `team.json` command it runs (gate steps, deploy, health, rollback) with the
  guard before running it.

## 3. Live preconditions (all required, never waived)

1. `hades gate <task> --preset predeploy` ok on the commit being deployed (critical/high scanner
   finding = block) and no critical/high in `hades defect list <task> --open`.
2. A rollback command written in `08` before deploying (first deploy: how to remove or disable it).
3. A `health` command.
4. Data protection before any migration or data change: backup or snapshot when the platform allows
   (managed-database snapshot, dump to the backup location named in `notes`), restore command recorded.
   No backup possible: the migration must have a down step proven on test or local, else blocker.
5. Migrations are backward compatible with the running code (expand now, contract in a later task);
   no destructive data statements outside a reviewed migration.
6. Failed health check -> automatic rollback (section 2). No second attempt in the same round.

Against live, security testing is passive only (`security-policy.md`).

## 4. Credentials

- By environment-variable or CLI-profile name only. Never read, print, echo or write a secret value;
  never commit `.env` files with values (`.env.example` lists names).
- Secret stores are referenced at runtime (platform secret references, `{{resolve:...}}`-style
  dynamic references); never fetch a secret value into the session.
- Missing credential -> blocker naming the variable or profile; deploy recorded as `none`.

## 5. AWS

- Use the AWS skills and MCP server as `playbooks/aws.md` describes (`hades mcp aws`). Profiles:
  `hades.config.json` `aws` (`profile` or `profiles`, `region`, `read_only`), else `AWS_PROFILE`. The owner provisions a least-privilege profile; `hades doctor` FAILs on a profile
  that resolves to the account root user.
- Identity first: `aws sts get-caller-identity` with the configured profile (region from the config,
  `AWS_REGION` or team notes). ARN ending in `:root` = root credentials: run read-only
  diagnostics only (describe/list/get, no secret reads), record `--env none` and a blocker, and draft
  in `08` the least-privilege IAM policy the deploy needs, for the owner to create.
- Least privilege: a deploy role or profile scoped to the team's resources; short-lived credentials
  (SSO, assumed roles) preferred. Never create IAM users or access keys, never widen a policy
  (`*` actions or resources) to make a deploy pass: record a blocker.
- Infrastructure as code (CDK, CloudFormation, SAM, Terraform/OpenTofu) in the repo; review the
  diff, plan or change set in `08` before applying. Direct CLI or console changes only where IaC
  cannot reach, listed in `08`.
- New resources only as designed in `02`, smallest size meeting the NFRs, tagged `hades:team` and
  `hades:task`, monthly cost estimate in `08`.
- Never delete data stores, buckets with data, snapshots, backups, or resources HADES did not create
  for the same task. Never change account settings, billing, DNS of other workloads or organisation
  policies unless the request asks for it.

## 6. Not provisioned

1. Look for an existing mechanism first (CI workflow, Dockerfile, compose file, platform config,
   deploy scripts) and complete it rather than adding a second one.
2. Otherwise create the minimal configuration chosen in `02`: container or platform config, IaC, a
   health endpoint, a CI workflow that runs build, test and the scans (greenfield: always).
3. Verify locally: image build, compose up plus health on localhost, `synth`/`validate`/`plan`.
4. Provision cloud resources only when the request asks for it and a least-privilege profile is
   available; otherwise write "Provisioning steps for the owner" in `08`.
5. Record `hades task deploy <task> --env none`, `08` status *not provisioned*, and what is already
   known with `hades team set <team> env ...` (for example `via_push true` for a CI deploy-on-push,
   `notes` naming the env vars and profile); `deploy` stays empty until the environment exists.
