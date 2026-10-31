// Tests for "hades init". HADES_CONFIG_FILE redirects the config file to a temp folder, so the
// engine's real hades.config.json is never written.
// Run: node --test tests/cli/init.test.mjs
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runCli, tempDir, cleanup, git, ENGINE, REAL_CONFIG } from '../helpers/vault.mjs';

let realBefore;
before(() => {
  realBefore = fs.existsSync(REAL_CONFIG) ? fs.readFileSync(REAL_CONFIG, 'utf8') : null;
});
after(() => {
  const now = fs.existsSync(REAL_CONFIG) ? fs.readFileSync(REAL_CONFIG, 'utf8') : null;
  cleanup();
  assert.equal(now, realBefore, 'the real hades.config.json was not touched');
});

function setup() {
  const root = tempDir('hades-init-');
  const configFile = `${root}/engine-config/hades.config.json`;
  const init = (args, env = {}) => runCli(['init', ...args], { configFile, env });
  return { root, configFile, init, vault: `${root}/vault`, work: `${root}/work` };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('hades init', () => {
  test('writes the config and scaffolds a git-initialised vault', () => {
    const s = setup();
    const r = s.init(['--vault', s.vault, '--workspace', s.work]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length >= 3 && r.lines.length <= 5, r.out);
    assert.match(r.out, /hades install/);
    assert.match(r.out, /scaffolded \d+ file\(s\); git init/);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.configFile, 'utf8')), { vault: s.vault, workspace: s.work });
    const reg = JSON.parse(fs.readFileSync(`${s.vault}/registry.json`, 'utf8'));
    assert.deepEqual(reg, { version: 3, organizations: {}, teams: {} });
    for (const f of ['.gitignore', 'CLAUDE.md', 'README.md', 'company/README.md', 'company/staff/devops-engineer.md']) {
      assert.ok(fs.existsSync(`${s.vault}/${f}`), `${f} scaffolded`);
    }
    assert.ok(fs.existsSync(`${s.vault}/.git`), 'git init');
    assert.notEqual(git(s.vault, 'log', '-1').status, 0, 'nothing committed');
    for (const f of walk(s.vault)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\{\{[A-Z0-9_]+\}\}/, `${f} fully rendered`);
    assert.ok(fs.readFileSync(`${s.vault}/CLAUDE.md`, 'utf8').includes(ENGINE), 'ENGINE rendered');
  });

  test('merges into an existing config and keeps unknown keys', () => {
    const s = setup();
    fs.mkdirSync(`${s.root}/engine-config`, { recursive: true });
    fs.writeFileSync(s.configFile, JSON.stringify({ aws: { profile: 'dev', region: 'eu-west-1' }, vault: '/old/vault', extra: [1, 2] }));
    const r = s.init(['--vault', s.vault]);
    assert.equal(r.code, 0, r.err);
    const cfg = JSON.parse(fs.readFileSync(s.configFile, 'utf8'));
    assert.deepEqual(Object.keys(cfg), ['aws', 'vault', 'extra', 'workspace']);
    assert.deepEqual(cfg.aws, { profile: 'dev', region: 'eu-west-1' });
    assert.equal(cfg.vault, s.vault);
    assert.deepEqual(cfg.extra, [1, 2]);
    assert.ok(cfg.workspace, 'workspace defaulted');
  });

  test('keeps the configured vault and workspace when no flag or env is given', () => {
    const s = setup();
    fs.mkdirSync(`${s.root}/engine-config`, { recursive: true });
    fs.writeFileSync(s.configFile, JSON.stringify({ vault: s.vault, workspace: s.work }));
    const r = s.init([]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\(unchanged\)/);
    assert.ok(fs.existsSync(`${s.vault}/registry.json`), 'configured vault scaffolded');
  });

  test('HADES_VAULT and HADES_WORKSPACE are the defaults', () => {
    const s = setup();
    const r = s.init(['--json'], { HADES_VAULT: s.vault, HADES_WORKSPACE: s.work });
    assert.equal(r.code, 0, r.err);
    const d = r.json();
    assert.equal(d.vault, s.vault);
    assert.equal(d.workspace, s.work);
    assert.equal(d.scaffolded, true);
    assert.equal(d.git, 'init');
    assert.equal(d.configFile, s.configFile);
    assert.deepEqual(d.registry, { version: 3, organizations: 0, teams: 0 });
    assert.deepEqual(d.next, ['hades install', 'hades doctor']);
  });

  test('an existing vault is not scaffolded again', () => {
    const s = setup();
    fs.mkdirSync(s.vault, { recursive: true });
    const reg = { version: 3, organizations: { acme: { org_dir: 'organizations/acme', root_path: '/w/acme', aliases: [] } }, teams: {} };
    fs.writeFileSync(`${s.vault}/registry.json`, JSON.stringify(reg));
    const r = s.init(['--vault', s.vault, '--workspace', s.work]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /existing: registry v3, 1 org\(s\), 0 team\(s\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${s.vault}/registry.json`, 'utf8')), reg);
    assert.ok(!fs.existsSync(`${s.vault}/CLAUDE.md`), 'no template files added');
    assert.ok(!fs.existsSync(`${s.vault}/.git`), 'no git init for an existing vault');
  });

  test('a v1 registry points to hades migrate', () => {
    const s = setup();
    fs.mkdirSync(s.vault, { recursive: true });
    fs.writeFileSync(`${s.vault}/registry.json`, JSON.stringify({ version: 2, vault: 'x', organizations: {}, teams: {} }));
    const r = s.init(['--vault', s.vault]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /next +hades migrate, then hades install/);
  });

  test('a vault inside an existing git repository gets no nested repository', () => {
    const s = setup();
    fs.mkdirSync(`${s.root}/repo`, { recursive: true });
    git(`${s.root}/repo`, 'init', '-q');
    const vault = `${s.root}/repo/vault`;
    const r = s.init(['--vault', vault, '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().git, 'inside-repo');
    assert.ok(!fs.existsSync(`${vault}/.git`));
  });

  test('a vault git-ignored by its parent repository gets its own repository', () => {
    const s = setup();
    fs.mkdirSync(`${s.root}/repo`, { recursive: true });
    git(`${s.root}/repo`, 'init', '-q');
    fs.writeFileSync(`${s.root}/repo/.gitignore`, 'vault/\n');
    const vault = `${s.root}/repo/vault`;
    const r = s.init(['--vault', vault, '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().git, 'init');
    assert.ok(fs.existsSync(`${vault}/.git`));
  });

  test('usage errors exit 1', () => {
    const s = setup();
    const bad = s.init(['--vault']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--vault needs a path/);
    const unknown = s.init(['--vualt', s.vault]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown flag --vualt/);
    const file = `${s.root}/afile`;
    fs.writeFileSync(file, 'x');
    const isFile = s.init(['--vault', file]);
    assert.equal(isFile.code, 1);
    assert.match(isFile.err, /is a file/);
    assert.ok(!fs.existsSync(s.configFile), 'nothing written on error');
  });

  test('--help prints usage and writes nothing', () => {
    const s = setup();
    const r = s.init(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^Usage: hades init/);
    assert.ok(!fs.existsSync(s.configFile));
  });
});

// A copy of the engine's CLI (bin, lib, templates) in a temp folder, so "hades init" without --vault
// can scaffold <engine>/.vault there. The real engine's vault is never touched. No HADES_* variable
// reaches the child: the copy's own hades.config.json and default vault are used.
function tempEngine({ gitignore = '/.vault/\n/vault/\n', repo = true } = {}) {
  const root = tempDir('hades-engine-');
  const engine = `${root}/hades-vault`;
  for (const d of ['bin', 'lib', 'templates']) fs.cpSync(`${ENGINE}/${d}`, `${engine}/${d}`, { recursive: true });
  fs.copyFileSync(`${ENGINE}/package.json`, `${engine}/package.json`);
  if (repo) git(engine, 'init', '-q');
  if (gitignore !== null) fs.writeFileSync(`${engine}/.gitignore`, gitignore);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^HADES_/i.test(k)) env[k] = v;
  const cli = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [`${engine}/bin/hades.mjs`, ...args], { encoding: 'utf8', cwd: root, env: { ...env, ...extra }, windowsHide: true });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', json: () => JSON.parse(r.stdout) };
  };
  return { root, engine, cli, vault: `${engine}/.vault`, configFile: `${engine}/hades.config.json` };
}

describe('hades init: the default vault is <engine>/.vault', () => {
  test('no --vault scaffolds <engine>/.vault as its own git repository, ignored by the engine', () => {
    const e = tempEngine();
    const r = e.cli(['init', '--json']);
    assert.equal(r.code, 0, r.err);
    const d = r.json();
    assert.equal(d.vault, e.vault);
    assert.equal(d.scaffolded, true);
    assert.equal(d.git, 'init');
    assert.equal(d.workspace, e.root, 'workspace defaults to the engine parent');
    assert.ok(fs.existsSync(`${e.vault}/registry.json`));
    assert.ok(fs.existsSync(`${e.vault}/.git`), 'its own repository');
    assert.equal(git(e.vault, 'rev-parse', '--show-toplevel').stdout.trim().toLowerCase(), e.vault.toLowerCase());
    assert.equal(git(e.engine, 'check-ignore', '-q', '.vault').status, 0, 'git-ignored by the engine');
    assert.doesNotMatch(git(e.engine, 'status', '--porcelain', '-uall').stdout, /\.vault/,'the engine repository does not see the vault');
    // stored relative to the engine, so renaming the engine folder keeps the vault
    assert.deepEqual(JSON.parse(fs.readFileSync(e.configFile, 'utf8')), { vault: '.vault', workspace: e.root });
    const again = e.cli(['init', '--json']);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.json().vault, e.vault, 'the relative config path resolves against the engine');
    assert.equal(again.json().scaffolded, false);
  });

  test('a renamed engine folder still finds its .vault through the relative config path', () => {
    const e = tempEngine();
    assert.equal(e.cli(['init']).code, 0);
    const moved = `${e.root}/renamed`;
    fs.renameSync(e.engine, moved);
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^HADES_/i.test(k)) env[k] = v;
    const r = spawnSync(process.execPath, [`${moved}/bin/hades.mjs`, 'init', '--json'], { encoding: 'utf8', cwd: e.root, env, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.vault, `${moved}/.vault`);
    assert.equal(d.scaffolded, false);
  });

  test('a vault inside the engine gets its own repository even when the engine does not ignore it', () => {
    const e = tempEngine({ gitignore: null });
    const r = e.cli(['init', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().git, 'init');
    assert.ok(fs.existsSync(`${e.vault}/.git`));
  });

  test('an explicit --vault outside the engine still works and is stored absolute', () => {
    const e = tempEngine();
    const v = `${e.root}/elsewhere/vault`;
    const r = e.cli(['init', '--vault', v, '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().vault, v);
    assert.equal(JSON.parse(fs.readFileSync(e.configFile, 'utf8')).vault, v);
    assert.ok(!fs.existsSync(e.vault), 'no default vault created');
  });

  test('a legacy <engine>/vault with a registry is kept while .vault does not exist', () => {
    const e = tempEngine();
    fs.mkdirSync(`${e.engine}/vault`, { recursive: true });
    const reg = { version: 3, organizations: {}, teams: {} };
    fs.writeFileSync(`${e.engine}/vault/registry.json`, JSON.stringify(reg));
    const r = e.cli(['init', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().vault, `${e.engine}/vault`);
    assert.equal(r.json().scaffolded, false);
    assert.ok(!fs.existsSync(e.vault), 'no .vault scaffolded next to the legacy vault');
    assert.equal(JSON.parse(fs.readFileSync(e.configFile, 'utf8')).vault, 'vault');
  });
});

describe('hades init: a vault inside the engine is always its own repository', () => {
  test('an existing .vault that lost its .git gets git init again (never the engine repository)', () => {
    const e = tempEngine();
    assert.equal(e.cli(['init']).code, 0);
    fs.rmSync(`${e.vault}/.git`, { recursive: true, force: true });
    assert.equal(git(e.vault, 'rev-parse', '--show-toplevel').stdout.trim().toLowerCase(), e.engine.toLowerCase(), 'precondition: git sees the engine repository');
    const r = e.cli(['init', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().scaffolded, false);
    assert.equal(r.json().git, 'init');
    assert.equal(git(e.vault, 'rev-parse', '--show-toplevel').stdout.trim().toLowerCase(), e.vault.toLowerCase());
    const text = e.cli(['init']);
    assert.equal(text.code, 0, text.err);
    assert.doesNotMatch(text.out, /note +.*no git repository/, 'second run: nothing to fix');
    assert.equal(e.cli(['init', '--json']).json().git, 'repo');
  });

  test('a moved-in vault without .git (git-ignored by the engine) gets its own repository', () => {
    const e = tempEngine();
    fs.mkdirSync(e.vault, { recursive: true });
    fs.writeFileSync(`${e.vault}/registry.json`, JSON.stringify({ version: 3, organizations: {}, teams: {} }));
    const r = e.cli(['init']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /note +.*had no git repository of its own.*ran git init/);
    assert.ok(fs.existsSync(`${e.vault}/.git`));
  });
});

describe('hades init: relative paths are relative to the engine', () => {
  test('--vault .vault from another folder is <engine>/.vault', () => {
    const e = tempEngine();
    const r = e.cli(['init', '--vault', '.vault', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().vault, e.vault);
    assert.ok(!fs.existsSync(`${e.root}/.vault`), 'no stray vault in the current folder');
    assert.equal(JSON.parse(fs.readFileSync(e.configFile, 'utf8')).vault, '.vault');
  });

  test('a relative HADES_VAULT is relative to the engine too', () => {
    const e = tempEngine();
    const r = e.cli(['init', '--json'], { HADES_VAULT: '.vault' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().vault, e.vault);
    assert.ok(!fs.existsSync(`${e.root}/.vault`));
  });

  test('the engine folder itself (any letter case) is refused', () => {
    const e = tempEngine();
    for (const v of [e.engine, process.platform === 'win32' ? e.engine.toUpperCase() : e.engine, '.', e.root]) {
      const r = e.cli(['init', '--vault', v]);
      assert.equal(r.code, 1, `${v}: ${r.out}`);
      assert.match(r.err, /cannot be the engine folder/);
    }
    assert.ok(!fs.existsSync(e.configFile), 'nothing written');
  });

  test('repointing away from a vault that still has a registry prints a note', () => {
    const e = tempEngine();
    assert.equal(e.cli(['init']).code, 0);
    const other = `${e.root}/other-vault`;
    const r = e.cli(['init', '--vault', other]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /note +the config pointed at .*\/\.vault, which still holds a registry\.json/);
    const json = e.cli(['init', '--json']).json();
    assert.deepEqual(json.notes, [], 'no note once the config is unchanged');
  });
});
