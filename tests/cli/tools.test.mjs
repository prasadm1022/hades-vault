// Tool runtime tests: no network, no Docker, no real machine config (temp engine roots).
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TOOL_NAMES,
  resolveTool,
  runTool,
  lockfile,
  canonicalName,
  tagVersion,
  parseVersion,
  envVarName,
  findExe,
  mergeEnv,
  uvxArgs,
  npxArgs,
  dockerRunArgs,
  serenaArgs,
  playwrightArgs,
  awsSettings,
  awsArgs,
  releaseAsset,
  mcpSpec,
  sha256File,
  parseChecksums,
  verifyChecksum,
  cooldownCheck,
  verifyTools,
  setupTool,
  ensureSerenaConfig,
  hardenSerenaConfig,
  serenaProjectFolder,
  trivyCacheDir,
  TRIVY_CACHE,
  DEFAULT_AWS_MCP_ENDPOINT,
} from '../../lib/core/tools.mjs';
import { prepareMcp } from '../../lib/commands/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', '..', 'bin', 'hades.mjs');
const IS_WIN = process.platform === 'win32';
const s = (p) => p.replace(/\\/g, '/');

const PINS = {
  rea: { repo: 'https://github.com/morluto/rea', tag: 'rea-agents-6.5.0', commit: 'a'.repeat(40), license: 'MIT' },
  serena: { repo: 'https://github.com/oraios/serena', tag: 'v2.0.0', commit: 'b'.repeat(40), license: 'GPL-3.0-or-later' },
  ccusage: { repo: 'https://github.com/ryoppippi/ccusage', tag: 'v20.0.34', commit: 'c'.repeat(40), license: 'MIT' },
  semgrep: { repo: 'https://github.com/semgrep/semgrep', tag: 'v1.181.0', commit: 'd'.repeat(40), license: 'LGPL-2.1' },
  gitleaks: { repo: 'https://github.com/gitleaks/gitleaks', tag: 'v8.30.1', commit: 'e'.repeat(40), license: 'MIT' },
  trivy: { repo: 'https://github.com/aquasecurity/trivy', tag: 'v0.76.0', commit: 'f'.repeat(40), license: 'Apache-2.0' },
  'playwright-mcp': { repo: 'https://github.com/microsoft/playwright-mcp', tag: 'v0.0.83', commit: '1'.repeat(40), license: 'Apache-2.0' },
  zaproxy: { repo: 'https://github.com/zaproxy/zaproxy', tag: 'v2.17.0', commit: '2'.repeat(40), license: 'Apache-2.0' },
  'aws-agent-toolkit': { repo: 'https://github.com/aws/agent-toolkit-for-aws', tag: null, commit: '3'.repeat(40), license: 'Apache-2.0' },
  'mcp-proxy-for-aws': { repo: 'https://github.com/aws/mcp-proxy-for-aws', tag: 'v1.7.0', commit: '4'.repeat(40), license: 'Apache-2.0' },
};

function writeLock(root, tools = PINS) {
  fs.mkdirSync(`${root}/tools`, { recursive: true });
  fs.writeFileSync(`${root}/tools/tools.lock.json`, JSON.stringify({ policy: { cooldown_days: 14 }, tools: tools }, null, 2));
}

function fakeScript(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return s(file);
}

// A fake executable on PATH: an empty file is enough for lookup tests (never spawned).
function fakeExe(dir, name) {
  const file = path.join(dir, IS_WIN ? `${name}.exe` : name);
  fs.writeFileSync(file, IS_WIN ? '' : '#!/bin/sh\nexit 0\n');
  if (!IS_WIN) fs.chmodSync(file, 0o755);
  return s(file);
}

// A real executable that prints a version: a link (or copy) of node, whose --version is vX.Y.Z.
function nodeAlias(dir, name) {
  const file = path.join(dir, IS_WIN ? `${name}.exe` : name);
  try {
    fs.linkSync(process.execPath, file);
  } catch {
    fs.copyFileSync(process.execPath, file);
  }
  if (!IS_WIN) fs.chmodSync(file, 0o755);
  return s(file);
}

let root;
let emptyBin;
const saved = {};
const ENV_KEYS = ['HADES_ENGINE_ROOT', 'HADES_DOCKER', 'PATH', 'AWS_PROFILE', ...Object.keys(PINS).map((n) => envVarName(n))];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-tools-')));
  emptyBin = s(path.join(root, 'emptybin'));
  fs.mkdirSync(emptyBin);
  writeLock(root);
  process.env.HADES_ENGINE_ROOT = root;
  process.env.HADES_DOCKER = '0';
  process.env.PATH = emptyBin;
  delete process.env.AWS_PROFILE;
  for (const n of Object.keys(PINS)) delete process.env[envVarName(n)];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({ engine: root, config: {} });

