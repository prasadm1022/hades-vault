// Tests for "hades migrate" (lib/core/migrate.mjs + lib/commands/migrate.mjs).
// Every test works on a temp copy of tests/fixtures/migrate/v1-vault; git runs with an isolated,
// empty global config. No network, no Docker, no real machine config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  migrateVault, rewriteV1Paths, normalizeNote, parseTeamMd, purposeKeys, splitRow,
  V2_ROLES, STAFF_ROLES, MARKER, ENV_TODO, V2_MARK,
} from '../../lib/core/migrate.mjs';
import { formatReport } from '../../lib/commands/migrate.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ENGINE_ROOT, 'tests', 'fixtures', 'migrate', 'v1-vault');
const OLD_VAULT = 'C:/Users/owner/git/v1-vault';
const slash = (p) => p.replace(/\\/g, '/');
const PORTAL = 'organizations/acme/teams/portal';
const DOCS = 'organizations/acme/teams/docs-site';
const SHOP = 'organizations/globex/teams/shop';

let TMP;
let TPL;
let n = 0;
const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const saved = {};

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hades-migrate-'));
  // Isolate git from the machine's config (autocrlf, signing, hooks ...).
  const gitconfig = path.join(TMP, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HADES_TEMPLATES_DIR']) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // Small stand-in for the engine templates (the real ones may change independently).
  TPL = path.join(TMP, 'templates');
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(TPL, rel)), { recursive: true });
    fs.writeFileSync(path.join(TPL, rel), text);
  };
  for (const role of V2_ROLES) {
    w(`team/agents/${role}.md`, `---\nrole: ${role}\nteam: {{TEAM}}\n---\n# ${role} - team {{TEAM}} notes\n\n## Overrides\n\n## Project notes\n<!-- tpl -->\n`);
  }
  w('team/CONTEXT.md', '# {{TEAM}} - context\n\n## Purpose\n{{DESCRIPTION}}\n');
  w('team/team.json', JSON.stringify({ team: '{{TEAM}}', projects: [], environments: {}, branch_strategy: 'current-branch', security: { semgrep_config: 'p/default', dast_live: 'baseline', dast_test: 'full' } }, null, 2));
  w('vault/CLAUDE.md', '# HADES vault\n\nEngine: `{{ENGINE}}`.\n');
  w('vault/README.md', '# HADES vault\n\nEngine: `{{ENGINE}}`.\n');
  w('vault/company/README.md', '# Company (vault)\n\ntemplate company readme\n');
  for (const role of STAFF_ROLES) w(`vault/company/staff/${role}.md`, `---\nrole: ${role}\nscope: company\n---\n# ${role} - company notes\n`);
  process.env.HADES_TEMPLATES_DIR = TPL;
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// Fresh copy of the fixture: { vault, engine, ctx }. withGit: git init + commit everything.
function setup({ withGit = true } = {}) {
  const dir = path.join(TMP, `case-${++n}`);
  const vault = slash(path.join(dir, 'vault'));
  const engine = slash(path.join(dir, 'engine'));
  fs.cpSync(FIXTURE, vault, { recursive: true });
  fs.mkdirSync(engine, { recursive: true });
  if (withGit) {
    git(vault, 'init', '-q');
    git(vault, 'add', '-A');
    git(vault, 'commit', '-q', '-m', 'v1');
  }
  return { vault, engine, ctx: { vault, engine, configFile: `${engine}/hades.config.json` } };
}

const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');
const exists = (vault, rel) => fs.existsSync(path.join(vault, rel));
const fixture = (rel) => fs.readFileSync(path.join(FIXTURE, rel), 'utf8');

function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
    }
  };
  walk(root, '');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pure functions

