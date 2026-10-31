// Tests for the guard's platform adapters ("hooks/guard.mjs --format <platform>", registered by
// "hades export"): payload mapping (adaptInput), patch parsing (patchPaths), the output contract of
// each platform (adapterOutput), and end-to-end runs of the hook against an isolated fixture (home,
// workspace, vault, registry, config, policy, log), as the other coding agents call it.
// Run: node --test tests/hooks/guard-adapters.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const GUARD = `${ENGINE}/hooks/guard.mjs`;
const { adaptInput, adapterOutput, patchPaths, GUARD_FORMATS } = await import(pathToFileURL(GUARD).href);

const fx = {};

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

before(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-guard-adapt-'))).replace(/\\/g, '/');
  Object.assign(fx, {
    root,
    home: `${root}/home`,
    ws: `${root}/ws`,
    project: `${root}/ws/acme/portal`,
    vault: `${root}/vault`,
    scratch: `${root}/scratch`,
    config: `${root}/hades.config.json`,
    policy: `${root}/guard-policy.json`,
    log: `${root}/guard.log`,
  });
  for (const d of [fx.home, fx.scratch, `${fx.project}/.git`, `${fx.project}/src`]) fs.mkdirSync(d, { recursive: true });
  write(`${fx.project}/.env`, 'API_TOKEN=abc\n');
  write(`${fx.project}/src/app.ts`, 'export const a = 1;\n');
  write(`${fx.ws}/.cursor/hooks.json`, '{"version":1,"hooks":{}}');
  write(`${fx.vault}/registry.json`, JSON.stringify({
    version: 3,
    organizations: { acme: { org_dir: 'organizations/acme', root_path: `${fx.ws}/acme` } },
    teams: { portal: { organization: 'acme', type: 'main', project_path: fx.project, team_dir: 'organizations/acme/teams/portal' } },
  }));
  write(fx.config, JSON.stringify({ vault: fx.vault, workspace: fx.ws }));
  const policy = JSON.parse(fs.readFileSync(`${ENGINE}/hooks/guard-policy.json`, 'utf8'));
  policy.tempDirs = ['{ostmp}'];
  write(fx.policy, JSON.stringify(policy));
});

after(() => {
  if (fx.root) fs.rmSync(fx.root, { recursive: true, force: true });
});

function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HADES_|CLAUDE_CONFIG_DIR$|DEVIN_PROJECT_DIR$)/i.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: fx.home, USERPROFILE: fx.home, TEMP: fx.scratch, TMP: fx.scratch, TMPDIR: fx.scratch,
    HADES_CONFIG_FILE: fx.config, HADES_GUARD_POLICY: fx.policy, HADES_GUARD_LOG: fx.log,
  }, extra);
  return env;
}

