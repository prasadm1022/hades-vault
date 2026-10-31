// Tests for hades doctor: every check runs against a fake probe (no real PATH tools, no network).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const doc = await import(pathToFileURL(`${ENGINE}/lib/commands/doctor.mjs`).href);
const ins = await import(pathToFileURL(`${ENGINE}/lib/commands/install.mjs`).href);

const s = (p) => p.replace(/\\/g, '/');

// tools: { name: { path, stdout, code, stderr } }; exec answers by executable path + first arg.
function fakeProbe({ tools = {}, node = '22.13.1', env = {}, sts = null, git = {} } = {}) {
  const calls = [];
  return {
    calls,
    nodeVersion: node,
    env,
    find: (cmd) => (tools[cmd] ? tools[cmd].path : null),
    exec: (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'sts') return sts || { code: 255, stdout: '', stderr: 'no credentials' };
      const t = Object.values(tools).find((x) => x.path === file);
      return t ? { code: t.code ?? 0, stdout: t.stdout ?? '', stderr: t.stderr ?? '' } : { code: 127, stdout: '', stderr: 'missing' };
    },
    git: (cwd) => git[path.basename(cwd)] || { code: 128, stdout: '', stderr: 'not a repo' },
  };
}

describe('prerequisite checks', () => {
  test('node', () => {
    assert.equal(doc.checkNode(fakeProbe()).status, 'OK');
    const old = doc.checkNode(fakeProbe({ node: '20.19.0' }));
    assert.equal(old.status, 'FAIL', 'Node 20 reached end of life');
    assert.match(doc.formatCheck(old), /^FAIL node: v20\.19\.0 is too old -> install Node\.js 22 or newer$/);
    assert.equal(doc.checkNode(fakeProbe({ node: '24.1.0' })).status, 'OK');
  });

  test('git present / missing', () => {
    const p = fakeProbe({ tools: { git: { path: '/usr/bin/git', stdout: 'git version 2.45.2.windows.1\n' } } });
    assert.equal(doc.formatCheck(doc.checkGit(p)), 'OK git: git 2.45.2');
    assert.equal(doc.checkGit(fakeProbe()).status, 'FAIL');
  });

  test('claude version gate', () => {
    const at = (v) => doc.checkClaude(fakeProbe({ tools: { claude: { path: '/bin/claude', stdout: `${v} (Claude Code)\n` } } }));
    const old = at('2.1.150');
    assert.equal(old.status, 'WARN');
    assert.match(doc.formatCheck(old), /2\.1\.150 < 2\.1\.271: newer agent frontmatter \(omitClaudeMd and others\) is ignored -> claude update/);
    assert.equal(at('2.1.271').status, 'OK');
    assert.equal(at('2.2.0').status, 'OK');
    assert.equal(at('10.0.0').status, 'OK');
    assert.equal(doc.checkClaude(fakeProbe()).status, 'FAIL');
  });

  test('uv and docker are warnings when missing', () => {
    assert.equal(doc.checkUv(fakeProbe()).status, 'WARN');
    assert.equal(doc.checkUv(fakeProbe({ tools: { uvx: { path: '/bin/uvx', stdout: 'uvx 0.13.5' } } })).detail, 'uvx 0.13.5');
    assert.equal(doc.checkDocker(fakeProbe()).status, 'WARN');
    assert.equal(doc.checkDocker(fakeProbe({ tools: { docker: { path: '/bin/docker', stdout: 'Docker version 29.6.2, build x' } } })).status, 'OK');
  });

  test('compareVersions', () => {
    assert.equal(doc.compareVersions('2.1.150', '2.1.271'), -1);
    assert.equal(doc.compareVersions('2.1.271', '2.1.271'), 0);
    assert.equal(doc.compareVersions('2.10.0', '2.9.9'), 1);
  });
});

