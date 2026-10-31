# Python

## Detect
- Package manager: `uv.lock` uv; `poetry.lock` or `[tool.poetry]` poetry; `Pipfile.lock` pipenv;
  `requirements*.txt` / `setup.py` / `setup.cfg` pip; `pdm.lock` pdm; `environment.yml` conda.
- Version: `.python-version`, `requires-python` in pyproject.toml.
- Frameworks: `manage.py` + `django` (Django); `fastapi`, `flask`, `celery`, `pydantic` in deps.
- Tool config in `pyproject.toml` (`[tool.ruff]`, `[tool.mypy]`, `[tool.pytest.ini_options]`),
  `ruff.toml`, `mypy.ini`, `pytest.ini`, `tox.ini`, `noxfile.py`.

## Commands
| key | uv | poetry | pip (venv) |
|---|---|---|---|
| install | `uv sync --locked` | `poetry install --no-interaction` | `python -m venv .venv` then `.venv/bin/python -m pip install -r requirements.txt` |
| tool prefix | `uv run <cmd>` | `poetry run <cmd>` | `.venv/bin/<cmd>` (Windows `.venv/Scripts/<cmd>.exe`) |
| lint | `uv run ruff check .` | `poetry run ruff check .` | `ruff check .` (flake8/pylint only if configured) |
| types | `uv run mypy .` (or `pyright`) | same with `poetry run` | `mypy .` |
| test | `uv run pytest -q` | `poetry run pytest -q` | `python -m pytest -q` |
| format | `uv run ruff format --check .` (black: `black --check .`) | | |
| build | libraries: `uv build` / `poetry build` / `python -m build`; apps: `python -m compileall -q <pkg>` | | |

Django: build = `python manage.py check` + `python manage.py makemigrations --check --dry-run`;
test = `python manage.py test` unless pytest-django is configured. Run (background only):
`python manage.py runserver`, `uvicorn app.main:app`, `fastapi dev app/main.py`, `flask --app app run`.

## Layout
`src/<pkg>/` or `<pkg>/` at root; tests in `tests/` mirroring the package (`test_*.py`), fixtures in
`conftest.py`. Django: one app per domain (`models.py`, `views.py`, `urls.py`, `migrations/`, `tests/`),
settings split by env. FastAPI: `app/main.py`, `routers/`, `schemas/` (pydantic), `models/`, `services/`.

## Testing
- pytest everywhere; pytest-django (`DJANGO_SETTINGS_MODULE` or `--ds`), pytest-asyncio for async,
  FastAPI `TestClient`/httpx `AsyncClient`, factory_boy for data, testcontainers for real DBs.
- Coverage: `pytest --cov=<pkg> --cov-report=term-missing:skip-covered` (pytest-cov).
- E2E browser: Playwright (`pytest --browser chromium` with pytest-playwright) or `../qa-automation.md`.
- Iterate: `pytest tests/test_x.py::test_name -q -x`.

## Security
- trivy reads uv.lock, poetry.lock, Pipfile.lock, requirements*.txt. Second opinion: `pip-audit -r requirements.txt`.
- Fast SAST: `ruff check --select S .` (bandit rules). Review: raw SQL / `.extra()` / f-string queries,
  `pickle`/`yaml.load` on untrusted input, `subprocess(..., shell=True)`, `DEBUG=True`, `ALLOWED_HOSTS`,
  CSRF exemptions, `SECRET_KEY` from env only, path traversal in file serving.
- Django deploy check: `python manage.py check --deploy` with production settings.

## Pitfalls
- Never install into the system interpreter (PEP 668 blocks it on many OSes): always a venv or uv/poetry.
- Windows: `python` may be the Store stub; use `py -3` or the venv's `Scripts/python.exe`. Paths in
  team.json: prefer `uv run`/`poetry run` forms, which work on every OS.
- Interactive prompts: `poetry --no-interaction`, `pip ... -y` for uninstall, Django `--noinput` for
  `migrate`, `collectstatic`, `makemigrations` (exits 3 where it would ask, e.g. renames: write those by hand).
- Never `manage.py shell`/`python` REPL; use `python -c "..."` or `manage.py shell -c "..."`.
- pytest collects from `.venv`/`node_modules` without `testpaths`; set it if collection is slow.
- Heavy wheels (torch, numpy builds) make installs slow: background + long timeout; reuse the uv cache.
- Django ORM in async views: use the async API (`aget`, `acreate`) or `sync_to_async`, else SynchronousOnlyOperation.

## Small output
`pytest -q -x --tb=short`; `ruff check --output-format=concise`; `mypy . 2>&1 | tail -20`;
`pip install -q`; `uv sync --locked -q`.
