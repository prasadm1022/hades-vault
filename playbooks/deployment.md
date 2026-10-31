# Deployment playbook

Owner: devops-engineer. `<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.
Binding: `<engine>/company/deployment-policy.md` (wins over this playbook on any conflict) and
`<engine>/docs/architecture.md` section 3. `team.json` schema: `<engine>/docs/file-formats.md`.
AWS specifics: `<engine>/playbooks/aws.md`. `08-deployment.md` skeleton: your agent prompt.

## 1. Inputs

- `<team_dir>/team.json` -> `environments.test|live`: `url`, `deploy`, `health`, `rollback`, `via_push`,
  `notes` (env-var and profile names, backup location). Configured = `deploy` non-empty. Commands
  run from the project root. Changes: `hades team set <team> env <test|live> <field> <value>` only
  (shell values are checked by the guard; a refusal prints the reason).
- Your team notes: targets, hosts, profiles, contexts learned earlier.
- `02-technical-solution.md` (deployment topology, migrations) and the `## Summary` of each
  `05-impl-*.md` (migrations, new env-var names, new services).
- Redeploy after security fixes: same environment as the recorded deploy (`hades task show <task>`).

## 2. Resolve the environment

1. Candidate = `test` if configured, else `live`.
2. Candidate has `via_push: true`, a deploy command containing `git push`, or a platform that
   builds from the remote repository -> **pending-push** (section 9), no preflight.
3. Preflight (section 3). Pass -> deploy to the candidate (`live`: section 4 step 1 preconditions).
   HADES stops at test; promotion to live only in a task whose request asks for it. `test` fails ->
   record the failing check, candidate = `live` if configured, back to step 2.
4. Nothing configured -> **not provisioned** (section 8). Configured but nothing reachable ->
   **blocked** (section 10). Every failing check goes into `08` as one line.

## 3. Preflight

Non-interactive, short timeouts, no secret printed. First, every env-var and profile name listed in
the environment's `notes` is set: `[ -n "${NAME:-}" ] && echo NAME=set || echo NAME=missing`. Then:

| Target | Tool check | Target answers |
|---|---|---|
| any with `url` | `curl --version` | `curl -sS -o /dev/null -m 10 -w '%{http_code}' "$URL"` (any code but `000`) |
| SSH host | `ssh -V` | `ssh -o BatchMode=yes -o ConnectTimeout=10 "$H" true` |
| Kubernetes / Helm | `kubectl version --client`, `helm version --short` | `kubectl --context "$CTX" -n "$NS" auth can-i patch deployments` |
| AWS | `aws --version` | `aws sts get-caller-identity --profile "$P" --query Arn --output text` (aws.md section 4) |
| Cloudflare | `npx wrangler --version` | `npx wrangler whoami` (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) |
| Netlify | `npx netlify --version` | `npx netlify status` (`NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`) |
| Vercel | `npx vercel --version` | `npx vercel whoami --token "$VERCEL_TOKEN"` |
| Fly.io | `fly version` | `fly auth whoami` (`FLY_API_TOKEN`) |
| Render | `curl --version` | `curl -fsS -m 10 -o /dev/null -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID"` |
| Heroku | `heroku --version` | `heroku auth:whoami` (`HEROKU_API_KEY`) |
| Azure | `az version` | `az account show --query id -o tsv` |
| GCP | `gcloud version` | `gcloud auth list --filter=status:ACTIVE --format='value(account)'` |

## 4. Procedure

1. **Live preconditions** (never waived): `hades gate <task> --preset predeploy` exits 0 on the
   commit being deployed and `hades defect list <task> --open` shows no critical/high. Red -> no
   deploy, `hades task deploy <task> --env none`, `STATUS: blocked`, `NEXT: cybersecurity triage of
   the findings, fixes, then redeploy`. Test: the release commit's `precommit` gate suffices.
2. **Plan in `08` first**: target, commit (`git rev-parse --short HEAD`), artefact, and the exact
   deploy, health and rollback commands, written before anything runs. `rollback` empty in
   `team.json` -> derive it from section 7; first deploy -> how to remove or disable the new
   deployment. Live without a workable rollback or a `health` command is not run (blocked).
3. **What ships**: the recorded release commit(s) and the PM's `chore(deploy)`/fix commits only;
   never a dirty tree. Deploy config you must change: change and validate it, do not deploy, return
   `STATUS: partial` with the files in `OUTPUT` (the PM commits, then re-spawns you).
4. **Rollback target**: the artefact running now (image tag, task-definition ARN, Lambda version,
   release or revision id), recorded.
5. **Backup** before any migration or data change (section 6); static-site and config copies when
   the rollback needs them. Backups stay in the environment or at the location named in `notes`, or
   under `<engine>/.hades/backups/<task>/` for non-personal data; never copy production data
   to the workstation.