function runGuard(args, stdin, extraEnv) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [GUARD, ...args], { env: childEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

const shapes = (calls) => calls.map((c) => [c.tool_name, c.tool_input && (c.tool_input.command || c.tool_input.file_path || c.tool_input.path || c.tool_input.relative_path || '')]);

describe('patchPaths', () => {
  test('apply_patch envelope: add, update, delete, move; body lines are content', () => {
    const text = '*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** Update File: src/app.ts\n*** Move to: src/main.ts\n@@\n--- not a header\n+++ nor this\n*** Delete File: old.txt\n*** End Patch';
    assert.deepEqual(patchPaths(text), [
      { path: 'src/new.ts', op: 'add' },
      { path: 'src/app.ts', op: 'update' },
      { path: 'src/main.ts', op: 'add' },
      { path: 'old.txt', op: 'delete' },
    ]);
  });
  test('unified diff headers; /dev/null and duplicates dropped', () => {
    const text = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/.git/hooks/pre-commit\n';
    assert.deepEqual(patchPaths(text).map((p) => p.path), ['x.js', '.git/hooks/pre-commit']);
  });
  test('nothing for empty or non-patch text', () => {
    assert.deepEqual(patchPaths(''), []);
    assert.deepEqual(patchPaths(undefined), []);
  });
});

describe('adaptInput', () => {
  test('formats are the documented set', () => {
    assert.deepEqual(GUARD_FORMATS, ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'cline', 'opencode']);
  });

  test('claude: the payload as is', () => {
    const p = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    assert.deepEqual(adaptInput('claude', p), [p]);
  });

  test('codex: Bash (string or argv), apply_patch files, Serena MCP, other tools ignored', () => {
    assert.deepEqual(shapes(adaptInput('codex', { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/w' }, { win: false })), [['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('codex', { tool_name: 'Bash', tool_input: { command: 'git push' } }, { win: true })), [['Bash', 'git push'], ['PowerShell', 'git push']], 'undocumented Windows shell: both readings');
    assert.deepEqual(shapes(adaptInput('codex', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'git push origin'] } }, { win: false })), [['Bash', "bash -lc 'git push origin'"]]);
    const patch = adaptInput('codex', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: .git/config\n*** End Patch' }, cwd: '/w' });
    assert.deepEqual(shapes(patch), [['Write', 'a.txt'], ['Edit', '.git/config']]);
    assert.equal(patch[0].cwd, '/w');
    assert.deepEqual(shapes(adaptInput('codex', { tool_name: 'mcp__serena__create_text_file', tool_input: { relative_path: 'x' } })), [['mcp__serena__create_text_file', 'x']]);
    assert.deepEqual(adaptInput('codex', { tool_name: 'update_plan', tool_input: {} }), []);
    assert.deepEqual(adaptInput('codex', { tool_name: 'mcp__playwright__browser_click', tool_input: {} }), []);
  });

  test('cursor: shell, read, MCP (JSON-string arguments), preToolUse Write/Delete', () => {
    assert.deepEqual(shapes(adaptInput('cursor', { hook_event_name: 'beforeShellExecution', command: 'git push', cwd: '/w' }, { win: false })), [['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('cursor', { hook_event_name: 'beforeReadFile', file_path: '/w/.env', content: 'x' })), [['Read', '/w/.env']]);
    const mcp = adaptInput('cursor', { hook_event_name: 'beforeMCPExecution', mcp_server_name: 'serena', tool_name: 'create_text_file', tool_input: '{"relative_path":".mcp.json","content":"{}"}', command: 'node x' });
    assert.deepEqual(shapes(mcp), [['mcp__serena__create_text_file', '.mcp.json']]);
    assert.deepEqual(adaptInput('cursor', { hook_event_name: 'beforeMCPExecution', mcp_server_name: 'github', tool_name: 'create_issue', tool_input: '{}', command: 'gh' }), [], 'other MCP servers are not checked');
    assert.deepEqual(shapes(adaptInput('cursor', { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: '/w/a.ts' }, workspace_roots: ['/w'] })), [['Write', '/w/a.ts']]);
    assert.deepEqual(shapes(adaptInput('cursor', { hook_event_name: 'preToolUse', tool_name: 'Delete', tool_input: { path: '/w/.git/HEAD' } })), [['Edit', '/w/.git/HEAD']]);
    assert.equal(adaptInput('cursor', { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: 'a' }, workspace_roots: ['/w'] })[0].cwd, '/w');
  });

  test('gemini: PowerShell on Windows, bash elsewhere; dir_path; files; mcp_serena_ names', () => {
    assert.deepEqual(shapes(adaptInput('gemini', { tool_name: 'run_shell_command', tool_input: { command: 'git push' }, cwd: '/w' }, { win: true })), [['PowerShell', 'git push']]);
    const sub = adaptInput('gemini', { tool_name: 'run_shell_command', tool_input: { command: 'ls', dir_path: 'sub' }, cwd: '/w' }, { win: false });
    assert.deepEqual(shapes(sub), [['Bash', 'ls']]);
    assert.equal(sub[0].cwd.replace(/\\/g, '/').replace(/^[A-Z]:/i, ''), '/w/sub');
    assert.deepEqual(shapes(adaptInput('gemini', { tool_name: 'write_file', tool_input: { file_path: 'a', content: 'x' } })), [['Write', 'a']]);
    assert.deepEqual(shapes(adaptInput('gemini', { tool_name: 'replace', tool_input: { file_path: 'a', old_string: 'x', new_string: 'y' } })), [['Edit', 'a']]);
    assert.deepEqual(shapes(adaptInput('gemini', { tool_name: 'read_many_files', tool_input: { paths: ['a', '**/.env'] } })), [['Read', 'a'], ['Read', '**/.env']]);
    assert.deepEqual(adaptInput('gemini', { tool_name: 'grep_search', tool_input: { pattern: 'x', include: '**/.env' } }).map((c) => [c.tool_name, c.tool_input.glob]), [['Grep', '**/.env']]);
    assert.deepEqual(shapes(adaptInput('gemini', { tool_name: 'mcp_serena_replace_content', tool_input: { relative_path: 'b' } })), [['mcp__serena__replace_content', 'b']]);
  });

  test('copilot: PascalCase (Claude names) and camelCase (toolArgs JSON) payloads', () => {
    assert.deepEqual(shapes(adaptInput('copilot', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }, { win: false })), [['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('copilot', { toolName: 'powershell', toolArgs: '{"command":"git push"}', cwd: '/w' })), [['PowerShell', 'git push']]);
    assert.deepEqual(shapes(adaptInput('copilot', { tool_name: 'Read', tool_input: { file_path: '.env' } })), [['Read', '.env']]);
    assert.deepEqual(shapes(adaptInput('copilot', { tool_name: 'Edit', tool_input: { input: '*** Begin Patch\n*** Update File: x.ts\n*** End Patch' } })), [['Edit', 'x.ts']]);
    assert.deepEqual(shapes(adaptInput('copilot', { tool_name: 'serena/create_text_file', tool_input: { relative_path: 'y' } })), [['mcp__serena__create_text_file', 'y']]);
  });

  test('windsurf (Devin): exec, write_to_process, files, apply_patch, DEVIN_PROJECT_DIR as cwd', () => {
    assert.deepEqual(shapes(adaptInput('windsurf', { tool_name: 'exec', tool_input: { command: 'git push' } }, { win: false })), [['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('windsurf', { tool_name: 'write_to_process', tool_input: { input: 'git push\n' } }, { win: false })), [['Bash', 'git push\n']]);
    assert.deepEqual(shapes(adaptInput('windsurf', { tool_name: 'write', tool_input: { file_path: 'a' } })), [['Write', 'a']]);
    assert.deepEqual(shapes(adaptInput('windsurf', { tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\n*** Delete File: b\n*** End Patch' } })), [['Edit', 'b']]);
    assert.equal(adaptInput('windsurf', { tool_name: 'read', tool_input: { file_path: 'a' } }, { env: { DEVIN_PROJECT_DIR: '/proj' } })[0].cwd, '/proj');
  });

  test('cline: legacy and CLI tool names, JSON-string parameters, use_mcp_tool', () => {
    const pre = (toolName, parameters) => ({ hookName: 'PreToolUse', preToolUse: { toolName, parameters }, workspaceRoots: ['/w'] });
    const cmd = adaptInput('cline', pre('execute_command', { command: 'git push', requires_approval: 'false' }), { win: false });
    assert.deepEqual(shapes(cmd), [['Bash', 'git push']]);
    assert.equal(cmd[0].cwd, '/w');
    assert.deepEqual(shapes(adaptInput('cline', pre('run_commands', { commands: '["ls","git push"]' }), { win: false })), [['Bash', 'ls'], ['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('cline', pre('write_to_file', { path: 'a', content: 'x' }))), [['Write', 'a']]);
    assert.deepEqual(shapes(adaptInput('cline', pre('read_files', { paths: ['a', '.env'] }))), [['Read', 'a'], ['Read', '.env']]);
    assert.deepEqual(shapes(adaptInput('cline', pre('use_mcp_tool', { server_name: 'serena', tool_name: 'create_text_file', arguments: '{"relative_path":"z"}' }))), [['mcp__serena__create_text_file', 'z']]);
    assert.deepEqual(shapes(adaptInput('cline', { tool_call: { name: 'run_commands', input: { commands: ['git push'] } } }, { win: false })), [['Bash', 'git push']]);
  });

  test('opencode: lower-case tools, filePath, serena_ names', () => {
    assert.deepEqual(shapes(adaptInput('opencode', { tool_name: 'bash', tool_input: { command: 'git push' }, cwd: '/w' }, { win: false })), [['Bash', 'git push']]);
    assert.deepEqual(shapes(adaptInput('opencode', { tool_name: 'write', tool_input: { filePath: '/w/a', content: 'x' } })), [['Write', '/w/a']]);
    assert.deepEqual(shapes(adaptInput('opencode', { tool_name: 'patch', tool_input: { patchText: '*** Begin Patch\n*** Add File: n\n*** End Patch' } })), [['Write', 'n']]);
    assert.deepEqual(shapes(adaptInput('opencode', { tool_name: 'serena_find_symbol', tool_input: { relative_path: '.env' } })), [['mcp__serena__find_symbol', '.env']]);
    assert.deepEqual(adaptInput('opencode', { tool_name: 'todowrite', tool_input: {} }), []);
  });

  test('garbage payloads map to nothing', () => {
    for (const f of GUARD_FORMATS.filter((x) => x !== 'claude')) {
      assert.deepEqual(adaptInput(f, null), [], f);
      assert.deepEqual(adaptInput(f, { tool_name: 42, tool_input: 'x' }), [], f);
    }
  });
});

describe('adapterOutput', () => {
  const msg = 'HADES guard: git.push: no';
  test('deny contracts', () => {
    assert.deepEqual(adapterOutput('claude', msg), { stdout: '', stderr: `${msg}\n`, code: 2 });
    for (const f of ['codex', 'copilot', 'opencode']) assert.deepEqual(adapterOutput(f, msg), { stdout: '', stderr: `${msg}\n`, code: 2 }, f);
    const c = adapterOutput('cursor', msg);
    assert.equal(c.code, 2);
    assert.deepEqual(JSON.parse(c.stdout), { permission: 'deny', user_message: msg, agent_message: msg });
    assert.deepEqual(adapterOutput('gemini', msg), { stdout: '', stderr: `${msg}\n`, code: 2 });
    const w = adapterOutput('windsurf', msg);
    assert.equal(w.code, 2);
    assert.deepEqual(JSON.parse(w.stdout), { decision: 'block', reason: msg });
    const cl = adapterOutput('cline', msg);
    assert.equal(cl.code, 0);
    assert.deepEqual(JSON.parse(cl.stdout), { cancel: true, errorMessage: msg });
  });
  test('allow contracts (never an "approve" that would skip the platform\'s own prompts)', () => {
    for (const f of ['claude', 'codex', 'copilot', 'opencode', 'windsurf']) assert.deepEqual(adapterOutput(f, null), { stdout: '', stderr: '', code: 0 }, f);
    assert.deepEqual(adapterOutput('cursor', null), { stdout: '{"permission":"allow"}\n', stderr: '', code: 0 });
    assert.deepEqual(adapterOutput('gemini', null), { stdout: '{}\n', stderr: '', code: 0 });
    assert.deepEqual(adapterOutput('cline', null), { stdout: '{"cancel":false}\n', stderr: '', code: 0 });
    assert.equal(adapterOutput('cursor', null, { warn: 'w\n' }).stderr, 'w\n');
  });
});

// End to end: [format, payload builder, expected rule prefix or 'allow'].
const P = (rel = '') => `${fx.project}${rel}`;
const E2E = [
  ['codex', () => ({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: P() }), 'git.push'],
  ['codex', () => ({ tool_name: 'Bash', tool_input: { command: 'git status && npm test' }, cwd: P() }), 'allow'],
  ['codex', () => ({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .git/config\n*** End Patch' }, cwd: P() }), 'git.internals'],
  ['codex', () => ({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch' }, cwd: P() }), 'allow'],
  ['codex', () => ({ tool_name: 'Edit', tool_input: { command: `*** Begin Patch\n*** Update File: ${fx.ws}/.cursor/hooks.json\n*** End Patch` }, cwd: P() }), 'self.protect'],
  ['cursor', () => ({ hook_event_name: 'beforeShellExecution', command: 'git reset --hard', cwd: P() }), 'git.discard'],
  ['cursor', () => ({ hook_event_name: 'beforeShellExecution', command: 'npm test', cwd: P() }), 'allow'],
  ['cursor', () => ({ hook_event_name: 'beforeReadFile', file_path: P('/.env'), content: 'API_TOKEN=abc' }), 'secrets.file'],
  ['cursor', () => ({ hook_event_name: 'beforeReadFile', file_path: P('/src/app.ts'), content: '' }), 'allow'],
  ['cursor', () => ({ hook_event_name: 'beforeMCPExecution', mcp_server_name: 'serena', tool_name: 'create_text_file', tool_input: JSON.stringify({ relative_path: '.mcp.json', content: '{}' }), command: 'node', cwd: P() }), 'self.protect'],
  ['cursor', () => ({ hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: `${fx.ws}/.cursor/hooks.json` }, cwd: P() }), 'self.protect'],
  ['gemini', () => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push' }, cwd: P() }), 'git.push'],
  ['gemini', () => ({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: P('/.env') }, cwd: P() }), 'secrets.file'],
  ['gemini', () => ({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: P('/src/new.ts'), content: 'x' }, cwd: P() }), 'allow'],
  ['copilot', () => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: P() }), 'git.push'],
  ['copilot', () => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${fx.ws}/AGENTS.md`, content: 'x' }, cwd: P() }), 'self.protect'],
  ['copilot', () => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: P('/src/app.ts') }, cwd: P() }), 'allow'],
  ['windsurf', () => ({ hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'git push' }, cwd: P() }), 'git.push'],
  ['windsurf', () => ({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { file_path: P('/.devin/hooks.v1.json') }, cwd: P() }), 'self.protect'],
  ['windsurf', () => ({ hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'ls' }, cwd: P() }), 'allow'],
  ['cline', () => ({ hookName: 'PreToolUse', preToolUse: { toolName: 'execute_command', parameters: { command: 'git push' } }, workspaceRoots: [P()] }), 'git.push'],
  ['cline', () => ({ hookName: 'PreToolUse', preToolUse: { toolName: 'read_file', parameters: { path: '.env' } }, workspaceRoots: [P()] }), 'secrets.file'],
  ['cline', () => ({ hookName: 'PreToolUse', preToolUse: { toolName: 'read_file', parameters: { path: 'src/app.ts' } }, workspaceRoots: [P()] }), 'allow'],
  ['opencode', () => ({ tool_name: 'bash', tool_input: { command: 'git clean -fdx' }, cwd: P() }), 'git.discard'],
  ['opencode', () => ({ tool_name: 'edit', tool_input: { filePath: P('/opencode.json') }, cwd: P() }), 'self.protect'],
  ['opencode', () => ({ tool_name: 'serena_create_text_file', tool_input: { relative_path: '.git/hooks/pre-commit', content: 'x' }, cwd: P() }), 'git.internals'],
  ['opencode', () => ({ tool_name: 'read', tool_input: { filePath: P('/src/app.ts') }, cwd: P() }), 'allow'],
];

function decision(format, r) {
  if (format === 'cursor') return JSON.parse(r.stdout).permission === 'deny' ? 'deny' : 'allow';
  if (format === 'cline') return JSON.parse(r.stdout).cancel ? 'deny' : 'allow';
  return r.code === 2 ? 'deny' : 'allow';
}

describe('guard --format end to end', () => {
  for (const [format, build, expect] of E2E) {
    test(`${format}: ${expect}`, async () => {
      const payload = build();
      const r = await runGuard(['--format', format], payload);
      const got = decision(format, r);
      const text = `${r.stdout} ${r.stderr}`;
      if (expect === 'allow') {
        assert.equal(got, 'allow', `${JSON.stringify(payload)} -> ${text}`);
        assert.equal(r.code, 0, text);
        if (format === 'gemini') assert.equal(r.stdout, '{}\n');
        if (['codex', 'copilot', 'opencode', 'windsurf'].includes(format)) assert.equal(r.stdout, '', 'allow prints nothing');
      } else {
        assert.equal(got, 'deny', `${JSON.stringify(payload)} -> ${text}`);
        assert.match(text, new RegExp(`HADES guard: ${expect.replace('.', '\\.')}`), text);
        if (['codex', 'copilot', 'opencode', 'gemini'].includes(format)) assert.equal(r.code, 2);
        if (format === 'windsurf') assert.equal(JSON.parse(r.stdout).decision, 'block');
        if (format === 'cline') assert.equal(r.code, 0, 'cline reads the cancel flag');
      }
    });
  }

  test('blocks are logged with the format', async () => {
    await runGuard(['--format', 'codex'], { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: P() });
    const lines = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.format === 'codex' && l.rule === 'git.push'), JSON.stringify(lines.slice(-3)));
  });

  test('--format=<platform> spelling works; an unknown format blocks', async () => {
    const r = await runGuard(['--format=codex'], { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: P() });
    assert.equal(r.code, 2);
    const bad = await runGuard(['--format', 'vim'], { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /guard\.config: unknown --format "vim"/);
  });

  test('HADES_GUARD=off answers allow in the platform contract', async () => {
    const r = await runGuard(['--format', 'cursor'], { hook_event_name: 'beforeShellExecution', command: 'git push' }, { HADES_GUARD: 'off' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"permission":"allow"}\n');
    assert.match(r.stderr, /HADES_GUARD=off/);
  });

  test('unparseable input: fail closed on high-risk words, open otherwise, in the platform contract', async () => {
    const risky = await runGuard(['--format', 'cline'], '{not json git push');
    assert.equal(risky.code, 0);
    assert.equal(JSON.parse(risky.stdout).cancel, true);
    assert.match(JSON.parse(risky.stdout).errorMessage, /guard\.error/);
    const plain = await runGuard(['--format', 'cursor'], '{not json at all');
    assert.equal(plain.code, 0);
    assert.equal(JSON.parse(plain.stdout).permission, 'allow');
    assert.match(plain.stderr, /fail-open/);
  });

  test('the Claude Code contract is unchanged without --format', async () => {
    const block = await runGuard([], { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: P() });
    assert.equal(block.code, 2);
    assert.equal(block.stdout, '');
    assert.match(block.stderr, /^HADES guard: git\.push:/);
    const ok = await runGuard([], { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: P() });
    assert.deepEqual([ok.code, ok.stdout, ok.stderr], [0, '', '']);
  });
});