describe('names and versions', () => {
  test('TOOL_NAMES lists the lock file keys', () => {
    for (const n of ['gitleaks', 'semgrep', 'trivy', 'zaproxy', 'serena', 'rea', 'mcp-proxy-for-aws']) assert.ok(TOOL_NAMES.includes(n), n);
  });
  test('aliases, tag versions, env var names', () => {
    assert.equal(canonicalName('playwright'), 'playwright-mcp');
    assert.equal(canonicalName('AWS'), 'mcp-proxy-for-aws');
    assert.equal(tagVersion('v8.30.1'), '8.30.1');
    assert.equal(tagVersion('rea-agents-6.5.0'), '6.5.0');
    assert.equal(tagVersion(null), null);
    assert.equal(parseVersion('Version: 0.76.0\n'), '0.76.0');
    assert.equal(parseVersion('ccusage 20.0.34'), '20.0.34');
    assert.equal(envVarName('playwright-mcp'), 'HADES_TOOL_PLAYWRIGHT_MCP');
    assert.equal(envVarName('aws'), 'HADES_TOOL_MCP_PROXY_FOR_AWS');
  });
  test('lockfile honours HADES_ENGINE_ROOT', () => {
    assert.equal(lockfile(ctx()).tools.gitleaks.tag, 'v8.30.1');
  });
  test('mergeEnv removes undefined values', () => {
    const env = mergeEnv({ A: '1', SEMGREP_APP_TOKEN: 'x' }, { SEMGREP_APP_TOKEN: undefined, B: 2 });
    assert.deepEqual(env, { A: '1', B: '2' });
  });
});