test('rewriteV1Paths maps exact v1 framework paths and leaves everything else', () => {
  const engine = 'E:/eng';
  const text = [
    `a \`${OLD_VAULT}/company/roles/senior-qa-engineer.md\``,
    'b `C:\\Users\\owner\\git\\v1-vault\\company\\skills\\testing-qa\\SKILL.md`',
    'c `company/workflow/task-lifecycle.md` and company/workflow/handover-protocol.md.',
    'd see company/skills/knowledge-capture. and `company/skills/security-review`',
    'e `company/templates/team/TEAM.md` and {{VAULT}}/company/roles/project-manager.md',
    'f ../../company/roles/uiux-engineer.md',
    `g ${OLD_VAULT}/HADES.md`,
    'h keep `company/skills/` and src/company/roles/admin.md and company/roles/unknown.md',
    'i keep company/skills/testing-qa/references/x.md and HADES.md',
  ].join('\n');
  const { text: out, count } = rewriteV1Paths(text, { engine, vaults: [OLD_VAULT] });
  const lines = out.split('\n');
  assert.equal(lines[0], 'a `E:/eng/agents/hades-qa-engineer.md`');
  assert.equal(lines[1], 'b `E:/eng/playbooks/qa-automation.md`');
  assert.equal(lines[2], 'c `E:/eng/company/pipeline.md` and E:/eng/company/handover.md.');
  assert.equal(lines[3], 'd see E:/eng/playbooks/knowledge-capture.md. and `E:/eng/playbooks/security-testing.md`');
  assert.equal(lines[4], 'e `E:/eng/templates/team/TEAM.md` and E:/eng/HADES.md');
  assert.equal(lines[5], 'f E:/eng/agents/hades-frontend-engineer.md');
  assert.equal(lines[6], 'g E:/eng/HADES.md');
  assert.equal(lines[7], text.split('\n')[7]);
  assert.equal(lines[8], text.split('\n')[8]);
  assert.equal(count, 10);
  assert.equal(rewriteV1Paths(out, { engine, vaults: [OLD_VAULT] }).count, 0, 'idempotent');
});

test('rewriteV1Paths covers every v1 skill and workflow file', () => {
  const skills = ['implementation', 'testing-qa', 'security-review', 'devops-ci', 'ui-ux-design', 'ai-ml-engineering', 'architecture-design', 'requirements-analysis', 'code-review', 'git-commit', 'knowledge-capture', 'task-intake'];
  const flows = ['task-lifecycle', 'handover-protocol', 'model-routing', 'quality-gates', 'commit-policy'];
  const text = [...skills.map((s) => `company/skills/${s}/SKILL.md`), ...flows.map((f) => `company/workflow/${f}.md`)].join('\n');
  const { text: out, count } = rewriteV1Paths(text, { engine: '/e', vaults: [] });
  assert.equal(count, skills.length + flows.length);
  assert.deepEqual(out.split('\n'), [
    '/e/company/pipeline.md', '/e/playbooks/qa-automation.md', '/e/playbooks/security-testing.md', '/e/playbooks/deployment.md',
    '/e/playbooks/ui-ux-design.md', '/e/playbooks/tech/data-ml.md', '/e/agents/hades-software-architect.md',
    '/e/agents/hades-business-analyst.md', '/e/agents/hades-tech-lead.md', '/e/company/commit-policy.md',
    '/e/playbooks/knowledge-capture.md', '/e/skills/hades/SKILL.md',
    '/e/company/pipeline.md', '/e/company/handover.md', '/e/company/model-routing.md', '/e/company/quality-gates.md', '/e/company/commit-policy.md',
  ]);
});

test('normalizeNote rewrites the frontmatter, drops the base-role line, keeps CRLF, is idempotent', () => {
  const raw = '---\r\nname: senior-qa-engineer\r\nmodel: opus\r\norganization: acme\r\nteam: portal\r\nextends: company/roles/senior-qa-engineer.md\r\n---\r\n\r\n# QA - team portal\r\n\r\nRead the base role first: `X/company/roles/senior-qa-engineer.md`. Everything there applies.\r\n\r\n## Project notes\r\n- a\r\n';
  const out = normalizeNote(raw, { role: 'qa-engineer', team: 'portal' });
  assert.equal(out, '---\r\nname: qa-engineer\r\nrole: qa-engineer\r\nmodel: opus\r\norganization: acme\r\nteam: portal\r\n---\r\n\r\n# QA - team portal\r\n\r\n## Project notes\r\n- a\r\n');
  assert.equal(normalizeNote(out, { role: 'qa-engineer', team: 'portal' }), out);
  const v2 = '---\nrole: tech-lead\nteam: portal\n---\n# notes\n';
  assert.equal(normalizeNote(v2, { role: 'tech-lead', team: 'portal' }), v2, 'v2 template notes are left alone');
  assert.equal(normalizeNote('# bare\n', { role: 'qa-engineer', team: 't' }), '---\nrole: qa-engineer\nteam: t\n---\n\n# bare\n');
});

