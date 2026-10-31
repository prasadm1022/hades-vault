// Tests for hades install: rendering, markers, settings merge, idempotency, conflicts, uninstall.
// Everything happens in temp dirs: a fake engine, a temp CLAUDE_CONFIG_DIR and a temp workspace.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const FIXTURE = `${ENGINE}/tests/fixtures/install`;
const INSTALL = `${ENGINE}/lib/commands/install.mjs`;
const SETTINGS = `${ENGINE}/lib/core/settings.mjs`;

const ins = await import(pathToFileURL(INSTALL).href);
const set = await import(pathToFileURL(SETTINGS).href);

const s = (p) => p.replace(/\\/g, '/');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

let tmp;
let ctx;
let claudeDir;
const savedEnv = {};

function setEnv(k, v) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-install-')));
  const engine = `${tmp}/engine`;
  fs.mkdirSync(`${engine}/hooks`, { recursive: true });
  fs.writeFileSync(`${engine}/package.json`, JSON.stringify({ name: 'hades-company', version: '9.9.9' }));
  fs.writeFileSync(`${engine}/hooks/guard.mjs`, '// fake guard\n');
  fs.cpSync(FIXTURE, `${tmp}/source`, { recursive: true });
  // a binary support file must be copied byte for byte, never rendered
  fs.writeFileSync(`${tmp}/source/skills/hades-fixture/blob.bin`, Buffer.from([0, 1, 2, 123, 123, 0, 255]));
  fs.mkdirSync(`${tmp}/vault`);
  fs.mkdirSync(`${tmp}/ws`);
  claudeDir = `${tmp}/claude`;
  setEnv('CLAUDE_CONFIG_DIR', claudeDir);
  setEnv('HADES_INSTALL_SOURCE', `${tmp}/source`);
  ctx = { engine, vault: `${tmp}/vault`, workspace: `${tmp}/ws`, configFile: `${engine}/hades.config.json`, config: {}, registry: null };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const opts = (o = {}) => ({ scope: 'user', autonomy: 'guarded', workspace: ctx.workspace, dryRun: false, uninstall: false, ...o });