describe('resolution order', () => {
  test('1. HADES_TOOL_* override wins and runs scripts with node', () => {
    const file = fakeScript(`${root}/fake/gitleaks.mjs`, 'console.log("x")');
    process.env.HADES_TOOL_GITLEAKS = file;
    // also give it a local install: the override must still win
    fakeScript(`${root}/.tools-bin/gitleaks/bin.mjs`, '');
    fs.writeFileSync(`${root}/.tools-bin/gitleaks/install.json`, JSON.stringify({ tag: 'v8.30.1', commit: PINS.gitleaks.commit, kind: 'node', entry: 'bin.mjs', version: '8.30.1' }));
    const r = resolveTool(ctx(), 'gitleaks');
    assert.equal(r.via, 'env');
    assert.equal(r.cmd, process.execPath);
    assert.deepEqual(r.args, [file]);
  });

  test('1. override to a missing file is an error', () => {
    process.env.HADES_TOOL_TRIVY = `${root}/nope.exe`;
    assert.throws(() => resolveTool(ctx(), 'trivy'), /missing file/);
  });

  test('2. local install from .tools-bin (node and binary kinds)', () => {
    fakeScript(`${root}/.tools-bin/rea/node_modules/rea-agents/scripts/rea.mjs`, '');
    fs.writeFileSync(`${root}/.tools-bin/rea/install.json`, JSON.stringify({ tag: PINS.rea.tag, commit: PINS.rea.commit, kind: 'node', entry: 'node_modules/rea-agents/scripts/rea.mjs', version: '6.5.0' }));
    const r = resolveTool(ctx(), 'rea');
    assert.equal(r.via, 'local');
    assert.equal(r.cmd, process.execPath);
    assert.equal(r.args[0], `${root}/.tools-bin/rea/node_modules/rea-agents/scripts/rea.mjs`);
    assert.equal(r.version, '6.5.0');
    assert.equal(r.env.REA_MCP_INPUT_SCHEMA_PROFILE, 'compact');

    fs.mkdirSync(`${root}/.tools-bin/gitleaks`, { recursive: true });
    const bin = fakeExe(`${root}/.tools-bin/gitleaks`, 'gitleaks');
    fs.writeFileSync(`${root}/.tools-bin/gitleaks/install.json`, JSON.stringify({ tag: 'v8.30.1', commit: PINS.gitleaks.commit, kind: 'binary', entry: path.basename(bin), version: '8.30.1' }));
    const g = resolveTool(ctx(), 'gitleaks');
    assert.equal(g.via, 'local');
    assert.equal(g.cmd, bin);
    assert.deepEqual(g.args, []);
  });

  test('2. stale or escaping install.json is ignored; nothing left -> setup hint', () => {
    fakeScript(`${root}/.tools-bin/gitleaks/bin.mjs`, '');
    fs.writeFileSync(`${root}/.tools-bin/gitleaks/install.json`, JSON.stringify({ tag: 'v8.0.0', commit: 'x', kind: 'node', entry: 'bin.mjs' }));
    assert.throws(() => resolveTool(ctx(), 'gitleaks'), (e) => /stale local install/.test(e.message) && /run: hades tools setup gitleaks/.test(e.message));
    fs.writeFileSync(`${root}/.tools-bin/gitleaks/install.json`, JSON.stringify({ tag: 'v8.30.1', commit: PINS.gitleaks.commit, kind: 'node', entry: '../../outside.mjs' }));
    fakeScript(`${root}/outside.mjs`, '');
    assert.throws(() => resolveTool(ctx(), 'gitleaks'), /run: hades tools setup gitleaks/);
  });

  test('2. docker install pins the digest and mounts cwd', () => {
    fs.mkdirSync(`${root}/.tools-bin/zaproxy`, { recursive: true });
    const ref = `zaproxy/zap-stable@sha256:${'9'.repeat(64)}`;
    fs.writeFileSync(`${root}/.tools-bin/zaproxy/install.json`, JSON.stringify({ tag: 'v2.17.0', commit: PINS.zaproxy.commit, kind: 'docker', image: 'zaproxy/zap-stable:2.17.0', ref, version: '2.17.0' }));
    const r = resolveTool(ctx(), 'zaproxy', { cwd: root });
    assert.equal(r.via, 'docker');
    assert.ok(r.args.includes(ref));
    assert.ok(r.args.includes(`type=bind,source=${root},target=/zap/wrk`));
  });

  test('3. PATH binary is used only at the pinned version', () => {
    const bin = s(path.join(root, 'pathbin'));
    fs.mkdirSync(bin);
    const exe = nodeAlias(bin, 'trivy'); // "trivy --version" prints node's version
    process.env.PATH = bin;
    writeLock(root, { ...PINS, trivy: { ...PINS.trivy, tag: `v${process.versions.node}` } });
    const r = resolveTool(ctx(), 'trivy');
    assert.equal(r.via, 'path');
    assert.equal(r.cmd, exe);
    writeLock(root, { ...PINS, trivy: { ...PINS.trivy, tag: 'v0.0.1' } });
    assert.throws(() => resolveTool(ctx(), 'trivy'), /run: hades tools setup trivy/);
  });

  test('4. uvx runner: pinned PyPI package or vendored source', () => {
    process.env.PATH = emptyBin;
    const uvx = fakeExe(emptyBin, 'uvx');
    const r = resolveTool(ctx(), 'semgrep');
    assert.equal(r.via, 'uvx');
    assert.equal(r.cmd, uvx);
    assert.deepEqual(r.args, ['--from', 'semgrep==1.181.0', 'semgrep']);
    assert.equal(r.env.SEMGREP_SEND_METRICS, 'off');
    assert.ok('SEMGREP_APP_TOKEN' in r.env && r.env.SEMGREP_APP_TOKEN === undefined);

    // serena needs the vendored source tree
    assert.throws(() => resolveTool(ctx(), 'serena'), /setup serena/);
    fakeScript(`${root}/tools/serena/pyproject.toml`, '');
    const sr = resolveTool(ctx(), 'serena');
    assert.deepEqual(sr.args, ['-p', '3.12', '--from', `${root}/tools/serena`, 'serena']);
    assert.equal(sr.env.SERENA_USAGE_REPORTING, 'false');
    assert.equal(sr.env.SERENA_HOME, `${root}/.hades/serena-home`);
  });

  test('4. npx runner is pinned and ignores install scripts (no shell, no .cmd on Windows)', () => {
    let expected;
    if (IS_WIN) {
      fs.writeFileSync(`${emptyBin}/npx.cmd`, '');
      const cli = fakeScript(`${emptyBin}/node_modules/npm/bin/npx-cli.js`, '');
      expected = { cmd: process.execPath, args: [cli, '-y', 'ccusage@20.0.34'] };
    } else {
      expected = { cmd: fakeExe(emptyBin, 'npx'), args: ['-y', 'ccusage@20.0.34'] };
    }
    const r = resolveTool(ctx(), 'ccusage');
    assert.equal(r.via, 'npx');
    assert.equal(r.cmd, expected.cmd);
    assert.deepEqual(r.args, expected.args);
    assert.equal(r.env.npm_config_ignore_scripts, 'true');
    assert.equal(r.env.LOG_LEVEL, '0');
  });

  test('4. docker is used only when available', () => {
    assert.throws(() => resolveTool(ctx(), 'zaproxy'), /run: hades tools setup zaproxy/);
    process.env.HADES_DOCKER = '1';
    const r = resolveTool(ctx(), 'zaproxy', { cwd: root });
    assert.equal(r.via, 'docker');
    assert.ok(r.args.includes('zaproxy/zap-stable:2.17.0'));
  });

  test('4. docker without cwd has no mounts or -w (callers such as the gate add their own)', () => {
    process.env.HADES_DOCKER = '1';
    for (const n of ['gitleaks', 'semgrep', 'trivy', 'zaproxy']) {
      const r = resolveTool(ctx(), n);
      assert.equal(r.via, 'docker', n);
      assert.equal(r.args[0], 'run', n);
      assert.ok(!r.args.includes('--mount') && !r.args.includes('-v') && !r.args.includes('-w'), n);
    }
    const t = resolveTool(ctx(), 'trivy');
    assert.ok(t.args.includes('TRIVY_CACHE_DIR=/cache'));
  });

  test('data-only tool and unknown tool', () => {
    assert.throws(() => resolveTool(ctx(), 'aws-agent-toolkit'), /not a runnable tool/);
    assert.throws(() => resolveTool(ctx(), 'nmap'), /unknown tool/);
  });

  test('runTool spawns without a shell, appends args and applies the hardening env', () => {
    const file = fakeScript(`${root}/fake/trivy.mjs`, 'console.log(JSON.stringify({ argv: process.argv.slice(2), tel: process.env.TRIVY_DISABLE_TELEMETRY, plugin: process.env.TRIVY_RUN_AS_PLUGIN ?? null }))');
    process.env.HADES_TOOL_TRIVY = file;
    const res = runTool(ctx(), 'trivy', ['fs', 'a b; echo x', '--exit-code', 3], { cwd: root, env: { TRIVY_RUN_AS_PLUGIN: 'evil' } });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.argv, ['fs', 'a b; echo x', '--exit-code', '3']);
    assert.equal(out.tel, 'true');
    assert.equal(out.plugin, 'evil'); // caller env layers last, by design
  });
});

