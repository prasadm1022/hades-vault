// Tests for the guard registration and permission rules hades install writes (lib/core/settings.mjs):
// the hook command (absolute Node, quoted), the matcher (Serena tools included), the narrow allow
// rules (no "hades run"), quoting of engine paths with spaces, and recognition of older installs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const set = await import(pathToFileURL(`${ENGINE}/lib/core/settings.mjs`).href);
const s = (p) => p.replace(/\\/g, '/');

test('guard hook: absolute Node binary, quoted paths, onFailure block, Serena in the matcher', () => {
  assert.equal(set.guardCommand('/opt/hades', '/usr/local/bin/node'), '"/usr/local/bin/node" "/opt/hades/hooks/guard.mjs"');
  assert.equal(set.guardCommand('C:\\Users\\Jane Doe\\hades', 'C:\\Program Files\\nodejs\\node.exe'), '"C:/Program Files/nodejs/node.exe" "C:/Users/Jane Doe/hades/hooks/guard.mjs"');
  const entry = set.guardHookEntry('/opt/hades', '/usr/bin/node');
  assert.equal(entry.matcher, set.GUARD_MATCHER);
  assert.deepEqual(entry.hooks, [{ type: 'command', command: '"/usr/bin/node" "/opt/hades/hooks/guard.mjs"', timeout: 10, onFailure: 'block' }]);
  assert.ok(set.GUARD_MATCHER.split('|').includes('mcp__serena__.*'));
  // the matcher is a regular expression: it must match Serena's tools and the built-in ones only
  const rx = new RegExp(`^(?:${set.GUARD_MATCHER})$`);
  for (const t of ['Bash', 'PowerShell', 'Write', 'Grep', 'mcp__serena__replace_content', 'mcp__serena__create_text_file']) assert.ok(rx.test(t), t);
  for (const t of ['WebFetch', 'mcp__playwright__browser_click']) assert.ok(!rx.test(t), t);
  assert.equal(set.guardCommand('/e'), `"${s(process.execPath)}" "/e/hooks/guard.mjs"`, 'defaults to the Node running hades install');
});

test('older installs (node from PATH) still count as a registered guard', () => {
  const old = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep', hooks: [{ type: 'command', command: 'node "/opt/hades/hooks/guard.mjs"', timeout: 10 }] }] } };
  assert.ok(set.hasGuardHook(old, '/opt/hades'));
  assert.deepEqual(set.guardMatcherGaps(old, '/opt/hades'), ['mcp__serena__.*']);
  assert.equal(set.guardHookNode(old, '/opt/hades'), 'node');
  const cur = { hooks: { PreToolUse: [set.guardHookEntry('/opt/hades', '/usr/bin/node')] } };
  assert.ok(set.hasGuardHook(cur, '/opt/hades'));
  assert.deepEqual(set.guardMatcherGaps(cur, '/opt/hades'), []);
  assert.equal(set.guardHookNode(cur, '/opt/hades'), '/usr/bin/node');
  assert.ok(!set.hasGuardHook(cur, '/other/engine'));
  assert.equal(set.guardMatcherGaps({}, '/opt/hades'), null);
});

test('allow rules: safe CLI subcommands and git -C forms only; never run, install, migrate, tools', () => {
  const rules = set.allowRules('/opt/hades');
  for (const sub of ['task *', 'defect *', 'gate *', 'team resolve *', 'team set *', 'team list*', 'detect *', 'status*', 'usage *', 'doctor*']) {
    assert.ok(rules.includes(`Bash(node /opt/hades/bin/hades.mjs ${sub})`), sub);
  }
  for (const g of ['add *', 'commit *', 'status*', 'diff*', 'log*', 'rev-parse *']) {
    assert.ok(rules.includes(`Bash(git -C * ${g})`), g);
    assert.ok(rules.includes(`Bash(git ${g})`), g);
  }
  assert.equal(rules.length, 22);
  assert.ok(!rules.some((r) => /hades\.mjs (\*|run|install|uninstall|migrate|tools|mcp|init)\b/.test(r)), rules.join('\n'));
  assert.ok(!rules.some((r) => /git (-C \* )?(push|reset|clean|checkout|rebase)/.test(r)));
});

test('engine paths with spaces are quoted in the CLI line and the allow rules', () => {
  const eng = 'C:/Users/Jane Doe/git/hades-vault';
  assert.equal(set.hadesCli(eng), 'node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs"');
  assert.equal(set.hadesCli('/opt/hades'), 'node /opt/hades/bin/hades.mjs');
  const rules = set.allowRules(eng);
  assert.ok(rules.includes('Bash(node "C:/Users/Jane Doe/git/hades-vault/bin/hades.mjs" task *)'), rules.join('\n'));
  assert.ok(set.desiredSettings(eng).allow.every((r) => !/hades\.mjs" \*\)/.test(r)));
});

test('install never auto-approves a bypassPermissions session (F4)', () => {
  const d = set.desiredSettings('/opt/hades', { autonomy: 'guarded' });
  assert.ok(!d.allow.some((r) => r.includes(' run') || r.endsWith('hades.mjs *)')));
  assert.ok(!d.keys.length, 'guarded leaves defaultMode alone');
});

// The registered command really runs the guard through a shell (paths quoted, absolute Node).
test('the registered hook command runs the guard and blocks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hades-hookcmd-'));
  try {
    const input = JSON.stringify({ tool_name: 'Read', cwd: s(tmp), tool_input: { file_path: `${s(tmp)}/.env` } });
    const env = { ...process.env, HADES_GUARD_LOG: `${s(tmp)}/guard.log` };
    delete env.HADES_GUARD;
    const r = spawnSync(set.guardCommand(ENGINE), { shell: true, input, encoding: 'utf8', env });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^HADES guard: secrets\.file/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
