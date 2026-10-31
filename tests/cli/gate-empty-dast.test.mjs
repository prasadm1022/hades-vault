// Gate verdict when nothing ran (cli F9, pipeline F3: GATE EMPTY) and the team's DAST limits
// (pipeline F8: security.dast_live / security.dast_test). No network, no Docker, no scanners:
// project commands are node one-liners and the scanners are the gate fixture scripts.
// Run: node --test tests/cli/gate-empty-dast.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as gate from '../../lib/core/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..');
const BIN = path.join(ENGINE, 'bin', 'hades.mjs');
const FIX = path.join(HERE, '..', 'fixtures', 'gate');
const slash = (p) => p.replace(/\\/g, '/');
const EMIT = slash(path.join(FIX, 'bin', 'emit.mjs'));
const FAKE = (name) => slash(path.join(FIX, 'bin', `fake-${name}.mjs`));
const cmd = (mode, code = 0) => `"${process.execPath}" "${EMIT}" ${mode} ${code}`;
const EMPTY = 'GATE EMPTY (no commands configured: run hades detect --write or hades team set)';

const created = [];
after(() => {
  for (const v of created) {
    for (const dir of [v.root, path.join(ENGINE, '.hades', 'logs', v.taskId)]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // best effort: temp folder
      }
    }
  }
});

function makeVault({ projects = [{ path: '.', commands: {} }], environments = {}, security } = {}) {
  const root = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-gate-empty-')));
  const team = `ge${Math.random().toString(36).slice(2, 8)}`;
  const vault = `${root}/vault`;
  const work = `${root}/work`;
  const projectPath = `${work}/app`;
  const teamDir = `organizations/acme/teams/${team}`;
  const registry = {
    version: 3,
    organizations: { acme: { org_dir: 'organizations/acme', root_path: work, description: 'test', aliases: [], created: '2026-10-31' } },
    teams: { [team]: { organization: 'acme', type: 'main', project_path: projectPath, team_dir: teamDir, description: 'gate test', aliases: [], status: 'active', created: '2026-10-31' } },
  };
  fs.mkdirSync(`${vault}/${teamDir}`, { recursive: true });
  fs.writeFileSync(`${vault}/registry.json`, JSON.stringify(registry, null, 2));
  for (const p of projects) {
    fs.mkdirSync(path.join(projectPath, p.path), { recursive: true });
    fs.cpSync(path.join(FIX, 'projects', 'clean'), path.join(projectPath, p.path), { recursive: true });
  }
  const teamJson = { team, projects: projects.map((p) => ({ path: p.path, stack: [], commands: p.commands || {} })), environments, ...(security ? { security } : {}) };
  fs.writeFileSync(`${vault}/${teamDir}/team.json`, JSON.stringify(teamJson, null, 2));
  const taskId = `${team}-001`;
  const taskDir = `${vault}/${teamDir}/tasks/${taskId}-sample`;
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(`${taskDir}/state.json`, JSON.stringify({ id: taskId, team, status: 'open' }));
  const v = { root, vault, work, team, taskId, taskDir };
  created.push(v);
  return v;
}

function hades(v, args) {
  const env = { ...process.env, HADES_VAULT: v.vault, HADES_WORKSPACE: v.work, HADES_TOOL_GITLEAKS: FAKE('gitleaks'), HADES_TOOL_SEMGREP: FAKE('semgrep'), HADES_TOOL_TRIVY: FAKE('trivy'), HADES_TOOL_ZAPROXY: FAKE('zap') };
  for (const k of ['FAKE_GITLEAKS_EXIT', 'FAKE_SEMGREP_EXIT', 'FAKE_TRIVY_EXIT', 'FAKE_ZAP_EXIT', 'FAKE_ZAP_REPORT', 'FAKE_ARGV_LOG']) delete env[k];
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: v.root, timeout: 120000, windowsHide: true });
  const out = r.stdout || '';
  return { code: r.status, out, err: r.stderr || '', lines: out.replace(/\s+$/, '').split(/\r?\n/) };
}

const lastRun = (v) => JSON.parse(fs.readFileSync(`${v.taskDir}/gates.json`, 'utf8')).runs.at(-1);