describe('recipes (pure builders)', () => {
  test('uvx / npx arguments', () => {
    assert.deepEqual(uvxArgs('mcp-proxy-for-aws', '1.7.0', '/e'), ['-p', '3.12', '--from', '/e/tools/mcp-proxy-for-aws', 'mcp-proxy-for-aws']);
    assert.deepEqual(uvxArgs('semgrep', '1.181.0', '/e'), ['--from', 'semgrep==1.181.0', 'semgrep']);
    assert.deepEqual(npxArgs('rea', '6.5.0'), ['-y', 'rea-agents@6.5.0']);
    assert.deepEqual(npxArgs('playwright-mcp', '0.0.83'), ['-y', '@playwright/mcp@0.0.83']);
  });

  test('docker run arguments per tool', () => {
    const g = dockerRunArgs('gitleaks', { ref: 'img', cwd: root, root, uid: 1000, gid: 1000 });
    assert.deepEqual(g.slice(0, 3), ['run', '--rm', '-i']);
    assert.ok(g.join(' ').includes('--network none'));
    assert.ok(g.join(' ').includes('--user 1000:1000'));
    assert.equal(g[g.length - 1], 'img');

    const sg = dockerRunArgs('semgrep', { ref: 'semgrep/semgrep:1.181.0', cwd: root, root });
    assert.deepEqual(sg.slice(-2), ['semgrep/semgrep:1.181.0', 'semgrep']);
    assert.ok(sg.includes('SEMGREP_SEND_METRICS=off'));
    assert.ok(!sg.includes('--user'));

    const t = dockerRunArgs('trivy', { ref: 'aquasec/trivy:0.76.0', cwd: root, root });
    assert.ok(t.includes(`type=bind,source=${root}/.tools-bin/trivy-cache,target=/cache`));
    assert.ok(t.includes('TRIVY_CACHE_DIR=/cache'));
    assert.ok(t.includes('TRIVY_DISABLE_TELEMETRY=true') && t.includes('TRIVY_SKIP_VERSION_CHECK=true'));

    const z = dockerRunArgs('zaproxy', { ref: 'zaproxy/zap-stable:2.17.0', cwd: root, root });
    assert.ok(z.includes(`type=bind,source=${root},target=/zap/wrk`));
    assert.ok(z.includes('host.docker.internal:host-gateway'));
    assert.ok(z.includes('ZAP_SILENT=true'));
    assert.ok(!z.includes('-p'));
    assert.throws(() => dockerRunArgs('zaproxy', { ref: 'x', cwd: `${root}/a,b`, root }), /comma/);
  });

  test('docker run arguments with explicit mounts, workdir and container name', () => {
    const mounts = [{ host: `${root}/logs`, container: '/src' }, { host: `${root}/app`, container: '/project', ro: true }];
    const t = dockerRunArgs('trivy', { ref: 'aquasec/trivy:0.76.0', cwd: `${root}/ignored`, root, mounts, containerName: 'hades-trivy-1' });
    assert.deepEqual(t.slice(0, 5), ['run', '--rm', '-i', '--name', 'hades-trivy-1']);
    const binds = t.filter((x, i) => t[i - 1] === '--mount');
    assert.deepEqual(binds, [
      `type=bind,source=${root}/logs,target=/src`,
      `type=bind,source=${root}/app,target=/project,readonly`,
      `type=bind,source=${trivyCacheDir(ctx())},target=/cache`,
    ]);
    assert.equal(t[t.indexOf('-w') + 1], '/src');
    assert.equal(trivyCacheDir(ctx()), `${root}/${TRIVY_CACHE}`);
    const own = dockerRunArgs('trivy', { ref: 'x', root, mounts: [{ host: `${root}/c`, container: '/cache' }], workdir: '/w' });
    assert.equal(own.filter((x) => String(x).includes('target=/cache')).length, 1, 'a mount at /cache replaces the default cache');
    assert.equal(own[own.indexOf('-w') + 1], '/w');
    assert.throws(() => dockerRunArgs('gitleaks', { ref: 'x', root, mounts: [{ host: `${root}/a,b`, container: '/src' }] }), /comma/);
  });

  test('release assets match the goreleaser templates', () => {
    const g = releaseAsset('gitleaks', 'v8.30.1', 'win32', 'x64', 'https://github.com/gitleaks/gitleaks');
    assert.deepEqual(g, {
      archive: 'gitleaks_8.30.1_windows_x64.zip',
      checksums: 'gitleaks_8.30.1_checksums.txt',
      bin: 'gitleaks.exe',
      base: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/',
    });
    assert.equal(releaseAsset('gitleaks', 'v8.30.1', 'linux', 'arm64').archive, 'gitleaks_8.30.1_linux_arm64.tar.gz');
    assert.equal(releaseAsset('gitleaks', 'v8.30.1', 'darwin', 'x64').archive, 'gitleaks_8.30.1_darwin_x64.tar.gz');
    assert.equal(releaseAsset('trivy', 'v0.76.0', 'win32', 'x64').archive, 'trivy_0.76.0_windows-64bit.zip');
    assert.equal(releaseAsset('trivy', 'v0.76.0', 'linux', 'x64').archive, 'trivy_0.76.0_Linux-64bit.tar.gz');
    assert.equal(releaseAsset('trivy', 'v0.76.0', 'darwin', 'arm64').archive, 'trivy_0.76.0_macOS-ARM64.tar.gz');
    assert.equal(releaseAsset('trivy', 'v0.76.0', 'darwin', 'arm64').checksums, 'trivy_0.76.0_checksums.txt');
    assert.equal(releaseAsset('trivy', 'v0.76.0', 'win32', 'arm64'), null);
    assert.equal(releaseAsset('semgrep', 'v1.181.0'), null);
  });

  test('serena and playwright MCP arguments are hardened', () => {
    const a = serenaArgs('/p');
    assert.equal(a[0], 'start-mcp-server');
    const flag = (k) => a[a.indexOf(k) + 1];
    assert.equal(flag('--context'), 'claude-code');
    assert.equal(flag('--project'), '/p');
    assert.equal(flag('--agent-interface'), 'tools');
    assert.equal(flag('--enable-web-dashboard'), 'False');
    assert.equal(flag('--enable-gui-log-window'), 'False');
    assert.equal(flag('--open-web-dashboard'), 'False');
    assert.equal(flag('--mode'), 'no-memories');
    assert.ok(!a.includes('--project-from-cwd'));

    const p = playwrightArgs('/out');
    for (const f of ['--headless', '--isolated', '--no-webmcp']) assert.ok(p.includes(f), f);
    assert.equal(p[p.indexOf('--output-dir') + 1], '/out');
    assert.equal(p[p.indexOf('--browser') + 1], 'chromium');
    for (const f of ['--extension', '--no-sandbox', '--allow-unrestricted-file-access', '--cdp-endpoint']) assert.ok(!p.includes(f), f);
  });

  test('aws settings: config, env fallback, missing profile, region as metadata', () => {
    assert.throws(() => awsSettings({ config: {} }, {}), /no AWS profile configured/);
    const fromEnv = awsSettings({ config: {} }, { AWS_PROFILE: 'dev' });
    assert.deepEqual(fromEnv.profiles, ['dev']);
    const s1 = awsSettings({ config: { aws: { profile: 'deploy', region: 'eu-west-1' } } }, { AWS_PROFILE: 'other' });
    assert.deepEqual(s1, { profiles: ['deploy'], region: 'eu-west-1', endpoint: DEFAULT_AWS_MCP_ENDPOINT, readOnly: false });
    assert.deepEqual(awsArgs(s1), [DEFAULT_AWS_MCP_ENDPOINT, '--profile', 'deploy', '--metadata', 'AWS_REGION=eu-west-1', '--disable-telemetry', '--log-level', 'ERROR']);
    assert.ok(!awsArgs(s1).includes('--region'));
    const s2 = awsSettings({ config: { aws: { profile: ['a', 'b'], read_only: true } } }, {});
    assert.deepEqual(awsArgs(s2), [DEFAULT_AWS_MCP_ENDPOINT, '--profile', 'a', 'b', '--read-only', '--disable-telemetry', '--log-level', 'ERROR']);
    assert.throws(() => awsSettings({ config: { aws: { profile: 'x; rm' } } }, {}), /invalid AWS profile/);
    assert.throws(() => awsSettings({ config: { aws: { profile: 'x', endpoint: 'http://evil' } } }, {}), /https/);
    assert.throws(() => awsSettings({ config: { aws: { profile: 'x', region: 'mars' } } }, {}), /invalid AWS region/);
  });
});

