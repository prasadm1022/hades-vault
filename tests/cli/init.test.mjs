// Tests for "hades init". HADES_CONFIG_FILE redirects the config file to a temp folder, so the
// engine's real hades.config.json is never written.
// Run: node --test tests/cli/init.test.mjs
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
