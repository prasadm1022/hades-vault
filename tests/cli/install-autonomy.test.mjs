// hades install: a bare re-run keeps the recorded autonomy (cli F8, install-autonomy F8), and
// engine/vault paths with whitespace are quoted in the rendered CLI lines (cli F11).
// Settings content (allow rules, hook command) is covered by install.test.mjs; these tests only
// look at permissions.defaultMode, the install record and the rendered agent/skill text.
// Everything happens in temp dirs: a fake engine, a temp CLAUDE_CONFIG_DIR and a temp workspace.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const FIXTURE = `${ENGINE}/tests/fixtures/install`;
const ins = await import(pathToFileURL(`${ENGINE}/lib/commands/install.mjs`).href);
const set = await import(pathToFileURL(`${ENGINE}/lib/core/settings.mjs`).href);

const s = (p) => p.replace(/\\/g, '/');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

let tmp;
let ctx;
const saved = {};
const setEnv = (k, v) => {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

function fakeEngine(dir) {
  fs.mkdirSync(`${dir}/hooks`, { recursive: true });
  fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: 'hades-company', version: '9.9.9' }));
  fs.writeFileSync(`${dir}/hooks/guard.mjs`, '// fake guard\n');
  return dir;
}

beforeEach(() => {
  tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-install-auto-')));
  fs.cpSync(FIXTURE, `${tmp}/source`, { recursive: true });
  fs.mkdirSync(`${tmp}/vault`);
  fs.mkdirSync(`${tmp}/ws`);
  setEnv('CLAUDE_CONFIG_DIR', `${tmp}/claude`);
  setEnv('HADES_INSTALL_SOURCE', `${tmp}/source`);
  ctx = { engine: fakeEngine(`${tmp}/engine`), vault: `${tmp}/vault`, workspace: `${tmp}/ws`, configFile: `${tmp}/engine/hades.config.json`, config: {}, registry: null };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Options as parseInstallOptions returns them for "hades install [--autonomy <a>]".
const opts = (flags = {}) => ins.parseInstallOptions({ flags, positional: [] }, ctx);
const mode = () => {
  const f = `${tmp}/claude/settings.json`;
  return fs.existsSync(f) ? (readJson(f).permissions || {}).defaultMode : undefined;
};
const recorded = () => readJson(ins.manifestFile(ctx)).installs.map((r) => r.autonomy);

describe('install autonomy on re-run', () => {
  test('no --autonomy means "keep": parseInstallOptions leaves it unset', () => {
    assert.equal(opts().autonomy, null);
    assert.equal(opts({ autonomy: 'full' }).autonomy, 'full');
    assert.throws(() => opts({ autonomy: 'max' }), /--autonomy must be guarded or full/);
  });

  test('a bare re-run after --autonomy full keeps bypassPermissions and says so', () => {
    fs.mkdirSync(`${tmp}/claude`, { recursive: true });
    fs.writeFileSync(`${tmp}/claude/settings.json`, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    const first = ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    assert.equal(first.autonomy, 'full');
    assert.equal(mode(), 'bypassPermissions');
    const again = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(again.autonomy, 'full');
    assert.equal(mode(), 'bypassPermissions', 'not silently downgraded');
    assert.ok(again.lines.some((l) => /^WARN autonomy full \(kept from the previous install; --autonomy guarded\|full changes it\)/.test(l)), again.lines.join('\n'));
    assert.ok(!again.lines.some((l) => /permissions\.defaultMode untouched/.test(l)));
    assert.ok(!again.settings_changes.some((c) => /defaultMode/.test(c)), again.settings_changes.join(', '));
    assert.deepEqual(recorded(), ['full']);
  });

  test('an explicit --autonomy guarded removes it and prints what really happened', () => {
    fs.mkdirSync(`${tmp}/claude`, { recursive: true });
    fs.writeFileSync(`${tmp}/claude/settings.json`, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    const down = ins.install(ctx, opts({ autonomy: 'guarded' }), set.claudeHome());
    assert.ok(down.lines.includes('autonomy guarded: removed permissions.defaultMode=bypassPermissions added by the previous --autonomy full install'), down.lines.join('\n'));
    assert.equal(mode(), 'acceptEdits', "the owner's own mode is back");
    assert.deepEqual(recorded(), ['guarded']);
    const bare = ins.install(ctx, opts(), set.claudeHome());
    assert.ok(bare.lines.includes('autonomy guarded (kept from the previous install; --autonomy guarded|full changes it): permissions.defaultMode untouched'), bare.lines.join('\n'));
  });

  test('a first install without --autonomy is guarded', () => {
    const r = ins.install(ctx, opts(), set.claudeHome());
    assert.equal(r.autonomy, 'guarded');
    assert.ok(r.lines.includes('autonomy guarded: permissions.defaultMode untouched'), r.lines.join('\n'));
    assert.equal(mode(), undefined);
  });

  test('a dry run reports the kept autonomy and writes nothing', () => {
    ins.install(ctx, opts({ autonomy: 'full' }), set.claudeHome());
    const before = fs.readFileSync(`${tmp}/claude/settings.json`, 'utf8');
    const dry = ins.install(ctx, { ...opts(), dryRun: true }, set.claudeHome());
    assert.equal(dry.autonomy, 'full');
    assert.equal(fs.readFileSync(`${tmp}/claude/settings.json`, 'utf8'), before);
  });
});

describe('paths with whitespace are quoted in rendered files', () => {
  const vars = { HADES_HOME: 'C:/Users/Jane Doe/git/hades', HADES_VAULT: 'C:/Users/Jane Doe/git/hades-vault', HADES_WORKSPACE: 'C:/Users/Jane Doe/git' };

  test('quoteSpacedPaths', () => {
    const q = (t) => ins.quoteSpacedPaths(t, vars);
    assert.equal(q('CLI: node C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs task show x'), 'CLI: node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs" task show x');
    assert.equal(q('Read `C:/Users/Jane Doe/git/hades/HADES.md`.'), 'Read `"C:/Users/Jane Doe/git/hades/HADES.md"`.');
    assert.equal(q('see C:/Users/Jane Doe/git/hades/HADES.md.'), 'see "C:/Users/Jane Doe/git/hades/HADES.md".');
    assert.equal(q('git -C C:/Users/Jane Doe/git/hades-vault add <task folder>'), 'git -C "C:/Users/Jane Doe/git/hades-vault" add <task folder>');
    assert.equal(q('Task folder: C:/Users/Jane Doe/git/hades-vault/<team_dir>/tasks/<task-id>-<slug>/'), 'Task folder: "C:/Users/Jane Doe/git/hades-vault/<team_dir>/tasks/<task-id>-<slug>/"');
    // already quoted (templates may quote) and JSON args stay as they are
    assert.equal(q('node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs" x'), 'node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs" x');
    assert.equal(q('args: ["C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs", "mcp", "serena"]'), 'args: ["C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs", "mcp", "serena"]');
    // paths without whitespace are never changed
    const plain = { HADES_HOME: 'C:/git/hades', HADES_VAULT: 'C:/git/vault', HADES_WORKSPACE: 'C:/git' };
    assert.equal(ins.quoteSpacedPaths('node C:/git/hades-vault/bin/hades.mjs x', plain), 'node C:/git/hades-vault/bin/hades.mjs x');
  });

  test('installed agents and skills carry a CLI line that is one shell word', () => {
    ctx.engine = fakeEngine(`${tmp}/my engine`);
    ctx.vault = `${tmp}/my vault`;
    const plan = ins.buildPlan(ctx, set.claudeHome());
    const text = (rel) => plan.files.find((f) => f.rel === rel).content.toString('utf8');
    const agent = text('agents/hades/hades-test-agent.md');
    assert.ok(agent.includes(`CLI: node "${tmp}/my engine/bin/hades.mjs"`), agent);
    assert.ok(agent.includes(`Vault: "${tmp}/my vault"`), agent);
    const skill = text('skills/hades-fixture/SKILL.md');
    assert.ok(skill.includes(`Run node "${tmp}/my engine/bin/hades.mjs" status`), skill);
    assert.ok(skill.includes(`Read "${tmp}/my vault/registry.json"`), skill);
  });
});
