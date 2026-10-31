// Tests for hades run: argument building, stream-json progress formatting and the spawn plumbing.
// claude is never started: a fake spawn replays a recorded stream.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const r = await import(pathToFileURL(`${ENGINE}/lib/commands/run.mjs`).href);

const s = (p) => p.replace(/\\/g, '/');
const A = (positional, flags = {}) => ({ positional, flags, rest: [] });

// A recorded "claude -p ... --output-format stream-json --verbose" run (trimmed).
const STREAM = [
  { type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-4-6', cwd: 'C:/ws', tools: ['Bash', 'Agent'] },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Dispatching to the team.' }] }, parent_tool_use_id: null, session_id: 's-1' },
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'hades' } }] }, parent_tool_use_id: null },
  { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'node C:/eng/bin/hades.mjs task new app --title "Login"', description: 'new task' } }] }, parent_tool_use_id: null },
  { type: 'assistant', message: { id: 'msg_4', content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'hades-backend-engineer', description: 'Build W1', prompt: 'HADES task app-001 ...' } }] }, parent_tool_use_id: null },
  { type: 'assistant', message: { id: 'msg_5', content: [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: 'C:\\ws\\app\\src\\auth.ts', old_string: 'a', new_string: 'b' } }] }, parent_tool_use_id: 'tu_agent' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_bash', is_error: true, content: 'Exit code 2\nFAIL gate build' }] }, parent_tool_use_id: null },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'ok' }] }, parent_tool_use_id: 'tu_agent' },
  { type: 'result', subtype: 'success', is_error: false, result: 'Task app-001 done. 2 commits.', total_cost_usd: 1.2345, num_turns: 12, duration_ms: 125000, session_id: 's-1', usage: { input_tokens: 10, output_tokens: 20 } },
];
const RAW = STREAM.map((e) => JSON.stringify(e)).join('\n') + '\n';

const EXPECTED = [
  'started session s-1 (claude-opus-4-6)',
  '  Skill hades',
  '  Bash node .../hades.mjs task new app --title "Login"',
  '  Agent hades-backend-engineer (Build W1)',
  '    Edit .../auth.ts',
  '  ! Bash error: Exit code 2 FAIL gate build',
  'RESULT:',
  'Task app-001 done. 2 commits.',
  'cost $1.23, 12 turns, 2 min, session s-1',
];