describe('MCP launch specs', () => {
  test('serena, rea, playwright and aws', () => {
    for (const [n, v] of [['SERENA', 'serena'], ['REA', 'rea'], ['PLAYWRIGHT_MCP', 'pw'], ['MCP_PROXY_FOR_AWS', 'aws']]) {
      process.env[`HADES_TOOL_${n}`] = fakeScript(`${root}/fake/${v}.mjs`, '');
    }
    const project = s(fs.mkdtempSync(path.join(root, 'proj-')));
    const c = { engine: root, config: { aws: { profile: 'deploy', region: 'us-west-2' } } };

    const se = mcpSpec(c, 'serena', { project });
    assert.equal(se.cmd, process.execPath);
    assert.equal(se.args[1], 'start-mcp-server');
    assert.equal(se.args[se.args.indexOf('--project') + 1], project);
    assert.equal(se.cwd, project);
    assert.equal(se.env.SERENA_USAGE_REPORTING, 'false');

    const re = mcpSpec(c, 'rea', { project, env: { GHIDRA_INSTALL_DIR: '/g', JAVA_HOME: '/j', SECRET: 'x' } });
    assert.deepEqual(re.args.slice(1), ['mcp']);
    assert.equal(re.env.REA_MCP_INPUT_SCHEMA_PROFILE, 'compact');
    assert.equal(re.env.REA_LOG_LEVEL, 'warn');
    assert.equal(re.env.GHIDRA_INSTALL_DIR, '/g');
    assert.equal(re.env.JAVA_HOME, '/j');
    assert.equal(re.env.SECRET, undefined);

    const pw = mcpSpec(c, 'playwright', { project });
    const out = pw.args[pw.args.indexOf('--output-dir') + 1];
    assert.ok(out.startsWith(`${root}/.hades/playwright/`), out);

    const aw = mcpSpec(c, 'aws', { project, env: {} });
    assert.deepEqual(aw.args.slice(1, 4), [DEFAULT_AWS_MCP_ENDPOINT, '--profile', 'deploy']);
    assert.equal(aw.env.AWS_MCP_PROXY_PROFILES, 'deploy');
    assert.throws(() => mcpSpec({ engine: root, config: {} }, 'aws', { project, env: {} }), /no AWS profile/);
    assert.throws(() => mcpSpec(c, 'nope', { project }), /unknown MCP server/);
    assert.throws(() => mcpSpec(c, 'rea', { project: `${root}/missing` }), /project directory not found/);
  });

  test('serena config is seeded once with hardened settings', () => {
    const file = ensureSerenaConfig(ctx());
    const text = fs.readFileSync(file, 'utf8');
    for (const line of ['agent_interface: tools', 'web_dashboard: false', 'gui_log_window: false', 'trusted_project_path_patterns: []', 'projects: []', '  - execute_shell_command', '  - editing']) {
      assert.ok(text.includes(line), line);
    }
    assert.ok(text.includes(`project_serena_folder_location: "${root}/.hades/serena/$projectFolderName"`), text);
    assert.equal(file, `${root}/.hades/serena-home/serena_config.yml`);
    ensureSerenaConfig(ctx());
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'a seeded config is left as it is');
    // Serena's own projects list is kept; weakened or missing hardened keys are restored.
    fs.writeFileSync(file, 'agent_interface: REPL\nweb_dashboard: True\ntrusted_project_path_patterns:\n- "**"\n  - "/x/**"\nprojects:\n- /p\n');
    ensureSerenaConfig(ctx());
    const fixed = fs.readFileSync(file, 'utf8');
    assert.ok(fixed.startsWith('agent_interface: tools\nweb_dashboard: false\ntrusted_project_path_patterns: []\nprojects:\n- /p\n'), fixed);
    assert.ok(fixed.includes('gui_log_window: false\n') && fixed.includes('project_serena_folder_location: "'), fixed);
    assert.ok(!fixed.includes('**'));
    assert.equal(hardenSerenaConfig('a: 1\r\nweb_dashboard: true\r\n', { web_dashboard: 'false' }), 'a: 1\r\nweb_dashboard: false\r\n');
  });

  test('hades mcp serena prepares a project folder outside the project', () => {
    process.env.HADES_TOOL_SERENA = fakeScript(`${root}/fake/serena.mjs`, '');
    process.env.HADES_TOOL_PLAYWRIGHT_MCP = fakeScript(`${root}/fake/pw.mjs`, '');
    const project = s(fs.mkdtempSync(path.join(root, 'proj-')));
    const spec = mcpSpec(ctx(), 'serena', { project });
    prepareMcp(ctx(), 'Serena', spec);
    assert.equal(serenaProjectFolder(ctx(), project), `${root}/.hades/serena/${path.basename(project)}`);
    assert.ok(fs.statSync(serenaProjectFolder(ctx(), project)).isDirectory());
    assert.ok(!fs.existsSync(`${project}/.serena`));
    assert.ok(fs.existsSync(`${root}/.hades/serena-home/serena_config.yml`));
    assert.equal(spec.env.SERENA_HOME, `${root}/.hades/serena-home`);
    for (const [k, v] of [['--context', 'claude-code'], ['--mode', 'no-memories'], ['--enable-web-dashboard', 'False'], ['--enable-gui-log-window', 'False']]) {
      assert.equal(spec.args[spec.args.indexOf(k) + 1], v, k);
    }
    const pw = mcpSpec(ctx(), 'playwright', { project: root, env: {} });
    for (const f of ['--headless', '--isolated']) assert.ok(pw.args.includes(f), f);
    for (const [k, v] of [['--browser', 'chromium'], ['--caps', 'testing'], ['--image-responses', 'omit']]) assert.equal(pw.args[pw.args.indexOf(k) + 1], v, k);
  });

  test('hades mcp execs the server with stdio inherited and its exit code; stdout untouched', () => {
    const fake = fakeScript(`${root}/fake/rea-mcp.mjs`, 'process.stderr.write("args:" + process.argv.slice(2).join(",") + ";profile:" + process.env.REA_MCP_INPUT_SCHEMA_PROFILE); process.exit(7);');
    const res = spawnSync(process.execPath, [CLI, 'mcp', 'rea', '--project', root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: saved.PATH, HADES_ENGINE_ROOT: root, HADES_VAULT: `${root}/novault`, HADES_TOOL_REA: fake },
    });
    assert.equal(res.status, 7, res.stderr);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, 'args:mcp;profile:compact');
  });
});