6. **Migrations** (expand only) before the new code (section 6).
7. **Deploy**: `LOG=<engine>/.hades/logs/<task>/deploy-<env>-<n>.log`;
   `( <deploy> ) > "$LOG" 2>&1; rc=$?`; on `rc != 0` read only `tail -n 30 "$LOG"`. Every wait is
   bounded: the platform's own wait flag, else the Bash tool timeout, else a background run.
8. **Health** (section 5).
9. **Red deploy or red health -> automatic rollback**: run `rollback`, rerun `health`, record both;
   record the cause as a defect per root cause (`hades defect add <task> --title "..." --severity high
   --owner <role> --source deploy --repro "<deploy> -> <health> red" --evidence "08-deployment.md#deploy-<n>"`;
   owner: you for deploy/infra config, else the engineer whose code fails); the PM runs the defect
   loop; no second attempt in the same round; `STATUS: blocked`. Rollback also red -> `08` states the exact state and the
   owner's recovery command.
10. **Record**: healthy -> `hades task deploy <task> --env <test|live> --url <url>`; rolled back or not
    deployed -> `hades task deploy <task> --env none`. Append `## Deploy <n>` to `08`; keep
    `## Summary` current. Steps list the rollback target, backup id and log path.

## 5. Health checks

- Platform wait first (`rollout status`, `ecs wait services-stable`, `compose up --wait`,
  `fly deploy --wait-timeout`), then the `team.json` `health` command, retried for up to 5 minutes.
- HTTP: `curl -fsS -m 10 --retry 20 --retry-delay 15 --retry-max-time 300 --retry-all-errors -o /dev/null "$URL/health"`
  (curl >= 7.71).
- Other commands: `ok=0; for i in $(seq 1 15); do sh -c "$HEALTH" >/dev/null 2>&1 && { ok=1; break; }; sleep 20; done; echo "ok=$ok tries=$i"`
- Healthy = health exit 0 **and**, when the app exposes it, the version endpoint shows the deployed
  commit **and** no new error burst in the last 10 minutes of logs (target log command piped to
  `grep -iE 'error|exception|fatal' | tail -n 20`).

## 6. Database migrations

1. Classify: **expand** (new table, nullable or defaulted column, index built online/concurrently,
   new enum value) or **contract** (drop, rename, type narrowing, NOT NULL on existing data).
2. A deploy runs expand migrations only, **before** the code, so old and new code both work on the
   new schema. Contract migrations ship in a later task after the new code is healthy on live,
   never in the same deploy. Rename = add + dual-write + backfill + switch reads + drop later.
3. Backfills: batched, idempotent, resumable, outside the schema transaction.
4. Backup immediately before: `pg_dump -Fc` on the host or in the container, managed-DB snapshot
   (aws.md 5.5), or the provider's backup API; record its id and the restore command. No backup
   possible -> the migration needs a down step proven on test or locally, else blocked.
5. Run the project's tool against the target (connection by env-var name): Flyway `migrate`,
   Liquibase `update`, Alembic `upgrade head`, Prisma `migrate deploy`, Django `migrate`, Rails
   `db:migrate`, EF Core `database update`, golang-migrate `up`, Knex `migrate:latest`. Postgres: set
   `lock_timeout` (for example `5s`) so blocked DDL fails instead of stalling traffic.
6. Reversible: each migration has a down or compensating script tested locally (up -> down -> up).
   Rollback order: code first (old code runs on the expanded schema); the down migration only when
   the expand itself broke something.
7. Never against shared environments: `prisma migrate dev`, `prisma db push`, `--accept-data-loss`,
   ORM auto-sync (`synchronize: true`, `ddl-auto=update`), manual DDL or data statements.
8. Production data changes go under `DECISIONS` (the PM escalates the model).

## 7. Recipes

`$SHA` = short commit; artefacts are immutable and tagged with it. Rollback re-points to the
previous artefact; never rebuild old code to roll back.

### Docker Compose over SSH

```sh
H=deploy@app-host; D=/srv/portal; IMG=registry.example.com/portal; S="ssh -o BatchMode=yes $H"   # from team notes
PREV=$($S "grep '^IMAGE_TAG=' $D/.env | cut -d= -f2")          # one key, never the whole file
docker build -q -t "$IMG:$SHA" . && docker push -q "$IMG:$SHA"
$S "cd $D && sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$SHA/' .env && docker compose pull -q && docker compose up -d --remove-orphans --wait --wait-timeout 180"
$S "cd $D && sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$PREV/' .env && docker compose up -d --wait --wait-timeout 180"   # rollback
$S "cd $D && docker compose exec -T db sh -c 'pg_dump -U \"\$POSTGRES_USER\" -Fc \"\$POSTGRES_DB\"' > backups/pre-$SHA.dump"   # backup on the host
```

