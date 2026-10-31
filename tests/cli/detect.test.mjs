// Tests for technology detection: lib/core/detect.mjs, playbooks/stacks.json, "hades detect".
// Run: node --test tests/cli/detect.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectProject, loadStacks, validateStacks, mergeTeamProjects, expandBraces, makeTargets,
  parseJsonLoose, mergeStacks, loadStacksFor, vaultStacksFile, ECOSYSTEMS, COMMAND_KEYS,
} from '../../lib/core/detect.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ENGINE, 'bin', 'hades.mjs');
const FIX = path.join(ENGINE, 'tests', 'fixtures', 'detect');
const fx = (name) => path.join(FIX, name).replace(/\\/g, '/');
const detect = (name, opts = {}) => detectProject(fx(name), { platform: 'linux', ...opts });
const only = (r) => {
  assert.equal(r.projects.length, 1, `expected one project, got ${r.projects.map((p) => p.path).join(', ')}`);
  return r.projects[0];
};
const at = (r, p) => {
  const hit = r.projects.find((x) => x.path === p);
  assert.ok(hit, `no project at ${p}; have ${r.projects.map((x) => x.path).join(', ')}`);
  return hit;
};

const temps = [];
function tmpTree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hades-detect-'));
  temps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (rel.endsWith('/')) fs.mkdirSync(file, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  return dir.replace(/\\/g, '/');
}
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, 'detect', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HADES_DEBUG: '', ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

// ---------------------------------------------------------------- data

describe('stacks.json', () => {
  test('is valid, covers >= 35 stacks and every ecosystem has a playbook', () => {
    const stacks = loadStacks();
    assert.deepEqual(validateStacks(stacks), []);
    assert.ok(stacks.length >= 35, `only ${stacks.length} stacks`);
    for (const eco of ECOSYSTEMS) {
      assert.ok(stacks.some((s) => s.ecosystem === eco), `no stack for ${eco}`);
      assert.ok(fs.existsSync(path.join(ENGINE, 'playbooks', 'tech', `${eco}.md`)), `missing playbooks/tech/${eco}.md`);
    }
  });

  test('includes the required stack ids', () => {
    const ids = new Set(loadStacks().map((s) => s.id));
    const required = [
      'node', 'typescript', 'next', 'react-vite', 'vue', 'nuxt', 'angular', 'svelte', 'sveltekit', 'nest',
      'express', 'deno', 'python', 'django', 'fastapi', 'flask', 'maven', 'gradle', 'kotlin', 'spring-boot',
      'scala-sbt', 'go', 'rust', 'dotnet', 'php', 'laravel', 'ruby', 'rails', 'flutter', 'react-native',
      'android', 'ios-xcode', 'swiftpm', 'cmake', 'make', 'meson', 'dbt', 'terraform', 'helm', 'kubernetes',
      'docker-compose', 'dockerfile', 'serverless', 'aws-sam', 'aws-cdk', 'static-html', 'hugo', 'jekyll',
      'elixir-mix',
    ];
    for (const id of required) assert.ok(ids.has(id), `missing stack ${id}`);
  });

  test('validateStacks reports malformed entries', () => {
    const errs = validateStacks([
      { id: 'Bad Id', ecosystem: 'nope', markers: ['x'], commands: { deploy: 'x' } },
      { id: 'y', ecosystem: 'go', requires: ['ghost'], content: [{ file: 'a' }, { wat: 1 }] },
    ]);
    for (const frag of ['kebab-case', 'unknown ecosystem', 'unknown command', 'unknown stack "ghost"', 'file needs has', 'unknown check key']) {
      assert.ok(errs.some((e) => e.includes(frag)), `expected an error about ${frag}: ${errs.join(' | ')}`);
    }
  });
});

