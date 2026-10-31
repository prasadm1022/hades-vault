// Tests for "hades gate" (lib/commands/gate.mjs + lib/core/gate.mjs).
// No network, no Docker, no real scanners: project commands are node one-liners and the scanners
// are fixture scripts selected through HADES_TOOL_<NAME> overrides.
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
const LOG = (name) => fs.readFileSync(path.join(FIX, 'logs', name), 'utf8');
// team.json command line (run through the platform shell by the gate) for the fake project command.
const cmd = (mode, code = 0) => `"${process.execPath}" "${EMIT}" ${mode} ${code}`;

const created = [];
after(async () => {
  // The timeout test leaves its sleeping child running for a few seconds and Windows keeps that
  // child's cwd locked (EBUSY, which rmSync does not retry), so retry here for up to 15 s.
  const dirs = created.flatMap((c) => [c.root, path.join(ENGINE, '.hades', 'logs', c.taskId)]);
  const deadline = Date.now() + 15000;
  for (const dir of dirs) {
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        if (Date.now() > deadline) break; // best effort: temp folder
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

// Temp vault (registry v3, team folder with team.json, one task folder) plus project folders.
function makeVault({ projects = [{ path: '.', fixture: 'clean', commands: {} }], environments = {}, security } = {}) {
  const root = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-gate-')));
  const team = `gt${Math.random().toString(36).slice(2, 8)}`;
  const vault = `${root}/vault`;
  const work = `${root}/work`;
  const projectPath = `${work}/app`;
  const teamDir = `organizations/acme/teams/${team}`;
  const registry = {
    version: 3,
    organizations: { acme: { org_dir: 'organizations/acme', root_path: work, description: 'test', aliases: [], created: '2026-10-31' } },
    teams: {
      [team]: { organization: 'acme', type: 'main', project_path: projectPath, team_dir: teamDir, description: 'gate test', aliases: [], status: 'active', created: '2026-10-31' },
    },
  };
  fs.mkdirSync(`${vault}/${teamDir}`, { recursive: true });
  fs.writeFileSync(`${vault}/registry.json`, JSON.stringify(registry, null, 2));
  for (const p of projects) {
    const dir = path.join(projectPath, p.path);
    fs.mkdirSync(dir, { recursive: true });
    if (p.fixture) fs.cpSync(path.join(FIX, 'projects', p.fixture), dir, { recursive: true });
  }
  const teamJson = {
    team,
    projects: projects.map((p) => ({ path: p.path, stack: ['node'], commands: p.commands || {} })),
    environments,
    branch_strategy: 'current-branch',
    ...(security ? { security } : {}),
  };
  fs.writeFileSync(`${vault}/${teamDir}/team.json`, JSON.stringify(teamJson, null, 2));
  const taskId = `${team}-001`;
  const taskDir = `${vault}/${teamDir}/tasks/${taskId}-sample`;
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(`${taskDir}/state.json`, JSON.stringify({ id: taskId, team, status: 'open' }));
  const v = { root, vault, work, projectPath, team, taskId, taskDir, argvLog: `${root}/argv.jsonl` };
  created.push(v);
  return v;
}

const FAKE_ENV = ['FAKE_GITLEAKS_EXIT', 'FAKE_SEMGREP_EXIT', 'FAKE_TRIVY_EXIT', 'FAKE_ZAP_EXIT', 'FAKE_ZAP_REPORT'];

function hades(v, args, extraEnv = {}) {
  const env = {
    ...process.env,
    HADES_VAULT: v.vault,
    HADES_WORKSPACE: v.work,
    HADES_TOOL_GITLEAKS: FAKE('gitleaks'),
    HADES_TOOL_SEMGREP: FAKE('semgrep'),
    HADES_TOOL_TRIVY: FAKE('trivy'),
    HADES_TOOL_ZAPROXY: FAKE('zap'),
    FAKE_ARGV_LOG: v.argvLog,
  };
  for (const k of FAKE_ENV) delete env[k];
  for (const [k, val] of Object.entries(extraEnv)) {
    if (val === undefined) delete env[k];
    else env[k] = val;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, 'gate', ...args], { env, encoding: 'utf8', cwd: v.root, timeout: 120000, windowsHide: true });
  const out = r.stdout || '';
  return { code: r.status, out, err: r.stderr || '', lines: out.replace(/\s+$/, '').split(/\r?\n/), ms: Date.now() - t0 };
}

const gates = (v) => JSON.parse(fs.readFileSync(`${v.taskDir}/gates.json`, 'utf8'));
const argvOf = (v, tool) =>
  fs.existsSync(v.argvLog)
    ? fs.readFileSync(v.argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.tool === tool)
    : [];
const after1 = (argv, flag) => argv[argv.indexOf(flag) + 1];

// ---------------------------------------------------------------------------------------------
describe('failure excerpts and test summaries', () => {
  const cases = [
    ['maven-compile.log', ['App.java:[12,9] cannot find symbol', 'symbol:   variable foo', 'BUILD FAILURE'], ['re-run Maven', '[Help 1]', 'Finished at'], null],
    ['maven-surefire.log', ['expected: <3> but was: <4>', 'AppTest.adds:12'], ['[Help 1]'], { passed: 11, failed: 1 }],
    ['gradle.log', ['adds() FAILED', '* What went wrong:', 'AssertionFailedError at AppTest.java:12'], ['Run with --scan', 'help.gradle.org'], { passed: 6, failed: 1 }],
    ['jest.log', ['FAIL src/sum.test.js', 'Expected: 4', 'Received: 3', '> 4 |'], [], { passed: 10, failed: 1 }],
    ['vitest.log', ['× sum > adds', 'AssertionError: expected 3 to be 4'], ['\x1b['], { passed: 4, failed: 1 }],
    ['pytest.log', ['E       assert 4 == 5', 'FAILED test_sample.py::test_answer'], ['platform linux'], { passed: 3, failed: 1 }],
    ['go.log', ['--- FAIL: TestAdd', 'add_test.go:9: Add(1,2) = 4; want 3'], [], { passed: 2, failed: 1 }],
    ['cargo.log', ['panicked at src/lib.rs:10:9', 'left: 4', 'test tests::it_fails ... FAILED'], ['RUST_BACKTRACE'], { passed: 2, failed: 1 }],
    ['dotnet.log', ['Failed CalcTests.Adds [12 ms]', 'Expected: 3', 'Actual:   4'], ['Determining projects'], { passed: 5, failed: 1 }],
    ['tsc.log', ['error TS2322', 'error TS2339'], [], null],
    ['rspec.log', ['Failure/Error: expect(calc.add(1, 2)).to eq(4)', 'rspec ./spec/calc_spec.rb:4'], [], { passed: 2, failed: 1 }],
    ['phpunit.log', ['Failed asserting that 3 matches expected 4.', 'There was 1 failure:'], ['Sebastian Bergmann'], { passed: 2, failed: 1 }],
    ['python-traceback.log', ['Traceback (most recent call last)', "ModuleNotFoundError: No module named 'requests'"], [], null],
    ['eslint.log', ["3:7  error  'x' is assigned a value but never used"], ['A complete log', 'npm ERR! code', 'npm ERR! errno'], null],
    ['node-test.log', ['not ok 2 - subtracts'], [], { passed: 1, failed: 1 }],
    ['mocha.log', ['AssertionError: expected 3 to equal 4', '1 failing'], [], { passed: 9, failed: 1 }],
  ];
  for (const [file, must, mustNot, summary] of cases) {
    test(`${file}: relevant lines, no boilerplate, <= 25 lines`, () => {
      const text = LOG(file);
      const ex = gate.extractExcerpt(text);
      const lines = ex.split('\n');
      assert.ok(lines.length <= 25, `${lines.length} lines`);
      for (const m of must) assert.ok(ex.includes(m), `${file}: missing "${m}" in:\n${ex}`);
      for (const m of mustNot) assert.ok(!ex.includes(m), `${file}: should not include "${m}" in:\n${ex}`);
      assert.deepEqual(gate.parseTestSummary(text), summary);
    });
  }

  test('a 5,000-line log yields the error line and stays small', () => {
    const noise = Array.from({ length: 5000 }, (_, i) => `[INFO] Compiling module ${i}`);
    const text = [...noise, '[ERROR] /src/App.java:[77,3] incompatible types', ...noise.slice(0, 300)].join('\n');
    const ex = gate.extractExcerpt(text);
    assert.ok(ex.includes('App.java:[77,3] incompatible types'));
    assert.ok(ex.split('\n').length <= 3);
  });

  test('falls back to the last 25 lines when nothing matches', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const ex = gate.extractExcerpt(text).split('\n');
    assert.equal(ex.length, 25);
    assert.equal(ex[0], 'line 75');
    assert.equal(ex[24], 'line 99');
  });

  test('deduplicates and caps at 25 lines; strong matches win over noisy ERROR logs', () => {
    const appLogs = Array.from({ length: 60 }, (_, i) => `12:00:${i} ERROR c.a.Service - retrying connection ${i}`);
    const text = [...appLogs, 'boom: Error: same', 'boom: Error: same', 'boom: Error: same', 'FAIL src/a.test.js', '  ● a › works'].join('\n');
    const ex = gate.extractExcerpt(text);
    const lines = ex.split('\n');
    assert.ok(lines.length <= 25);
    assert.ok(ex.includes('FAIL src/a.test.js'));
    assert.ok(ex.includes('● a › works'));
    assert.equal(lines.filter((l) => l === 'boom: Error: same').length, 1);
  });

  test('strips ANSI and progress-bar carriage returns; truncates long lines', () => {
    const text = `\x1b[31merror:\x1b[0m bad thing\nDownloading 10%\rDownloading 100%\rerror: ${'x'.repeat(500)}\n`;
    const ex = gate.extractExcerpt(text);
    assert.ok(!ex.includes('\x1b'));
    assert.ok(ex.includes('error: bad thing'));
    assert.ok(!ex.includes('Downloading'));
    for (const l of ex.split('\n')) assert.ok(l.length <= 200);
  });

  test('credential-looking values are masked in excerpts', () => {
    const text = 'error: login failed password=hunter2hunter2 key AKIAABCDEFGHIJKLMNOP\nerror: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\nerror: postgres://admin:s3cretpass@db:5432/x';
    const ex = gate.extractExcerpt(text);
    for (const secret of ['hunter2hunter2', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnopqrstuvwxyz0123', 's3cretpass']) assert.ok(!ex.includes(secret), secret);
    assert.ok(ex.includes('[REDACTED]'));
  });
});

// ---------------------------------------------------------------------------------------------
describe('scanner report parsing', () => {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(FIX, p), 'utf8'));

  test('semgrep: ERROR->high, WARNING->medium, INFO->low; dedupe; nosem ignored', () => {
    const r = gate.parseSemgrep(read('projects/vuln/.fake/semgrep.json'));
    assert.deepEqual(r.counts, { critical: 0, high: 1, medium: 1, low: 1 });
    assert.equal(r.findings[0].severity, 'high');
    const id = 'javascript.express.security.audit.xss.direct-response-write.direct-response-write';
    assert.equal(gate.formatFinding(r.findings[0]), `high ...${id.slice(-67)} src/server.js:21`, 'long rule ids are shortened from the left');
    assert.ok(gate.blocking(r.counts));
    const low = gate.parseSemgrep(read('projects/lowsev/.fake/semgrep.json'));
    assert.deepEqual(low.counts, { critical: 0, high: 0, medium: 1, low: 1 });
    assert.ok(!gate.blocking(low.counts));
  });

  test('trivy: vulnerabilities and failed misconfigurations by severity', () => {
    const r = gate.parseTrivy(read('projects/vuln/.fake/trivy.json'));
    assert.deepEqual(r.counts, { critical: 1, high: 2, medium: 1, low: 0 });
    assert.equal(gate.formatFinding(r.findings[0]), 'critical CVE-2021-44906 package-lock.json minimist@1.2.5 -> 1.2.6');
    assert.ok(r.findings.some((f) => f.rule === 'DS002' && f.line === 1));
    assert.ok(!r.findings.some((f) => f.rule === 'DS026'), 'PASS misconfigurations are not findings');
    const unk = gate.parseTrivy({ Results: [{ Target: 'go.sum', Vulnerabilities: [{ VulnerabilityID: 'X', PkgName: 'p', InstalledVersion: '1', Severity: 'UNKNOWN' }] }] });
    assert.deepEqual(unk.counts, { critical: 0, high: 0, medium: 0, low: 1 });
  });

  test('gitleaks: every finding is critical, .gitleaksignore applied, no secret values kept', () => {
    const report = [
      { RuleID: 'generic-api-key', File: '/w/app/config/app.env', StartLine: 3, Secret: 'REDACTED', Match: 'REDACTED', Fingerprint: '/w/app/config/app.env:generic-api-key:3' },
      { RuleID: 'aws-access-token', File: '/w/app/src/db.js', StartLine: 7, Secret: 'REDACTED', Match: 'REDACTED', Fingerprint: '/w/app/src/db.js:aws-access-token:7' },
    ];
    const all = gate.parseGitleaks(report, { roots: ['/w/app'] });
    assert.deepEqual(all.counts, { critical: 2, high: 0, medium: 0, low: 0 });
    const some = gate.parseGitleaks(report, { roots: ['/w/app'], ignore: new Set(['config/app.env:generic-api-key:3']) });
    assert.equal(some.findings.length, 1);
    assert.deepEqual(Object.keys(some.findings[0]).sort(), ['file', 'line', 'rule', 'severity']);
    assert.equal(gate.formatFinding(some.findings[0]), 'critical aws-access-token src/db.js:7');
    const abs = gate.parseGitleaks(report, { roots: ['/w/app'], ignore: new Set(['/w/app/src/db.js:aws-access-token:7']) });
    assert.equal(abs.findings.length, 1);
    assert.equal(abs.findings[0].rule, 'generic-api-key');
  });

  test('zap: High/Medium/Low counted, Informational ignored', () => {
    const r = gate.parseZap(read('zap/high.json'));
    assert.deepEqual(r.counts, { critical: 0, high: 1, medium: 1, low: 0 });
    assert.equal(gate.formatFinding(r.findings[0]), 'high 40012 https://test.example.com/search?q=x Cross Site Scripting (Reflected) x2');
    const byDesc = gate.parseZap({ site: { alerts: [{ pluginid: '1', alert: 'a', riskdesc: 'Low (High)' }] } });
    assert.deepEqual(byDesc.counts, { critical: 0, high: 0, medium: 0, low: 1 });
  });

  test('without lib/core/tools.mjs only the HADES_TOOL_<NAME> override resolves, else a setup hint', () => {
    const saved = process.env.HADES_TOOL_PLAYWRIGHT_MCP;
    try {
      delete process.env.HADES_TOOL_PLAYWRIGHT_MCP;
      assert.throws(() => gate.fallbackTools.resolveTool({}, 'playwright-mcp'), /run: hades tools setup playwright-mcp/);
      process.env.HADES_TOOL_PLAYWRIGHT_MCP = '/opt/x/fake.mjs';
      assert.deepEqual(gate.fallbackTools.resolveTool({}, 'playwright-mcp'), { cmd: process.execPath, args: ['/opt/x/fake.mjs'], via: 'env', version: null });
      process.env.HADES_TOOL_PLAYWRIGHT_MCP = '/opt/x/tool';
      assert.equal(gate.fallbackTools.resolveTool({}, 'playwright-mcp').cmd, '/opt/x/tool');
    } finally {
      if (saved === undefined) delete process.env.HADES_TOOL_PLAYWRIGHT_MCP;
      else process.env.HADES_TOOL_PLAYWRIGHT_MCP = saved;
    }
  });

  test('trivy goes offline only when its DB is cached', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hades-trivy-'));
    created.push({ root: cache, taskId: '__none__' });
    assert.deepEqual(gate.trivyOfflineFlags(cache), []);
    fs.mkdirSync(path.join(cache, 'db'));
    fs.writeFileSync(path.join(cache, 'db', 'trivy.db'), '');
    assert.deepEqual(gate.trivyOfflineFlags(cache), ['--skip-db-update', '--skip-check-update', '--offline-scan']);
    fs.mkdirSync(path.join(cache, 'java-db'));
    fs.writeFileSync(path.join(cache, 'java-db', 'trivy-java.db'), '');
    assert.ok(gate.trivyOfflineFlags(cache).includes('--skip-java-db-update'));
  });

  test('presets match docs/cli.md', () => {
    assert.deepEqual(gate.PRESETS, {
      build: ['build', 'lint', 'types', 'test'],
      precommit: ['build', 'test', 'secrets'],
      predeploy: ['build', 'test', 'secrets', 'sast', 'deps'],
      security: ['secrets', 'sast', 'deps'],
      full: ['build', 'lint', 'types', 'test', 'secrets', 'sast', 'deps'],
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('DAST target rules and docker helpers', () => {
  const teamJson = { environments: { live: { url: 'https://shop.example.com' }, test: { url: 'https://test.example.com/' } } };
  const check = (url, mode, extra = {}) => gate.checkDastTarget({ url, mode, teamJson, ...extra });

  test('baseline (passive) is allowed anywhere, including live', () => {
    assert.equal(check('https://shop.example.com/', 'baseline'), null);
    assert.equal(check('https://anything.example.org', 'baseline'), null);
  });

  test('full/api refused against the live host, even with --i-own-this-target', () => {
    assert.match(check('https://shop.example.com/x', 'full'), /refused.*live/);
    assert.match(check('https://SHOP.example.com:8443/', 'full', { iOwnTarget: true }), /refused.*live/);
    assert.match(check('https://test.example.com', 'api', { openapi: 'https://shop.example.com/openapi.json' }), /refused.*live/);
  });

  test('full/api need the test url or --i-own-this-target', () => {
    assert.equal(check('https://test.example.com/app', 'full'), null);
    assert.match(check('https://staging.other.org', 'full'), /not the team's test environment/);
    assert.equal(check('https://staging.other.org', 'full', { iOwnTarget: true }), null);
    assert.match(gate.checkDastTarget({ url: 'https://x.org', mode: 'api', teamJson: {} }), /none configured/);
  });

  test('bad URLs and modes are rejected', () => {
    assert.match(check('ftp://test.example.com', 'baseline'), /http/);
    assert.match(check('not a url', 'baseline'), /invalid/);
    assert.match(check('https://test.example.com', 'aggressive'), /unknown --mode/);
  });

  test('zap arguments per mode keep ZAP silent and pin the API host', () => {
    const b = gate.zapArgs({ mode: 'baseline', target: 'https://t', jsonName: 'r.json', htmlName: 'r.html' });
    assert.equal(b[0], 'zap-baseline.py');
    assert.match(after1(b, '-z'), /-silent/);
    assert.equal(after1(b, '-J'), 'r.json');
    assert.equal(gate.zapArgs({ mode: 'full', target: 'https://t', jsonName: 'r', htmlName: 'h' })[0], 'zap-full-scan.py');
    const a = gate.zapArgs({ mode: 'api', target: 'https://t/api', openapi: 'https://t/openapi.json', jsonName: 'r', htmlName: 'h' });
    assert.equal(a[0], 'zap-api-scan.py');
    assert.equal(after1(a, '-t'), 'https://t/openapi.json');
    assert.equal(after1(a, '-f'), 'openapi');
    assert.equal(after1(a, '-O'), 'https://t/api');
  });

  test('docker volume paths and option placement', () => {
    assert.equal(gate.dockerMountPath('c:/Users/me/x', 'win32'), 'C:\\Users\\me\\x');
    assert.equal(gate.dockerMountPath('/home/me/x', 'linux'), '/home/me/x');
    const args = gate.dockerArgs(['run', '--rm', 'zaproxy/zap-stable:2.17.0'], { mounts: [{ host: '/logs', container: '/zap/wrk' }, { host: '/p', container: '/project', ro: true }], name: 'n1', workdir: '/w' }, 'linux');
    assert.deepEqual(args, [
      'run', '--name', 'n1', '--mount', 'type=bind,source=/logs,target=/zap/wrk', '--mount', 'type=bind,source=/p,target=/project,readonly', '-w', '/w',
      '--rm', 'zaproxy/zap-stable:2.17.0',
    ]);
    assert.throws(() => gate.dockerArgs(['run', 'img'], { mounts: [{ host: '/a,b', container: '/x' }] }, 'linux'), /comma/);
    const mounts = [{ host: path.resolve('/data/proj'), container: '/src' }, { host: path.resolve('/data/proj/out'), container: '/out' }];
    assert.equal(gate.containerPath(path.resolve('/data/proj/a/b.js'), mounts), '/src/a/b.js');
    assert.equal(gate.containerPath(path.resolve('/data/proj/out/r.json'), mounts), '/out/r.json');
  });

  test('docker plan keeps the mounts resolveTool made and adds only the missing ones', () => {
    // Shape of lib/core/tools.mjs dockerRunArgs for trivy: cwd mounted at /src, cache at /cache.
    const base = ['run', '--rm', '-i', '--mount', 'type=bind,source=/w/logs,target=/src', '-w', '/src', '--mount', 'type=bind,source=/e/.tools-bin/trivy-cache,target=/cache', '-e', 'TRIVY_CACHE_DIR=/cache', 'aquasec/trivy:0.76.0'];
    assert.deepEqual(gate.existingMounts(base), [{ host: '/w/logs', container: '/src' }, { host: '/e/.tools-bin/trivy-cache', container: '/cache' }]);
    assert.deepEqual(gate.existingMounts(['run', '-v', 'C:\\x\\y:/zap/wrk:rw', 'img']), [{ host: 'C:\\x\\y', container: '/zap/wrk' }]);
    const plan = gate.planDocker(base, {
      want: [{ host: '/w/logs', container: '/src' }, { host: '/w/app', container: '/project', ro: true }, { host: '/e/.tools-bin/trivy-cache', container: '/cache' }],
      name: 'hades-trivy-1',
      extra: ['--add-host', 'host.docker.internal:host-gateway'],
    }, 'linux');
    assert.deepEqual(plan.args.slice(0, 7), ['run', '--name', 'hades-trivy-1', '--mount', 'type=bind,source=/w/app,target=/project,readonly', '--add-host', 'host.docker.internal:host-gateway']);
    assert.equal(plan.args.filter((a) => a === '--mount').length, 3);
    assert.equal(plan.args.at(-1), 'aquasec/trivy:0.76.0');
    assert.equal(gate.containerPath(path.resolve('/w/app/package-lock.json'), plan.mounts), '/project/package-lock.json');
    const again = gate.planDocker(plan.args, { extra: ['--add-host', 'host.docker.internal:host-gateway'] }, 'linux');
    assert.equal(again.args.filter((a) => a === '--add-host').length, 1);
  });

  test('mergeEnv: later layers win, undefined removes a variable', () => {
    const env = gate.mergeEnv({ A: '1', SEMGREP_APP_TOKEN: 'x' }, { B: 2 }, { A: '3', SEMGREP_APP_TOKEN: undefined });
    assert.deepEqual(env, { A: '3', B: '2' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('docker-resolved scanners (fake docker, no Docker needed)', () => {
  test('mounts, container paths, container names and the localhost rewrite', async () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'vuln' }] });
    const engine = slash(path.join(v.root, 'engine'));
    const logDir = slash(path.join(v.root, 'logs'));
    fs.mkdirSync(logDir, { recursive: true });
    const images = { gitleaks: 'ghcr.io/gitleaks/gitleaks:v8.30.1', semgrep: 'semgrep/semgrep:1.181.0', trivy: 'aquasec/trivy:0.76.0', zaproxy: 'zaproxy/zap-stable:2.17.0' };
    // Same shape as lib/core/tools.mjs dockerRunArgs: cwd mounted at the image workdir.
    gate.setToolsApi({
      resolveTool(ctx, name, opts) {
        const wd = name === 'zaproxy' ? '/zap/wrk' : '/src';
        return {
          cmd: process.execPath,
          args: [
            FAKE('docker'), 'run', '--rm', '-i', '--mount', `type=bind,source=${slash(opts.cwd)},target=${wd}`, '-w', wd,
            ...(name === 'trivy' ? ['--mount', `type=bind,source=${engine}/.tools-bin/trivy-cache,target=/cache`] : []),
            ...(name === 'zaproxy' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
            images[name], ...(name === 'semgrep' ? ['semgrep'] : []),
          ],
          via: 'docker',
          version: 'pinned',
          env: {},
        };
      },
    });
    const saved = { log: process.env.FAKE_ARGV_LOG, rep: process.env.FAKE_ZAP_REPORT };
    process.env.FAKE_ARGV_LOG = v.argvLog;
    process.env.FAKE_ZAP_REPORT = slash(path.join(FIX, 'zap', 'medium.json'));
    try {
      const ctx = { engine };
      const common = { project: { rel: '.' }, dir: v.projectPath, logDir, timeoutMs: 60000 };
      const sec = await gate.runSecretsStep(ctx, common);
      const sast = await gate.runSastStep(ctx, { ...common, config: 'p/default' });
      const deps = await gate.runDepsStep(ctx, common);
      const dast = await gate.runDast(ctx, { url: 'http://localhost:8080/', mode: 'baseline', logDir, timeoutMs: 60000 });
      assert.deepEqual([sec.status, sast.status, deps.status, dast.status], ['pass', 'fail', 'fail', 'pass']);
      assert.deepEqual(deps.counts, { critical: 1, high: 2, medium: 1, low: 0 });

      const calls = argvOf(v, 'docker').map((c) => c.argv);
      const [gl, sg, tv, zp] = calls;
      const mountsOf = (a) => a.flatMap((x, i) => (a[i - 1] === '--mount' ? [x] : []));
      // gitleaks: project already mounted at /src by resolveTool; the gate adds /out for reports
      assert.match(after1(gl, '--name'), /^hades-gitleaks-\d+$/);
      assert.equal(mountsOf(gl).length, 2);
      assert.ok(mountsOf(gl).some((m) => m.endsWith(',target=/out')));
      assert.equal(after1(gl, 'dir'), '/src');
      assert.match(after1(gl, '-r'), /^\/out\/root-secrets-\d+\.json$/);
      // semgrep: image command "semgrep" not duplicated
      assert.equal(sg.filter((x) => x === 'semgrep').length, 1);
      assert.equal(sg.at(-1), '/src');
      assert.match(after1(sg, '--output'), /^\/out\/root-sast-\d+\.json$/);
      // trivy: logs at /src (cwd), project read-only at /project, cache reused at /cache
      assert.ok(mountsOf(tv).some((m) => m.endsWith(',target=/project,readonly')));
      assert.equal(mountsOf(tv).filter((m) => m.includes('target=/cache')).length, 1);
      assert.equal(after1(tv, '--cache-dir'), '/cache');
      assert.equal(tv.at(-1), '/project');
      assert.match(after1(tv, '--output'), /^\/src\/root-deps-\d+\.json$/);
      // zap: report folder is the resolveTool cwd mount; localhost reaches the host
      assert.equal(mountsOf(zp).length, 1);
      assert.equal(zp.filter((x) => x === '--add-host').length, 1);
      assert.equal(after1(zp, '-t'), 'http://host.docker.internal:8080/');
    } finally {
      gate.setToolsApi(null);
      if (saved.log === undefined) delete process.env.FAKE_ARGV_LOG;
      else process.env.FAKE_ARGV_LOG = saved.log;
      if (saved.rep === undefined) delete process.env.FAKE_ZAP_REPORT;
      else process.env.FAKE_ZAP_REPORT = saved.rep;
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('hades gate (CLI)', () => {
  test('build preset: pass and n/a steps, GATE GREEN, evidence in gates.json', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean', commands: { build: cmd('ok'), lint: '', test: cmd('log:node-test.log', 0) } }] });
    const r = hades(v, [v.taskId]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.lines[0], /^PASS build \(\d+\.\ds\)$/);
    assert.equal(r.lines[1], 'N/A lint (no command)');
    assert.equal(r.lines[2], 'N/A types (no command)');
    assert.match(r.lines[3], /^PASS test \(\d+\.\ds\) 1 passed, 1 failed$/);
    assert.equal(r.lines[4], 'GATE GREEN (2 n/a)');
    const run = gates(v).runs[0];
    assert.equal(run.preset, 'build');
    assert.equal(run.ok, true);
    assert.deepEqual(run.steps.map((s) => [s.step, s.status]), [['build', 'pass'], ['lint', 'n/a'], ['types', 'n/a'], ['test', 'pass']]);
    assert.ok(run.at && run.repos && 'head' in run && 'dirty' in run);
    const log = run.steps[0].log;
    assert.ok(log.startsWith(`.hades/logs/${v.taskId}/root-build-`), log);
    assert.match(fs.readFileSync(path.join(ENGINE, log), 'utf8'), /all good/);
    assert.equal(run.steps[1].log, undefined);
  });

  test('failures: one line per step, first excerpt only, GATE RED, exit 2', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { build: cmd('log:maven-compile.log', 1), lint: cmd('ok'), test: cmd('log:jest.log', 1) } }] });
    const r = hades(v, [v.taskId]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.lines[0], /^FAIL build \([\d.]+s\) exit 1 - log: .+root-build-\d+\.log$/);
    assert.match(r.out, /^FAIL test \([\d.]+s\) 10 passed, 1 failed - log: /m);
    assert.match(r.out, /First failure: build/);
    assert.match(r.out, /App\.java:\[12,9\] cannot find symbol/);
    assert.ok(!r.out.includes('Expected: 4'), 'only the first failure is excerpted');
    assert.equal(r.lines.at(-1), 'GATE RED (2 failing)');
    assert.ok(r.lines.length <= 30);
    const logPath = /log: (\S+)/.exec(r.lines[0])[1];
    assert.ok(path.isAbsolute(logPath) && fs.existsSync(logPath), logPath);
    const steps = gates(v).runs[0].steps;
    const t = steps.find((s) => s.step === 'test');
    assert.deepEqual(t.tests, { passed: 10, failed: 1 });
    assert.match(t.excerpt, /Expected: 4/);
    assert.equal(steps.find((s) => s.step === 'lint').excerpt, undefined);
    assert.equal(gates(v).runs[0].ok, false);
  });

  test('a 5,000-line failing build prints at most 30 lines', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { build: cmd('huge', 1), lint: cmd('huge', 1), types: cmd('huge', 1), test: cmd('huge', 1) } }] });
    const r = hades(v, [v.taskId, '--preset', 'full'], { HADES_TOOL_GITLEAKS: FAKE('gitleaks') });
    assert.equal(r.code, 2);
    assert.ok(r.lines.length <= 30, `${r.lines.length} lines`);
    assert.match(r.out, /Huge\.java:\[77,3\] incompatible types/);
    assert.equal(r.lines.at(-1), 'GATE RED (4 failing)');
  });

  test('--only runs exactly the named steps in canonical order; unknown step exits 1', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean', commands: { build: cmd('ok'), lint: cmd('ok', 1), test: cmd('ok') } }] });
    const r = hades(v, [v.taskId, '--only', 'test,build']);
    assert.equal(r.code, 0, r.out + r.err);
    const run = gates(v).runs[0];
    assert.deepEqual(run.steps.map((s) => s.step), ['build', 'test']);
    assert.equal(run.preset, 'custom');
    assert.deepEqual(run.only, ['build', 'test']);
    const bad = hades(v, [v.taskId, '--only', 'build,nope']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown step/);
  });

  test('presets select the documented steps', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean', commands: { build: cmd('ok'), lint: cmd('ok'), types: cmd('ok'), test: cmd('ok') } }] });
    for (const preset of ['precommit', 'predeploy', 'security', 'full']) {
      const r = hades(v, [v.taskId, '--preset', preset]);
      assert.equal(r.code, 0, `${preset}: ${r.out}${r.err}`);
      assert.equal(r.lines.at(-1), 'GATE GREEN');
    }
    const runs = gates(v).runs;
    assert.deepEqual(runs.map((x) => x.preset), ['precommit', 'predeploy', 'security', 'full']);
    runs.forEach((x, i) => assert.deepEqual(x.steps.map((s) => s.step), gate.PRESETS[x.preset], `run ${i}`));
    const sg = argvOf(v, 'semgrep');
    assert.equal(sg.length, 3);
    assert.ok(sg.every((c) => after1(c.argv, '--config') === 'p/default'), 'default semgrep config');
    const bad = hades(v, [v.taskId, '--preset', 'turbo']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown preset/);
  });

  test('--project picks one project; several projects are labelled and compressed', () => {
    const projects = ['.', 'api', 'web'].map((p) => ({ path: p, fixture: 'clean', commands: { build: cmd('ok'), lint: cmd('ok'), types: cmd('ok'), test: cmd(p === 'web' ? 'log:jest.log' : 'ok', p === 'web' ? 1 : 0) } }));
    const v = makeVault({ projects });
    const one = hades(v, [v.taskId, '--project', './api']);
    assert.equal(one.code, 0, one.out + one.err);
    assert.ok(gates(v).runs[0].steps.every((s) => s.project === 'api'));
    assert.ok(!one.out.includes('[api]'), 'single project output is not labelled');
    const all = hades(v, [v.taskId, '--preset', 'full']);
    assert.equal(all.code, 2);
    assert.ok(all.lines.length <= 30, `${all.lines.length} lines`);
    assert.match(all.out, /^\[api\] PASS build/m);
    assert.match(all.out, /^FAIL test \[web\] \([\d.]+s\) 10 passed, 1 failed/m);
    assert.deepEqual(Object.keys(gates(v).runs[1].repos).sort(), ['.', 'api', 'web']);
    const bad = hades(v, [v.taskId, '--project', 'mobile']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no project "mobile".*api/);
  });

  test('a missing command is reported as error, not fail', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { types: 'hades-no-such-command-xyz --noEmit' } }] });
    const r = hades(v, [v.taskId, '--only', 'types']);
    assert.equal(r.code, 2);
    assert.match(r.lines[0], /^ERROR types \([\d.]+s\) command not found - log: /);
    assert.equal(gates(v).runs[0].steps[0].status, 'error');
  });

  test('a step that exceeds --timeout fails with "timeout" and does not hang', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { test: cmd('sleep:5000', 0) } }] });
    const r = hades(v, [v.taskId, '--only', 'test', '--timeout', '0.02']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.lines[0], /^FAIL test \([\d.]+s\) timeout after 1\.2s/);
    assert.ok(r.ms < 4500, `took ${r.ms} ms - the gate waited for the child instead of timing out`);
    assert.equal(gates(v).runs[0].steps[0].note, 'timeout after 1.2s');
  });

  test('a team.json command the guard blocks is not run: error step, GATE RED', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { build: `${cmd('ok')} && git push origin main`, test: cmd('ok') } }] });
    const r = hades(v, [v.taskId, '--only', 'build,test']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.lines[0], /^ERROR build \(0\.0s\) blocked by the guard \(git\.push\) - log: /);
    assert.match(r.out, /HADES guard: git\.push: pushing is reserved for the owner/);
    assert.match(r.out, /^PASS test /m);
    const step = gates(v).runs[0].steps[0];
    assert.deepEqual([step.status, step.ms], ['error', 0]);
    const log = fs.readFileSync(path.join(ENGINE, step.log), 'utf8');
    assert.match(log, /\[hades\] not run: HADES guard: git\.push/);
    assert.ok(!log.includes('all good'), 'the command never ran');
  });
});

