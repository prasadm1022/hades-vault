// Tests for the default layout where the vault lives INSIDE the engine (<engine>/.vault, git-ignored
// by the engine repository). The guard derives the engine from its own location, so each fixture is a
// temp engine with a copy of hooks/guard.mjs and the shipped policy, a registry in <engine>/.vault and
// a registered project next to it. Nothing here reads or writes the real engine's vault.
// Run: node --test tests/hooks/guard-engine-vault.test.mjs
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const fx = {};

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// <root>/ws/<name>/{hooks,bin,lib,docs,<vaultDir>} + <root>/ws/acme/portal (the registered project).
function makeEngine(name, { vaultDir = '.vault', config = null } = {}) {
  const engine = `${fx.ws}/${name}`;
  const vault = `${engine}/${vaultDir}`;
  fs.mkdirSync(`${engine}/hooks`, { recursive: true });
  fs.copyFileSync(`${REAL_ENGINE}/hooks/guard.mjs`, `${engine}/hooks/guard.mjs`);
  const policy = JSON.parse(fs.readFileSync(`${REAL_ENGINE}/hooks/guard-policy.json`, 'utf8'));
  policy.tempDirs = ['{ostmp}']; // the fixture lives under the OS temp dir; only the scratch dir is "temp"
  write(`${engine}/hooks/guard-policy.json`, JSON.stringify(policy));
  write(`${engine}/bin/hades.mjs`, '// stub\n');
  write(`${engine}/lib/core/config.mjs`, '// stub\n');
  write(`${engine}/README.md`, '# engine\n');
  write(`${engine}/docs/credentials.md`, '# how credentials are handled\n');
  write(`${engine}/.gitignore`, '/.vault/\n/vault/\n');
  write(`${vault}/registry.json`, JSON.stringify({
    version: 3,
    organizations: { acme: { org_dir: 'organizations/acme', root_path: fx.org } },
    teams: { portal: { organization: 'acme', type: 'main', project_path: fx.project, team_dir: 'organizations/acme/teams/portal' } },
  }));
  const team = `${vault}/organizations/acme/teams/portal`;
  write(`${team}/team.json`, '{"team":"portal"}');
  write(`${team}/CONTEXT.md`, '# portal\n');
  write(`${team}/tasks/portal-001-reset/state.json`, '{}');
  if (config) write(`${engine}/hades.config.json`, JSON.stringify(config));
  return { engine, vault, team, task: `${team}/tasks/portal-001-reset`, guard: `${engine}/hooks/guard.mjs` };
}

before(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-ev-'))).replace(/\\/g, '/');
  Object.assign(fx, { root, home: `${root}/home`, ws: `${root}/ws`, scratch: `${root}/scratch`, log: `${root}/guard.log` });
  fx.org = `${fx.ws}/acme`;
  fx.project = `${fx.ws}/acme/portal`;
  for (const d of [fx.home, fx.scratch, `${fx.project}/src`]) fs.mkdirSync(d, { recursive: true });
  write(`${fx.home}/.claude/settings.json`, '{}');
  // Default layout: no hades.config.json, so the guard falls back to <engine>/.vault.
  fx.e = makeEngine('hades-vault');
  // The same layout declared in a config file with a path relative to the engine.
  fx.rel = makeEngine('engine-rel', { config: { vault: '.vault' } });
  // A legacy engine: <engine>/vault holds the registry and <engine>/.vault does not exist.
  fx.legacy = makeEngine('engine-legacy', { vaultDir: 'vault' });
  // The engine folder was renamed but hades.config.json still holds the old absolute vault path.
  fx.stale = makeEngine('renamed', { config: { vault: `${fx.ws}/hades/.vault` } });
});

after(() => {
  if (fx.root) fs.rmSync(fx.root, { recursive: true, force: true });
});

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HADES_|CLAUDE_CONFIG_DIR$)/i.test(k)) env[k] = v;
  return Object.assign(env, { HOME: fx.home, USERPROFILE: fx.home, TEMP: fx.scratch, TMP: fx.scratch, TMPDIR: fx.scratch, HADES_GUARD_LOG: fx.log });
}