function userSettings() {
  return {
    model: 'opus',
    env: { FOO: 'bar' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    permissions: { allow: ['Bash(ls *)'], deny: ['Bash(curl *)'], defaultMode: 'acceptEdits' },
  };
}

function seedSettings(data = userSettings()) {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(`${claudeDir}/settings.json`, JSON.stringify(data, null, 2));
  return data;
}

function backups() {
  return fs.existsSync(claudeDir) ? fs.readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.hades-backup-')) : [];
}

describe('install', () => {
  test('renders placeholders, adds the marker and copies skill folders', () => {
    const res = ins.install(ctx, opts(), set.claudeHome());
    const agent = fs.readFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, 'utf8');
    assert.match(agent, new RegExp(`node ${ctx.engine}/bin/hades\\.mjs`));
    assert.match(agent, new RegExp(`Vault: ${ctx.vault}`));
    assert.match(agent, /\{\{NOT_A_VAR\}\}/, 'unknown placeholders stay');
    assert.match(agent, /^---\nname: hades-test-agent\n[\s\S]*hades-generated: true\nhades-version: 9\.9\.9\n---\n/);
    assert.ok(ins.hasMarker(agent));
    const skill = fs.readFileSync(`${claudeDir}/skills/hades-fixture/SKILL.md`, 'utf8');
    assert.ok(ins.hasMarker(skill));
    assert.ok(!skill.includes('{{HADES_HOME}}'));
    const notes = fs.readFileSync(`${claudeDir}/skills/hades-fixture/references/notes.md`, 'utf8');
    assert.ok(notes.includes(`${ctx.engine}/playbooks/deployment.md`));
    assert.deepEqual([...fs.readFileSync(`${claudeDir}/skills/hades-fixture/blob.bin`)], [0, 1, 2, 123, 123, 0, 255]);
    assert.ok(!fs.existsSync(`${claudeDir}/agents/hades/helper.md`), 'agents without hades- prefix are skipped');
    assert.ok(!fs.existsSync(`${claudeDir}/agents/hades/README.md`));
    assert.ok(!fs.existsSync(`${claudeDir}/skills/not-a-skill`), 'folders without SKILL.md are skipped');
    assert.ok(res.lines.some((l) => /WARN agents\/helper\.md skipped/.test(l)));
    assert.equal(res.conflicts.length, 0);
    const manifest = readJson(`${ctx.engine}/.hades/install.json`);
    assert.equal(manifest.installs.length, 1);
    const rec = manifest.installs[0];
    assert.equal(rec.scope, 'user');
    assert.equal(rec.files.length, 4);
    for (const f of rec.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  });

  test('placeholders render with forward slashes; playbooks/ is never installed', () => {
    fs.mkdirSync(`${tmp}/source/playbooks/tech`, { recursive: true });
    fs.writeFileSync(`${tmp}/source/playbooks/deployment.md`, '# Deployment\n<engine> = the directory of the hades CLI in your handover\n');
    fs.writeFileSync(`${tmp}/source/playbooks/tech/go.md`, '# Go\n');
    const back = (p) => p.replace(/\//g, '\\');
    const winCtx = { ...ctx, engine: back(ctx.engine), vault: back(ctx.vault), workspace: back(ctx.workspace) };
    assert.deepEqual(ins.renderVars(winCtx), { HADES_HOME: ctx.engine, HADES_VAULT: ctx.vault, HADES_WORKSPACE: ctx.workspace, NODE: s(process.execPath) });
    assert.equal(ins.renderVars(winCtx, 'C:\\Program Files\\nodejs\\node.exe').NODE, 'C:/Program Files/nodejs/node.exe');
    const plan = ins.buildPlan(winCtx, claudeDir);
    assert.ok(plan.files.every((f) => /^(agents\/hades|skills)\//.test(f.rel)), plan.files.map((f) => f.rel).join(', '));
    const agent = plan.files.find((f) => f.kind === 'agent').content.toString('utf8');
    assert.ok(agent.includes(`Vault: ${ctx.vault}`), agent);
    assert.ok(!agent.includes('\\'), 'no backslashes in rendered paths');
    ins.install(ctx, opts(), set.claudeHome());
    assert.ok(!fs.existsSync(`${claudeDir}/playbooks`));
  });

  test('MCP servers run with the absolute Node binary that ran the install ({{NODE}})', () => {
    const mcp = '---\nname: hades-mcp-agent\ndescription: x\nmcpServers:\n  - serena:\n      command: "{{NODE}}"\n      args: ["{{HADES_HOME}}/bin/hades.mjs", "mcp", "serena"]\n---\nbody\n';
    fs.writeFileSync(`${tmp}/source/agents/hades-mcp-agent.md`, mcp);
    ins.install(ctx, opts(), set.claudeHome());
    const text = fs.readFileSync(`${claudeDir}/agents/hades/hades-mcp-agent.md`, 'utf8');
    assert.ok(text.includes(`      command: "${s(process.execPath)}"\n`), text);
    assert.ok(text.includes(`      args: ["${ctx.engine}/bin/hades.mjs", "mcp", "serena"]\n`), 'quoted args stay as they are');
    assert.deepEqual(ins.agentNodeCommands(text), [s(process.execPath)]);
    assert.deepEqual(ins.agentNodeCommands('---\nmcpServers:\n  - a:\n      command: node\n  - b:\n      command: \'/opt/n/node\'\n---\n'), ['node', '/opt/n/node']);
    assert.deepEqual(ins.agentNodeCommands('no frontmatter\n      command: x\n'), []);
    // doctor compares against a render with the recorded Node, not with the Node running doctor
    const rec = readJson(`${ctx.engine}/.hades/install.json`).installs[0];
    assert.equal(rec.node, s(process.execPath));
    assert.deepEqual(ins.inspectInstall(ctx, rec).outdated, []);
    assert.deepEqual(ins.inspectInstall(ctx, { ...rec, node: '/opt/other/node' }).outdated, ['agents/hades/hades-mcp-agent.md']);
  });

  test('merges settings, keeps unrelated keys and user hooks, backs up first', () => {
    const before = seedSettings();
    const res = ins.install(ctx, opts(), set.claudeHome());
    const after = readJson(`${claudeDir}/settings.json`);
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.env, before.env);
    assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
    assert.deepEqual(after.hooks.PreToolUse[0], before.hooks.PreToolUse[0], 'user hook kept first');
    assert.equal(after.hooks.PreToolUse.length, 2);
    assert.deepEqual(after.hooks.PreToolUse[1], {
      matcher: 'Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*',
      hooks: [{ type: 'command', command: `"${s(process.execPath)}" "${ctx.engine}/hooks/guard.mjs"`, timeout: 10, onFailure: 'block' }],
    });
    assert.ok(after.permissions.deny.includes('Bash(curl *)'));
    for (const r of set.DENY_RULES) assert.ok(after.permissions.deny.includes(r), r);
    assert.ok(!after.permissions.deny.includes('Read(**/.env.*)'), '.env.example must stay readable');
    assert.ok(after.permissions.allow.includes('Bash(ls *)'));
    for (const sub of ['task *', 'defect *', 'gate *', 'team resolve *', 'team set *', 'team list*', 'detect *', 'status*', 'usage *', 'doctor*']) {
      assert.ok(after.permissions.allow.includes(`Bash(node ${ctx.engine}/bin/hades.mjs ${sub})`), sub);
    }
    for (const g of ['add *', 'commit *', 'status*', 'diff*', 'log*', 'rev-parse *']) {
      assert.ok(after.permissions.allow.includes(`Bash(git -C * ${g})`), g);
      assert.ok(after.permissions.allow.includes(`Bash(git ${g})`), g);
    }
    // no blanket CLI rule: run (a bypassPermissions session), install, migrate and tools must prompt
    assert.ok(!after.permissions.allow.some((r) => /hades\.mjs (\*|run|install|migrate|tools|mcp)/.test(r)), after.permissions.allow.join('\n'));
    assert.equal(after.permissions.defaultMode, 'acceptEdits', 'guarded leaves defaultMode alone');
    assert.equal(backups().length, 1);
    assert.deepEqual(readJson(`${claudeDir}/${backups()[0]}`), before);
    assert.ok(res.lines.some((l) => /^settings: .*\+hook PreToolUse, \+12 deny, \+22 allow \(backup settings\.json\.hades-backup-/.test(l)), res.lines.join('\n'));
  });

  test('is idempotent: a second run changes nothing and makes no backup', () => {
    seedSettings();
    ins.install(ctx, opts(), set.claudeHome());
    const first = fs.readFileSync(`${claudeDir}/settings.json`, 'utf8');
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(fs.readFileSync(`${claudeDir}/settings.json`, 'utf8'), first);
    assert.equal(backups().length, 1);
    assert.ok(res.actions.every((a) => a.action === 'unchanged'));
    assert.ok(res.lines.some((l) => /settings: .*: no changes$/.test(l)));
    // ownership is remembered across runs, so uninstall still removes the entries
    const rec = readJson(`${ctx.engine}/.hades/install.json`).installs[0];
    assert.equal(rec.settings_added.hooks.length, 1);
    assert.equal(rec.settings_added.deny.length, 12);
  });

  test('upgrading an install whose guard matcher lacks Grep replaces the hook entry', () => {
    ins.install(ctx, opts(), set.claudeHome());
    const old = 'Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit';
    const manifestFile = `${ctx.engine}/.hades/install.json`;
    const manifest = readJson(manifestFile);
    manifest.installs[0].settings_added.hooks[0].entry.matcher = old;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const st = readJson(`${claudeDir}/settings.json`);
    st.hooks.PreToolUse[0].matcher = old;
    fs.writeFileSync(`${claudeDir}/settings.json`, JSON.stringify(st));
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.ok(res.lines.some((l) => /settings: .*-hook PreToolUse, \+hook PreToolUse/.test(l)), res.lines.join('\n'));
    const after = readJson(`${claudeDir}/settings.json`).hooks.PreToolUse;
    assert.equal(after.length, 1);
    assert.equal(after[0].matcher, set.GUARD_MATCHER);
    assert.deepEqual(set.guardMatcherGaps(readJson(`${claudeDir}/settings.json`), ctx.engine), []);
  });

  test('never overwrites an unmarked file with the same name', () => {
    fs.mkdirSync(`${claudeDir}/agents/hades`, { recursive: true });
    fs.writeFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, '---\nname: hades-test-agent\n---\nmine\n');
    fs.mkdirSync(`${claudeDir}/skills/hades-fixture`, { recursive: true });
    fs.writeFileSync(`${claudeDir}/skills/hades-fixture/SKILL.md`, '---\nname: hades-fixture\n---\nmine\n');
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(res.conflicts.length, 2);
    assert.equal(fs.readFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, 'utf8'), '---\nname: hades-test-agent\n---\nmine\n');
    assert.ok(!fs.existsSync(`${claudeDir}/skills/hades-fixture/references/notes.md`), 'whole skill skipped');
    assert.ok(res.lines.some((l) => /^CONFLICT agents\/hades\/hades-test-agent\.md exists without the hades-generated marker/.test(l)));
    const rec = readJson(`${ctx.engine}/.hades/install.json`).installs[0];
    assert.equal(rec.files.length, 0, 'conflicting files are not recorded as ours');
  });

  test('a marked file is updated in place when the source changes', () => {
    ins.install(ctx, opts(), set.claudeHome());
    fs.appendFileSync(`${tmp}/source/agents/hades-test-agent.md`, 'new line\n');
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(res.actions.find((a) => a.kind === 'agent').action, 'update');
    assert.match(fs.readFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, 'utf8'), /new line/);
  });

  test('removes files a previous install wrote that the engine no longer ships', () => {
    ins.install(ctx, opts(), set.claudeHome());
    fs.rmSync(`${tmp}/source/skills/hades-fixture/references`, { recursive: true });
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(res.removals.length, 1);
    assert.ok(!fs.existsSync(`${claudeDir}/skills/hades-fixture/references`), 'empty folder cleaned up');
  });

  test('warns about an unmarked agent with the same name elsewhere', () => {
    fs.mkdirSync(`${claudeDir}/agents/old`, { recursive: true });
    fs.writeFileSync(`${claudeDir}/agents/old/x.md`, '---\nname: hades-test-agent\n---\nold\n');
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.ok(res.lines.some((l) => /WARN agent name "hades-test-agent" is also defined in .*agents\/old\/x\.md/.test(l)));
  });

  test('warns when unmarked project-level copies in the workspace override the user install', () => {
    fs.mkdirSync(`${ctx.workspace}/.claude/skills/hades-fixture`, { recursive: true });
    fs.writeFileSync(`${ctx.workspace}/.claude/skills/hades-fixture/SKILL.md`, '---\nname: hades-fixture\n---\nold v1 copy\n');
    fs.mkdirSync(`${ctx.workspace}/.claude/agents`, { recursive: true });
    fs.writeFileSync(`${ctx.workspace}/.claude/agents/a.md`, '---\nname: hades-test-agent\n---\nold\n');
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.ok(res.lines.some((l) => /^WARN skill "hades-fixture" in .*\/ws\/\.claude\/skills\/hades-fixture\/SKILL\.md overrides this install/.test(l)), res.lines.join('\n'));
    assert.ok(res.lines.some((l) => /^WARN agent "hades-test-agent" in .*\/ws\/\.claude\/agents\/a\.md overrides this install/.test(l)));
    assert.equal(fs.readFileSync(`${ctx.workspace}/.claude/skills/hades-fixture/SKILL.md`, 'utf8'), '---\nname: hades-fixture\n---\nold v1 copy\n', 'never touched');
    const rec = ins.loadManifest(ctx).installs[0];
    assert.equal(ins.shadowedBy(rec.files, ctx.workspace).length, 2);
  });

  test('--dry-run writes nothing', () => {
    const before = seedSettings();
    const res = ins.install(ctx, opts({ dryRun: true }), set.claudeHome());
    assert.ok(res.lines[0].startsWith('DRY RUN hades install (user scope)'));
    assert.ok(res.lines.some((l) => l === '  write agents/hades/hades-test-agent.md'));
    assert.deepEqual(readJson(`${claudeDir}/settings.json`), before);
    assert.ok(!fs.existsSync(`${claudeDir}/agents`));
    assert.ok(!fs.existsSync(`${ctx.engine}/.hades/install.json`));
    assert.equal(backups().length, 0);
  });

  test('guard hook is skipped with a warning when hooks/guard.mjs is missing', () => {
    fs.rmSync(`${ctx.engine}/hooks/guard.mjs`);
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.ok(res.lines.some((l) => /WARN .*guard\.mjs missing: guard hook not registered/.test(l)));
    assert.equal(readJson(`${claudeDir}/settings.json`).hooks, undefined);
  });
});

describe('autonomy', () => {
  test('full (user scope) sets bypassPermissions and the prompt flag, with a warning', () => {
    seedSettings();
    const res = ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    const after = readJson(`${claudeDir}/settings.json`);
    assert.equal(after.permissions.defaultMode, 'bypassPermissions');
    assert.equal(after.skipDangerousModePermissionPrompt, true);
    assert.ok(res.lines.some((l) => l.startsWith('WARN autonomy full')));
  });

  test('re-install with guarded reverts what full set; uninstall restores the old value', () => {
    seedSettings();
    ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    ins.install(ctx, opts({ autonomy: 'guarded' }), set.claudeHome());
    let after = readJson(`${claudeDir}/settings.json`);
    assert.equal(after.permissions.defaultMode, 'acceptEdits');
    assert.equal(after.skipDangerousModePermissionPrompt, undefined);
    ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    ins.uninstall(ctx, opts({ uninstall: true }), set.claudeHome());
    after = readJson(`${claudeDir}/settings.json`);
    assert.deepEqual(after, userSettings());
  });

  test('project scope: files under <workspace>/.claude, full autonomy has no effect', () => {
    const dir = set.claudeDirFor('project', { workspace: ctx.workspace });
    assert.equal(dir, `${ctx.workspace}/.claude`);
    const res = ins.install(ctx, opts({ scope: 'project', autonomy: 'full' }), dir);
    assert.ok(fs.existsSync(`${dir}/agents/hades/hades-test-agent.md`));
    const st = readJson(`${dir}/settings.json`);
    assert.equal(st.permissions.defaultMode, undefined);
    assert.ok(res.lines.some((l) => /WARN autonomy full has no effect in project settings/.test(l)));
    assert.ok(res.lines.some((l) => /note: project settings apply only to Claude Code sessions started in/.test(l)));
    assert.ok(!fs.existsSync(`${claudeDir}/settings.json`), 'user settings untouched');
  });
});

describe('uninstall', () => {
  test('removes only marked files and the exact entries it added', () => {
    const original = seedSettings();
    ins.install(ctx, opts(), set.claudeHome());
    // the user edits settings and adds own files afterwards; those must survive
    const st = readJson(`${claudeDir}/settings.json`);
    st.permissions.deny.push('Bash(rm *)');
    fs.writeFileSync(`${claudeDir}/settings.json`, JSON.stringify(st));
    fs.writeFileSync(`${claudeDir}/agents/hades/mine.md`, '---\nname: mine\n---\n');
    fs.writeFileSync(`${claudeDir}/skills/hades-fixture/references/notes.md`, 'edited by the user\n');
    const res = ins.uninstall(ctx, opts({ uninstall: true }), set.claudeHome());
    assert.ok(!fs.existsSync(`${claudeDir}/agents/hades/hades-test-agent.md`));
    assert.ok(fs.existsSync(`${claudeDir}/agents/hades/mine.md`));
    assert.ok(fs.existsSync(`${claudeDir}/skills/hades-fixture/references/notes.md`), 'changed support file kept');
    assert.ok(!fs.existsSync(`${claudeDir}/skills/hades-fixture/SKILL.md`));
    assert.deepEqual(res.kept, ['skills/hades-fixture/references/notes.md']);
    const after = readJson(`${claudeDir}/settings.json`);
    assert.deepEqual(after, { ...original, permissions: { ...original.permissions, deny: ['Bash(curl *)', 'Bash(rm *)'] } });
    assert.equal(readJson(`${ctx.engine}/.hades/install.json`).installs.length, 0);
  });

  test('nothing recorded -> nothing to do', () => {
    const res = ins.uninstall(ctx, opts({ uninstall: true }), set.claudeHome());
    assert.match(res.lines[0], /nothing recorded/);
  });

  test('--dry-run reports without removing', () => {
    ins.install(ctx, opts(), set.claudeHome());
    const res = ins.uninstall(ctx, opts({ uninstall: true, dryRun: true }), set.claudeHome());
    assert.equal(res.removed.length, 4);
    assert.ok(fs.existsSync(`${claudeDir}/agents/hades/hades-test-agent.md`));
    assert.equal(readJson(`${ctx.engine}/.hades/install.json`).installs.length, 1);
  });
});

describe('inspectInstall (used by doctor)', () => {
  test('detects hand edits, missing files and engine changes', () => {
    ins.install(ctx, opts(), set.claudeHome());
    let rec = ins.loadManifest(ctx).installs[0];
    assert.deepEqual(ins.inspectInstall(ctx, rec), { missing: [], modified: [], outdated: [] });
    fs.appendFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, 'x');
    fs.rmSync(`${claudeDir}/skills/hades-fixture/blob.bin`);
    fs.appendFileSync(`${tmp}/source/skills/hades-fixture/SKILL.md`, 'more\n');
    rec = ins.loadManifest(ctx).installs[0];
    const r = ins.inspectInstall(ctx, rec);
    assert.deepEqual(r.modified, ['agents/hades/hades-test-agent.md']);
    assert.deepEqual(r.missing, ['skills/hades-fixture/blob.bin']);
    assert.deepEqual(r.outdated, ['skills/hades-fixture/SKILL.md']);
  });
});