test('splitRow and purposeKeys handle code spans, escaped pipes and combined purposes', () => {
  assert.deepEqual(splitRow('| verify | `api` | `grep -l "A\\|B" x` |'), ['verify', '`api`', '`grep -l "A|B" x`']);
  assert.deepEqual(splitRow('| a | `x | y` | c |'), ['a', '`x | y`', 'c']);
  assert.deepEqual(purposeKeys('build + test'), ['build', 'test']);
  assert.deepEqual(purposeKeys('lint / type-check'), ['lint', 'types']);
  assert.deepEqual(purposeKeys('build (skip tests)'), ['build']);
  assert.deepEqual(purposeKeys('run (web, dev)'), ['run']);
  assert.deepEqual(purposeKeys('single test class / method'), []);
  assert.deepEqual(purposeKeys('docker build (manual)'), []);
});

test('parseTeamMd reads projects, commands per directory and branch strategy', () => {
  const portal = parseTeamMd(fixture(`${PORTAL}/TEAM.md`), { projectPath: 'C:/Users/owner/git/acme/portal' });
  assert.deepEqual(portal.projects.map((p) => p.path), ['portal-api', 'portal-web']);
  assert.deepEqual(portal.projects[0].commands, { install: '', build: 'mvn -q package -DskipTests', lint: '', types: '', test: 'mvn -q package', run: 'mvn spring-boot:run', format: '' });
  assert.deepEqual(portal.projects[1].commands, { install: 'npm ci', build: 'npm run build', lint: 'npm run lint', types: 'npm run lint', test: 'npm test', run: 'npm run dev', format: '' });
  assert.equal(portal.branch_strategy, 'current-branch');
  const docs = parseTeamMd(fixture(`${DOCS}/TEAM.md`), { projectPath: 'C:/Users/owner/git/acme/docs-site' });
  assert.deepEqual(docs.projects.map((p) => p.path), ['.']);
  assert.equal(docs.projects[0].commands.install, 'npm install');
  assert.equal(docs.projects[0].commands.build, '', '"web" is not a project: left empty');
  assert.equal(docs.unplaced, 1);
  assert.equal(docs.branch_strategy, 'feature-branch');
  const shop = parseTeamMd(fixture(`${SHOP}/TEAM.md`), { projectPath: 'C:/Users/owner/git/globex/shop' });
  assert.deepEqual(shop.projects.map((p) => p.path), ['.', 'api', 'web']);
  assert.equal(shop.projects[1].commands.test, 'mvn test');
  assert.equal(shop.projects[2].commands.install, 'npm install');
  assert.deepEqual(parseTeamMd('# no tables\n').projects, [{ path: '.', stack: [], commands: { install: '', build: '', lint: '', types: '', test: '', run: '', format: '' } }]);
  const tsHint = parseTeamMd('## Commands\n| Purpose | Directory | Command |\n|---|---|---|\n| test | project-x | `go test ./...` |\n', { projectPath: '/w/project-x' });
  assert.equal(tsHint.projects[0].commands.test, 'go test ./...', 'directory named like the project folder = "."');
});

// ---------------------------------------------------------------------------------------------
// The migration on the fixture