function runGuard(E, c) {
  const input = { session_id: 'test', cwd: c.cwd || fx.project, hook_event_name: 'PreToolUse', permission_mode: 'bypassPermissions', tool_name: c.tool, tool_use_id: 't1' };
  if (c.agent) Object.assign(input, { agent_id: 'a1', agent_type: c.agent });
  if (c.input) input.tool_input = c.input;
  else if (c.tool === 'Bash' || c.tool === 'PowerShell') input.tool_input = { command: c.cmd };
  else input.tool_input = { file_path: c.file, content: 'x', old_string: 'a', new_string: 'b' };
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [E.guard], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
    p.stdin.end(JSON.stringify(input));
  });
}

async function expectCase(E, c, expect) {
  const r = await runGuard(E, c);
  if (expect === 'allow') assert.equal(r.code, 0, `expected allow, got: ${r.stderr}`);
  else {
    assert.equal(r.code, 2, `expected ${expect}, got allow`);
    assert.ok(r.stderr.startsWith(`HADES guard: ${expect}`), `expected ${expect}, got: ${r.stderr}`);
  }
}

const BE = 'hades-backend-engineer';
const TL = 'hades-tech-lead';
const BA = 'hades-business-analyst';

// [name, case(E), expect]
const CASES = [
  // (a) every legitimate vault write still works with the vault inside the engine
  ['PM writes a task README in the vault', (E) => ({ tool: 'Write', file: `${E.task}/README.md` }), 'allow'],
  ['backend engineer writes its task notes', (E) => ({ tool: 'Write', file: `${E.task}/notes/backend-engineer.md`, agent: BE }), 'allow'],
  ['business analyst writes team knowledge', (E) => ({ tool: 'Write', file: `${E.team}/knowledge/glossary.md`, agent: BA }), 'allow'],
  ['tech lead edits CONTEXT.md', (E) => ({ tool: 'Edit', file: `${E.team}/CONTEXT.md`, agent: TL }), 'allow'],
  ['role notes through the shell', (E) => ({ tool: 'Bash', cmd: `echo note >> "${E.team}/roles/backend-engineer.md"`, agent: BE }), 'allow'],
  ['engineer writes the registered project', (E) => ({ tool: 'Write', file: `${fx.project}/src/app.ts`, agent: BE }), 'allow'],
  ['the CLI changes state for an agent', (E) => ({ tool: 'Bash', cmd: `node "${E.engine}/bin/hades.mjs" task status portal-001 --stage build`, agent: BE }), 'allow'],
  ['the CLI sets team commands', (E) => ({ tool: 'Bash', cmd: `node "${E.engine}/bin/hades.mjs" team set portal --command "npm test"` }), 'allow'],
  ['reading a vault file', (E) => ({ tool: 'Read', file: `${E.team}/CONTEXT.md`, agent: BE }), 'allow'],
  // (b) everything that protected the vault still protects it
  ['state.json direct edit (PM)', (E) => ({ tool: 'Write', file: `${E.task}/state.json` }), 'state.direct-edit'],
  ['state.json direct edit (agent)', (E) => ({ tool: 'Edit', file: `${E.task}/state.json`, agent: BE }), 'state.direct-edit'],
  ['defects.json direct edit', (E) => ({ tool: 'Write', file: `${E.task}/defects.json`, agent: BE }), 'state.direct-edit'],
  ['gates.json direct edit', (E) => ({ tool: 'Write', file: `${E.task}/gates.json` }), 'state.direct-edit'],
  ['team.json direct edit', (E) => ({ tool: 'Write', file: `${E.team}/team.json`, agent: TL }), 'state.direct-edit'],
  ['state.json through the shell', (E) => ({ tool: 'Bash', cmd: `echo '{}' > "${E.task}/state.json"`, agent: BE }), 'state.direct-edit'],
  ['rm -rf the vault', (E) => ({ tool: 'Bash', cmd: `rm -rf "${E.vault}"` }), 'fs.delete'],
  ['rm -rf .vault from the engine folder', (E) => ({ tool: 'Bash', cmd: 'rm -rf .vault', cwd: E.engine }), 'fs.delete'],
  ['rm -rf .* in the engine reaches the vault', (E) => ({ tool: 'Bash', cmd: 'rm -rf .*', cwd: E.engine }), 'fs.delete'],
  ['rm -rf the engine (contains the vault)', (E) => ({ tool: 'Bash', cmd: `rm -rf "${E.engine}"` }), 'fs.delete'],
  ['Remove-Item the vault', (E) => ({ tool: 'PowerShell', cmd: `Remove-Item -Recurse -Force "${E.vault}"` }), 'fs.delete'],
  ['git clean -fdx in the engine (ignored vault)', (E) => ({ tool: 'Bash', cmd: 'git clean -fdx', cwd: E.engine }), 'git.discard'],
  ['git clean -fdX in the engine (ignored vault)', (E) => ({ tool: 'Bash', cmd: `git -C "${E.engine}" clean -fdX` }), 'git.discard'],
  ['secret-named notes inside the vault stay secret', (E) => ({ tool: 'Read', file: `${E.team}/knowledge/credentials.md`, agent: BE }), 'secrets.file'],
  // (c) engine self-protection holds; the vault inside the engine does not exempt engine files
  ['guard.mjs is self-protected', (E) => ({ tool: 'Write', file: `${E.engine}/hooks/guard.mjs` }), 'self.protect'],
  ['guard.mjs via a path through the vault', (E) => ({ tool: 'Write', file: `${E.vault}/../hooks/guard.mjs`, agent: BE }), 'self.protect'],
  ['guard policy via the shell from the vault', (E) => ({ tool: 'Bash', cmd: "echo '{}' > ../hooks/guard-policy.json", cwd: E.vault, agent: BE }), 'self.protect'],
  ['engine hades.config.json', (E) => ({ tool: 'Write', file: `${E.engine}/hades.config.json`, agent: TL }), 'self.protect'],
  ['agent writes engine code', (E) => ({ tool: 'Write', file: `${E.engine}/lib/core/config.mjs`, agent: BE }), 'scope.engine'],
  ['agent writes engine code via the vault path', (E) => ({ tool: 'Write', file: `${E.vault}/../lib/core/config.mjs`, agent: TL }), 'scope.engine'],
  ['analyst writes the engine README (outside its scope)', (E) => ({ tool: 'Edit', file: `${E.engine}/README.md`, agent: BA }), 'scope.write'],
  ['engineer writes the engine README', (E) => ({ tool: 'Edit', file: `${E.engine}/README.md`, agent: BE }), 'scope.engine'],
  ['a vault-like folder name next to .vault is not the vault', (E) => ({ tool: 'Write', file: `${E.engine}/.vault-x/notes.md`, agent: BE }), 'scope.engine'],
  ['rm -rf the engine hooks', (E) => ({ tool: 'Bash', cmd: `rm -rf "${E.engine}/hooks"` }), 'fs.delete'],
  ['engine docs named credentials stay readable', (E) => ({ tool: 'Read', file: `${E.engine}/docs/credentials.md` }), 'allow'],
  // (d) Serena may not be rooted at the engine or the vault
  ['serena activate_project on the engine', (E) => ({ tool: 'mcp__serena__activate_project', input: { project: E.engine, session_id: 's' } }), 'scope.write'],
  ['serena activate_project on the vault', (E) => ({ tool: 'mcp__serena__activate_project', input: { project: E.vault, session_id: 's' } }), 'scope.write'],
  ['serena activate_project on a vault team folder', (E) => ({ tool: 'mcp__serena__activate_project', input: { project: E.team, session_id: 's' } }), 'allow'],
  ['serena activate_project on a project', (E) => ({ tool: 'mcp__serena__activate_project', input: { project: fx.project, session_id: 's' } }), 'allow'],
];