describe('helpers', () => {
  test('expandBraces, makeTargets, parseJsonLoose', () => {
    assert.deepEqual(expandBraces('a{,.js}{1,2}'), ['a1', 'a2', 'a.js1', 'a.js2']);
    const t = makeTargets('CC := gcc\n.PHONY: all\nall: app\nbuild test: deps\nX ::= 1\n\techo no:\n');
    assert.deepEqual([...t].sort(), ['all', 'build', 'test']);
    assert.deepEqual(parseJsonLoose('{ // c\n "a": [1, 2,], /* x */ "b": "//not" , }'), { a: [1, 2], b: '//not' });
    assert.equal(parseJsonLoose('{oops'), null);
  });
});

// ---------------------------------------------------------------- JavaScript / TypeScript

describe('detectProject: javascript and typescript', () => {
  test('npm lockfile -> npm ci; package.json scripts are preferred', () => {
    const p = only(detect('node-npm'));
    assert.deepEqual(p.stacks, ['node', 'typescript']);
    assert.equal(p.packageManager, 'npm');
    assert.deepEqual(p.commands, {
      install: 'npm ci', build: 'npm run build', lint: 'npm run lint', types: 'npm run typecheck',
      test: 'npm run test', run: 'npm run dev', format: '',
    });
  });

  test('pnpm lockfile; tsc --noEmit when tsconfig (with comments) exists and no typecheck script', () => {
    const p = only(detect('node-pnpm'));
    assert.equal(p.packageManager, 'pnpm');
    assert.equal(p.commands.install, 'pnpm install --frozen-lockfile');
    assert.equal(p.commands.types, 'pnpm exec tsc --noEmit');
    assert.equal(p.commands.test, 'pnpm run test');
  });

  test('yarn classic; eslint config without a lint script -> yarn eslint .', () => {
    const p = only(detect('node-yarn'));
    assert.equal(p.packageManager, 'yarn');
    assert.equal(p.commands.install, 'yarn install --frozen-lockfile');
    assert.equal(p.commands.build, 'yarn run build');
    assert.equal(p.commands.lint, 'yarn eslint .');
  });

  test('yarn berry (.yarnrc.yml) -> --immutable', () => {
    assert.equal(only(detect('node-yarn-berry')).commands.install, 'yarn install --immutable');
  });

  test('bun lockfile; prettier dependency -> bunx prettier --check', () => {
    const p = only(detect('node-bun'));
    assert.equal(p.packageManager, 'bun');
    assert.equal(p.commands.install, 'bun install --frozen-lockfile');
    assert.equal(p.commands.format, 'bunx prettier --check .');
  });

  test('no lockfile -> npm install; the npm init placeholder test script is ignored', () => {
    const p = only(detect('node-nolock'));
    assert.equal(p.commands.install, 'npm install');
    assert.equal(p.commands.test, 'npx jest --ci');
  });

  test('next: framework stacks merge with node; Dockerfile does not override; public/ is no project', () => {
    const r = detect('next-app');
    const p = only(r);
    assert.deepEqual(p.stacks, ['node', 'typescript', 'react', 'next', 'dockerfile']);
    assert.deepEqual(p.ecosystems, ['javascript-typescript', 'infra']);
    assert.equal(p.commands.build, 'npm run build');
    assert.equal(p.commands.run, 'npm run dev');
    assert.equal(p.commands.types, 'npx tsc --noEmit');
  });

  test('react-vite: framework fallback when no build script; tsconfig.app.json; no static-html', () => {
    const p = only(detect('react-vite'));
    assert.deepEqual(p.stacks, ['node', 'typescript', 'react', 'react-vite']);
    assert.equal(p.commands.build, 'npx vite build');
    assert.equal(p.commands.types, 'npx tsc --noEmit -p tsconfig.app.json');
    assert.equal(p.commands.run, 'npm run dev');
  });

  test('create-react-app: test script runs once (npm needs the -- separator)', () => {
    const p = only(detect('cra'));
    assert.equal(p.commands.test, 'npm run test -- --watchAll=false');
    assert.equal(p.commands.build, 'npx react-scripts build');
  });

  test('angular with pnpm and karma: no separator, headless, no watch', () => {
    const p = only(detect('angular-pnpm'));
    assert.equal(p.commands.test, 'pnpm run test --watch=false --browsers=ChromeHeadless');
    assert.equal(p.commands.build, 'pnpm run build');
    assert.equal(p.commands.run, 'pnpm exec ng serve');
  });

  test('nuxt without scripts uses nuxi', () => {
    const p = only(detect('nuxt'));
    assert.deepEqual(p.stacks, ['node', 'vue', 'nuxt']);
    assert.equal(p.commands.build, 'npx nuxi build');
    assert.equal(p.commands.types, 'npx nuxi typecheck');
  });

  test('sveltekit: "check" script is the type check', () => {
    const p = only(detect('sveltekit'));
    assert.deepEqual(p.stacks, ['node', 'svelte', 'sveltekit']);
    assert.equal(p.commands.types, 'npm run check');
    assert.equal(p.commands.build, 'npx vite build');
  });

  test('nest: start:dev script beats the generic start script', () => {
    const p = only(detect('nest'));
    assert.deepEqual(p.stacks, ['node', 'nest', 'express']);
    assert.equal(p.commands.run, 'npm run start:dev');
    assert.equal(p.commands.build, 'npx nest build');
  });

  test('deno: deno.jsonc tasks with comments and trailing commas', () => {
    const p = only(detect('deno'));
    assert.deepEqual(p.stacks, ['deno']);
    assert.equal(p.commands.run, 'deno task dev');
    assert.equal(p.commands.types, 'deno check main.ts');
    assert.equal(p.commands.lint, 'deno lint');
    assert.equal(p.commands.test, '');
  });

  test('a lockfile in an ancestor directory selects the package manager', () => {
    const r = detect('inherit-lock');
    assert.equal(r.projects.length, 1);
    const p = at(r, 'web');
    assert.equal(p.packageManager, 'pnpm');
    assert.equal(p.commands.install, 'pnpm install --frozen-lockfile');
  });
});

