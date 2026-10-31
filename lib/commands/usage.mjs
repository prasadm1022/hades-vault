// hades usage --task <task> [--session <id,...>]      tokens + estimated cost of a task window, stored in state.json
// hades usage [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--no-ccusage]   daily report (ccusage, else own parser)
import { print, output, fail, run as runCmd, allowFlags } from '../core/util.mjs';
import { resolveTask, loadState, updateState } from '../core/task.mjs';
import {
  claudeDataDirs,
  computeTaskUsage,
  listTranscriptFiles,
  loadEntries,
  dailyUsage,
  localDate,
  fmtTokens,
  fmtUsd,
  PRICING_NOTE,
} from '../core/usage.mjs';

export const needsVault = false;
export const FLAGS = ['task', 'session', 'since', 'until', 'noCcusage'];
export const BOOLEAN_FLAGS = ['noCcusage'];

const HELP = `hades usage --task <task> [--session <id,...>] [--json]
  Tokens by model and estimated cost for the task window (state.opened .. state.closed or now),
  read from Claude Code transcripts (CLAUDE_CONFIG_DIR, ~/.config/claude, ~/.claude) incl. subagents.
  Stored in state.json "usage". Every session active inside the window is counted: parallel
  sessions overlap; use --session to keep only given session IDs.
hades usage [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--no-ccusage] [--json]
  Daily report via ccusage (offline prices); falls back to the built-in parser. Default: last 7 days.`;

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) return print(HELP);
  if (args.flags.task !== undefined) return taskUsage(args, ctx);
  return periodUsage(args, ctx);
}

