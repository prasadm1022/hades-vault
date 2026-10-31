# Infrastructure (containers, Kubernetes, IaC, serverless)

Deploy procedure, environments, health and rollback: `../deployment.md`. AWS (credentials, CDK, SAM,
CloudFormation, official AWS skills and MCP): `../aws.md`. This file: validation and safe commands.

## Detect
- Containers: `Dockerfile`/`Containerfile`, `compose.yaml`/`docker-compose.yml`, `.dockerignore`, `devcontainer.json`.
- Kubernetes: YAML with `apiVersion` + `kind`, `kustomization.yaml`, Helm `Chart.yaml` + `values*.yaml`, Skaffold, Tilt.
- IaC: `*.tf` + `.terraform.lock.hcl` (Terraform/OpenTofu), `Pulumi.yaml`, `cdk.json` (AWS CDK),
  `template.yaml` + `samconfig.toml` (AWS SAM), `AWSTemplateFormatVersion` (CloudFormation),
  `serverless.yml`, `*.bicep`, Ansible (`ansible.cfg`, playbooks).
- CI: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`.

## Commands (validation first; mutating commands only in the deploy stage, per deploy policy)
| Tool | Validate (safe) | Deploy / rollback |
|---|---|---|
| Docker | `docker build --check .`; `docker build -t <app>:<git-sha> .`; `hadolint Dockerfile` | push/run per `../deployment.md` |
| Compose | `docker compose config -q`; local: `docker compose up -d --wait` | `docker compose down` (never `-v` on shared hosts) |
| Kubernetes | `kubectl apply --dry-run=client -R -f k8s/`; `kubectl kustomize <dir>`; `kubeconform -strict -summary k8s/` | `kubectl apply`, `kubectl rollout status deploy/<n> --timeout=180s`, `kubectl rollout undo deploy/<n>` |
| Helm | `helm lint <chart>`; `helm template <rel> <chart> -f <values>` | `helm upgrade --install <rel> <chart> -f <values> --wait --atomic` (Helm 4: `--rollback-on-failure`); `helm rollback <rel> <rev>` |
| Terraform / `tofu` | `terraform fmt -check -recursive`; `terraform init -input=false -backend=false`; `terraform validate`; `tflint` | `terraform plan -input=false -out=tfplan`, then `terraform apply -input=false tfplan` |
| Pulumi | `pulumi preview --non-interactive --stack <s>` | `pulumi up --yes --non-interactive --stack <s>` |
| AWS CDK | `npx cdk synth -q`; `npx cdk diff` | `npx cdk deploy --require-approval never` (see `../aws.md`) |
| AWS SAM | `sam validate --lint`; `sam build` | `sam deploy --no-confirm-changeset --no-fail-on-empty-changeset` |
| CloudFormation | `cfn-lint <template>` | change sets (see `../aws.md`) |
| Serverless Fw | `npx serverless package --stage <s>` (v4 needs `SERVERLESS_ACCESS_KEY`) | `npx serverless deploy --stage <s>` |
| Ansible | `ansible-lint`; `ansible-playbook <pb>.yml --check --diff` | `ansible-playbook <pb>.yml` |
| CI workflows | `actionlint` (GitHub Actions) | CI that deploys on push = `via_push` (HADES never pushes) |

## Layout
`Dockerfile` at the service root (multi-stage: build stage, slim runtime stage, non-root `USER`,
`HEALTHCHECK` or platform probe); `deploy/` or `infra/` for IaC; Terraform: `modules/` + `envs/<env>/`
(one state per environment); Helm values per environment (`values-<env>.yaml`); Kustomize `base/` + `overlays/<env>/`.

## Testing
- Static: the validate column above + `hades gate <task> --preset security` (trivy `deps` covers
  Dockerfile, Kubernetes, Helm, Terraform, CloudFormation misconfigurations).
- Images: `hades tools run trivy -- image --severity HIGH,CRITICAL <app>:<tag>`.
- Runtime smoke: start locally (`docker compose up -d --wait`), probe the health endpoint, read
  `docker compose logs --tail=50 <svc>`, then `docker compose down`.
- Terraform modules: `terraform test` (1.6+) where tests exist; plans reviewed for `destroy`/`replace` lines.

## Security
- Containers: pinned base image tags (digest if the project does), non-root user, no secrets in layers or
  build args, `.dockerignore` excludes `.env` and `.git`. Kubernetes: resource limits, `runAsNonRoot`,
  no `privileged`, secrets from a secret store, NetworkPolicies. IAM: least privilege, no `*:*`.
- Terraform state holds secrets in plain text: never print it (`terraform show`, `state pull`, `output -json`
  on sensitive outputs); never commit `*.tfstate` or `*.tfvars` with values.
- trivy misconfig scans download remote Terraform modules: scan untrusted IaC only with egress restricted.

## Pitfalls
- Docker Desktop not running (Windows/macOS): `docker info` first; record "docker unavailable" instead of failing silently.
- Git Bash rewrites `/paths` in arguments (`docker run -v /data:/data`): prefix `MSYS_NO_PATHCONV=1`.
- CRLF in shell entrypoints breaks containers ("no such file or directory"): `.gitattributes` `*.sh text eol=lf`.
- Never-exiting commands: `docker compose up` without `-d`, `kubectl logs -f`, `port-forward`: background only.
- Prompts: Terraform without `-input=false` and a plan file; Pulumi without `--yes --non-interactive`;
  CDK without `--require-approval never`. Never `destroy`, `force-unlock`, `state rm` or `delete` stacks.
- Tag images with the git SHA, not only `latest`: rollback needs the previous tag.

## Small output
`docker build -q` (prints the image ID); failures: `--progress=plain 2>&1 | tail -40`; `terraform plan -no-color
-compact-warnings | grep -E "Plan:|Error|must be replaced|will be destroyed"`; `kubectl get ... -o name`.