// ---------------------------------------------------------------- Python

describe('detectProject: python', () => {
  test('pip + flask + pytest; interpreter name depends on the platform', () => {
    const p = only(detect('python-pip-flask'));
    assert.deepEqual(p.stacks, ['python', 'flask']);
    assert.equal(p.packageManager, 'pip');
    assert.equal(p.commands.install, 'python3 -m pip install -r requirements.txt');
    assert.equal(p.commands.test, 'python3 -m pytest -q');
    assert.equal(p.commands.run, 'python3 -m flask run');
    const w = only(detect('python-pip-flask', { platform: 'win32' }));
    assert.equal(w.commands.test, 'python -m pytest -q');
  });

  test('poetry + fastapi + ruff', () => {
    const p = only(detect('python-poetry-fastapi'));
    assert.equal(p.packageManager, 'poetry');
    assert.equal(p.commands.install, 'poetry install --no-interaction');
    assert.equal(p.commands.lint, 'poetry run ruff check .');
    assert.equal(p.commands.format, 'poetry run ruff format --check .');
    assert.equal(p.commands.run, 'poetry run uvicorn main:app --reload');
    assert.equal(p.commands.test, '', 'no pytest configured -> n/a, never a red pytest exit 5');
  });

  test('uv + django: manage.py check/test/runserver through uv', () => {
    const p = only(detect('python-uv-django'));
    assert.deepEqual(p.stacks, ['python', 'django']);
    assert.equal(p.packageManager, 'uv');
    assert.equal(p.commands.install, 'uv sync --locked');
    assert.equal(p.commands.build, 'uv run python manage.py check');
    assert.equal(p.commands.test, 'uv run python manage.py test');
    assert.equal(p.commands.run, 'uv run python manage.py runserver');
  });

  test('pipenv with a lockfile -> pipenv sync --dev', () => {
    const p = only(detect('pipenv'));
    assert.equal(p.packageManager, 'pipenv');
    assert.equal(p.commands.install, 'pipenv sync --dev');
  });
});