function sessionsFlag(args) {
  const s = args.flags.session;
  if (s === undefined) return null;
  if (s === true || !String(s).trim()) fail('--session needs one or more session IDs (comma-separated)');
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function taskUsage(args, ctx) {
  const id = args.flags.task;
  if (id === true || !String(id).trim()) fail('--task needs a task ID, e.g. --task portal-012');
  if (!ctx.registry) fail(`no vault at ${ctx.vault}. Run "hades init --vault <path>" first.`);
  const task = resolveTask(ctx, String(id));
  const state = loadState(task);
  const dirs = claudeDataDirs();
  if (dirs.length === 0) fail('no Claude data directory with projects/ found (CLAUDE_CONFIG_DIR, ~/.config/claude, ~/.claude)');
  // The transcript scan runs outside the lock; only the store is a locked read-modify-write.
  const usage = computeTaskUsage(state, { sessions: sessionsFlag(args), dirs });
  updateState(task, (s) => {
    s.usage = usage;
  });
  output(args, usage, formatTaskUsage(task.id, usage));
}

export function formatTaskUsage(id, u) {
  const lines = [];
  const end = u.window.open ? `${u.window.end} (open)` : u.window.end;
  const filter = u.session_filter ? `, sessions ${u.session_filter.join(',')}` : '';
  lines.push(`usage ${id}: ${u.window.start} .. ${end}; ${u.sessions} session(s), ${u.totals.messages} messages${filter}`);
  const models = Object.entries(u.by_model).sort((a, b) => (b[1].cost_usd ?? -1) - (a[1].cost_usd ?? -1) || b[1].total_tokens - a[1].total_tokens);
  for (const [model, r] of models.slice(0, 3)) {
    lines.push(
      `  ${model}: in ${fmtTokens(r.input_tokens)} out ${fmtTokens(r.output_tokens)} cache w ${fmtTokens(r.cache_creation_tokens)} r ${fmtTokens(r.cache_read_tokens)} ${r.cost_usd === null ? 'tokens only' : `~${fmtUsd(r.cost_usd)}`}`,
    );
  }
  const more = models.length > 3 ? ` incl. ${models.length - 3} more model(s) (--json)` : '';
  const unpriced = u.unpriced_models.length ? `; unpriced: ${u.unpriced_models.join(', ')}` : '';
  lines.push(`total: ${fmtTokens(u.totals.total_tokens)} tokens${more} ~${fmtUsd(u.cost_usd_estimate)} (${PRICING_NOTE}${unpriced})`);
  if (!u.session_filter) lines.push('note: parallel sessions inside the window are included; --session <id> narrows it');
  return lines.join('\n');
}

function normDate(v, name) {
  if (v === undefined) return null;
  const s = String(v);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m || Number.isNaN(Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`))) fail(`--${name} must be YYYY-MM-DD, got "${s}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function periodUsage(args, ctx) {
  const until = normDate(args.flags.until, 'until');
  const since = normDate(args.flags.since, 'since') || localDate(Date.now() - 6 * 86400000);
  if (until && since > until) fail('--since is after --until');
  let report = null;
  let reason = 'disabled by --no-ccusage';
  if (!args.flags.noCcusage) {
    const res = await ccusageDaily(ctx, since, until);
    if (res.ok) report = res.report;
    else reason = res.reason;
  }
  if (!report) {
    const dirs = claudeDataDirs();
    if (dirs.length === 0) fail('no Claude data directory with projects/ found (CLAUDE_CONFIG_DIR, ~/.config/claude, ~/.claude)');
    const startMs = Date.parse(`${since}T00:00:00`) - 86400000;
    const entries = loadEntries(listTranscriptFiles(dirs, { since: startMs }));
    const d = dailyUsage(entries, { since, until });
    report = { source: `hades transcripts (ccusage: ${reason})`, since, until, ...d };
  }
  output(args, report, formatDaily(report));
}

export function formatDaily(r) {
  const lines = [`usage ${r.since}..${r.until || 'today'} (source: ${r.source})`];
  for (const d of r.daily) {
    const unpriced = d.unpriced_models && d.unpriced_models.length ? ' +unpriced' : '';
    lines.push(`${d.date}  ${fmtTokens(d.totals.total_tokens).padStart(7)} tok  ${fmtUsd(d.cost_usd_estimate).padStart(9)}${unpriced}  ${shortModels(d.models)}`);
  }
  if (r.daily.length === 0) lines.push('no usage in this period');
  lines.push(`total       ${fmtTokens(r.totals.total_tokens).padStart(7)} tok  ${fmtUsd(r.cost_usd_estimate).padStart(9)}`);
  return lines.join('\n');
}

function shortModels(models) {
  return (models || []).map((m) => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '')).join(', ');
}

// ---- ccusage ----

// resolveTool (lib/core/tools.mjs) returns { cmd, args, via, version, env } and throws when the
// tool is unavailable; a plain path string or { command|bin|path } is accepted as well.
export function toolCommand(resolved) {
  if (!resolved) return null;
  if (typeof resolved === 'string') return { cmd: resolved, args: [] };
  if (typeof resolved !== 'object' || resolved.available === false || resolved.ok === false) return null;
  const cmd = resolved.cmd || resolved.command || resolved.bin || resolved.path || resolved.exe;
  if (!cmd || typeof cmd !== 'string') return null;
  const pre = resolved.args || resolved.prefix || resolved.argv || [];
  return { cmd, args: Array.isArray(pre) ? pre.map(String) : [] };
}

async function ccusageDaily(ctx, since, until) {
  let mod;
  try {
    mod = await import('../core/tools.mjs');
  } catch {
    return { ok: false, reason: 'lib/core/tools.mjs not available' };
  }
  if (typeof mod.resolveTool !== 'function') return { ok: false, reason: 'no resolveTool helper' };
  let resolved;
  try {
    resolved = await mod.resolveTool(ctx, 'ccusage');
  } catch (err) {
    return { ok: false, reason: `not available: ${String(err && err.message ? err.message : err).split('\n')[0]}` };
  }
  // A package-runner fallback (npx) downloads on first use: a usage report must not do that.
  if (resolved && (resolved.via === 'npx' || resolved.via === 'uvx')) return { ok: false, reason: 'not set up locally; run "hades tools setup ccusage"' };
  const tool = toolCommand(resolved);
  if (!tool) return { ok: false, reason: 'not installed; run "hades tools setup ccusage"' };
  const args = [...tool.args, 'claude', 'daily', '--json', '--offline', '--since', since];
  if (until) args.push('--until', until);
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(tool.cmd);
  const res = runCmd(shell ? `"${tool.cmd}"` : tool.cmd, args, {
    cwd: ctx.engine, // never a client project: ccusage auto-loads ./.ccusage/ccusage.json from the cwd
    env:
      typeof mod.mergeEnv === 'function'
        ? mod.mergeEnv(process.env, resolved && resolved.env, { LOG_LEVEL: '0', NO_COLOR: '1' })
        : { ...process.env, ...((resolved && resolved.env) || {}), LOG_LEVEL: '0', NO_COLOR: '1' },
    shell,
    timeout: 120000,
  });
  if (res.code !== 0) return { ok: false, reason: `exit ${res.code}: ${res.stderr.trim().split('\n')[0] || 'no output'}` };
  try {
    return { ok: true, report: fromCcusage(JSON.parse(res.stdout), since, until) };
  } catch (err) {
    return { ok: false, reason: `unreadable JSON (${err.message})` };
  }
}

// ccusage claude daily --json: {"daily":[{date,inputTokens,outputTokens,cacheCreationTokens,
// cacheReadTokens,totalTokens,totalCost,modelsUsed}],"totals":{...}}
export function fromCcusage(data, since, until) {
  const rows = (data.daily || []).map((d) => ({
    date: d.date,
    totals: {
      input_tokens: d.inputTokens || 0,
      output_tokens: d.outputTokens || 0,
      cache_creation_tokens: d.cacheCreationTokens || 0,
      cache_read_tokens: d.cacheReadTokens || 0,
      total_tokens: d.totalTokens || 0,
    },
    models: d.modelsUsed || [],
    cost_usd_estimate: typeof d.totalCost === 'number' ? Math.round(d.totalCost * 10000) / 10000 : null,
    unpriced_models: [],
  }));
  const t = data.totals || {};
  return {
    source: 'ccusage (offline prices)',
    since,
    until,
    daily: rows,
    totals: {
      input_tokens: t.inputTokens || 0,
      output_tokens: t.outputTokens || 0,
      cache_creation_tokens: t.cacheCreationTokens || 0,
      cache_read_tokens: t.cacheReadTokens || 0,
      total_tokens: t.totalTokens || rows.reduce((a, r) => a + r.totals.total_tokens, 0),
    },
    cost_usd_estimate: typeof t.totalCost === 'number' ? Math.round(t.totalCost * 10000) / 10000 : null,
    unpriced_models: t.unpricedModels || [],
  };
}