test('dry run plans every step and writes nothing', { skip: !HAS_GIT }, () => {
  const { vault, engine, ctx } = setup();
  const before = snapshot(vault);
  const r = migrateVault(ctx, { dryRun: true });
  assert.deepEqual(snapshot(vault), before);
  assert.equal(git(vault, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(`${engine}/hades.config.json`), false);
  assert.equal(r.dryRun, true);
  assert.equal(r.git, true);
  // renamed 3+2+1, kept as .v1.md 2+1+2, created 3+7+7, frontmatter 7+3+3 (portal, docs-site, shop)
  assert.deepEqual(r.steps.roles, { renamed: 6, kept: 5, created: 17, frontmatter: 13 });
  assert.equal(r.steps.archive.moved, 35);
  assert.equal(r.steps.teams.teamJson, 3);
  assert.equal(r.steps.teams.context, 3);
  assert.deepEqual(r.steps.company.docs, ['HADES.md', 'CLAUDE.md', 'README.md']);
  assert.ok(r.steps.paths.refs > 20);
  assert.equal(r.changes, r.actions.length);
  assert.ok(r.actions.some((a) => a.op === 'config'));
  assert.ok(r.actions.some((a) => a.op === 'move' && a.path === `${PORTAL}/agents/senior-qa-engineer.md` && a.to === `${PORTAL}/agents/qa-engineer.md`));
  const text = formatReport(r);
  assert.match(text, /dry run, nothing written/);
  assert.match(text, /registry {2}v2 -> v3; hades\.config\.json: vault, workspace/);
  assert.match(text, /plan \(\d+ actions, first 25; --json for all\):/);
  assert.ok(text.split('\n').length < 60);
});

test('migrates the fixture vault', { skip: !HAS_GIT }, () => {
  const { vault, engine, ctx } = setup();
  const r = migrateVault(ctx);

  // registry v3 + hades.config.json
  const reg = JSON.parse(read(vault, 'registry.json'));
  const orig = JSON.parse(fixture('registry.json'));
  assert.deepEqual(Object.keys(reg), ['version', 'organizations', 'teams']);
  assert.equal(reg.version, 3);
  assert.deepEqual(Object.keys(reg.teams.portal), Object.keys(orig.teams.portal), 'key order kept');
  assert.deepEqual(reg.teams.portal, orig.teams.portal);
  assert.deepEqual(reg.teams['docs-site'].aliases, ['docs', 'ds']);
  assert.equal(reg.teams['docs-site'].status, 'active');
  assert.equal(reg.teams.shop.type, 'main');
  assert.deepEqual(reg.teams.shop.aliases, []);
  assert.deepEqual(reg.organizations.globex.aliases, ['gx', 'globex-inc']);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${engine}/hades.config.json`, 'utf8')), { vault, workspace: 'C:/Users/owner/git' });
  assert.ok(r.warnings.some((w) => w.includes(OLD_VAULT)));

  // role notes: full roster, renames through git, split sources kept
  for (const t of [PORTAL, DOCS, SHOP]) {
    for (const role of V2_ROLES) assert.ok(exists(vault, `${t}/agents/${role}.md`), `${t} ${role}`);
    for (const old of ['senior-qa-engineer', 'senior-aiml-engineer', 'security-engineer', 'senior-fullstack-engineer', 'uiux-engineer']) {
      assert.ok(!exists(vault, `${t}/agents/${old}.md`), `${t} ${old} gone`);
    }
  }
  assert.ok(exists(vault, `${PORTAL}/agents/senior-fullstack-engineer.v1.md`) && exists(vault, `${PORTAL}/agents/uiux-engineer.v1.md`));
  assert.ok(exists(vault, `${DOCS}/agents/senior-fullstack-engineer.v1.md`) && !exists(vault, `${DOCS}/agents/uiux-engineer.v1.md`));
  const tracked = git(vault, 'ls-files').split('\n');
  assert.ok(tracked.includes(`${PORTAL}/agents/qa-engineer.md`), 'renamed with git mv');
  assert.ok(!tracked.includes(`${PORTAL}/agents/senior-qa-engineer.md`));
  assert.ok(tracked.includes('archive/v1/company/roles/senior-qa-engineer.md'));

  const qa = read(vault, `${PORTAL}/agents/qa-engineer.md`);
  assert.match(qa, /^---\nname: qa-engineer\nrole: qa-engineer\nmodel: opus\norganization: acme\nteam: portal\n---\n/);
  assert.doesNotMatch(qa, /extends:|Read the base role first/);
  assert.ok(qa.includes(`\`${engine}/playbooks/qa-automation.md\``), 'backslash v1 path rewritten');
  assert.ok(qa.includes('- Test accounts by name only.'), 'notes kept');
  assert.ok(read(vault, `${PORTAL}/agents/business-analyst.md`).includes(`${engine}/agents/hades-business-analyst.md`));
  assert.match(read(vault, `${SHOP}/agents/aiml-data-engineer.md`), /name: aiml-data-engineer\nrole: aiml-data-engineer/);
  assert.match(read(vault, `${DOCS}/agents/cybersecurity-engineer.md`), /name: cybersecurity-engineer/);
  assert.ok(read(vault, `${PORTAL}/agents/backend-engineer.md`).includes(`## Project notes\n<!-- ${MARKER} split notes from senior-fullstack-engineer.v1.md -->\n<!-- tpl -->`));
  assert.ok(read(vault, `${PORTAL}/agents/frontend-engineer.md`).includes(`<!-- ${MARKER} split notes from senior-fullstack-engineer.v1.md and uiux-engineer.v1.md -->`));
  assert.ok(read(vault, `${DOCS}/agents/frontend-engineer.md`).includes(`<!-- ${MARKER} split notes from senior-fullstack-engineer.v1.md -->`));
  assert.equal(read(vault, `${PORTAL}/agents/tech-lead.md`), '---\nrole: tech-lead\nteam: portal\n---\n# tech-lead - team portal notes\n\n## Overrides\n\n## Project notes\n<!-- tpl -->\n');
  assert.ok(read(vault, `${PORTAL}/agents/senior-fullstack-engineer.v1.md`).includes(`${engine}/company/pipeline.md`), '.v1.md paths rewritten too');

  // path rewrite across notes; history left alone
  const conv = read(vault, `${PORTAL}/knowledge/conventions.md`);
  assert.ok(conv.includes(`\`${engine}/company/model-routing.md\``));
  assert.ok(conv.includes(`\`${engine}/company/quality-gates.md\``));
  assert.ok(conv.includes(`\`${engine}/templates/project.md\``));
  assert.ok(conv.includes(`\`${engine}/playbooks/knowledge-capture.md\``));
  assert.ok(conv.includes(`\`${engine}/agents/hades-qa-engineer.md\``));
  assert.ok(conv.includes('`company/skills/` (generic') && conv.includes('src/company/roles/admin.md') && conv.includes('company/roles/data-steward.md'));
  assert.ok(read(vault, 'organizations/acme/ORG.md').includes(`\`${engine}/HADES.md\``));
  assert.ok(read(vault, 'organizations/acme/knowledge/lessons.md').includes(`${engine}/playbooks/knowledge-capture.md.`));
  assert.ok(read(vault, `${PORTAL}/skills/local-dev/SKILL.md`).includes(`${engine}/playbooks/knowledge-capture.md`));
  for (const rel of [`${PORTAL}/tasks/portal-001-login-page.md`, `${PORTAL}/tasks/BACKLOG.md`, `${DOCS}/tasks/docs-site-001-initial-commit.md`, `${SHOP}/legacy/CLAUDE.md`, 'organizations/acme/skills/README.md']) {
    assert.equal(read(vault, rel), fixture(rel), `${rel} unchanged`);
  }

  // archive + company v2 layout + root docs
  for (const rel of ['company/roles/senior-qa-engineer.md', 'company/skills/testing-qa/SKILL.md', 'company/workflow/model-routing.md', 'company/templates/team/TEAM.md', 'company/README.md', 'scripts/status.ps1', '.claude/skills/hades/SKILL.md', 'HADES.md', 'CLAUDE.md', 'README.md']) {
    assert.equal(read(vault, `archive/v1/${rel}`), fixture(rel), `archive/v1/${rel}`);
  }
  for (const gone of ['company/roles', 'company/skills', 'company/workflow', 'company/templates', 'scripts', '.claude']) assert.ok(!exists(vault, gone), `${gone} gone`);
  for (const role of STAFF_ROLES) assert.ok(exists(vault, `company/staff/${role}.md`));
  assert.equal(read(vault, 'company/README.md'), '# Company (vault)\n\ntemplate company readme\n');
  const map = read(vault, 'company/MIGRATION.md');
  assert.ok(map.includes(`| \`company/skills/testing-qa/SKILL.md\` | \`${engine}/playbooks/qa-automation.md\` |`));
  assert.ok(map.includes(`| \`company/roles/project-manager.md\` | \`${engine}/HADES.md\` |`));
  const hades = read(vault, 'HADES.md');
  assert.ok(hades.startsWith(`${V2_MARK}\n`) && hades.includes(`\`${engine}/HADES.md\``));
  assert.equal(read(vault, 'CLAUDE.md'), `${V2_MARK}\n# HADES vault\n\nEngine: \`${engine}\`.\n`);
  const readme = read(vault, 'README.md');
  assert.ok(readme.includes('| acme | portal | docs-site |') && readme.includes('| globex | shop |  |'), 'org table regenerated');

  // team.json + CONTEXT.md
  const pj = JSON.parse(read(vault, `${PORTAL}/team.json`));
  assert.deepEqual(Object.keys(pj), ['team', 'projects', 'environments', 'branch_strategy', 'security']);
  assert.equal(pj.team, 'portal');
  assert.deepEqual(pj.projects.map((p) => p.path), ['portal-api', 'portal-web']);
  assert.equal(pj.projects[1].commands.test, 'npm test');
  assert.deepEqual(Object.keys(pj.environments), ['test', 'live']);
  assert.equal(pj.environments.live.notes, ENV_TODO);
  assert.equal(pj.environments.test.deploy, '');
  assert.equal(JSON.parse(read(vault, `${DOCS}/team.json`)).branch_strategy, 'feature-branch');
  assert.deepEqual(JSON.parse(read(vault, `${SHOP}/team.json`)).projects.map((p) => p.path), ['.', 'api', 'web']);
  assert.ok(read(vault, `${SHOP}/CONTEXT.md`).startsWith(`# shop - context\n<!-- ${MARKER} write this digest`));
  assert.ok(read(vault, `${SHOP}/CONTEXT.md`).includes('Online shop monorepo'));

  // report
  assert.equal(r.todos.length, 12);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.next.some((x) => x.includes('/hades-learn <team> --migrate') && x.includes('portal, docs-site, shop')));
  assert.ok(r.next.includes('hades install') && r.next.includes('hades doctor'));
});