// ---------------------------------------------------------------- JVM and native

describe('detectProject: jvm, go, rust, dotnet, native', () => {
  test('maven wrapper: ./mvnw on posix, mvnw.cmd on Windows; spring-boot run; checkstyle', () => {
    const p = only(detect('maven-spring'));
    assert.deepEqual(p.stacks, ['maven', 'spring-boot']);
    assert.equal(p.packageManager, 'maven-wrapper');
    assert.equal(p.commands.test, './mvnw -B -q test');
    assert.equal(p.commands.lint, './mvnw -B -q checkstyle:check');
    assert.equal(p.commands.run, './mvnw spring-boot:run');
    const w = only(detect('maven-spring', { platform: 'win32' }));
    assert.equal(w.commands.test, 'mvnw.cmd -B -q test');
    assert.equal(w.commands.build, 'mvnw.cmd -B -q -DskipTests package');
  });

  test('gradle wrapper without gradlew.bat falls back to gradle on Windows; kotlin + detekt', () => {
    const p = only(detect('gradle-kotlin'));
    assert.deepEqual(p.stacks, ['gradle', 'kotlin']);
    assert.equal(p.commands.test, './gradlew test --console=plain');
    assert.equal(p.commands.lint, './gradlew detekt --console=plain');
    assert.equal(p.commands.run, './gradlew run --console=plain');
    const w = only(detect('gradle-kotlin', { platform: 'win32' }));
    assert.equal(w.packageManager, 'gradle');
    assert.equal(w.commands.test, 'gradle test --console=plain');
  });

  test('go: go wins over make; make fills only the empty field; Dockerfile adds nothing', () => {
    const p = only(detect('go'));
    assert.deepEqual(p.stacks, ['go', 'make', 'dockerfile']);
    assert.equal(p.commands.lint, 'golangci-lint run');
    assert.equal(p.commands.test, 'go test ./...');
    assert.equal(p.commands.types, 'make types');
    assert.equal(p.commands.build, 'go build ./...');
    assert.equal(p.commands.run, 'go run .');
  });

  test('cargo workspace folds member crates into the root project', () => {
    const p = only(detect('rust-workspace'));
    assert.equal(p.path, '.');
    assert.equal(p.commands.lint, 'cargo clippy --all-targets -- -D warnings');
    assert.ok(p.notes.includes('workspace members: crates/cli, crates/core'), p.notes.join(' | '));
  });

  test('dotnet solution: explicit .sln, web project run, csproj folders folded', () => {
    const p = only(detect('dotnet'));
    assert.deepEqual(p.stacks, ['dotnet', 'aspnet-core']);
    assert.equal(p.commands.build, 'dotnet build App.sln --nologo');
    assert.equal(p.commands.test, 'dotnet test App.sln --nologo');
    assert.equal(p.commands.run, 'dotnet run --project src/Api/Api.csproj');
  });

  test('make + C sources: Makefile targets become the commands', () => {
    const p = only(detect('make-c'));
    assert.deepEqual(p.stacks, ['make', 'c-cpp']);
    assert.equal(p.commands.build, 'make');
    assert.equal(p.commands.test, 'make test');
    assert.equal(p.commands.lint, 'make lint');
  });
});

// ---------------------------------------------------------------- other ecosystems