describe('project command steps (lib/core/gate.mjs)', () => {
  const dirs = () => {
    const root = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-gate-cmd-')));
    created.push({ root, taskId: '__none__' });
    fs.mkdirSync(`${root}/logs`);
    return { dir: root, logDir: `${root}/logs` };
  };
  const step = (command, extra = {}) => ({ step: 'test', project: { rel: '.' }, command, timeoutMs: 60000, ...dirs(), ...extra });
  const node = (code) => `"${process.execPath}" -e "${code}"`;

  test('runs with the non-interactive, telemetry-free environment', async () => {
    const keys = Object.keys(gate.GATE_ENV);
    assert.deepEqual(keys, ['CI', 'NEXT_TELEMETRY_DISABLED', 'NG_CLI_ANALYTICS', 'DOTNET_NOLOGO', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'FORCE_COLOR', 'NO_COLOR']);
    const r = await gate.runCommandStep(step(node(`console.log(${keys.map((k) => `process.env.${k}`).join("+','+")})`)));
    assert.equal(r.status, 'pass', r.excerpt);
    assert.match(fs.readFileSync(r.log, 'utf8'), /^true,1,false,1,1,0,1$/m);
  });

  test('stderr is kept in the log and the excerpt; exit codes map to fail', async () => {
    const r = await gate.runCommandStep(step(node("console.log('out line'); console.error('Error: boom at x.js:3'); process.exit(3)")));
    assert.equal(r.status, 'fail');
    assert.equal(r.note, 'exit 3');
    assert.match(r.excerpt, /Error: boom at x\.js:3/);
    const log = fs.readFileSync(r.log, 'utf8');
    assert.match(log, /out line\n\[stderr\]\nError: boom/);
  });

  test('guardCommand: platform shell, no agent, fail closed on a guard error', () => {
    const seen = [];
    assert.equal(gate.guardCommand('npm test', '/p', (c, o) => (seen.push([c, o]), null)), null);
    assert.deepEqual(seen, [['npm test', { shell: gate.COMMAND_SHELL, cwd: '/p', agentType: null }]]);
    assert.equal(gate.COMMAND_SHELL, process.platform === 'win32' ? 'cmd' : 'bash');
    const err = gate.guardCommand('x', '/p', () => {
      throw new Error('parser blew up');
    });
    assert.equal(err.id, 'guard.error');
    assert.match(err.message, /parser blew up/);
    assert.equal(gate.guardCommand('git push', process.cwd()).id, 'git.push');
    assert.equal(gate.guardCommand('npm run build', process.cwd()), null);
  });

  test('the trivy cache is the one lib/core/tools.mjs defines', () => {
    assert.equal(gate.trivyCacheDir({ engine: '/e' }), `${process.env.HADES_ENGINE_ROOT ? slash(path.resolve(process.env.HADES_ENGINE_ROOT)) : slash(path.resolve('/e'))}/.tools-bin/trivy-cache`);
  });
});