test('running again changes nothing (idempotent)', { skip: !HAS_GIT }, () => {
  const { vault, ctx } = setup();
  migrateVault(ctx);
  const once = snapshot(vault);
  const second = migrateVault(ctx);
  assert.equal(second.changes, 0);
  assert.deepEqual(second.actions, []);
  assert.equal(second.alreadyMigrated, true);
  assert.deepEqual(snapshot(vault), once);
  git(vault, 'add', '-A');
  git(vault, 'commit', '-q', '-m', 'v2');
  const third = migrateVault(ctx);
  assert.equal(third.changes, 0);
  assert.equal(git(vault, 'status', '--porcelain'), '');
  assert.match(formatReport(third), /registry {2}already v3/);
  assert.match(formatReport(third), /nothing to change/);
  assert.ok(third.next.some((x) => x.includes('--migrate')), 'LLM pass still pending (.v1.md notes, markers)');
});

test('files with uncommitted changes are skipped and listed; --include-dirty takes them', { skip: !HAS_GIT }, () => {
  const { vault, ctx } = setup();
  fs.appendFileSync(path.join(vault, `${PORTAL}/agents/devops-engineer.md`), '- local edit\n');
  fs.appendFileSync(path.join(vault, `${PORTAL}/agents/senior-qa-engineer.md`), '- local edit\n');
  fs.appendFileSync(path.join(vault, `${PORTAL}/agents/senior-fullstack-engineer.md`), '- local edit\n');
  fs.writeFileSync(path.join(vault, 'organizations/acme/notes.md'), 'See `company/workflow/model-routing.md`.\n');
  const devops = read(vault, `${PORTAL}/agents/devops-engineer.md`);

  const r = migrateVault(ctx);
  assert.deepEqual(r.dirty, [
    'organizations/acme/notes.md',
    `${PORTAL}/agents/devops-engineer.md`,
    `${PORTAL}/agents/senior-fullstack-engineer.md`,
    `${PORTAL}/agents/senior-qa-engineer.md`,
  ]);
  const skipped = r.skipped.map((s) => `${s.step}:${s.path}`);
  for (const s of [`roles:${PORTAL}/agents/devops-engineer.md`, `paths:${PORTAL}/agents/devops-engineer.md`, `roles:${PORTAL}/agents/senior-qa-engineer.md`, `roles:${PORTAL}/agents/senior-fullstack-engineer.md`, 'paths:organizations/acme/notes.md']) {
    assert.ok(skipped.includes(s), s);
  }
  assert.equal(read(vault, `${PORTAL}/agents/devops-engineer.md`), devops);
  assert.ok(exists(vault, `${PORTAL}/agents/senior-qa-engineer.md`) && !exists(vault, `${PORTAL}/agents/qa-engineer.md`), 'dirty rename skipped, no template in its place');
  assert.ok(exists(vault, `${PORTAL}/agents/senior-fullstack-engineer.md`) && !exists(vault, `${PORTAL}/agents/backend-engineer.md`) && !exists(vault, `${PORTAL}/agents/frontend-engineer.md`), 'split waits for the dirty source');
  assert.ok(exists(vault, `${PORTAL}/agents/uiux-engineer.v1.md`), 'clean split source still kept');
  assert.equal(read(vault, 'organizations/acme/notes.md'), 'See `company/workflow/model-routing.md`.\n');
  assert.ok(exists(vault, `${DOCS}/agents/qa-engineer.md`), 'other teams migrated');
  assert.ok(r.next[0].startsWith('commit or stash'));
  assert.match(formatReport(r), /dirty {5}4 files with uncommitted changes; skipped: /);

  const r2 = migrateVault(ctx, { includeDirty: true });
  assert.equal(r2.skipped.length, 0);
  assert.ok(exists(vault, `${PORTAL}/agents/qa-engineer.md`) && !exists(vault, `${PORTAL}/agents/senior-qa-engineer.md`));
  assert.ok(read(vault, `${PORTAL}/agents/qa-engineer.md`).includes('- local edit'), 'local edit carried along');
  assert.ok(read(vault, `${PORTAL}/agents/backend-engineer.md`).includes(MARKER));
  assert.doesNotMatch(read(vault, `${PORTAL}/agents/devops-engineer.md`), /extends:/);
  assert.ok(read(vault, 'organizations/acme/notes.md').includes('/company/model-routing.md') && !read(vault, 'organizations/acme/notes.md').includes('company/workflow'));
});