describe('integrity', () => {
  test('sha256 and checksum files', () => {
    const file = `${root}/asset.zip`;
    fs.writeFileSync(file, 'hello hades\n');
    const sum = crypto.createHash('sha256').update('hello hades\n').digest('hex');
    assert.equal(sha256File(file), sum);
    const map = parseChecksums(`${sum}  asset.zip\n${'0'.repeat(64)} *other.tar.gz\r\nnot a line\n`);
    assert.equal(map.get('asset.zip'), sum);
    assert.equal(map.get('other.tar.gz'), '0'.repeat(64));
    assert.equal(map.size, 2);
    assert.equal(verifyChecksum(file, sum), true);
    assert.equal(verifyChecksum(file, sum.toUpperCase()), true);
    assert.equal(verifyChecksum(file, '0'.repeat(64)), false);
    assert.equal(verifyChecksum(file, undefined), false);
  });

  test('cooldown policy', () => {
    const now = new Date('2026-10-31T00:00:00Z');
    assert.deepEqual(cooldownCheck('2026-10-14T10:00:00Z', 14, now), { ok: true, days: 16 });
    assert.deepEqual(cooldownCheck('2026-10-25', 14, now), { ok: false, days: 6 });
    assert.equal(cooldownCheck('garbage', 14, now).ok, false);
  });

  test('setup of a data-only tool is a no-op and an up-to-date install is skipped', async () => {
    const d = await setupTool(ctx(), 'aws-agent-toolkit');
    assert.equal(d.ok, true);
    assert.equal(d.via, 'data');
    fakeScript(`${root}/.tools-bin/rea/x.mjs`, '');
    fs.writeFileSync(`${root}/.tools-bin/rea/install.json`, JSON.stringify({ tag: PINS.rea.tag, commit: PINS.rea.commit, kind: 'node', entry: 'x.mjs', version: '6.5.0' }));
    const r = await setupTool(ctx(), 'rea');
    assert.equal(r.skipped, true);
    assert.equal(r.via, 'local');
  });
});