describe('vault checks', () => {
  let tmp;
  beforeEach(() => {
    tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-doctor-')));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function ctxWith(registry) {
    fs.mkdirSync(`${tmp}/vault`, { recursive: true });
    fs.mkdirSync(`${tmp}/ws`, { recursive: true });
    return { engine: `${tmp}/engine`, vault: `${tmp}/vault`, workspace: `${tmp}/ws`, configFile: `${tmp}/engine/hades.config.json`, config: {}, registry };
  }

  test('config, vault and workspace', () => {
    const ctx = ctxWith(null);
    const r = doc.checkConfig(ctx, {});
    assert.deepEqual(r.map((c) => c.status), ['WARN', 'FAIL', 'OK']);
    assert.match(doc.formatCheck(r[1]), /^FAIL vault: no registry\.json in .* -> hades init --vault <path>$/);
    const r2 = doc.checkConfig({ ...ctxWith({ version: 3, teams: {} }), workspace: `${tmp}/nope` }, { HADES_VAULT: 'x' });
    assert.deepEqual(r2.map((c) => c.status), ['OK', 'OK', 'FAIL']);
  });

  test('registry version', () => {
    assert.equal(doc.checkRegistry(ctxWith({ version: 3 }))[0].status, 'OK');
    const v2 = doc.checkRegistry(ctxWith({ version: 2 }))[0];
    assert.equal(doc.formatCheck(v2), 'WARN registry: version 2 (HADES v1 vault) -> hades migrate');
    assert.equal(doc.checkRegistry(ctxWith({ version: 7 }))[0].status, 'FAIL');
  });

  test('registry problems from validateRegistry are a FAIL', () => {
    const good = { version: 3, organizations: { acme: { org_dir: 'organizations/acme', root_path: '/w/acme', aliases: [] } }, teams: { portal: { organization: 'acme', type: 'main', team_dir: 'organizations/acme/teams/portal', project_path: '/w/acme/portal', aliases: ['web'] } } };
    assert.deepEqual(doc.checkRegistry(ctxWith(good)).map((c) => c.status), ['OK']);
    const bad = structuredClone(good);
    bad.teams.portal.organization = 'ghost';
    bad.teams.shop = { organization: 'acme', team_dir: 'organizations/acme/teams/shop', aliases: ['web'] };
    const r = doc.checkRegistry(ctxWith(bad));
    assert.deepEqual(r.map((c) => c.status), ['OK', 'FAIL']);
    assert.match(doc.formatCheck(r[1]), /^FAIL registry: 2 problem\(s\): teams\.portal\.organization: unknown organization "ghost"; alias "web" is ambiguous: .* -> fix .*registry\.json$/);
  });

  test('stack fingerprints: engine file, learned vault file merged by id', () => {
    const ctx = ctxWith({ version: 3, teams: {} });
    assert.match(doc.formatCheck(doc.checkStacks(ctx)[0]), /^OK stacks: \d+ engine fingerprints$/);
    const learned = `${tmp}/vault/company/playbooks/stacks.json`;
    fs.mkdirSync(path.dirname(learned), { recursive: true });
    fs.writeFileSync(learned, JSON.stringify([{ id: 'zig', ecosystem: 'cpp-c', markers: ['build.zig'], commands: { build: 'zig build' } }]));
    assert.match(doc.formatCheck(doc.checkStacks(ctx)[0]), /^OK stacks: \d+ engine \+ 1 learned fingerprints$/);
    fs.writeFileSync(learned, JSON.stringify([{ id: 'zig', ecosystem: 'nope', markers: ['build.zig'] }]));
    assert.match(doc.formatCheck(doc.checkStacks(ctx)[0]), /^FAIL stacks: .*stacks\.json: 1 problem\(s\): zig: unknown ecosystem "nope"; detect ignores it/);
    fs.writeFileSync(learned, '{');
    assert.match(doc.formatCheck(doc.checkStacks(ctx)[0]), /^FAIL stacks: .*invalid JSON/);
    const engineFile = `${tmp}/stacks.json`;
    fs.writeFileSync(engineFile, JSON.stringify([{ id: 'Bad Id', ecosystem: 'go', markers: ['x'] }]));
    assert.match(doc.formatCheck(doc.checkStacks(ctxWith({ version: 3 }), engineFile)[0]), /^FAIL stacks: .*kebab-case -> restore playbooks\/stacks\.json from git$/);
  });

  test('team folders', () => {
    const ctx = ctxWith({
      version: 3,
      teams: {
        good: { team_dir: 'organizations/o/teams/good' },
        partial: { team_dir: 'organizations/o/teams/partial' },
        gone: { team_dir: 'organizations/o/teams/gone' },
        nodir: {},
      },
    });
    fs.mkdirSync(`${tmp}/vault/organizations/o/teams/good`, { recursive: true });
    fs.writeFileSync(`${tmp}/vault/organizations/o/teams/good/team.json`, '{}');
    fs.writeFileSync(`${tmp}/vault/organizations/o/teams/good/CONTEXT.md`, '# ctx');
    fs.mkdirSync(`${tmp}/vault/organizations/o/teams/partial`, { recursive: true });
    fs.writeFileSync(`${tmp}/vault/organizations/o/teams/partial/CONTEXT.md`, '# ctx');
    const lines = doc.checkTeams(ctx).map(doc.formatCheck);
    assert.ok(lines.some((l) => /^FAIL team gone: folder missing: /.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^FAIL team nodir: no team_dir/.test(l)));
    assert.ok(lines.some((l) => /^WARN teams: 1\/4 missing files: partial \(team\.json\) -> hades migrate/.test(l)));
    const allGood = doc.checkTeams({ ...ctx, registry: { version: 3, teams: { good: { team_dir: 'organizations/o/teams/good' } } } });
    assert.equal(doc.formatCheck(allGood[0]), 'OK teams: 1 team(s), each with team.json and CONTEXT.md');
  });
});

describe('tool pins', () => {
  let tmp;
  beforeEach(() => {
    tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-doctor-')));
    fs.mkdirSync(`${tmp}/engine/tools/alpha`, { recursive: true });
    fs.mkdirSync(`${tmp}/engine/tools/beta`, { recursive: true });
    fs.mkdirSync(`${tmp}/engine/tools/gamma`, { recursive: true });
    fs.writeFileSync(`${tmp}/engine/tools/alpha/.git`, 'gitdir: x');
    fs.writeFileSync(`${tmp}/engine/tools/beta/.git`, 'gitdir: x');
    fs.writeFileSync(
      `${tmp}/engine/tools/tools.lock.json`,
      JSON.stringify({ tools: { alpha: { commit: 'a'.repeat(40) }, beta: { commit: 'b'.repeat(40) }, gamma: { commit: 'c'.repeat(40) } } }),
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('git rev-parse fallback: ok, mismatch and uninitialised', () => {
    const probe = fakeProbe({ git: { alpha: { code: 0, stdout: `${'a'.repeat(40)}\n` }, beta: { code: 0, stdout: `${'d'.repeat(40)}\n` } } });
    const lines = doc.checkToolPins({ engine: `${tmp}/engine` }, probe).map(doc.formatCheck);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^FAIL tool beta: at dddddddddddd, lock pins bbbbbbbbbbbb -> /);
    assert.match(lines[1], /^WARN tool gamma: submodule not checked out -> .*submodule update --init tools\/gamma/);
  });

  test('all pinned -> one OK line', () => {
    fs.writeFileSync(`${tmp}/engine/tools/gamma/.git`, 'gitdir: x');
    const probe = fakeProbe({ git: { alpha: { code: 0, stdout: 'a'.repeat(40) }, beta: { code: 0, stdout: 'b'.repeat(40) }, gamma: { code: 0, stdout: 'c'.repeat(40) } } });
    assert.deepEqual(doc.checkToolPins({ engine: `${tmp}/engine` }, probe).map(doc.formatCheck), ['OK tools: 3/3 submodules at pinned commits']);
  });

  test('verifyTools result shape from lib/core/tools.mjs is understood', () => {
    const lines = doc
      .fromVerifyResult([
        { name: 'a', expected: 'x'.repeat(40), actual: 'x'.repeat(40), ok: true, status: 'ok' },
        { name: 'b', expected: 'y'.repeat(40), actual: 'z'.repeat(40), ok: false, status: 'mismatch' },
        { name: 'c', expected: 'w'.repeat(40), actual: null, ok: false, status: 'not initialized' },
      ])
      .map(doc.formatCheck);
    assert.match(lines[0], /^FAIL tool b: at zzzzzzzzzzzz, lock pins yyyyyyyyyyyy/);
    assert.match(lines[1], /^WARN tool c: submodule not initialized/);
    assert.equal(doc.fromVerifyResult({ unexpected: true }), null);
    assert.deepEqual(doc.fromVerifyResult([{ name: 'a', ok: true }]).map(doc.formatCheck), ['OK tools: 1/1 submodules at pinned commits']);
  });
});

describe('install checks', () => {
  let tmp;
  let ctx;
  const saved = {};
  beforeEach(() => {
    tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-doctor-')));
    fs.mkdirSync(`${tmp}/engine/hooks`, { recursive: true });
    fs.writeFileSync(`${tmp}/engine/hooks/guard.mjs`, '// guard');
    fs.writeFileSync(`${tmp}/engine/package.json`, '{"version":"1.0.0"}');
    for (const k of ['CLAUDE_CONFIG_DIR', 'HADES_INSTALL_SOURCE']) saved[k] = process.env[k];
    process.env.CLAUDE_CONFIG_DIR = `${tmp}/claude`;
    process.env.HADES_INSTALL_SOURCE = `${ENGINE}/tests/fixtures/install`;
    ctx = { engine: `${tmp}/engine`, vault: `${tmp}/vault`, workspace: tmp, configFile: '', config: {}, registry: null };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('not installed -> WARN', () => {
    assert.deepEqual(doc.checkInstall(ctx).map(doc.formatCheck), ['WARN install: agents, skills and hooks are not installed -> hades install']);
  });

  test('installed and current; hook missing -> FAIL; edited file -> WARN', () => {
    ins.install(ctx, { scope: 'user', autonomy: 'guarded', workspace: tmp, dryRun: false }, `${tmp}/claude`);
    let lines = doc.checkInstall(ctx, fakeProbe()).map(doc.formatCheck);
    assert.match(lines[0], /^OK install user: 1 agents, 1 skills in .*claude, current$/);
    assert.match(lines[1], /^OK hook user: guard registered in .*settings\.json$/);
    assert.equal(lines[2], `OK hook node user: ${s(process.execPath)} (v${process.versions.node})`);
    assert.equal(lines.length, 3, 'the fixture agent has no MCP servers: no mcp node line');
    const st = JSON.parse(fs.readFileSync(`${tmp}/claude/settings.json`, 'utf8'));
    delete st.hooks;
    fs.writeFileSync(`${tmp}/claude/settings.json`, JSON.stringify(st));
    fs.appendFileSync(`${tmp}/claude/agents/hades/hades-test-agent.md`, 'edit');
    lines = doc.checkInstall(ctx).map(doc.formatCheck);
    assert.ok(lines.some((l) => /^WARN install user: 1 installed file\(s\) changed by hand: agents\/hades\/hades-test-agent\.md/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^FAIL hook user: guard hook not registered in .* -> hades install --scope user$/.test(l)));
  });

  test('a guard matcher without Grep (older install) -> WARN', () => {
    ins.install(ctx, { scope: 'user', autonomy: 'guarded', workspace: tmp, dryRun: false }, `${tmp}/claude`);
    const file = `${tmp}/claude/settings.json`;
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(st.hooks.PreToolUse[0].matcher, /\|Grep\|mcp__serena__\.\*$/);
    st.hooks.PreToolUse[0].matcher = 'Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit';
    fs.writeFileSync(file, JSON.stringify(st));
    const lines = doc.checkInstall(ctx).map(doc.formatCheck);
    assert.ok(lines.some((l) => /^WARN hook user: guard matcher in .*settings\.json misses Grep, mcp__serena__\.\* -> hades install --scope user$/.test(l)), lines.join('\n'));
  });

  test('guard hook Node binary: absolute and Node 22+, else FAIL; "node" from PATH (older install) -> WARN', () => {
    ins.install(ctx, { scope: 'user', autonomy: 'guarded', workspace: tmp, dryRun: false }, `${tmp}/claude`);
    const file = `${tmp}/claude/settings.json`;
    const guard = `"${ctx.engine}/hooks/guard.mjs"`;
    const setNode = (cmd) => {
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      st.hooks.PreToolUse[0].hooks[0].command = `${cmd} ${guard}`;
      fs.writeFileSync(file, JSON.stringify(st));
    };
    const old = `${tmp}/old node/node.exe`;
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '');
    const probe = fakeProbe({ tools: { oldnode: { path: old, stdout: 'v20.19.0\n' } } });
    const nodeLine = () => doc.checkInstall(ctx, probe).map(doc.formatCheck).find((l) => / hook node user: /.test(l));
    setNode(`"${old}"`);
    assert.equal(nodeLine(), `FAIL hook node user: ${old} is v20.19.0 (< 22) -> install Node.js 22 or newer, then hades install --scope user`);
    setNode(`"${tmp}/gone/node.exe"`);
    assert.match(nodeLine(), /^FAIL hook node user: .*\/gone\/node\.exe not found -> hades install --scope user \(with the Node 22\+ you use now\)$/);
    setNode('node');
    assert.match(nodeLine(), /^WARN hook node user: runs "node" from PATH \(older install\); .* -> hades install --scope user \(renders the absolute Node path\)$/);
  });

  test('agents\' MCP Node binary: rendered absolute path checked; missing or old -> WARN', () => {
    const source = `${tmp}/source`;
    fs.cpSync(process.env.HADES_INSTALL_SOURCE, source, { recursive: true });
    const agent = (cmd) => `---\nname: hades-mcp-agent\ndescription: x\nmcpServers:\n  - serena:\n      command: ${cmd}\n      args: ["{{HADES_HOME}}/bin/hades.mjs", "mcp", "serena"]\n---\nbody\n`;
    fs.writeFileSync(`${source}/agents/hades-mcp-agent.md`, agent('"{{NODE}}"'));
    process.env.HADES_INSTALL_SOURCE = source;
    ins.install(ctx, { scope: 'user', autonomy: 'guarded', workspace: tmp, dryRun: false }, `${tmp}/claude`);
    let lines = doc.checkInstall(ctx, fakeProbe()).map(doc.formatCheck);
    assert.ok(lines.includes(`OK mcp node user: ${s(process.execPath)} (v${process.versions.node})`), lines.join('\n'));
    const installed = `${tmp}/claude/agents/hades/hades-mcp-agent.md`;
    fs.writeFileSync(installed, fs.readFileSync(installed, 'utf8').replace(/command: ".*"/, `command: "${tmp}/gone/node"`));
    lines = doc.checkInstall(ctx, fakeProbe()).map(doc.formatCheck);
    assert.ok(lines.some((l) => /^WARN mcp node user: .*\/gone\/node not found -> hades install --scope user/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('FAIL')), 'agents without their MCP tools are a warning');
  });

  test('missing guard.mjs -> FAIL', () => {
    fs.rmSync(`${tmp}/engine/hooks/guard.mjs`);
    assert.match(doc.formatCheck(doc.checkInstall(ctx)[0]), /^FAIL guard: .*guard\.mjs missing/);
  });
});

describe('aws checks', () => {
  const aws = { aws: { path: '/bin/aws', stdout: 'aws-cli/2.0' } };
  const ctx = (config = {}) => ({ config });

  test('aws CLI missing or no profile -> WARN, no sts call', () => {
    assert.equal(doc.checkAws(ctx(), fakeProbe())[0].status, 'WARN');
    const p = fakeProbe({ tools: aws });
    assert.match(doc.formatCheck(doc.checkAws(ctx(), p)[0]), /^WARN aws: no AWS profile configured/);
    assert.equal(p.calls.length, 0);
  });

  test('profile precedence matches the AWS MCP server settings', () => {
    assert.deepEqual(doc.awsProfiles(ctx({ aws: { profile: 'cfg' } }), {}, { AWS_PROFILE: 'env' }), { profiles: ['cfg'], source: 'hades.config.json' });
    assert.deepEqual(doc.awsProfiles(ctx({ aws: { profiles: ['a', 'b'] } }), {}, {}), { profiles: ['a', 'b'], source: 'hades.config.json' });
    assert.deepEqual(doc.awsProfiles(ctx(), {}, { AWS_PROFILE: 'dev staging' }), { profiles: ['dev', 'staging'], source: 'AWS_PROFILE' });
    assert.deepEqual(doc.awsProfiles(ctx({ aws: { profile: 'cfg' } }), { awsProfile: 'adhoc' }, {}), { profiles: ['adhoc'], source: '--aws-profile' });
    assert.equal(doc.awsProfiles(ctx(), {}, {}), null);
  });

  test('root credentials -> FAIL with masked account', () => {
    const p = fakeProbe({ tools: aws, env: { AWS_PROFILE: 'prod' }, sts: { code: 0, stdout: '{"UserId":"123456789012","Account":"123456789012","Arn":"arn:aws:iam::123456789012:root"}' } });
    const [c] = doc.checkAws(ctx(), p);
    assert.equal(c.status, 'FAIL');
    assert.ok(!doc.formatCheck(c).includes('123456789012'), 'account ID is masked');
    assert.match(doc.formatCheck(c), /ROOT credentials \(arn:aws:iam::\*{8}9012:root\)/);
    assert.deepEqual(p.calls[0], ['/bin/aws', 'sts', 'get-caller-identity', '--profile', 'prod', '--output', 'json']);
  });

  test('role credentials -> OK; expired login -> WARN', () => {
    const ok = fakeProbe({ tools: aws, env: { AWS_PROFILE: 'dev' }, sts: { code: 0, stdout: '{"Arn":"arn:aws:sts::123456789012:assumed-role/Deployer/s1"}' } });
    assert.equal(doc.formatCheck(doc.checkAws(ctx(), ok)[0]), 'OK aws: profile dev (AWS_PROFILE) -> arn:aws:sts::********9012:assumed-role/Deployer/s1');
    const bad = fakeProbe({ tools: aws, env: { AWS_PROFILE: 'dev' }, sts: { code: 255, stdout: '', stderr: '\nToken has expired\n' } });
    assert.match(doc.formatCheck(doc.checkAws(ctx(), bad)[0]), /^WARN aws: profile dev \(AWS_PROFILE\) not usable: Token has expired -> aws login --profile dev/);
  });

  test('a profile name that is not plain is refused before any call', () => {
    const p = fakeProbe({ tools: aws, env: { AWS_PROFILE: 'x;rm' } });
    assert.equal(doc.checkAws(ctx(), p)[0].status, 'FAIL');
    assert.equal(p.calls.length, 0);
  });
});

describe('runChecks', () => {
  test('summary and FAIL detection', async () => {
    const tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-doctor-')));
    try {
      fs.mkdirSync(`${tmp}/engine/tools`, { recursive: true });
      fs.writeFileSync(`${tmp}/engine/tools/tools.lock.json`, '{"tools":{}}');
      const ctx = { engine: `${tmp}/engine`, vault: `${tmp}/vault`, workspace: tmp, configFile: `${tmp}/none.json`, config: {}, registry: null };
      const results = await doc.runChecks(ctx, fakeProbe(), {});
      for (const r of results) assert.match(doc.formatCheck(r), /^(OK|WARN|FAIL) [\w -]+: /);
      assert.ok(results.some((r) => r.status === 'FAIL'));
      assert.match(doc.summaryLine(results), /^doctor: \d+ ok, \d+ warn, \d+ fail$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