describe('detectProject: php, ruby, mobile, web, beam', () => {
  test('laravel + vite in one directory: php first, node commands joined', () => {
    const p = only(detect('laravel'));
    assert.deepEqual(p.stacks, ['node', 'vite', 'php', 'laravel']);
    assert.equal(p.commands.install, 'composer install --no-interaction --prefer-dist && npm install');
    assert.equal(p.commands.test, 'php artisan test');
    assert.equal(p.commands.build, 'npm run build');
    assert.equal(p.commands.run, 'php artisan serve');
    assert.equal(p.commands.format, 'php vendor/bin/pint --test');
  });

  test('rails with rspec and rubocop', () => {
    const p = only(detect('rails'));
    assert.deepEqual(p.stacks, ['ruby', 'rails']);
    assert.equal(p.commands.test, 'bundle exec rspec');
    assert.equal(p.commands.lint, 'bundle exec rubocop');
    assert.equal(p.commands.run, 'bundle exec rails server');
  });

  test('flutter: android/ and ios/ platform folders are not separate projects', () => {
    const p = only(detect('flutter'));
    assert.deepEqual(p.stacks, ['flutter']);
    assert.equal(p.commands.lint, 'flutter analyze');
    assert.equal(p.commands.test, 'flutter test');
    assert.ok(p.notes.includes('workspace members: android, ios'), p.notes.join(' | '));
  });

  test('static html is a fallback stack', () => {
    const p = only(detect('static-site'));
    assert.deepEqual(p.stacks, ['static-html']);
    assert.equal(p.commands.run, 'python3 -m http.server 8000');
  });

  test('hugo', () => {
    const p = only(detect('hugo'));
    assert.deepEqual(p.stacks, ['hugo']);
    assert.equal(p.commands.build, 'hugo --minify');
  });

  test('phoenix with credo', () => {
    const p = only(detect('phoenix'));
    assert.deepEqual(p.stacks, ['elixir-mix', 'phoenix']);
    assert.equal(p.commands.run, 'mix phx.server');
    assert.equal(p.commands.lint, 'mix credo --strict');
  });
});

// ---------------------------------------------------------------- trees