describe('markers', () => {
  test('addMarker replaces old marker lines and handles files without frontmatter', () => {
    const once = ins.addMarker('---\nname: a\nhades-version: 1.0.0\n---\nbody\n', '2.0.0');
    assert.equal(once, '---\nname: a\nhades-generated: true\nhades-version: 2.0.0\n---\nbody\n');
    assert.equal(ins.addMarker(once, '2.0.0'), once);
    assert.equal(ins.addMarker('plain\n', '1'), '---\nhades-generated: true\nhades-version: 1\n---\nplain\n');
    assert.equal(ins.addMarker('---\r\nname: a\r\n---\r\nb\r\n', '1'), '---\r\nname: a\r\nhades-generated: true\r\nhades-version: 1\r\n---\r\nb\r\n');
    assert.ok(!ins.hasMarker('---\nname: a\n---\n'));
  });
});

describe('command entry point', () => {
  function runCli(argsObj) {
    const code = `
      const m = await import(${JSON.stringify(pathToFileURL(INSTALL).href)});
      await m.run(${JSON.stringify(argsObj)}, ${JSON.stringify(ctx)});`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: process.env });
  }

  test('exit 2 on conflicts, --json output, invalid flags fail', () => {
    fs.mkdirSync(`${claudeDir}/agents/hades`, { recursive: true });
    fs.writeFileSync(`${claudeDir}/agents/hades/hades-test-agent.md`, 'not ours\n');
    const r = runCli({ positional: [], flags: { json: true }, rest: [] });
    assert.equal(r.status, 2, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.conflicts.length, 1);
    const bad = runCli({ positional: [], flags: { scope: 'global' }, rest: [] });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--scope must be user or project/);
  });

  test('installs the real engine agents and skills when they exist', { skip: !fs.existsSync(`${ENGINE}/agents`) || !fs.existsSync(`${ENGINE}/skills`) }, () => {
    setEnv('HADES_INSTALL_SOURCE', ENGINE);
    const res = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(res.conflicts.length, 0);
    for (const a of res.actions) {
      const text = fs.readFileSync(`${claudeDir}/${a.rel}`);
      if (a.kind === 'agent' || a.rel.endsWith('/SKILL.md')) {
        const t = text.toString('utf8');
        assert.ok(ins.hasMarker(t), a.rel);
        assert.ok(!/\{\{HADES_(HOME|VAULT)\}\}/.test(t), `${a.rel} still has placeholders`);
      }
    }
  });
});