describe('verify', () => {
  let gitOk = true;
  before(() => {
    gitOk = spawnSync('git', ['--version']).status === 0;
  });

  function gitRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const g = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    g('init', '-q');
    g('commit', '-q', '--allow-empty', '-m', 'pin');
    return g('rev-parse', 'HEAD').stdout.trim();
  }

  test('submodule HEADs against the lock (in process and through the CLI)', (t) => {
    if (!gitOk) return t.skip('git not available');
    process.env.PATH = saved.PATH; // git must be reachable for this test
    const head = gitRepo(`${root}/tools/gitleaks`);
    writeLock(root, { gitleaks: { ...PINS.gitleaks, commit: head } });
    let rows = verifyTools(ctx());
    assert.deepEqual(rows.map((r) => [r.name, r.ok, r.status]), [['gitleaks', true, 'ok']]);

    writeLock(root, { gitleaks: { ...PINS.gitleaks, commit: head }, trivy: PINS.trivy });
    rows = verifyTools(ctx());
    assert.equal(rows.find((r) => r.name === 'trivy').status, 'not initialized');

    writeLock(root, { gitleaks: { ...PINS.gitleaks, commit: 'f'.repeat(40) } });
    rows = verifyTools(ctx());
    assert.equal(rows[0].status, 'mismatch');
    assert.equal(rows[0].actual, head);

    const env = { ...process.env, PATH: saved.PATH, HADES_ENGINE_ROOT: root, HADES_VAULT: `${root}/novault` };
    const red = spawnSync(process.execPath, [CLI, 'tools', 'verify'], { encoding: 'utf8', env });
    assert.equal(red.status, 2, red.stderr);
    assert.match(red.stdout, /MISMATCH gitleaks: lock ffffffffffff, HEAD /);
    assert.match(red.stdout, /0\/1 tool pins match/);

    writeLock(root, { gitleaks: { ...PINS.gitleaks, commit: head } });
    const green = spawnSync(process.execPath, [CLI, 'tools', 'verify', '--json'], { encoding: 'utf8', env });
    assert.equal(green.status, 0, green.stderr);
    assert.equal(JSON.parse(green.stdout)[0].ok, true);
  });
});