for (const [label, key] of [['default <engine>/.vault (no config)', 'e'], ['config "vault": ".vault" (relative to the engine)', 'rel']]) {
  describe(`vault inside the engine: ${label}`, () => {
    for (const [name, mk, expect] of CASES) {
      test(name, async () => {
        const E = fx[key];
        await expectCase(E, mk(E), expect);
      });
    }
  });
}

describe('legacy <engine>/vault fallback', () => {
  test('a legacy vault with a registry is still the vault while .vault does not exist', async () => {
    const E = fx.legacy;
    await expectCase(E, { tool: 'Write', file: `${E.task}/notes/backend-engineer.md`, agent: BE }, 'allow');
    await expectCase(E, { tool: 'Write', file: `${E.task}/state.json`, agent: BE }, 'state.direct-edit');
    await expectCase(E, { tool: 'Bash', cmd: `rm -rf "${E.vault}"` }, 'fs.delete');
    await expectCase(E, { tool: 'Write', file: `${E.engine}/lib/core/config.mjs`, agent: BE }, 'scope.engine');
    await expectCase(E, { tool: 'mcp__serena__activate_project', input: { project: E.vault, session_id: 's' } }, 'scope.write');
  });
});

// The 8.3 short name of a path (C:/.../HADES-~1/VAULT~1), or null when the volume has none.
function shortPath(p) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p.replace(/\//g, '\\')}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  const s = String(r.stdout || '').trim().replace(/\\/g, '/');
  return s && s.toLowerCase() !== p.toLowerCase() ? s : null;
}

