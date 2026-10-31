// hades run "<requirements>" [--team <team>] [--model <alias>] [--max-budget-usd <n>] [--max-turns <n>] [--dry-run]
// Runs the whole pipeline headless: claude -p "/hades ..." --permission-mode bypassPermissions in the
// workspace, prints one line per tool call, saves the raw stream-json to <engine>/.hades/runs/.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { print, fail, output, run as runCmd, which, slash, clip, allowFlags } from '../core/util.mjs';
import { findTeam } from '../core/config.mjs';
import { stamp } from '../core/settings.mjs';

export const needsVault = true;
export const FLAGS = ['team', 'model', 'maxBudgetUsd', 'maxTurns', 'dryRun'];
export const BOOLEAN_FLAGS = ['dryRun'];

const HELP = `hades run "<requirements>" [--team <team>] [--model <alias>] [--max-budget-usd <n>] [--max-turns <n>] [--dry-run]
  Runs "/hades [<team>] <requirements>" with claude -p --permission-mode bypassPermissions
  --output-format stream-json --verbose in the workspace. Prints one line per tool call and the
  final result with its cost; the raw stream is saved to <engine>/.hades/runs/<timestamp>.jsonl.
  Exit 0 when the run ends without error. permissions.deny rules and the guard hook still apply.`;

// ---- process helpers (also used by doctor) ----

// Resolves an executable on PATH. On Windows "where" can list an extensionless npm shim first,
// which CreateProcess cannot start: prefer .exe, then .cmd/.bat.
export function findExecutable(cmd, { platform = process.platform, runner = runCmd } = {}) {
  if (platform !== 'win32') return which(cmd);
  const res = runner('where', [cmd]);
  if (res.code !== 0) return null;
  const lines = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.(cmd|bat)$/i.test(l)) || lines.find((l) => /\.com$/i.test(l)) || null;
}