test('an existing v2 note blocks its rename (conflict reported, nothing overwritten)', { skip: !HAS_GIT }, () => {
  const { vault, ctx } = setup();
  fs.writeFileSync(path.join(vault, `${DOCS}/agents/qa-engineer.md`), '---\nrole: qa-engineer\nteam: docs-site\n---\n# mine\n');
  git(vault, 'add', '-A');
  git(vault, 'commit', '-q', '-m', 'v2 note');
  const r = migrateVault(ctx);
  assert.ok(r.skipped.some((s) => s.path === `${DOCS}/agents/senior-qa-engineer.md` && /conflict/.test(s.reason)));
  assert.equal(read(vault, `${DOCS}/agents/qa-engineer.md`), '---\nrole: qa-engineer\nteam: docs-site\n---\n# mine\n');
  assert.ok(exists(vault, `${DOCS}/agents/senior-qa-engineer.md`));
  assert.match(formatReport(r), /conflicts .*senior-qa-engineer\.md \(conflict: qa-engineer\.md exists\)/);
});

test('a v3 registry is reported as migrated and only idempotent steps run', { skip: !HAS_GIT }, () => {
  const { vault, ctx } = setup();
  migrateVault(ctx);
  fs.rmSync(path.join(vault, `${PORTAL}/CONTEXT.md`));
  const reg = read(vault, 'registry.json');
  const r = migrateVault(ctx);
  assert.equal(r.alreadyMigrated, true);
  assert.equal(r.steps.registry.changed, false);
  assert.equal(read(vault, 'registry.json'), reg);
  assert.equal(r.steps.teams.context, 1);
  assert.equal(r.changes, 1);
});