describe('Windows 8.3 short names reach the same folders', () => {
  const short = {};
  before(() => {
    short.vault = shortPath(fx.e.vault);
    short.engine = shortPath(fx.e.engine);
  });
  const need = (t, key) => {
    if (!short[key]) {
      t.skip('no 8.3 short names on this volume');
      return false;
    }
    return true;
  };
  const leaf = (p) => p.slice(p.lastIndexOf('/') + 1);

  test('deleting or moving the vault by its short name is blocked', async (t) => {
    if (!need(t, 'vault')) return;
    const E = fx.e;
    const sv = `${E.engine}/${leaf(short.vault)}`; // <engine>/VAULT~1
    await expectCase(E, { tool: 'Bash', cmd: `rm -rf "${sv}"` }, 'fs.delete');
    await expectCase(E, { tool: 'Bash', cmd: `rm -rf ${leaf(short.vault)}`, cwd: E.engine }, 'fs.delete');
    await expectCase(E, { tool: 'Bash', cmd: `rm -rf "${short.vault}"` }, 'fs.delete');
    await expectCase(E, { tool: 'PowerShell', cmd: `Remove-Item -Recurse -Force "${sv}"` }, 'fs.delete');
    await expectCase(E, { tool: 'Bash', cmd: `mv "${sv}" "${fx.scratch}/x"` }, 'fs.delete');
    await expectCase(E, { tool: 'Bash', cmd: `rm -rf "${E.engine}/${leaf(short.vault).replace(/\d$/, '?')}"` }, 'fs.delete');
    await expectCase(E, { tool: 'mcp__serena__activate_project', input: { project: sv, session_id: 's' } }, 'scope.write');
    assert.ok(fs.existsSync(E.vault), 'nothing deleted');
  });

  test('deleting the engine by its short name is blocked', async (t) => {
    if (!need(t, 'engine')) return;
    await expectCase(fx.e, { tool: 'Bash', cmd: `rm -rf "${short.engine}"` }, 'fs.delete');
    await expectCase(fx.e, { tool: 'Bash', cmd: `rm -rf "${short.engine}/.vault"` }, 'fs.delete');
    await expectCase(fx.e, { tool: 'Bash', cmd: `rm -rf "${short.engine}/hooks"` }, 'fs.delete');
  });

  test('short names elsewhere still allow ordinary deletes', async (t) => {
    if (!need(t, 'engine')) return;
    await expectCase(fx.e, { tool: 'Bash', cmd: `rm -rf "${short.engine}/.vault/organizations/acme/teams/portal/tasks/portal-001-reset/notes"` }, 'allow');
  });
});