No registry: `DOCKER_HOST=ssh://$H docker compose up -d --build --wait` builds on the remote engine
(keep the previous image under a tag for rollback).

### Kubernetes (kubectl, Helm)

```sh
K="kubectl --context $CTX -n $NS"
$K rollout history deploy/portal | tail -n 3                       # rollback target
$K set image deploy/portal app="$IMG:$SHA"                         # or: $K diff -k overlays/<env>; $K apply -k overlays/<env>
$K rollout status deploy/portal --timeout=300s
$K rollout undo deploy/portal && $K rollout status deploy/portal --timeout=300s   # rollback

HL="helm --kube-context $CTX -n $NS"
$HL history portal --max 3
$HL upgrade --install portal ./chart -f values-<env>.yaml --set image.tag="$SHA" --atomic --wait --timeout 5m   # Helm 4: --rollback-on-failure
$HL rollback portal <prev-revision> --wait --timeout 5m
```

Never `kubectl get secret -o yaml|json`; secrets come from the cluster's secret mechanism.

### Static hosting and edge

| Platform | Deploy | Rollback |
|---|---|---|
| Cloudflare Workers | `npx wrangler deploy` (first record `npx wrangler deployments list`) | `npx wrangler rollback <version-id> --message "<task>"` |
| Cloudflare Pages | `npx wrangler pages deploy dist --project-name portal --branch <prod-branch> --commit-hash $SHA` (another branch = preview URL to health-check first) | `curl -fsS -X POST -o /dev/null -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/portal/deployments/<prev-id>/rollback` (ids: `npx wrangler pages deployment list --project-name portal`) |
| Netlify | draft `npx netlify deploy --dir dist --json` -> health-check its `deploy_url` -> `npx netlify deploy --dir dist --prod --json` | `npx netlify api restoreSiteDeploy --data '{"site_id":"<id>","deploy_id":"<prev>"}'` (ids: `npx netlify api listSiteDeploys --data '{"site_id":"<id>","per_page":5}'`, read `id`, `state` only) |
| Vercel | `npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"` (prints the URL) | `npx vercel rollback <prev-deployment-url> --token "$VERCEL_TOKEN"` (urls: `npx vercel ls portal --token "$VERCEL_TOKEN"`) |

Avoid `vercel pull` and `vercel env pull` (they write secret values to disk).

### PaaS

| Platform | Deploy | Rollback |
|---|---|---|
| Fly.io | `fly deploy -a portal --strategy rolling --wait-timeout 5m` (fly.toml checks gate the rollout) | `fly releases -a portal --image` -> `fly deploy -a portal --image <prev-image>` |
| Render (image service) | `POST https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys` body `{"imageUrl":"<img>:<sha>"}`; poll `GET .../deploys/<id>` until `live` or `*_failed` | `POST .../services/$RENDER_SERVICE_ID/rollback` body `{"deployId":"<prev-live-id>"}` |
| Heroku | `heroku container:login && heroku container:push web -a portal && heroku container:release web -a portal` | `heroku releases -a portal -n 3` -> `heroku rollback v<N> -a portal` (the database is not rolled back) |

Repository-backed Render services and `git push heroku` build from the remote: section 9.

### AWS (commands and skills: aws.md section 5)

| Target | Deploy / wait | Rollback |
|---|---|---|
| ECS (5.1) | `register-task-definition` -> `ecs update-service --task-definition <new>` -> `ecs wait services-stable` | `update-service --task-definition <prev>` |
| Lambda via SAM (5.2) | `sam build` -> `sam deploy --config-env <env> --no-confirm-changeset --no-fail-on-empty-changeset` | alias back to the previous version; CodeDeploy alarms roll back canaries |
| CDK, CloudFormation (5.3, 5.4) | reviewed `cdk diff` or change set -> `cdk deploy` / `execute-change-set` | CloudFormation rolls back failed updates; app rollback via the previous artefact |
| S3 + CloudFront (5.6) | `s3 sync --delete` -> `cloudfront create-invalidation` | sync the saved copy back, invalidate |
| Amplify Hosting (5.7) | manual: `create-deployment` -> upload zip -> `start-deployment`; repo-connected: section 9 | redeploy the previous zip |

### Azure and GCP (brief)

- App Service: `az webapp deploy -g RG -n APP --src-path app.zip --type zip --slot staging` ->
  health-check the slot -> `az webapp deployment slot swap -g RG -n APP --slot staging --target-slot production`;
  rollback = swap again.
- Container Apps: `az containerapp update -n APP -g RG --image "$IMG:$SHA"`; rollback (multiple
  revision mode) `az containerapp ingress traffic set -n APP -g RG --revision-weight <prev-rev>=100`.