describe('detectProject: trees, monorepos and multi-stack directories', () => {
  test('workspace of repos: each repo is a project; root and docker/ are not', () => {
    const r = detect('workspace-of-repos');
    assert.deepEqual(r.projects.map((p) => p.path), ['api', 'charts/portal', 'infra', 'k8s', 'web']);
    assert.equal(at(r, 'api').commands.run, 'uv run uvicorn app.main:app --reload');
    assert.equal(at(r, 'charts/portal').commands.lint, 'helm lint .');
    assert.equal(at(r, 'infra').commands.build, 'terraform init -backend=false -input=false && terraform validate');
    assert.deepEqual(at(r, 'k8s').stacks, ['kubernetes']);
    assert.deepEqual(at(r, 'web').stacks, ['node', 'react', 'next']);
  });

  test('npm workspaces fold JS members; a python service stays its own project', () => {
    const r = detect('js-workspace');
    assert.deepEqual(r.projects.map((p) => p.path), ['.', 'services/ml']);
    assert.ok(at(r, '.').notes.includes('workspace members: apps/web, packages/ui'));
    const ml = at(r, 'services/ml');
    assert.deepEqual(ml.stacks, ['python', 'python-ml', 'dockerfile']);
    assert.deepEqual(ml.ecosystems, ['python', 'data-ml', 'infra']);
    assert.equal(ml.commands.install, 'python3 -m pip install -e .');
  });

  test('several stacks in one directory: commands joined, primary family first', () => {
    const p = only(detect('django-assets'));
    assert.deepEqual(p.stacks, ['node', 'python', 'django']);
    assert.equal(p.packageManager, 'pip');
    assert.equal(p.commands.install, 'python3 -m pip install -r requirements.txt && npm ci');
    assert.equal(p.commands.build, 'python3 manage.py check && npm run build');
    assert.equal(p.commands.test, 'python3 manage.py test && npm run test');
    assert.equal(p.commands.run, 'python3 manage.py runserver');
    assert.ok(p.notes.includes('node: npm'));
  });

  test('skip directories are never scanned', () => {
    const files = { 'real/go.mod': 'module x\n' };
    for (const d of ['node_modules/x', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.idea', '.vscode', 'coverage', '.git']) {
      files[`${d}/package.json`] = '{}';
      files[`${d}/pyproject.toml`] = '[project]\n';
    }
    const r = detectProject(tmpTree(files), { platform: 'linux' });
    assert.deepEqual(r.projects.map((p) => p.path), ['real']);
  });

  test('depth limit: depth 2 by default, configurable', () => {
    const dir = tmpTree({ 'a/b/package.json': '{}', 'a/b/c/Cargo.toml': '[package]\n', 'x/go.mod': 'module x\n' });
    assert.deepEqual(detectProject(dir, { platform: 'linux' }).projects.map((p) => p.path), ['a/b', 'x']);
    assert.deepEqual(detectProject(dir, { platform: 'linux', maxDepth: 1 }).projects.map((p) => p.path), ['x']);
    assert.deepEqual(detectProject(dir, { platform: 'linux', maxDepth: 3 }).projects.map((p) => p.path), ['a/b', 'a/b/c', 'x']);
  });

  test('a Dockerfile-only subfolder is reported as a note on the enclosing project', () => {
    const dir = tmpTree({ 'go.mod': 'module x\n', 'docker/Dockerfile': 'FROM scratch\n' });
    const p = only(detectProject(dir, { platform: 'linux' }));
    assert.ok(p.notes.includes('also: docker/ (dockerfile)'), p.notes.join(' | '));
  });

  test('a Dockerfile-only root uses the docker commands', () => {
    const dir = tmpTree({ 'Dockerfile': 'FROM scratch\n' });
    const p = only(detectProject(dir, { platform: 'linux' }));
    assert.match(p.commands.build, /^docker build -t [a-z0-9._-]+:dev \.$/);
  });

  test('empty directory -> no projects; a file path fails', () => {
    assert.deepEqual(detectProject(tmpTree({ 'notes.txt': 'x' })).projects, []);
    assert.throws(() => detectProject(path.join(fx('node-npm'), 'package.json')), /not a directory/);
  });
});

// ---------------------------------------------------------------- team.json merge

describe('mergeTeamProjects', () => {
  const detected = [
    { path: '.', stacks: ['node', 'next'], commands: { install: 'npm ci', build: 'npm run build', lint: 'npm run lint', types: '', test: 'npm test', run: 'npm run dev', format: '' } },
    { path: 'api', stacks: ['python'], commands: { install: 'uv sync', build: '', lint: '', types: '', test: 'uv run pytest -q', run: '', format: '' } },
  ];
  const base = {
    team: 'portal',
    projects: [
      { path: './', stack: ['node'], commands: { install: '', build: 'make web', lint: '', types: '', test: '', run: '', format: '' } },
      { path: 'docs', stack: [], commands: { install: '', build: '', lint: '', types: '', test: '', run: '', format: '' } },
      { path: 'legacy', stack: ['php'], commands: { test: 'phpunit' } },
    ],
    environments: { test: { deploy: 'x' } },
  };

  test('fills empty fields only, adds projects, drops unconfirmed placeholders, keeps the rest', () => {
    const res = mergeTeamProjects(base, detected);
    const root = res.team.projects.find((p) => p.path === './');
    assert.equal(root.commands.build, 'make web');
    assert.equal(root.commands.install, 'npm ci');
    assert.deepEqual(root.stack, ['node', 'next']);
    assert.deepEqual(res.added, ['api']);
    assert.deepEqual(res.removed, ['docs']);
    assert.ok(res.team.projects.some((p) => p.path === 'legacy'));
    assert.deepEqual(res.team.environments, base.environments);
    assert.equal(base.projects[0].commands.install, '', 'input is not mutated');
    assert.equal(res.replaced, 0);
    assert.ok(res.changed);
    assert.deepEqual(Object.keys(res.team.projects.find((p) => p.path === 'api').commands), COMMAND_KEYS);
  });

  test('overwrite replaces non-empty commands, never with empty ones', () => {
    const res = mergeTeamProjects(base, detected, { overwrite: true });
    const root = res.team.projects.find((p) => p.path === './');
    assert.equal(root.commands.build, 'npm run build');
    assert.equal(res.replaced, 1);
    const again = mergeTeamProjects(res.team, detected, { overwrite: true });
    assert.equal(again.changed, false);
  });
});

// ---------------------------------------------------------------- CLI

describe('hades detect (CLI)', () => {
  const noVault = { HADES_VAULT: path.join(os.tmpdir(), `hades-no-vault-${process.pid}`) };

  test('--json prints the detection result without a vault', () => {
    const r = cli([fx('workspace-of-repos'), '--json'], noVault);
    assert.equal(r.code, 0, r.err);
    const data = JSON.parse(r.out);
    assert.deepEqual(data, detectProject(fx('workspace-of-repos')));
  });

  test('prints a compact table: path, stacks, package manager, commands, n/a', () => {
    const r = cli([fx('node-pnpm')], noVault);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^\. {2}node, typescript {2}\[pnpm\]$/m);
    assert.match(r.out, /^ {2}install pnpm install --frozen-lockfile$/m);
    assert.match(r.out, /^ {2}n\/a {5}build, lint, run, format$/m);
  });

  test('--help, and a missing directory exits 1', () => {
    const h = cli(['--help'], noVault);
    assert.equal(h.code, 0);
    assert.match(h.out, /Usage: hades detect/);
    const m = cli([path.join(FIX, 'does-not-exist')], noVault);
    assert.equal(m.code, 1);
    assert.match(m.err, /not a directory/);
  });

  function makeVault(projectPath, teamJson) {
    const vault = tmpTree({});
    const teamDir = 'organizations/acme/teams/portal';
    fs.mkdirSync(path.join(vault, teamDir), { recursive: true });
    fs.writeFileSync(path.join(vault, 'registry.json'), JSON.stringify({
      version: 3,
      organizations: { acme: { org_dir: 'organizations/acme', root_path: path.dirname(projectPath), aliases: [], created: '2026-10-31' } },
      teams: { portal: { organization: 'acme', type: 'main', project_path: projectPath, team_dir: teamDir, aliases: ['acme-portal'], status: 'active', created: '2026-10-31' } },
    }, null, 2));
    const file = path.join(vault, teamDir, 'team.json');
    if (teamJson) fs.writeFileSync(file, JSON.stringify(teamJson, null, 2));
    return { vault, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  const envs = {
    test: { url: 'https://test.example.com', deploy: 'npm run deploy:test', health: 'curl -fsS https://test.example.com/health', rollback: 'npm run rollback', via_push: false, notes: 'keep' },
    live: { url: '', deploy: '', health: '', rollback: '', via_push: true, notes: '' },
  };
  const empty = () => Object.fromEntries(COMMAND_KEYS.map((k) => [k, '']));

  test('--write fills team.json: empty fields only, new projects, placeholder removed, environments untouched', () => {
    const project = fx('workspace-of-repos');
    const v = makeVault(project, {
      team: 'portal',
      projects: [
        { path: '.', stack: [], commands: empty() },
        { path: 'web', stack: ['node'], commands: { ...empty(), build: 'custom build' } },
      ],
      environments: envs,
      branch_strategy: 'current-branch',
    });
    const r = cli(['--write', 'acme-portal'], { HADES_VAULT: v.vault });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /team\.json \(portal\): \+4 project\(s\)/);
    const doc = v.read();
    assert.deepEqual(doc.projects.map((p) => p.path), ['web', 'api', 'charts/portal', 'infra', 'k8s']);
    const web = doc.projects[0];
    assert.equal(web.commands.build, 'custom build');
    assert.equal(web.commands.install, 'npm ci');
    assert.deepEqual(web.stack, ['node', 'react', 'next']);
    assert.deepEqual(doc.environments, envs);
    assert.equal(doc.branch_strategy, 'current-branch');

    const o = cli(['--write', 'portal', '--overwrite', '--json'], { HADES_VAULT: v.vault });
    assert.equal(o.code, 0, o.err);
    assert.equal(JSON.parse(o.out).written.replaced, 1);
    assert.equal(v.read().projects[0].commands.build, 'npm run build');
    assert.deepEqual(v.read().environments, envs);
  });

  test('--write with a subdirectory stores paths relative to the team project', () => {
    const project = fx('workspace-of-repos');
    const v = makeVault(project, null);
    const r = cli([`${project}/api`, '--write', 'portal', '--json'], { HADES_VAULT: v.vault });
    assert.equal(r.code, 0, r.err);
    const doc = v.read();
    assert.equal(doc.team, 'portal');
    assert.deepEqual(doc.projects.map((p) => p.path), ['api']);
    assert.equal(doc.projects[0].commands.install, 'uv sync --locked');
    assert.equal(doc.environments, undefined);
  });

  test('--write errors: unknown team, path outside the project, no vault', () => {
    const v = makeVault(fx('workspace-of-repos'), null);
    const u = cli(['--write', 'nope'], { HADES_VAULT: v.vault });
    assert.equal(u.code, 1);
    assert.match(u.err, /unknown team/);
    const o = cli([fx('node-npm'), '--write', 'portal'], { HADES_VAULT: v.vault });
    assert.equal(o.code, 1);
    assert.match(o.err, /outside the project/);
    const n = cli([fx('node-npm'), '--write', 'portal'], noVault);
    assert.equal(n.code, 1);
    assert.match(n.err, /no vault/);
  });
});

describe('learned fingerprints in the vault (company/playbooks/stacks.json)', () => {
  const zig = { id: 'zig', ecosystem: 'cpp-c', markers: ['build.zig'], commands: { build: 'zig build', test: 'zig build test' } };

  test('mergeStacks: same id replaces in place, new ids are appended', () => {
    const merged = mergeStacks([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 1 }]);
    assert.deepEqual(merged, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 1 }]);
  });

  test('loadStacksFor merges a valid vault file and ignores an invalid one with a warning', () => {
    const vault = tmpTree({});
    assert.deepEqual(loadStacksFor({ vault }).files.length, 1, 'no vault file -> engine only');
    fs.mkdirSync(path.join(vault, 'company', 'playbooks'), { recursive: true });
    fs.writeFileSync(vaultStacksFile(vault), JSON.stringify([zig]));
    const ok = loadStacksFor({ vault });
    assert.deepEqual(ok.warnings, []);
    assert.equal(ok.files[1], vaultStacksFile(vault));
    assert.ok(ok.stacks.some((s) => s.id === 'zig'));
    assert.equal(ok.stacks.length, loadStacks().length + 1);
    fs.writeFileSync(vaultStacksFile(vault), JSON.stringify([{ ...zig, ecosystem: 'nope' }]));
    const bad = loadStacksFor({ vault });
    assert.equal(bad.stacks.length, loadStacks().length);
    assert.match(bad.warnings[0], /ignored: zig: unknown ecosystem "nope"/);
  });

  test('hades detect uses the vault file when HADES_VAULT has one; a broken file only warns', () => {
    const project = tmpTree({ 'build.zig': 'const std = @import("std");\n' });
    const vault = tmpTree({});
    const none = cli([project], { HADES_VAULT: vault });
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /no known stack/);
    fs.mkdirSync(path.join(vault, 'company', 'playbooks'), { recursive: true });
    fs.writeFileSync(vaultStacksFile(vault), JSON.stringify([zig]));
    const r = cli([project, '--json'], { HADES_VAULT: vault });
    assert.equal(r.code, 0, r.err);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.projects.map((p) => [p.path, p.stacks, p.commands.build, p.commands.test]), [['.', ['zig'], 'zig build', 'zig build test']]);
    assert.equal(data.learned, vaultStacksFile(vault));
    fs.writeFileSync(vaultStacksFile(vault), '{ not json');
    const b = cli([project], { HADES_VAULT: vault });
    assert.equal(b.code, 0, b.err);
    assert.match(b.err, /warning: .*stacks\.json ignored: invalid JSON/);
    assert.match(b.out, /no known stack/);
  });
});