describe('a stale absolute vault path in hades.config.json (engine folder renamed)', () => {
  const S = () => fx.stale;
  const cases = [
    ['rm -rf the real .vault', () => ({ tool: 'Bash', cmd: `rm -rf "${S().vault}"` }), 'fs.delete'],
    ['mv the real .vault', () => ({ tool: 'Bash', cmd: `mv "${S().vault}" "${fx.scratch}/v"` }), 'fs.delete'],
    ['rm -rf the real .vault contents', () => ({ tool: 'Bash', cmd: `rm -rf "${S().vault}"/*` }), 'fs.delete'],
    ['PM writes state.json', () => ({ tool: 'Write', file: `${S().task}/state.json` }), 'state.direct-edit'],
    ['PM writes team.json', () => ({ tool: 'Write', file: `${S().team}/team.json` }), 'state.direct-edit'],
    ['serena on the real .vault', () => ({ tool: 'mcp__serena__activate_project', input: { project: S().vault, session_id: 's' } }), 'scope.write'],
    ['backend engineer still writes its task notes', () => ({ tool: 'Write', file: `${S().task}/notes/be.md`, agent: BE }), 'allow'],
    ['tech lead still edits CONTEXT.md', () => ({ tool: 'Edit', file: `${S().team}/CONTEXT.md`, agent: TL }), 'allow'],
    ['engine code stays out of scope', () => ({ tool: 'Write', file: `${S().engine}/lib/core/config.mjs`, agent: BE }), 'scope.engine'],
  ];
  for (const [name, mk, expect] of cases) test(name, async () => expectCase(S(), mk(), expect));

  test('allowed calls carry a warning about the stale vault path', async () => {
    const r = await runGuard(S(), { tool: 'Write', file: `${fx.project}/src/x.ts`, agent: BE });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: the configured vault .*\/hades\/\.vault has no registry\.json; using .*\/renamed\/\.vault/);
  });

  test('a healthy layout prints no warning', async () => {
    const r = await runGuard(fx.e, { tool: 'Write', file: `${fx.project}/src/x.ts`, agent: BE });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
  });
});