test('existing hades.config.json values win', { skip: !HAS_GIT }, () => {
  const { vault, engine, ctx } = setup();
  fs.writeFileSync(`${engine}/hades.config.json`, JSON.stringify({ vault: 'D:/elsewhere', workspace: 'D:/ws', autonomy: 'guarded' }));
  const r = migrateVault(ctx);
  assert.deepEqual(r.steps.registry.config, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${engine}/hades.config.json`, 'utf8')), { vault: 'D:/elsewhere', workspace: 'D:/ws', autonomy: 'guarded' });
  assert.equal(JSON.parse(read(vault, 'registry.json')).vault, undefined, 'still dropped from the registry');
});

test('works without git (plain renames) and with built-in fallbacks when templates are missing', () => {
  const { vault, engine, ctx } = setup({ withGit: false });
  const empty = path.join(TMP, `no-templates-${n}`);
  fs.mkdirSync(empty);
  process.env.HADES_TEMPLATES_DIR = empty;
  try {
    const r = migrateVault(ctx);
    assert.equal(r.git, false);
    assert.deepEqual(r.dirty, []);
    assert.ok(exists(vault, `${PORTAL}/agents/qa-engineer.md`) && exists(vault, 'archive/v1/company/roles/uiux-engineer.md'));
    const be = read(vault, `${PORTAL}/agents/backend-engineer.md`);
    assert.ok(be.startsWith('---\nrole: backend-engineer\nteam: portal\n---\n') && be.includes(`## Project notes\n<!-- ${MARKER}`));
    for (const role of STAFF_ROLES) assert.match(read(vault, `company/staff/${role}.md`), new RegExp(`role: ${role}\\nscope: company`));
    assert.ok(read(vault, `${SHOP}/CONTEXT.md`).includes(MARKER));
    const tj = JSON.parse(read(vault, `${SHOP}/team.json`));
    assert.deepEqual(tj.security, { semgrep_config: 'p/default', dast_live: 'baseline', dast_test: 'full' });
    assert.ok(read(vault, 'CLAUDE.md').includes(engine));
    assert.equal(migrateVault(ctx).changes, 0, 'idempotent without git too');
  } finally {
    process.env.HADES_TEMPLATES_DIR = TPL;
  }
});