export function needsShell(file, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

// Only plain arguments may pass through cmd.exe (used for .cmd shims, with arguments built here).
function shellSafe(a) {
  const s = String(a);
  if (/^[A-Za-z0-9._:/\\=@+,-]+$/.test(s)) return s;
  if (/["%!^&|<>\r\n]/.test(s)) fail(`argument not safe for a .cmd launcher: ${s.slice(0, 40)}`);
  return `"${s}"`;
}

// Synchronous run of a resolved executable (native or .cmd shim).
export function execFile(file, args, opts = {}) {
  if (needsShell(file)) return runCmd(`"${file}"`, args.map(shellSafe), { ...opts, shell: true });
  return runCmd(file, args, opts);
}

// ---- argument building ----

export function buildPrompt(team, requirements) {
  const req = String(requirements).trim();
  return team ? `/hades ${team} ${req}` : `/hades ${req}`;
}

export function parseRunOptions(args) {
  const f = args.flags;
  const requirements = args.positional.join(' ').trim();
  if (!requirements) fail('usage: hades run "<requirements>" [--team <team>] [--model <alias>] [--max-budget-usd <n>] [--max-turns <n>] [--dry-run]');
  const opts = { requirements, team: null, model: null, maxBudgetUsd: null, maxTurns: null, dryRun: !!f.dryRun };
  if (f.team !== undefined) {
    if (f.team === true || !String(f.team).trim()) fail('--team needs a team name or alias');
    opts.team = String(f.team).trim();
  }
  if (f.model !== undefined) {
    if (f.model === true || !/^[A-Za-z0-9._[\]-]+$/.test(String(f.model))) fail('--model needs a model alias or ID (e.g. opus, sonnet)');
    opts.model = String(f.model);
  }
  if (f.maxBudgetUsd !== undefined) {
    const n = Number(f.maxBudgetUsd);
    if (!Number.isFinite(n) || n <= 0) fail('--max-budget-usd needs a positive number');
    opts.maxBudgetUsd = n;
  }
  if (f.maxTurns !== undefined) {
    const n = Number(f.maxTurns);
    if (!Number.isInteger(n) || n <= 0) fail('--max-turns needs a positive integer');
    opts.maxTurns = n;
  }
  return opts;
}

// Flags for claude. The prompt is not included: it goes as the positional argument for native
// executables and through stdin for .cmd shims (so no user text ever reaches a shell).
export function buildClaudeFlags(opts) {
  const flags = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose'];
  if (opts.model) flags.push('--model', opts.model);
  if (opts.maxBudgetUsd !== null && opts.maxBudgetUsd !== undefined) flags.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.maxTurns !== null && opts.maxTurns !== undefined) flags.push('--max-turns', String(opts.maxTurns));
  return flags;
}

function quoteForDisplay(s) {
  return /^[A-Za-z0-9._:/\\=@+,-]+$/.test(s) ? s : JSON.stringify(s);
}

export function commandLine(claude, prompt, flags) {
  return [claude || 'claude', flags[0], quoteForDisplay(prompt), ...flags.slice(1).map(quoteForDisplay)].join(' ');
}

// ---- stream-json progress ----

function shortPaths(s) {
  return String(s).replace(/(?<=^|[\s"'=(])(?:[A-Za-z]:)?(?:[\\/][^\s"'\\/]+)*[\\/]([^\s"'\\/]+)/g, (m, last) => (/[\\/].*[\\/]/.test(m) ? `.../${last}` : m));
}

function oneLine(s, max = 100) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export function describeToolUse(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Agent':
    case 'Task':
      return oneLine(`Agent ${i.subagent_type || 'general-purpose'}${i.description ? ` (${i.description})` : ''}`);
    case 'Bash':
    case 'PowerShell':
      return oneLine(`${name} ${shortPaths(i.command || '')}`);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(`${name} ${shortPaths(i.file_path || i.notebook_path || '')}`);
    case 'Glob':
    case 'Grep':
      return oneLine(`${name} ${i.pattern || ''}${i.path ? ` in ${shortPaths(i.path)}` : ''}`);
    case 'WebFetch':
      return oneLine(`WebFetch ${i.url || ''}`);
    case 'WebSearch':
      return oneLine(`WebSearch ${i.query || ''}`);
    case 'Skill':
      return oneLine(`Skill ${i.skill || i.name || ''}`);
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string' && v.trim());
      return oneLine(first ? `${name} ${shortPaths(first)}` : name);
    }
  }
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
  return '';
}