describe('hades gate (CLI), scanners', () => {
  test('secrets: gitleaks flags, allowlisted finding dropped, critical fails', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'leaky', commands: { build: cmd('ok'), test: cmd('ok') } }] });
    const r = hades(v, [v.taskId, '--preset', 'precommit']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^FAIL secrets \([\d.]+s\) 1 critical - report: .+root-secrets-\d+\.json$/m);
    assert.match(r.out, /^ {2}critical aws-access-token src\/db\.js:7$/m);
    assert.ok(!r.out.includes('generic-api-key'), 'finding covered by .gitleaksignore is not reported');
    assert.ok(!/REDACTED|Secret/.test(r.out));
    const [call] = argvOf(v, 'gitleaks');
    for (const f of ['dir', '--no-banner', '--redact=100', '--no-color']) assert.ok(call.argv.includes(f), f);
    assert.equal(after1(call.argv, '-f'), 'json');
    assert.equal(after1(call.argv, '--exit-code'), '2');
    assert.equal(slash(after1(call.argv, '-i')), slash(v.projectPath));
    const step = gates(v).runs[0].steps.find((s) => s.step === 'secrets');
    assert.deepEqual(step.counts, { critical: 1, high: 0, medium: 0, low: 0 });
    assert.deepEqual(step.top, ['critical aws-access-token src/db.js:7']);
  });

  test('security preset: semgrep and trivy severities, hardened flags, top findings', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'vuln' }], security: { semgrep_config: 'p/owasp-top-ten' } });
    const r = hades(v, [v.taskId, '--preset', 'security'], { SEMGREP_APP_TOKEN: 'should-not-leak' });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^PASS secrets \([\d.]+s\) no findings$/m);
    assert.match(r.out, /^FAIL sast \([\d.]+s\) 1 high, 1 medium, 1 low - report: /m);
    assert.match(r.out, /^FAIL deps \([\d.]+s\) 1 critical, 2 high, 1 medium - report: /m);
    assert.match(r.out, /First failure: sast\n {2}high \S*direct-response-write src\/server\.js:21/);
    assert.equal(r.lines.at(-1), 'GATE RED (2 failing)');
    const [sg] = argvOf(v, 'semgrep');
    for (const f of ['scan', '--metrics=off', '--disable-version-check', '--oss-only', '--json', '--quiet']) assert.ok(sg.argv.includes(f), f);
    assert.equal(after1(sg.argv, '--config'), 'p/owasp-top-ten');
    assert.equal(sg.env.SEMGREP_SEND_METRICS, 'off');
    assert.equal(sg.env.hasAppToken, false);
    const [tv] = argvOf(v, 'trivy');
    for (const f of ['fs', '--disable-telemetry', '--skip-version-check', '--config=', '--ignorefile=', '--list-all-pkgs=false', '--quiet']) assert.ok(tv.argv.includes(f), f);
    assert.equal(after1(tv.argv, '--scanners'), 'vuln,misconfig');
    assert.equal(after1(tv.argv, '--format'), 'json');
    assert.equal(after1(tv.argv, '--exit-code'), '3');
    assert.ok(!slash(tv.cwd).startsWith(slash(v.projectPath)), 'trivy must not run inside the checkout (config injection)');
    const deps = gates(v).runs[0].steps.find((s) => s.step === 'deps');
    assert.deepEqual(deps.counts, { critical: 1, high: 2, medium: 1, low: 0 });
    assert.equal(deps.top[0], 'critical CVE-2021-44906 package-lock.json minimist@1.2.5 -> 1.2.6');
    assert.ok(deps.top.length <= 5);
  });

  test('medium/low scanner findings pass with counts', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'lowsev' }], security: { semgrep_config: 'rules/hades.yml' } });
    const r = hades(v, [v.taskId, '--preset', 'security']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^PASS sast \([\d.]+s\) 1 medium, 1 low$/m);
    assert.match(r.out, /^PASS deps \([\d.]+s\) 1 medium, 1 low$/m);
    assert.equal(r.lines.at(-1), 'GATE GREEN');
    const [sg] = argvOf(v, 'semgrep');
    assert.equal(after1(sg.argv, '--config'), `${v.projectPath}/rules/hades.yml`, 'local rule files resolve against the project');
  });

  test('a missing or crashing scanner is an error with a setup hint', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean' }] });
    const r = hades(v, [v.taskId, '--preset', 'security'], {
      HADES_TOOL_GITLEAKS: slash(path.join(FIX, 'bin', 'not-a-tool.txt')),
      FAKE_SEMGREP_EXIT: '7',
      FAKE_TRIVY_EXIT: '1',
    });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^ERROR secrets /m);
    assert.match(r.out, /^ERROR sast \([\d.]+s\) tool exit 7 - log: /m);
    assert.match(r.out, /^ERROR deps \([\d.]+s\) tool exit 1 - log: /m);
    assert.equal(r.lines.at(-1), 'GATE RED (3 failing)');
    assert.ok(gates(v).runs[0].steps.every((s) => s.status === 'error'));
  });

  test('gitleaks partial scan (exit 1) is an error, not a pass', () => {
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean' }] });
    const r = hades(v, [v.taskId, '--only', 'secrets'], { FAKE_GITLEAKS_EXIT: '1' });
    assert.equal(r.code, 2);
    assert.match(r.lines[0], /^ERROR secrets .*tool exit 1/);
  });

  const envs = { live: { url: 'https://shop.example.com' }, test: { url: 'https://test.example.com/' } };

  test('DAST refusals exit 1 and run nothing', () => {
    const v = makeVault({ environments: envs });
    const cases = [
      [['--dast', 'https://shop.example.com/', '--mode', 'full'], /refused.*live/],
      [['--dast', 'https://shop.example.com/', '--mode', 'full', '--i-own-this-target'], /refused.*live/],
      [['--dast', 'https://test.example.com/', '--mode', 'api', '--openapi', 'https://shop.example.com/openapi.json'], /refused.*live/],
      [['--dast', 'https://staging.other.org/', '--mode', 'full'], /not the team's test environment/],
      [['--dast', 'https://staging.other.org/', '--mode', 'wild'], /unknown --mode/],
      [['--dast'], /needs a target URL/],
    ];
    for (const [args, re] of cases) {
      const r = hades(v, [v.taskId, ...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
    assert.equal(argvOf(v, 'zaproxy').length, 0);
    assert.ok(!fs.existsSync(`${v.taskDir}/gates.json`));
  });

  test('DAST runs: script per mode, risk mapping, exit codes, evidence', () => {
    const v = makeVault({ environments: envs });
    const medium = slash(path.join(FIX, 'zap', 'medium.json'));
    const high = slash(path.join(FIX, 'zap', 'high.json'));

    const base = hades(v, [v.taskId, '--dast', 'https://shop.example.com/'], { FAKE_ZAP_REPORT: medium });
    assert.equal(base.code, 0, base.out + base.err);
    assert.match(base.lines[0], /^PASS dast baseline https:\/\/shop\.example\.com\/ \([\d.]+s\) 1 medium, 1 low$/);
    assert.equal(base.lines.at(-1), 'GATE GREEN');

    const full = hades(v, [v.taskId, '--dast', 'https://test.example.com/', '--mode', 'full'], { FAKE_ZAP_REPORT: high });
    assert.equal(full.code, 2, full.out + full.err);
    assert.match(full.lines[0], /^FAIL dast full https:\/\/test\.example\.com\/ \([\d.]+s\) 1 high, 1 medium - report: .+dast-full-\d+\.json$/);
    assert.match(full.out, /^ {2}high 40012 https:\/\/test\.example\.com\/search\?q=x Cross Site Scripting \(Reflected\) x2$/m);

    const owned = hades(v, [v.taskId, '--dast', 'https://staging.other.org/', '--mode', 'full', '--i-own-this-target'], { FAKE_ZAP_REPORT: medium });
    assert.equal(owned.code, 0, owned.out + owned.err);

    const api = hades(v, [v.taskId, '--dast', 'https://test.example.com/api', '--mode', 'api', '--openapi', 'https://test.example.com/openapi.json'], { FAKE_ZAP_REPORT: medium });
    assert.equal(api.code, 0, api.out + api.err);

    const down = hades(v, [v.taskId, '--dast', 'https://test.example.com/', '--mode', 'full'], { FAKE_ZAP_EXIT: '3' });
    assert.equal(down.code, 2);
    assert.match(down.lines[0], /^ERROR dast full .*tool exit 3/);

    const calls = argvOf(v, 'zaproxy');
    assert.deepEqual(calls.map((c) => c.argv[0]), ['zap-baseline.py', 'zap-full-scan.py', 'zap-full-scan.py', 'zap-api-scan.py', 'zap-full-scan.py']);
    for (const c of calls) assert.match(after1(c.argv, '-z'), /-silent/);
    assert.equal(after1(calls[0].argv, '-t'), 'https://shop.example.com/');
    assert.equal(after1(calls[3].argv, '-t'), 'https://test.example.com/openapi.json');
    assert.equal(after1(calls[3].argv, '-O'), 'https://test.example.com/api');
    assert.equal(after1(calls[3].argv, '-f'), 'openapi');

    const runs = gates(v).runs;
    assert.equal(runs.length, 5);
    assert.deepEqual(runs.map((x) => [x.preset, x.mode, x.ok]), [
      ['dast', 'baseline', true],
      ['dast', 'full', false],
      ['dast', 'full', true],
      ['dast', 'api', true],
      ['dast', 'full', false],
    ]);
    assert.equal(runs[1].target, 'https://test.example.com/');
    assert.deepEqual(runs[1].steps[0].counts, { critical: 0, high: 1, medium: 1, low: 0 });
  });

  test('--json prints the run object; runs accumulate in gates.json', () => {
    const v = makeVault({ projects: [{ path: '.', commands: { build: cmd('ok') } }] });
    const a = hades(v, [v.taskId, '--only', 'build', '--json']);
    assert.equal(a.code, 0, a.out + a.err);
    const obj = JSON.parse(a.out);
    assert.equal(obj.ok, true);
    assert.equal(obj.steps[0].status, 'pass');
    const b = hades(v, ['--json', v.taskId, '--only', 'build']);
    assert.equal(b.code, 0, b.out + b.err);
    assert.equal(gates(v).runs.length, 2);
    assert.deepEqual(gates(v).runs[0], obj);
  });

  test('records head commit and dirty flag per repository', (t) => {
    if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not available');
    const v = makeVault({ projects: [{ path: '.', fixture: 'clean', commands: { build: cmd('ok') } }] });
    const hooks = path.join(v.root, 'no-hooks');
    fs.mkdirSync(hooks);
    const g = (...a) => spawnSync('git', ['-C', v.projectPath, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', ...a], { encoding: 'utf8' });
    g('init', '-q');
    g('add', '-A');
    if (g('commit', '-q', '-m', 'init').status !== 0) return t.skip('cannot create a test commit');
    const head = g('rev-parse', '--short', 'HEAD').stdout.trim();
    hades(v, [v.taskId, '--only', 'build']);
    fs.writeFileSync(path.join(v.projectPath, 'new.txt'), 'x');
    hades(v, [v.taskId, '--only', 'build']);
    const [clean, dirty] = gates(v).runs;
    assert.equal(clean.head, head);
    assert.equal(clean.dirty, false);
    assert.deepEqual(clean.repos['.'], { head, dirty: false });
    assert.equal(dirty.dirty, true);
  });

  test('usage errors exit 1; --help exits 0', () => {
    const v = makeVault();
    const help = hades(v, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage:/);
    assert.equal(hades(v, []).code, 1);
    const unknown = hades(v, [`${v.team}-999`]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /task folder not found/);
    assert.equal(hades(v, [v.taskId, '--timeout', 'soon']).code, 1);
  });
});
