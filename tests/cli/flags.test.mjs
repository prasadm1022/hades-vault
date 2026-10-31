// Every command refuses unknown flags (cli F6, opensource OSS-6): exit 1 "unknown flag --x",
// checked before anything runs, by one shared helper (allowFlags in lib/core/util.mjs).
// Run: node --test tests/cli/flags.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeVault, cleanup, tempDir, ENGINE, initRepo, git } from '../helpers/vault.mjs';
import { parseArgs, allowFlags, commandFlags } from '../../lib/core/util.mjs';

after(cleanup);

const COMMANDS = fs.readdirSync(`${ENGINE}/lib/commands`).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();

describe('unknown flags', () => {
  test('every command module declares its flags', async () => {
    assert.ok(COMMANDS.length >= 15, COMMANDS.join(','));
    for (const name of COMMANDS) {
      const mod = await import(pathToFileURL(`${ENGINE}/lib/commands/${name}.mjs`).href);
      assert.ok(Array.isArray(mod.FLAGS) || (mod.FLAGS && typeof mod.FLAGS === 'object'), `${name} exports FLAGS`);
    }
  });

  test('every command and subcommand refuses --bogus with exit 1 before doing anything', () => {
    const v = makeVault({ teams: { portal: {} } });
    const { id } = v.fakeTask('portal', 1);
    const claude = tempDir('hades-claude-');
    const env = { CLAUDE_CONFIG_DIR: claude };
    const cases = [
      ['init'],
      ['install'],
      ['install', '--scope', 'project'],
      ['export', 'codex', '--dir', v.work],
      ['export', 'codex', '--scope', 'user'],
      ['doctor'],
      ['org'],
      ['org', 'new', 'globex', '--root', v.work],
      ['org', 'list'],
      ['team', 'new', 'shop', '--org', 'acme', '--project', `${v.work}/shop`],
      ['team', 'resolve', 'portal'],
      ['team', 'list'],
      ['team', 'set', 'portal', 'branch-strategy', 'feature-branch'],
      ['task', 'new', 'portal', '--title', 'x'],
      ['task', 'adopt', 'portal-009'],
      ['task', 'show', id],
      ['task', 'stage', id, 'analysis', 'running'],
      ['task', 'size', id, 'L'],
      ['task', 'item', id, 'W1', 'done'],
      ['task', 'coverage', id],
      ['task', 'deploy', id, '--env', 'none'],
      ['task', 'close', id, '--status', 'blocked'],
      ['task', 'list', 'portal'],
      ['task', 'path', id],
      ['defect', 'add', id, '--title', 't', '--severity', 'low', '--owner', 'tech-lead', '--source', 'qa'],
      ['defect', 'update', id, 'D1', '--status', 'fixed'],
      ['defect', 'list', id],
      ['gate', id],
      ['detect', v.work],
      ['tools', 'list'],
      ['tools', 'setup', 'gitleaks'],
      ['tools', 'verify'],
      ['tools', 'bump', 'gitleaks', 'v1'],
      ['mcp', 'serena'],
      ['usage'],
      ['usage', '--task', id],
      ['status'],
      ['migrate'],
      ['run', 'build x'],
    ];
    const before = fs.readFileSync(`${v.taskDir(id)}/state.json`, 'utf8');
    for (const args of cases) {
      const r = v.run([...args, '--bogus'], { env });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}${r.err}`);
      assert.match(r.err, /^hades: unknown flag --bogus$/m, args.join(' '));
      assert.equal(r.out, '', `${args.join(' ')} printed nothing`);
    }
    assert.equal(fs.readFileSync(`${v.taskDir(id)}/state.json`, 'utf8'), before, 'nothing written');
    assert.deepEqual(fs.readdirSync(claude), [], 'install wrote nothing');
    assert.ok(!fs.existsSync(`${v.work}/shop`) && !fs.existsSync(`${v.vault}/organizations/globex`));
  });

  test('typos of a dry-run flag never fall through to the real action', () => {
    const v = makeVault({ teams: { portal: {} } });
    initRepo(v.vault, { message: 'vault' });
    const claude = tempDir('hades-claude-');
    for (const flag of ['--dryrun', '--dry_run', '--dryRUN']) {
      const m = v.run(['migrate', flag]);
      assert.equal(m.code, 1, m.out);
      assert.match(m.err, new RegExp(`unknown flag ${flag}`));
      const i = v.run(['install', '--autonomy', 'full', flag], { env: { CLAUDE_CONFIG_DIR: claude } });
      assert.equal(i.code, 1, i.out);
      const r = v.run(['run', 'build x', flag]);
      assert.equal(r.code, 1);
      assert.match(r.err, /unknown flag/);
      assert.doesNotMatch(r.err + r.out, /claude CLI not found/);
    }
    assert.equal(git(v.vault, 'status', '--porcelain').stdout, '', 'the vault is untouched');
    assert.deepEqual(fs.readdirSync(claude), []);
    const budget = v.run(['run', 'build x', '--max-budget', '20', '--dry-run']);
    assert.equal(budget.code, 1);
    assert.match(budget.err, /unknown flag --max-budget/);
    const session = v.run(['usage', '--task', 'portal-001', '--sesion', 'abc']);
    assert.match(session.err, /unknown flag --sesion/);
  });

  test('known flags and --help still work; a boolean flag does not swallow the next word', () => {
    const v = makeVault({ teams: { portal: {} } });
    for (const name of COMMANDS) {
      const r = v.run([name, '--help']);
      assert.equal(r.code, 0, `${name}: ${r.err}`);
    }
    const r = v.run(['run', '--dry-run', 'build the thing']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\/hades build the thing/);
    const d = v.run(['detect', '--overwrite', v.work]);
    assert.notEqual(d.code, null);
    assert.doesNotMatch(d.err, /unknown flag/);
  });

  test('parseArgs, allowFlags and commandFlags', () => {
    const a = parseArgs(['--dry_run', 'x', '--max-budget-usd=5', '--json', 'y'], { booleans: ['json'] });
    assert.deepEqual(a.flags, { dry_run: 'x', maxBudgetUsd: '5', json: true });
    assert.deepEqual(a.positional, ['y']);
    assert.deepEqual(Object.keys(a), ['positional', 'flags', 'rest'], 'names is not enumerable');
    assert.throws(() => allowFlags(a, ['maxBudgetUsd']), /^Error: unknown flag --dry_run$|unknown flag --dry_run/);
    assert.doesNotThrow(() => allowFlags(a, ['maxBudgetUsd', 'dry_run']));
    const sub = { FLAGS: { add: ['a'], list: ['b'] } };
    assert.deepEqual(commandFlags(sub, { positional: ['list'] }), ['b']);
    assert.deepEqual(commandFlags(sub, { positional: ['nope'] }).sort(), ['a', 'b']);
    assert.deepEqual(commandFlags({ FLAGS: ['x'] }, { positional: [] }), ['x']);
    assert.equal(commandFlags({}, { positional: [] }), null);
  });
});

// The repo's own install, used only to check that the published engine tree is complete.
describe('published tree (opensource OSS-1, OSS-2)', () => {
  test('nothing under templates/ or tests/fixtures/ is git-ignored', (t) => {
    const probe = git(ENGINE, 'rev-parse', '--git-dir');
    if (probe.status !== 0) return t.skip('not a git checkout');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(ENGINE, path.join(dir, e.name)).replace(/\\/g, '/')]));
    const files = [...walk(path.join(ENGINE, 'templates')), ...walk(path.join(ENGINE, 'tests', 'fixtures'))];
    assert.ok(files.some((f) => f.startsWith('templates/vault/')), 'templates/vault exists');
    assert.ok(files.some((f) => /^tests\/fixtures\/gate\/logs\/.+\.log$/.test(f)), 'gate log fixtures exist');
    const ignored = [];
    for (let i = 0; i < files.length; i += 200) {
      const r = git(ENGINE, 'check-ignore', '--no-index', ...files.slice(i, i + 200));
      if (r.stdout.trim()) ignored.push(...r.stdout.trim().split(/\r?\n/));
    }
    assert.deepEqual(ignored, [], 'ignored files would be missing from a clone');
    // the private in-repo vault and config stay ignored
    for (const p of ['vault/registry.json', 'hades.config.json', 'debug.log', '.hades/logs/x.log']) {
      assert.equal(git(ENGINE, 'check-ignore', '--no-index', '-q', p).status, 0, p);
    }
  });
});
