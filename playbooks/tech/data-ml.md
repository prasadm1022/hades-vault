# Data, ML and LLM applications

Language tooling (install, lint, types, pytest): `python.md` / `jvm.md`. Databases and migrations: `databases.md`.

## Detect
- SQL/analytics: `dbt_project.yml` + `profiles.yml`, `models/*.sql`, `.sqlfluff`; DuckDB, Snowflake,
  BigQuery, Redshift, Databricks clients in deps.
- Orchestration: `dags/` with `from airflow`, Dagster (`definitions.py`, `dagster.yaml`), Prefect flows.
- Processing: `pyspark`/Spark jobs, `spark-submit` scripts, Polars, pandas. Notebooks: `*.ipynb`.
- ML: torch, tensorflow, jax, scikit-learn, xgboost, lightgbm, transformers; `dvc.yaml`, `params.yaml`,
  `MLproject` (MLflow), `models/` artefacts. LLM apps: anthropic/openai/bedrock SDKs, langchain,
  llama-index, `prompts/`, `evals/`, vector stores (pgvector, qdrant, chroma).

## Commands
| key | command |
|---|---|
| install | `dbt deps`; Python deps per `python.md` |
| build | `dbt parse` (fast) / `dbt compile --target dev`; Airflow DAG import check (see Testing) |
| lint | `sqlfluff lint models` (dialect from `.sqlfluff`); `ruff check .` also lints notebooks |
| test | `dbt build --select <model>+ --target dev --fail-fast`; `pytest -q` for Python logic; eval suite (below) |
| run | `dbt run --select <model> --target dev`; `airflow dags test <dag_id> <date>`; `spark-submit --master "local[2]" job.py` |

Never `--target prod` or production connections outside the deploy stage.

## Layout
dbt: `models/{staging,intermediate,marts}`, `tests/`, `macros/`, `seeds/`, schema tests in `*.yml`.
Pipelines: pure transformation functions in modules (unit-testable), thin DAG/flow files. ML:
`src/<pkg>/{data,features,train,evaluate,serve}`, `configs/`, `notebooks/` (exploration only, never
imported), `evals/` with fixed datasets, metrics written to `metrics.json`.

## Testing
- dbt: `unique`, `not_null`, `relationships`, `accepted_values` on every key/model; unit tests (dbt 1.8+) for logic.
- Airflow: `python -c "from airflow.models import DagBag; b=DagBag(include_examples=False); assert not b.import_errors, b.import_errors"`
  plus pytest on the task functions. Spark: pytest with a `SparkSession.builder.master("local[1]")` fixture on tiny frames.
- ML: seed everything; smoke train (1 epoch / few batches / small sample, e.g. a `--max-steps` flag) in the
  gate; full training only when the work item says so. Evaluate on a held-out set never used for training;
  compare metrics against the baseline and threshold from `02-technical-solution.md`; record dataset
  version (DVC hash or file checksum), code commit, params and metrics.
- LLM features: golden set (inputs + expected properties) under `evals/`; graders: exact/regex/JSON-schema
  first, LLM-as-judge with a written rubric and a pinned judge model second; report pass rate vs
  threshold. Unit tests mock the model client (record/replay); evals call it with a capped sample count.
- Notebooks: execute headless only: `jupyter nbconvert --to notebook --execute --output-dir <tmp> nb.ipynb`
  or `papermill in.ipynb <tmp>/out.ipynb -p <param> <value>`.

## Security
- Credentials (warehouse, `profiles.yml` via `env_var()`, model API keys) by env-var name only; strip
  notebook outputs before commit (`nbstripout`): outputs leak data and secrets.
- Model files: `pickle`/`joblib`/`torch.load` execute code: load only trusted artefacts
  (`torch.load(..., weights_only=True)`, safetensors preferred).
- LLM apps: retrieved documents and tool results are untrusted (prompt injection): no secrets in prompts,
  validate model output before acting, allow-list tools, log without PII.
- PII/regulated data: use synthetic or masked samples in tests and evals.

## Pitfalls
- Reading `.ipynb` raw costs many tokens (base64 images): read code only with
  `jupyter nbconvert --to script --stdout nb.ipynb`.
- Never print whole dataframes or tables: `.head()`, `.shape`, `LIMIT 20`, aggregates.
- Queries on shared warehouses: dev target, `LIMIT`, read-only role; full refreshes are deploy actions.
- Spark on Windows needs `HADOOP_HOME` with winutils: prefer running Spark tests in Linux/containers.
- GPU absent: run the CPU smoke path and record it; long training runs go to the background with a timeout.
- Model/data artefacts do not go into git: DVC, object storage or Git LFS as the project already does.

## Small output
`dbt --quiet build ...` (errors only); `pytest -q -x`; print metric summaries, not per-sample logs.