test('an unsupported registry version fails with exit code 1', () => {
  const { vault, ctx } = setup({ withGit: false });
  const reg = JSON.parse(read(vault, 'registry.json'));
  reg.version = 1;
  fs.writeFileSync(path.join(vault, 'registry.json'), JSON.stringify(reg));
  assert.throws(() => migrateVault(ctx), (e) => e.exitCode === 1 && /unsupported registry version 1/.test(e.message));
});

// ---------------------------------------------------------------------------------------------
// The CLI

function cli(args, env) {
  return spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'hades.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('cli: hades migrate --dry-run --json prints the plan and writes nothing', { skip: !HAS_GIT }, () => {
  const { vault } = setup();
  const before = snapshot(vault);
  const res = cli(['migrate', '--dry-run', '--json'], { HADES_VAULT: vault });
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout);
  assert.equal(r.dryRun, true);
  assert.equal(r.vault, vault);
  assert.equal(r.engine, slash(ENGINE_ROOT));
  assert.ok(r.actions.length > 50);
  assert.deepEqual(snapshot(vault), before);
});

test('cli: --help needs no vault; stray arguments fail with exit 1', () => {
  const help = cli(['migrate', '--help'], { HADES_VAULT: path.join(TMP, 'does-not-exist') });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hades migrate \[--dry-run\] \[--json\] \[--include-dirty\]/);
  const { vault } = setup({ withGit: false });
  const bad = cli(['migrate', 'now'], { HADES_VAULT: vault });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unexpected argument "now"/);
});

// cli F7: a re-run never overwrites a committed owner README.md / CLAUDE.md / HADES.md.
test('a re-run leaves owner root docs without the v2 marker alone (conflict, not overwritten)', { skip: !HAS_GIT }, () => {
  const { vault, ctx } = setup();
  migrateVault(ctx);
  git(vault, 'add', '-A');
  git(vault, 'commit', '-q', '-m', 'v2');
  const owner = { 'README.md': '# Our vault\n\nOwner text, no marker.\n', 'CLAUDE.md': '# Our rules\n', 'HADES.md': '# Our pointer\n' };
  for (const [rel, text] of Object.entries(owner)) fs.writeFileSync(path.join(vault, rel), text);
  const archived = read(vault, 'archive/v1/README.md');
  git(vault, 'add', '-A');
  git(vault, 'commit', '-q', '-m', 'owner docs');
  const r = migrateVault(ctx);
  for (const [rel, text] of Object.entries(owner)) {
    assert.equal(read(vault, rel), text, `${rel} kept`);
    const s = r.skipped.find((x) => x.path === rel);
    assert.ok(s && /^conflict: archive\/v1\//.test(s.reason), `${rel}: ${JSON.stringify(r.skipped)}`);
  }
  assert.equal(read(vault, 'archive/v1/README.md'), archived, 'the v1 archive is not replaced');
  assert.equal(git(vault, 'status', '--porcelain'), '');
  assert.match(formatReport(r), /conflicts .*README\.md \(conflict: archive\/v1\/README\.md exists and differs/);
});

test('without git the owner text is not lost either', () => {
  const { vault, ctx } = setup({ withGit: false });
  migrateVault(ctx);
  fs.writeFileSync(path.join(vault, 'README.md'), '# Ours\n');
  migrateVault(ctx);
  assert.equal(read(vault, 'README.md'), '# Ours\n');
});
