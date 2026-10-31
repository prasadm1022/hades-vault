// Tests for "hades org" and "hades team" (new, list, resolve, set).
// Run: node --test tests/cli/org-team.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, cleanup, writeFile, git, runCli, tempDir } from '../helpers/vault.mjs';
import { addOrgRow } from '../../lib/commands/team.mjs';

after(cleanup);

const noPlaceholders = (text, where) => assert.doesNotMatch(text, /\{\{[A-Z0-9_]+\}\}/, `${where} fully rendered`);

describe('hades org', () => {
  test('org new scaffolds and registers; org list shows it', () => {
    const v = makeVault({ orgs: {} });
    const r = v.run(['org', 'new', 'initech', '--root', `${v.work}/initech`, '--description', 'Initech apps', '--aliases', 'ini,initech-corp']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length <= 3, r.out);
    assert.match(r.out, /org initech registered/);
    const reg = v.registry();
    assert.deepEqual(reg.organizations.initech, {
      org_dir: 'organizations/initech',
      root_path: `${v.work}/initech`,
      description: 'Initech apps',
      aliases: ['ini', 'initech-corp'],
      created: reg.organizations.initech.created,
    });
    const org = v.read('organizations/initech/ORG.md');
    noPlaceholders(org, 'ORG.md');
    assert.match(org, /^# Organization initech/);
    assert.match(org, /\| aliases \| ini, initech-corp \|/);
    assert.ok(org.includes(`\`${v.work}/initech\``));
    assert.ok(fs.existsSync(`${v.vault}/organizations/initech/knowledge/lessons.md`));
    noPlaceholders(v.read('organizations/initech/knowledge/lessons.md'), 'lessons.md');
    assert.ok(!fs.existsSync(`${v.work}/initech`), 'the root folder is not created');

    const list = v.run(['org', 'list']);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /^initech  .*\/work\/initech \[ini, initech-corp\]  teams: no teams$/m);
    const json = v.run(['org', 'list', '--json']).json();
    assert.equal(json[0].organization, 'initech');
    assert.deepEqual(json[0].teams, []);
  });

  test('org new refuses duplicates, bad names, alias collisions and missing --root', () => {
    const v = makeVault({ orgs: { acme: { aliases: ['acme-inc'] } }, teams: { portal: { aliases: ['acme-portal'] } } });
    const before = v.read('registry.json');
    const cases = [
      [['org', 'new', 'acme', '--root', '/x'], /already exists/],
      [['org', 'new', 'Bad_Org', '--root', '/x'], /kebab-case/],
      [['org', 'new', 'globex', '--root', '/x', '--aliases', 'acme-portal'], /already used: alias of team portal/],
      [['org', 'new', 'acme-inc', '--root', '/x'], /already used: alias of organization acme/],
      [['org', 'new', 'globex'], /--root is required/],
      [['org', 'new', 'globex', '--root'], /--root needs a value/],
      [['org', 'new', '--root', '/x'], /missing <org>/],
      [['org', 'new', 'globex', '--root', '/x', '--color', 'red'], /unknown flag --color/],
      [['org', 'frobnicate'], /unknown subcommand/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.err, re, args.join(' '));
    }
    assert.equal(v.read('registry.json'), before, 'registry unchanged');
    assert.ok(!fs.existsSync(`${v.vault}/organizations/globex`), 'nothing scaffolded');
  });

  test('org --help and no vault', () => {
    const v = makeVault();
    const h = v.run(['org', '--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /hades org new <org> --root <path>/);
    const r = runCli(['org', 'list'], { env: { HADES_VAULT: `${tempDir()}/none` } });
    assert.equal(r.code, 1);
    assert.match(r.err, /no vault/);
  });
});

describe('hades team new', () => {
  test('existing project: scaffolds, detects commands, adds the ORG.md row, registers', () => {
    const v = makeVault({ orgs: {} });
    assert.equal(v.run(['org', 'new', 'acme', '--root', `${v.work}/acme`, '--aliases', 'acme-inc']).code, 0);
    const project = `${v.work}/acme/portal`;
    writeFile(`${project}/package.json`, JSON.stringify({ name: 'portal', scripts: { build: 'tsc', test: 'node --test' } }));
    const r = v.run(['team', 'new', 'portal', '--org', 'acme-inc', '--project', project, '--description', 'Customer | portal', '--aliases', 'acme-portal']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length <= 5, r.out);
    assert.match(r.out, /team portal registered \(main, org acme\)/);
    assert.match(r.out, /project .*\(existing\)/);
    assert.match(r.out, /detect +\. \(node\)/);
    assert.match(r.out, /ORG\.md +row added/);

    const t = v.registry().teams.portal;
    assert.deepEqual(t, {
      organization: 'acme',
      type: 'main',
      project_path: project,
      team_dir: 'organizations/acme/teams/portal',
      description: 'Customer | portal',
      aliases: ['acme-portal'],
      status: 'active',
      created: t.created,
    });
    const dir = v.teamDir('portal');
    for (const f of ['TEAM.md', 'CONTEXT.md', 'team.json', 'agents/qa-engineer.md', 'knowledge/domain.md', 'tasks/README.md', 'tasks/BACKLOG.md', 'projects/portal.md']) {
      assert.ok(fs.existsSync(`${dir}/${f}`), `${f} scaffolded`);
      noPlaceholders(fs.readFileSync(`${dir}/${f}`, 'utf8'), f);
    }
    const teamMd = fs.readFileSync(`${dir}/TEAM.md`, 'utf8');
    assert.match(teamMd, /^# Team portal \(main team, organization acme\)/);
    assert.ok(teamMd.includes(`\`${v.vault}/organizations/acme\``));
    assert.ok(fs.readFileSync(`${dir}/projects/portal.md`, 'utf8').includes(`\`${project}\``));
    const tj = v.readJson(`${dir}/team.json`);
    assert.equal(tj.team, 'portal');
    assert.deepEqual(tj.projects.map((p) => p.path), ['.']);
    assert.ok(tj.projects[0].stack.includes('node'));
    assert.match(tj.projects[0].commands.test, /test/);
    assert.match(tj.projects[0].commands.build, /build/);
    assert.ok(tj.environments.test && tj.environments.live, 'environments kept from the template');

    const org = v.read('organizations/acme/ORG.md');
    assert.ok(org.includes(`| \`portal\` | main | \`${project}\` | Customer \\| portal |`), org);
    // a second team adds a second row right after the first
    const r2 = v.run(['team', 'new', 'docs', '--org', 'acme', '--project', `${v.work}/acme/docs`, '--type', 'sub']);
    assert.equal(r2.code, 0, r2.err);
    const rows = v.read('organizations/acme/ORG.md').split('\n').filter((l) => /^\| `/.test(l));
    assert.deepEqual(rows.map((l) => l.split('|')[1].trim()), ['`portal`', '`docs`']);
  });

  test('greenfield: the project folder is created and git-initialised without a commit', () => {
    const v = makeVault();
    const project = `${v.work}/acme/new-app`;
    const r = v.run(['team', 'new', 'new-app', '--org', 'acme', '--project', project, '--json']);
    assert.equal(r.code, 0, r.err);
    const d = r.json();
    assert.equal(d.project, 'created, git init');
    assert.equal(d.detect, null, 'no detection for a new folder');
    assert.ok(fs.existsSync(`${project}/.git`));
    assert.notEqual(git(project, 'log', '-1').status, 0, 'nothing committed');
    assert.equal(d.org_md, 'no ORG.md', 'the org was created without the CLI');
    const tj = v.readJson(`${v.teamDir('new-app')}/team.json`);
    assert.deepEqual(tj.projects.map((p) => p.path), ['.'], 'placeholder project kept');
    assert.ok(fs.existsSync(`${v.teamDir('new-app')}/projects/new-app.md`));
  });

  test('a monorepo yields one team.json project per detected project', () => {
    const v = makeVault();
    const project = `${v.work}/acme/mono`;
    writeFile(`${project}/api/pyproject.toml`, '[project]\nname = "api"\n');
    writeFile(`${project}/web/package.json`, JSON.stringify({ name: 'web', scripts: { test: 'vitest' } }));
    const r = v.run(['team', 'new', 'mono', '--org', 'acme', '--project', project]);
    assert.equal(r.code, 0, r.err);
    const tj = v.readJson(`${v.teamDir('mono')}/team.json`);
    assert.deepEqual(tj.projects.map((p) => p.path).sort(), ['api', 'web']);
    assert.ok(fs.existsSync(`${v.teamDir('mono')}/projects/api.md`));
    assert.ok(fs.existsSync(`${v.teamDir('mono')}/projects/web.md`));
  });

  test('refusals leave the registry and vault untouched', () => {
    const v = makeVault({ orgs: { acme: { aliases: ['acme-inc'] } }, teams: { portal: { aliases: ['acme-portal'] } } });
    const before = v.read('registry.json');
    const p = `${v.work}/x`;
    const cases = [
      [['team', 'new', 'portal', '--org', 'acme', '--project', p], /team "portal" already exists/],
      [['team', 'new', 'acme-portal', '--org', 'acme', '--project', p], /already used: alias of team portal/],
      [['team', 'new', 'web', '--org', 'acme', '--project', p, '--aliases', 'acme-inc'], /already used: alias of organization acme/],
      [['team', 'new', 'web', '--org', 'nope', '--project', p], /unknown organization "nope"/],
      [['team', 'new', 'web', '--org', 'acme', '--project', p, '--type', 'core'], /--type must be main or sub/],
      [['team', 'new', 'Web', '--org', 'acme', '--project', p], /kebab-case/],
      [['team', 'new', 'web', '--org', 'acme'], /--project is required/],
      [['team', 'new', 'web', '--project', p], /--org is required/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.err, re, args.join(' '));
    }
    assert.equal(v.read('registry.json'), before);
    assert.ok(!fs.existsSync(p), 'no project folder created');
    assert.ok(!fs.existsSync(`${v.vault}/organizations/acme/teams/web`));
  });

  test('ORG.md without a teams table is left untouched', () => {
    const v = makeVault();
    const text = '# Organization acme\r\n\r\nTeams: none yet.\r\n';
    v.write('organizations/acme/ORG.md', text);
    const r = v.run(['team', 'new', 'web', '--org', 'acme', '--project', `${v.work}/acme/web`]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ORG\.md +no teams table/);
    assert.equal(v.read('organizations/acme/ORG.md'), text);
  });
});

describe('addOrgRow', () => {
  const table = ['# Org', '', '## Teams', '<!-- rows -->', '| Team | Type | Project path | Owns |', '|---|---|---|---|', '| `a` | main | `/w/a` | A |', '', '## Shared infrastructure', ''];

  test('appends after the last row, keeps CRLF, skips a listed team', () => {
    const dir = tempDir();
    const file = `${dir}/ORG.md`;
    fs.writeFileSync(file, table.join('\r\n'));
    assert.equal(addOrgRow(file, { name: 'b', type: 'sub', projectPath: '/w/b', description: 'x\ny' }), 'row added');
    const lines = fs.readFileSync(file, 'utf8').split('\r\n');
    assert.equal(lines[7], '| `b` | sub | `/w/b` | x y |');
    assert.equal(lines[8], '');
    assert.equal(lines[9], '## Shared infrastructure');
    const after1 = fs.readFileSync(file, 'utf8');
    assert.equal(addOrgRow(file, { name: 'A', type: 'main', projectPath: '/w/a' }), 'already listed');
    assert.equal(fs.readFileSync(file, 'utf8'), after1);
  });

  test('a section without a table header is not touched', () => {
    const dir = tempDir();
    const file = `${dir}/ORG.md`;
    const text = '## Teams\n- a\n\n## Rules\n| Team | x |\n|---|---|\n';
    fs.writeFileSync(file, text);
    assert.equal(addOrgRow(file, { name: 'b', type: 'main', projectPath: '/w/b' }), 'no teams table');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(addOrgRow(`${dir}/missing.md`, { name: 'b' }), 'no ORG.md');
  });
});

describe('hades team resolve / list', () => {
  const setup = () =>
    makeVault({
      orgs: { acme: {}, globex: { aliases: ['gx'] } },
      teams: { portal: { aliases: ['Acme-Portal'] }, 'portal-api': { project_path: null }, shop: { org: 'globex', type: 'sub' } },
    });

  test('by name, alias (case-insensitive), path and current directory', () => {
    const v = setup();
    const expect = { team: 'portal', organization: 'acme', type: 'main', team_dir: 'organizations/acme/teams/portal', project_path: `${v.work}/acme/portal` };
    for (const q of ['portal', 'PORTAL', 'acme-portal', `${v.work}/acme/portal`, `${v.work}/acme/portal/src/deep`]) {
      const r = v.run(['team', 'resolve', q]);
      assert.equal(r.code, 0, `${q}: ${r.err}`);
      assert.equal(r.lines.length, 1);
      assert.deepEqual(JSON.parse(r.out), expect, q);
    }
    fs.mkdirSync(`${v.work}/acme/portal/src`, { recursive: true });
    const cwd = v.run(['team', 'resolve'], { cwd: `${v.work}/acme/portal/src` });
    assert.equal(cwd.code, 0, cwd.err);
    assert.deepEqual(cwd.json(), expect);
    const longest = v.run(['team', 'resolve', `${v.work}/acme/portal-api/x`]);
    assert.equal(longest.json().team, 'portal-api');
  });

  test('no match exits 1', () => {
    const v = setup();
    for (const q of ['nope', 'acme', `${v.work}/elsewhere`]) {
      const r = v.run(['team', 'resolve', q]);
      assert.equal(r.code, 1, q);
      assert.equal(r.out, '');
      assert.match(r.err, /no team matches/);
    }
    assert.equal(v.run(['team', 'resolve'], { cwd: v.root }).code, 1);
  });

  test('team list, filtered by organization name or alias', () => {
    const v = setup();
    const all = v.run(['team', 'list']);
    assert.equal(all.code, 0, all.err);
    assert.equal(all.lines.length, 3);
    assert.match(all.out, /^portal +main +active +acme +.*\/acme\/portal \[Acme-Portal\]$/m);
    assert.match(all.out, /^shop +sub +active +globex /m);
    const gx = v.run(['team', 'list', '--org', 'gx']);
    assert.deepEqual(gx.lines.map((l) => l.split(/\s+/)[0]), ['shop']);
    const json = v.run(['team', 'list', '--org', 'acme', '--json']).json();
    assert.deepEqual(json.map((t) => t.team), ['portal', 'portal-api']);
    assert.equal(v.run(['team', 'list', '--org', 'nope']).code, 1);
    const none = makeVault().run(['team', 'list']);
    assert.match(none.out, /no teams/);
  });

  test('team --help', () => {
    const r = setup().run(['team', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /hades team resolve/);
  });
});

describe('hades team set', () => {
  const setup = () => {
    const v = makeVault({ teams: { portal: { aliases: ['web'], projects: [{ path: '.', stack: ['node'], commands: { install: 'npm ci', build: '', lint: '', types: '', test: '', run: '', format: '' } }] } } });
    const file = `${v.teamDir('portal')}/team.json`;
    return { v, file, doc: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };

  test('command: sets, clears and targets a project with --project', () => {
    const { v, doc } = setup();
    const r = v.run(['team', 'set', 'web', 'command', 'test', 'npm test -- --watch=false']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'team.json (portal): projects[.].commands.test = "npm test -- --watch=false"');
    assert.equal(doc().projects[0].commands.test, 'npm test -- --watch=false');
    const again = v.run(['team', 'set', 'portal', 'command', 'test', 'npm test -- --watch=false']);
    assert.match(again.out, /\(unchanged\)$/m);
    const c = v.run(['team', 'set', 'portal', 'command', 'install', '']);
    assert.equal(c.out.trim(), 'team.json (portal): projects[.].commands.install cleared');
    assert.equal(doc().projects[0].commands.install, '');
    assert.equal(v.run(['team', 'set', 'portal', 'project', 'add', './api/']).code, 0);
    const j = v.run(['team', 'set', 'portal', 'command', 'build', '--project', 'api', 'mvn -B package', '--json']).json();
    assert.deepEqual(j, { team: 'portal', file: j.file, set: 'projects[api].commands.build', value: 'mvn -B package', previous: '', changed: true });
    assert.equal(doc().projects[1].commands.build, 'mvn -B package');
    const after = v.run(['team', 'set', 'portal', 'command', 'lint', '--', 'npm', 'run', 'lint']);
    assert.equal(after.code, 0, after.err);
    assert.equal(doc().projects[0].commands.lint, 'npm run lint', 'a value after -- may be unquoted');
  });

  test('the guard refuses blocked shell commands and nothing is written', () => {
    const { v, file } = setup();
    const before = fs.readFileSync(file, 'utf8');
    for (const args of [
      ['command', 'build', 'npm run build && git push origin main'],
      ['env', 'test', 'deploy', 'git push heroku main'],
      ['env', 'live', 'rollback', 'terraform destroy -auto-approve'],
      ['command', 'test', 'npm publish'],
    ]) {
      const r = v.run(['team', 'set', 'portal', ...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /refused: HADES guard: (git\.push|cloud\.destroy|publish\.package):/, args.join(' '));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    // the devops engineer runs environment commands: image pushes are allowed there
    const ok = v.run(['team', 'set', 'portal', 'env', 'test', 'deploy', 'docker build -t r/app . && docker push r/app']);
    assert.equal(ok.code, 0, ok.err);
  });

  test('env: fields, via_push parsing, url validation; missing environments are created', () => {
    const { v, doc } = setup();
    assert.equal(v.run(['team', 'set', 'portal', 'env', 'test', 'url', 'https://test.example.com']).code, 0);
    assert.equal(v.run(['team', 'set', 'portal', 'env', 'test', 'health', 'curl -fsS https://test.example.com/health']).code, 0);
    const p = v.run(['team', 'set', 'portal', 'env', 'live', 'via_push', 'TRUE']);
    assert.equal(p.code, 0, p.err);
    assert.equal(p.out.trim(), 'team.json (portal): environments.live.via_push = true');
    assert.deepEqual(doc().environments, {
      test: { url: 'https://test.example.com', deploy: '', health: 'curl -fsS https://test.example.com/health', rollback: '', via_push: false, notes: '' },
      live: { url: '', deploy: '', health: '', rollback: '', via_push: true, notes: '' },
    });
    assert.equal(v.run(['team', 'set', 'portal', 'env', 'live', 'via_push', 'false']).code, 0);
    assert.equal(doc().environments.live.via_push, false);
    const cases = [
      [['env', 'live', 'via_push', 'yes'], /via_push must be true\|false/],
      [['env', 'live', 'via_push', ''], /via_push must be true\|false/],
      [['env', 'test', 'url', 'ftp://x'], /url must be an http\(s\) URL/],
      [['env', 'prod', 'url', 'https://x'], /environment must be test\|live/],
      [['env', 'test', 'region', 'eu'], /environment field must be url\|deploy/],
      [['env', 'test', 'notes'], /missing "<value>"/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(['team', 'set', 'portal', ...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
  });

  test('security, branch-strategy and project add/remove', () => {
    const { v, doc } = setup();
    assert.equal(v.run(['team', 'set', 'portal', 'security', 'dast_test', 'api']).code, 0);
    assert.equal(v.run(['team', 'set', 'portal', 'security', 'semgrep_config', 'p/owasp-top-ten']).code, 0);
    assert.deepEqual(doc().security, { dast_test: 'api', semgrep_config: 'p/owasp-top-ten' });
    assert.equal(v.run(['team', 'set', 'portal', 'security', 'semgrep_config', '']).code, 0);
    assert.deepEqual(doc().security, { dast_test: 'api' });
    assert.match(v.run(['team', 'set', 'portal', 'security', 'dast_live', 'full']).err, /dast_live must be baseline\|none/);
    assert.match(v.run(['team', 'set', 'portal', 'security', 'token', 'x']).err, /security key must be/);
    assert.equal(v.run(['team', 'set', 'portal', 'branch-strategy', 'feature-branch']).code, 0);
    assert.equal(doc().branch_strategy, 'feature-branch');
    assert.match(v.run(['team', 'set', 'portal', 'branch-strategy', 'trunk']).err, /branch strategy must be current-branch\|feature-branch/);

    const add = v.run(['team', 'set', 'portal', 'project', 'add', 'services/api']);
    assert.equal(add.code, 0, add.err);
    assert.match(add.out, /^team\.json \(portal\): project services\/api added; fill its commands: hades detect ".*\/services\/api" --write portal$/m);
    assert.deepEqual(doc().projects[1], { path: 'services/api', stack: [], commands: { install: '', build: '', lint: '', types: '', test: '', run: '', format: '' } });
    assert.match(v.run(['team', 'set', 'portal', 'project', 'add', 'services/api']).out, /\(unchanged\)/);
    for (const bad of ['../other', '/abs/path', 'C:/x']) assert.equal(v.run(['team', 'set', 'portal', 'project', 'add', bad]).code, 1, bad);
    assert.equal(v.run(['team', 'set', 'portal', 'project', 'remove', 'services/api/']).code, 0);
    assert.deepEqual(doc().projects.map((p) => p.path), ['.']);
    assert.match(v.run(['team', 'set', 'portal', 'project', 'remove', 'nope']).err, /no project "nope"/);
    assert.match(v.run(['team', 'set', 'portal', 'command', 'test', 'x', '--project', 'nope']).err, /no project "nope" in team\.json .*project add nope/);
  });

  test('usage errors and help', () => {
    const { v } = setup();
    const cases = [
      [['team', 'set'], /missing <team>/],
      [['team', 'set', 'portal'], /missing what to set/],
      [['team', 'set', 'portal', 'colour', 'red'], /unknown setting "colour"/],
      [['team', 'set', 'nope', 'branch-strategy', 'feature-branch'], /unknown team/],
      [['team', 'set', 'portal', 'command', 'deploy', 'x'], /command key must be install\|build/],
      [['team', 'set', 'portal', 'command', 'test', 'npm', 'test'], /unexpected argument: test \(quote values with spaces\)/],
      [['team', 'set', 'portal', 'branch-strategy', 'feature-branch', '--project', 'x'], /--project applies to/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
    const h = v.run(['team', '--help']);
    assert.match(h.out, /hades team set <team> command <install\|build\|lint\|types\|test\|run\|format> "<cmd>" \[--project <rel>\]/);
    assert.match(h.out, /refused when the HADES guard blocks them/);
  });
});