describe('arguments', () => {
  test('prompt with and without a team', () => {
    assert.equal(r.buildPrompt('app', '  build the login page '), '/hades app build the login page');
    assert.equal(r.buildPrompt(null, 'build it'), '/hades build it');
  });

  test('options are validated', () => {
    assert.deepEqual(r.parseRunOptions(A(['build', 'it'], { team: 'app', model: 'opus', maxBudgetUsd: '5', maxTurns: '40', dryRun: true })), {
      requirements: 'build it',
      team: 'app',
      model: 'opus',
      maxBudgetUsd: 5,
      maxTurns: 40,
      dryRun: true,
    });
    assert.throws(() => r.parseRunOptions(A([])), /usage: hades run/);
    assert.throws(() => r.parseRunOptions(A(['x'], { maxBudgetUsd: '-1' })), /--max-budget-usd needs a positive number/);
    assert.throws(() => r.parseRunOptions(A(['x'], { maxTurns: '2.5' })), /--max-turns needs a positive integer/);
    assert.throws(() => r.parseRunOptions(A(['x'], { model: 'opus; rm -rf' })), /--model needs/);
    assert.throws(() => r.parseRunOptions(A(['x'], { team: true })), /--team needs/);
  });

  test('claude flags: bypassPermissions, stream-json, verbose, optional limits', () => {
    assert.deepEqual(r.buildClaudeFlags({ model: null, maxBudgetUsd: null, maxTurns: null }), ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose']);
    assert.deepEqual(r.buildClaudeFlags({ model: 'sonnet', maxBudgetUsd: 2.5, maxTurns: 30 }).slice(6), ['--model', 'sonnet', '--max-budget-usd', '2.5', '--max-turns', '30']);
    const line = r.commandLine('claude', '/hades app do it', r.buildClaudeFlags({ maxBudgetUsd: 5 }));
    assert.equal(line, 'claude -p "/hades app do it" --permission-mode bypassPermissions --output-format stream-json --verbose --max-budget-usd 5');
  });

  test('executable lookup prefers .exe, then .cmd, never an extensionless shim', () => {
    const where = (stdout) => () => ({ code: 0, stdout, stderr: '' });
    assert.equal(r.findExecutable('claude', { platform: 'win32', runner: where('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n') }), 'C:\\npm\\claude.cmd');
    assert.equal(r.findExecutable('claude', { platform: 'win32', runner: where('C:\\npm\\claude.cmd\r\nC:\\bin\\claude.exe\r\n') }), 'C:\\bin\\claude.exe');
    assert.equal(r.findExecutable('claude', { platform: 'win32', runner: () => ({ code: 1, stdout: '', stderr: '' }) }), null);
    assert.equal(r.needsShell('C:/npm/claude.cmd', 'win32'), true);
    assert.equal(r.needsShell('C:/bin/claude.exe', 'win32'), false);
    assert.equal(r.needsShell('/usr/bin/claude.cmd', 'linux'), false);
  });
});

describe('progress formatting', () => {
  test('one line per tool call, errors, final result and cost', () => {
    const p = r.createStreamParser();
    const lines = [];
    // feed in awkward chunks: split inside JSON lines
    for (let i = 0; i < RAW.length; i += 37) lines.push(...p.push(RAW.slice(i, i + 37)));
    lines.push(...p.end());
    assert.deepEqual(lines, EXPECTED);
    assert.equal(p.state.result.is_error, false);
    assert.equal(r.exitCodeFor(p.state.result, 0), 0);
  });

  test('tool descriptions', () => {
    assert.equal(r.describeToolUse('Read', { file_path: '/home/me/proj/src/a.ts' }), 'Read .../a.ts');
    assert.equal(r.describeToolUse('Grep', { pattern: 'TODO', path: 'src' }), 'Grep TODO in src');
    assert.equal(r.describeToolUse('Task', { description: 'scan' }), 'Agent general-purpose (scan)');
    assert.equal(r.describeToolUse('WebFetch', { url: 'https://example.com/a/b' }), 'WebFetch https://example.com/a/b');
    assert.equal(r.describeToolUse('mcp__serena__find_symbol', { name_path: 'Foo/bar' }), 'mcp__serena__find_symbol Foo/bar');
    assert.equal(r.describeToolUse('TodoWrite', { todos: [] }), 'TodoWrite');
    assert.ok(r.describeToolUse('Bash', { command: 'x'.repeat(300) }).length <= 100);
  });

  test('error results and missing results map to exit 1; non-JSON lines are shown', () => {
    const p = r.createStreamParser();
    const lines = p.push('warning: something\n{"type":"result","is_error":true,"subtype":"error_max_budget_usd","total_cost_usd":5,"num_turns":3}\n');
    assert.deepEqual(lines.slice(0, 3), ['warning: something', 'RESULT (error):', '(no result text: error_max_budget_usd)']);
    assert.equal(r.exitCodeFor(p.state.result, 1), 1);
    assert.equal(r.exitCodeFor(null, 0), 1);
    assert.equal(r.exitCodeFor({ is_error: false }, 0), 0);
  });
});

describe('streamClaude (fake spawn)', () => {
  let tmp;
  before(() => {
    tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-run-')));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function fakeSpawn(raw, code, calls) {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
      setImmediate(() => {
        child.stdout.write(raw.slice(0, 50));
        child.stdout.end(raw.slice(50));
        child.stderr.end('');
      });
      return child;
    };
  }

  test('native executable: prompt as argument, raw stream saved, progress printed', async () => {
    const calls = [];
    const out = [];
    const logFile = `${tmp}/run1.jsonl`;
    const flags = r.buildClaudeFlags({});
    const code = await r.streamClaude({ claude: '/usr/bin/claude', prompt: '/hades app x', flags, cwd: tmp, logFile, onLine: (l) => out.push(l), spawnFn: fakeSpawn(RAW, 0, calls) });
    assert.equal(code, 0);
    assert.deepEqual(out, EXPECTED);
    assert.equal(fs.readFileSync(logFile, 'utf8'), RAW);
    assert.equal(calls[0].cmd, '/usr/bin/claude');
    assert.deepEqual(calls[0].args, ['-p', '/hades app x', ...flags.slice(1)]);
    assert.equal(calls[0].opts.cwd, tmp);
    assert.equal(calls[0].opts.shell, undefined);
  });

  test('a run that dies without a result exits 1 with a FAIL line', async () => {
    const out = [];
    const code = await r.streamClaude({
      claude: '/usr/bin/claude',
      prompt: 'p',
      flags: r.buildClaudeFlags({}),
      cwd: tmp,
      logFile: `${tmp}/run2.jsonl`,
      onLine: (l) => out.push(l),
      spawnFn: fakeSpawn(`${JSON.stringify(STREAM[0])}\n`, 3, []),
    });
    assert.equal(code, 1);
    assert.match(out[out.length - 1], /^FAIL claude exited 3 without a result/);
  });
});

describe('command (subprocess, temp vault)', () => {
  let tmp;
  before(() => {
    tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-run-')));
    fs.mkdirSync(`${tmp}/vault`, { recursive: true });
    fs.writeFileSync(`${tmp}/vault/registry.json`, JSON.stringify({ version: 3, organizations: {}, teams: { app: { organization: 'acme', type: 'main', project_path: `${tmp}/app`, team_dir: 'organizations/acme/teams/app', aliases: ['the-app'] } } }));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const hades = (...args) =>
    spawnSync(process.execPath, [`${ENGINE}/bin/hades.mjs`, 'run', ...args], { encoding: 'utf8', env: { ...process.env, HADES_VAULT: `${tmp}/vault`, HADES_WORKSPACE: tmp } });

  test('--dry-run prints cwd and the claude command; nothing is started', () => {
    const res = hades('build the login page', '--team', 'the-app', '--max-budget-usd', '5', '--dry-run');
    assert.equal(res.status, 0, res.stderr);
    const [cwd, cmdLine] = res.stdout.split('\n');
    assert.equal(cwd, `cwd ${tmp}`);
    assert.match(cmdLine, /claude(\.exe|\.cmd)?"? -p "\/hades the-app build the login page" --permission-mode bypassPermissions --output-format stream-json --verbose --max-budget-usd 5$/);
    assert.ok(!fs.existsSync(`${tmp}/.hades`));
  });

  test('unknown team fails clearly', () => {
    const res = hades('x', '--team', 'nope', '--dry-run');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /unknown team "nope"/);
  });
});