describe('CLI', () => {
  test('tools list and tools run', () => {
    const fake = fakeScript(`${root}/fake/gl.mjs`, 'console.log("gitleaks " + process.argv.slice(2).join(" ")); process.exit(3);');
    const env = { ...process.env, PATH: emptyBin, HADES_ENGINE_ROOT: root, HADES_VAULT: `${root}/novault`, HADES_DOCKER: '0', HADES_TOOL_GITLEAKS: fake };
    const list = spawnSync(process.execPath, [CLI, 'tools', 'list', '--json'], { encoding: 'utf8', env });
    assert.equal(list.status, 0, list.stderr);
    const rows = JSON.parse(list.stdout);
    assert.equal(rows.find((r) => r.name === 'gitleaks').via, 'env');
    assert.equal(rows.find((r) => r.name === 'zaproxy').via, 'not set up');
    assert.equal(rows.find((r) => r.name === 'aws-agent-toolkit').via, 'data');

    const runRes = spawnSync(process.execPath, [CLI, 'tools', 'run', 'gitleaks', '--', 'dir', '.', '--redact'], { encoding: 'utf8', env });
    assert.equal(runRes.status, 3, runRes.stderr);
    assert.equal(runRes.stdout.trim(), 'gitleaks dir . --redact');
  });
});

after(() => {
  // nothing global to clean: every test uses its own temp root
});

// install-autonomy F2: Claude Code starts "hades mcp serena" in the session folder (normally the
// whole workspace). Serena must not be pinned to it: without --project it starts with no project,
// so activate_project stays available and the agent activates the project it works on.
describe('serena startup project', () => {
  test('no --project: no startup project (activate_project available); --project pins one', () => {
    process.env.HADES_TOOL_SERENA = fakeScript(`${root}/fake/serena.mjs`, '');
    const workspace = s(fs.mkdtempSync(path.join(root, 'workspace-')));
    const cwd = process.cwd();
    process.chdir(workspace);
    let free;
    try {
      free = mcpSpec(ctx(), 'serena', {});
    } finally {
      process.chdir(cwd);
    }
    assert.ok(!free.args.includes('--project'), free.args.join(' '));
    assert.ok(!free.args.includes('--project-from-cwd'));
    assert.equal(free.project, null);
    assert.equal(free.cwd, workspace);
    assert.equal(free.args[free.args.indexOf('--context') + 1], 'claude-code');
    assert.ok(!serenaArgs().includes('--project') && !serenaArgs(null).includes('--project'));
    const project = s(fs.mkdtempSync(path.join(root, 'proj-')));
    const pinned = mcpSpec(ctx(), 'serena', { project });
    assert.equal(pinned.args[pinned.args.indexOf('--project') + 1], project);
    assert.equal(pinned.project, project);
  });

  test('without --project the data folders of the vault\'s team projects are prepared (never <project>/.serena)', () => {
    process.env.HADES_TOOL_SERENA = fakeScript(`${root}/fake/serena.mjs`, '');
    const a = s(fs.mkdtempSync(path.join(root, 'alpha-')));
    const b = s(fs.mkdtempSync(path.join(root, 'beta-')));
    const c = { ...ctx(), registry: { teams: { alpha: { project_path: a }, beta: { project_path: b }, gone: { project_path: `${root}/missing` } } } };
    const spec = mcpSpec(c, 'serena', {});
    prepareMcp(c, 'serena', spec);
    for (const p of [a, b]) {
      assert.ok(fs.statSync(serenaProjectFolder(c, p)).isDirectory(), p);
      assert.ok(!fs.existsSync(`${p}/.serena`));
    }
    assert.ok(!fs.existsSync(serenaProjectFolder(c, process.cwd())), 'no folder for the session directory');
    assert.ok(!fs.existsSync(serenaProjectFolder(c, `${root}/missing`)));
  });
});