// One stream-json event -> zero or more progress lines. `st` carries tool names by id and the result.
export function formatEvent(ev, st) {
  if (!ev || typeof ev !== 'object') return [];
  const indent = ev.parent_tool_use_id ? '    ' : '  ';
  if (ev.type === 'system' && ev.subtype === 'init') {
    st.sessionId = ev.session_id || st.sessionId;
    return [`started session ${ev.session_id || '?'}${ev.model ? ` (${ev.model})` : ''}`];
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const lines = [];
    for (const b of ev.message.content) {
      if (b && b.type === 'tool_use') {
        st.tools[b.id] = b.name;
        lines.push(`${indent}${describeToolUse(b.name, b.input)}`);
      }
    }
    return lines;
  }
  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    const lines = [];
    for (const b of ev.message.content) {
      if (b && b.type === 'tool_result' && b.is_error) {
        lines.push(`${indent}! ${st.tools[b.tool_use_id] || 'tool'} error: ${oneLine(shortPaths(resultText(b)), 120)}`);
      }
    }
    return lines;
  }
  if (ev.type === 'result') {
    st.result = ev;
    const lines = [];
    const text = typeof ev.result === 'string' && ev.result.trim() ? clip(ev.result, { head: 30, tail: 10 }) : `(no result text${ev.subtype ? `: ${ev.subtype}` : ''})`;
    lines.push(ev.is_error ? 'RESULT (error):' : 'RESULT:', text);
    const cost = typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(2)}` : 'n/a';
    const mins = typeof ev.duration_ms === 'number' ? `, ${Math.round(ev.duration_ms / 60000)} min` : '';
    lines.push(`cost ${cost}, ${ev.num_turns ?? '?'} turns${mins}, session ${ev.session_id || st.sessionId || '?'}`);
    return lines;
  }
  return [];
}

// Feeds raw text chunks; returns progress lines for complete JSON lines.
export function createStreamParser() {
  const st = { tools: {}, result: null, sessionId: null, buffer: '' };
  const feedLine = (line) => {
    const t = line.trim();
    if (!t) return [];
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      return [oneLine(t, 200)];
    }
    return formatEvent(ev, st);
  };
  return {
    state: st,
    push(chunk) {
      st.buffer += chunk;
      const parts = st.buffer.split('\n');
      st.buffer = parts.pop();
      return parts.flatMap(feedLine);
    },
    end() {
      const rest = st.buffer;
      st.buffer = '';
      return feedLine(rest);
    },
  };
}

export function exitCodeFor(result, childCode) {
  if (!result) return 1;
  return result.is_error ? 1 : childCode && childCode !== 0 ? 1 : 0;
}

// ---- command ----

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) return print(HELP);
  const opts = parseRunOptions(args);
  if (opts.team && !findTeam(ctx.registry, opts.team)) fail(`unknown team "${opts.team}" (hades team list); omit --team to let the PM resolve or create one`);
  const prompt = buildPrompt(opts.team, opts.requirements);
  const flags = buildClaudeFlags(opts);
  const claude = findExecutable('claude');
  if (opts.dryRun) {
    const plan = { cwd: ctx.workspace, command: commandLine(claude ? slash(claude) : 'claude', prompt, flags), claude: claude ? slash(claude) : null };
    return output(args, plan, `cwd ${plan.cwd}\n${plan.command}${claude ? '' : '\nWARN claude CLI not found on PATH'}`);
  }
  if (!claude) fail('claude CLI not found on PATH -> install Claude Code (https://code.claude.com) and re-run');
  if (!fs.existsSync(ctx.workspace)) fail(`workspace not found: ${ctx.workspace} (hades init --workspace <path>)`);
  const runsDir = `${ctx.engine}/.hades/runs`;
  fs.mkdirSync(runsDir, { recursive: true });
  const logFile = `${runsDir}/${stamp()}.jsonl`;
  print(`hades run: ${oneLine(prompt, 120)}`);
  print(`cwd ${ctx.workspace}; log ${logFile}`);
  const code = await streamClaude({ claude, prompt, flags, cwd: ctx.workspace, logFile, onLine: print });
  process.exitCode = code;
}

// Spawns claude, tees stdout to the log file and prints progress. Resolves to the exit code.
export function streamClaude({ claude, prompt, flags, cwd, logFile, onLine, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const shell = needsShell(claude);
    const child = shell
      ? spawnFn(`"${claude}"`, flags.map(shellSafe), { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawnFn(claude, [flags[0], prompt, ...flags.slice(1)], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (shell) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
    const log = fs.openSync(logFile, 'a');
    const parser = createStreamParser();
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      fs.writeSync(log, chunk);
      for (const l of parser.push(chunk)) onLine(l);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr = (stderr + c).slice(-4000);
    });
    const finish = (codeOrErr) => {
      for (const l of parser.end()) onLine(l);
      fs.closeSync(log);
      const childCode = typeof codeOrErr === 'number' ? codeOrErr : 1;
      if (!parser.state.result) {
        const why = codeOrErr instanceof Error ? codeOrErr.message : `claude exited ${childCode} without a result`;
        onLine(`FAIL ${why}${stderr.trim() ? `: ${oneLine(stderr, 300)}` : ''}`);
      }
      resolve(exitCodeFor(parser.state.result, childCode));
    };
    let done = false;
    child.on('error', (err) => {
      if (!done) {
        done = true;
        finish(err);
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        finish(code === null ? 1 : code);
      }
    });
  });
}