describe('the vault never reaches the engine repository', () => {
  const E = () => fx.e;
  const cases = [
    ['git update-index --add of a vault file', () => ({ tool: 'Bash', cmd: 'git update-index --add .vault/registry.json', cwd: E().engine }), 'git.force'],
    ['git update-index --cacheinfo', () => ({ tool: 'Bash', cmd: 'git update-index --cacheinfo 100644,abc,x', cwd: E().engine }), 'git.force'],
    ['git stage -f (alias of add)', () => ({ tool: 'Bash', cmd: 'git stage -f .vault', cwd: E().engine }), 'git.force'],
    ['git add of a vault file from the engine', () => ({ tool: 'Bash', cmd: 'git add .vault/registry.json', cwd: E().engine }), 'git.vault'],
    ['git add with the excludes file switched off', () => ({ tool: 'Bash', cmd: 'git -c core.excludesFile=/dev/null add .vault', cwd: E().engine }), 'git.vault'],
    ['git -C <engine> add .vault', () => ({ tool: 'Bash', cmd: `git -C "${E().engine}" add .vault` }), 'git.vault'],
    ['git stage of the vault', () => ({ tool: 'Bash', cmd: `git -C "${E().engine}" stage -- "${E().vault}/registry.json"` }), 'git.vault'],
    ['git commit with a vault pathspec', () => ({ tool: 'Bash', cmd: 'git commit -m wip -- .vault/registry.json', cwd: E().engine }), 'git.vault'],
    ['git add with top magic', () => ({ tool: 'Bash', cmd: 'git add ":/.vault"', cwd: `${E().engine}/docs` }), 'git.vault'],
    ['the vault commits in its own repository', () => ({ tool: 'Bash', cmd: `git -C "${E().vault}" add registry.json organizations && git -C "${E().vault}" commit -m "vault: update .vault/registry.json"` }), 'allow'],
    ['engine files are staged as usual', () => ({ tool: 'Bash', cmd: 'git add README.md docs && git commit -m "docs: mention .vault/registry.json"', cwd: E().engine }), 'allow'],
    ['git add -A in the engine (the vault is ignored)', () => ({ tool: 'Bash', cmd: 'git add -A', cwd: E().engine }), 'allow'],
    ['PM edits the engine .gitignore', () => ({ tool: 'Write', file: `${E().engine}/.gitignore` }), 'self.protect'],
    ['sed removes the vault line from .gitignore', () => ({ tool: 'Bash', cmd: "sed -i '/vault/d' .gitignore", cwd: E().engine }), 'self.protect'],
    ['git stash -a', () => ({ tool: 'Bash', cmd: 'git stash -a', cwd: E().engine }), 'git.discard'],
    ['git stash push --all', () => ({ tool: 'Bash', cmd: `git -C "${E().engine}" stash push --all` }), 'git.discard'],
    ['git stash push --al (abbreviated)', () => ({ tool: 'Bash', cmd: 'git stash push -m wip --al', cwd: E().engine }), 'git.discard'],
    ['git stash -ua', () => ({ tool: 'Bash', cmd: 'git stash -ua', cwd: E().engine }), 'git.discard'],
    ['git stash push -m wip', () => ({ tool: 'Bash', cmd: 'git stash push -m wip', cwd: E().engine }), 'allow'],
    ['git stash -u', () => ({ tool: 'Bash', cmd: 'git stash -u', cwd: E().engine }), 'allow'],
    ['git stash list / apply', () => ({ tool: 'Bash', cmd: 'git stash list && git stash apply', cwd: E().engine }), 'allow'],
  ];
  for (const [name, mk, expect] of cases) test(name, async () => expectCase(fx.e, mk(), expect));
});

describe('the registry and the vault structure', () => {
  const E = () => fx.e;
  const cases = [
    ['PM writes registry.json', () => ({ tool: 'Write', file: `${E().vault}/registry.json` }), 'state.direct-edit'],
    ['agent writes registry.json', () => ({ tool: 'Write', file: `${E().vault}/registry.json`, agent: BE }), 'state.direct-edit'],
    ['registry.json through the shell', () => ({ tool: 'Bash', cmd: `echo '{}' > "${E().vault}/registry.json"`, agent: BE }), 'state.direct-edit'],
    ['the CLI still changes the registry', () => ({ tool: 'Bash', cmd: `node "${E().engine}/bin/hades.mjs" team create portal2 --org acme` }), 'allow'],
    ['git add registry.json inside the vault', () => ({ tool: 'Bash', cmd: 'git add registry.json', cwd: E().vault }), 'allow'],
    ['a project file named registry.json', () => ({ tool: 'Write', file: `${fx.project}/src/registry.json`, agent: BE }), 'allow'],
    ['rm -rf the vault organizations', () => ({ tool: 'Bash', cmd: `rm -rf "${E().vault}/organizations"` }), 'fs.delete'],
    ['rm -rf the vault company folder', () => ({ tool: 'Bash', cmd: 'rm -rf company', cwd: E().vault }), 'fs.delete'],
    ['rm -rf one task folder', () => ({ tool: 'Bash', cmd: `rm -rf "${E().task}/notes"` }), 'allow'],
    ['serena on the engine agents folder', () => ({ tool: 'mcp__serena__activate_project', input: { project: `${E().engine}/agents`, session_id: 's' } }), 'scope.write'],
    ['serena on the vault organizations', () => ({ tool: 'mcp__serena__activate_project', input: { project: `${E().vault}/organizations`, session_id: 's' } }), 'scope.write'],
  ];
  for (const [name, mk, expect] of cases) test(name, async () => expectCase(fx.e, mk(), expect));
});