- Cloud Run: `gcloud run deploy SVC --image "$IMG:$SHA" --region R --no-traffic --tag cand` ->
  health-check the `cand---` URL -> `gcloud run services update-traffic SVC --region R --to-latest`;
  rollback `gcloud run services update-traffic SVC --region R --to-revisions <prev>=100`.

### VPS with systemd

```sh
S="ssh -o BatchMode=yes $H"
PREV=$($S "readlink /opt/portal/current")
tar -czf - -C build . | $S "mkdir -p /opt/portal/releases/$SHA && tar -xzf - -C /opt/portal/releases/$SHA"
$S "ln -sfn /opt/portal/releases/$SHA /opt/portal/current && sudo -n systemctl restart portal && systemctl is-active --quiet portal"
$S "ln -sfn $PREV /opt/portal/current && sudo -n systemctl restart portal"     # rollback
$S "journalctl -u portal --since '-10 min' -p err --no-pager | tail -n 20"     # error burst check
```

## 8. Not provisioned (greenfield)

1. Complete an existing mechanism (CI workflow, Dockerfile, compose, platform config, deploy
   scripts) before adding a second one. Otherwise create the minimal configuration chosen in `02`:
   - `Dockerfile`: multi-stage, pinned base image tag, non-root `USER`, `HEALTHCHECK` or platform
     check, no secrets in `ARG`/`ENV`/layers; `.dockerignore` with `.git`, `.env*`, dependencies,
     build output.
   - `compose.yaml`: app + dependencies, `healthcheck` on each, `env_file: .env`, named volumes,
     `restart: unless-stopped`, internal ports bound to `127.0.0.1`.
   - `.env.example`: every variable name with a comment, no values.
   - CI in the repo's CI system (default `.github/workflows/ci.yml`): install, build, lint, test,
     secret/SAST/dependency scans, image build; `permissions: contents: read`; actions pinned to
     commit SHAs. A deploy job on push makes that environment `via_push: true`.
   - A health endpoint, and IaC when the target is a cloud.
2. Validate locally: `docker build -q -t portal:dev .`, `docker compose config -q`,
   `docker compose up -d --wait --wait-timeout 180`, HTTP health on localhost, `docker compose down`;
   IaC `synth`/`validate`/`plan`; `hades gate <task> --only deps` (Dockerfile and IaC
   misconfigurations). Docker missing -> `n/a` with the reason.
3. Provision cloud resources only when the request asks for it and a least-privilege profile is
   available; otherwise write "Provisioning steps for the owner" in `08`.
4. `hades task deploy <task> --env none`; `08` status *not provisioned*; record what is known with
   `hades team set <team> env <test|live> <field> <value>` (`via_push true` for a CI deploy-on-push,
   `notes` with env-var and profile names); `deploy` stays empty until the environment exists.

## 9. Pending push

Applies when `via_push: true`, the deploy command contains `git push`, or the platform builds from
the remote repository (repo-connected Render, Netlify or Amplify builds, `git push heroku`, CI that
deploys on push): such a deploy ships the pushed commit, never the local one.

1. Never push, never trigger the pipeline another way (re-run APIs, dispatch, empty commits).
2. Verify locally what can be: build, CI workflow syntax, IaC synth/validate; the release commit is
   recorded (`hades task show <task>`).
3. `08`: the push the owner must make (repo, branch), what the pipeline then does, expected URL,
   health and rollback commands.
4. `hades task deploy <task> --env pending-push --url <url>`; `NEXT: security runs source-level
   tests now; deployed-system tests after the owner's push`.

## 10. Blocked

- Never obtain credentials yourself: no interactive login (`aws login`, `aws sso login`, `az login`,
  `gcloud auth login`, `wrangler login`, `fly auth login`, `heroku login`), no reading other profiles
  or credential files, no copying keys.
- `08`: the failing check, a one-line reason, the owner action (command, or env-var/profile name).
- `hades task deploy <task> --env none`; finish everything that needs no environment (config, IaC
  validation, docs); `STATUS: blocked`.

## 11. Secrets and output

- Secrets by name only: env-var names, `--profile`, `--context`, platform secret stores. A value
  already in an env var may be piped, never echoed: `printf %s "$X" | npx wrangler secret put NAME`.
- Never: `env`, `printenv`, `set -x`, `echo "$SECRET"`, `cat .env`, `docker compose config` without
  `-q` (prints interpolated values), `docker inspect` (prints container env), `heroku config`,
  `kubectl get secret -o yaml`, `aws secretsmanager get-secret-value`, secrets as command arguments
  that land in logs.
- Output: quiet flags (`-q`, `--quiet`, `--no-color`, `--only-show-errors`); full output to `$LOG`
  (git-ignored); read `tail`/`grep` excerpts only. Never copy tokens, credentialed or presigned URLs
  from logs into stage files.