describe('a gate that ran nothing is red (GATE EMPTY)', () => {
  test('every step n/a: exit 2, last line GATE EMPTY, gates.json ok false; task show reports it', () => {
    const v = makeVault();
    for (const args of [[v.taskId], [v.taskId, '--preset', 'build', '--project', '.']]) {
      const r = hades(v, ['gate', ...args]);
      assert.equal(r.code, 2, r.out + r.err);
      assert.deepEqual(r.lines.slice(0, 4), ['N/A build (no command)', 'N/A lint (no command)', 'N/A types (no command)', 'N/A test (no command)']);
      assert.equal(r.lines.at(-1), EMPTY);
      const run = lastRun(v);
      assert.equal(run.ok, false);
      assert.deepEqual(run.empty, ['.']);
    }
    const show = hades(v, ['task', 'show', v.taskId, '--json']);
    assert.equal(show.code, 0, show.err);
    assert.equal(JSON.parse(show.out).gate.ok, false);
    assert.deepEqual(JSON.parse(show.out).gate.failing, ['empty(no commands: .)']);
  });

  test('--allow-empty accepts it (recorded), exit 0', () => {
    const v = makeVault();
    const r = hades(v, ['gate', v.taskId, '--allow-empty']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.lines.at(-1), 'GATE GREEN (4 n/a; empty accepted by --allow-empty)');
    const run = lastRun(v);
    assert.equal(run.ok, true);
    assert.equal(run.allow_empty, true);
    assert.deepEqual(run.empty, ['.']);
  });

  test('precommit with no build/test command is empty even though secrets passed', () => {
    const v = makeVault();
    const r = hades(v, ['gate', v.taskId, '--preset', 'precommit']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^PASS secrets /m);
    assert.equal(r.lines.at(-2), 'no command ran for project(s): .');
    assert.equal(r.lines.at(-1), EMPTY);
  });

  test('multi-project: one configured project does not make an unconfigured one green', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { build: cmd('ok'), test: cmd('ok') } }, { path: 'web', commands: {} }] });
    const r = hades(v, ['gate', v.taskId]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.equal(r.lines.at(-2), 'no command ran for project(s): web');
    assert.equal(r.lines.at(-1), EMPTY);
    assert.deepEqual(lastRun(v).empty, ['web']);
    // the configured project alone is green; partial n/a is fine
    const one = hades(v, ['gate', v.taskId, '--project', '.']);
    assert.equal(one.code, 0, one.out);
    assert.equal(one.lines.at(-1), 'GATE GREEN (2 n/a)');
    // a failure still reads RED, with the empty project named
    const f = makeVault({ projects: [{ path: '.', commands: { build: cmd('ok', 1) } }, { path: 'web', commands: {} }] });
    const red = hades(f, ['gate', f.taskId]);
    assert.equal(red.code, 2);
    assert.equal(red.lines.at(-2), 'no command ran for project(s): web');
    assert.equal(red.lines.at(-1), 'GATE RED (1 failing)');
  });

  test('security preset (scanners only) is judged on its scanners', () => {
    const v = makeVault();
    const r = hades(v, ['gate', v.taskId, '--preset', 'security']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.lines.at(-1), 'GATE GREEN');
  });

  test('emptyProjects and formatRun', () => {
    const na = (step, project = '.') => ({ step, status: 'n/a', project });
    assert.deepEqual(gate.emptyProjects([na('build'), na('test')]), ['.']);
    assert.deepEqual(gate.emptyProjects([na('build'), { step: 'test', status: 'pass', project: '.' }]), []);
    assert.deepEqual(gate.emptyProjects([{ step: 'secrets', status: 'n/a', project: '.' }]), ['.']);
    assert.deepEqual(gate.emptyProjects([{ step: 'secrets', status: 'pass', project: '.' }]), []);
    assert.equal(gate.formatRun({ steps: [na('build')], empty: ['.'] }).split('\n').at(-1), EMPTY);
    assert.equal(gate.GATE_EMPTY_LINE, EMPTY);
  });

  test('unknown gate flags are refused before anything runs', () => {
    const v = makeVault();
    const r = hades(v, ['gate', v.taskId, '--allow-emtpy']);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown flag --allow-emtpy/);
    assert.ok(!fs.existsSync(`${v.taskDir}/gates.json`));
  });
});

describe('team DAST limits (security.dast_live, security.dast_test)', () => {
  const envs = { live: { url: 'https://shop.example.com' }, test: { url: 'https://test.example.com/' } };
  const check = (url, mode, security, extra = {}) => gate.checkDastTarget({ url, mode, teamJson: { environments: envs, ...(security ? { security } : {}) }, ...extra });

  test('dast_live none refuses even a baseline scan of live; baseline (default) allows it', () => {
    assert.match(check('https://shop.example.com/', 'baseline', { dast_live: 'none' }), /security\.dast_live is none: no DAST against the live environment/);
    assert.match(check('https://test.example.com', 'api', { dast_live: 'none' }, { openapi: 'https://shop.example.com/openapi.json' }), /dast_live is none/);
    assert.equal(check('https://shop.example.com/', 'baseline', { dast_live: 'baseline' }), null);
    assert.equal(check('https://shop.example.com/', 'baseline'), null);
    assert.match(check('https://shop.example.com/', 'full', { dast_live: 'baseline' }), /refused.*live/);
  });

  test('dast_test caps the mode on the test environment', () => {
    assert.match(check('https://test.example.com/app', 'baseline', { dast_test: 'none' }), /security\.dast_test is none: no DAST against the test environment/);
    assert.match(check('https://test.example.com/app', 'full', { dast_test: 'none' }), /dast_test is none/);
    assert.match(check('https://test.example.com/app', 'api', { dast_test: 'baseline' }), /--mode api exceeds team\.json security\.dast_test \(baseline\); use --mode baseline/);
    assert.equal(check('https://test.example.com/app', 'baseline', { dast_test: 'baseline' }), null);
    assert.match(check('https://test.example.com/app', 'full', { dast_test: 'api' }), /--mode full exceeds .*\(api\); use --mode baseline or --mode api/);
    assert.equal(check('https://test.example.com/app', 'api', { dast_test: 'api' }), null);
    assert.equal(check('https://test.example.com/app', 'full', { dast_test: 'full' }), null);
    assert.equal(check('https://test.example.com/app', 'full'), null, 'default full');
  });

  test('a local target the owner runs is not capped by the environment limits', () => {
    const sec = { dast_live: 'none', dast_test: 'none' };
    assert.equal(check('http://localhost:3000', 'full', sec, { iOwnTarget: true }), null);
    assert.match(check('http://localhost:3000', 'full', sec), /not the team's test environment/);
  });

  test('the CLI refuses before any scan (exit 1)', () => {
    const v = makeVault({ environments: envs, security: { dast_live: 'none' } });
    const r = hades(v, ['gate', v.taskId, '--dast', 'https://shop.example.com']);
    assert.equal(r.code, 1);
    assert.match(r.err, /dast_live is none/);
    assert.ok(!fs.existsSync(`${v.taskDir}/gates.json`));
  });
});
