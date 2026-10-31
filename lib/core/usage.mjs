// Token usage from Claude Code transcripts (~/.claude/projects/**/*.jsonl), without ccusage.
// Field handling and de-duplication follow ccusage v20 (rust/adapters/claude/src/lib.rs,
// rust/crates/ccusage-core/src/types.rs, rust/adapters/claude/src/paths.rs):
// - a usage line has a string `timestamp` and `message.usage` with numeric input/output tokens;
// - lines with a non-semver `version` or an empty sessionId/requestId/message.id/model are skipped;
// - cache writes = usage.cache_creation.ephemeral_5m + ephemeral_1h when that object exists,
//   otherwise usage.cache_creation_input_tokens;
// - "<synthetic>" models are dropped (zero-token placeholders); speed "fast" gets a "-fast" suffix;
// - advisor iterations (usage.iterations[type=advisor_message]) count as their own entries;
// - duplicates (Claude Code writes one line per content block) collapse on message.id + requestId,
//   or message.id + session (+ timestamp for non "msg_" ids) when there is no requestId; sidechain
//   replays of a parent message collapse too. The survivor is the non-sidechain copy, then the one
//   with more tokens (later streaming chunks carry the final output count).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, slash } from './util.mjs';

export const PRICING_FILE = slash(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pricing.json'));
export const PRICING_NOTE = 'estimate; edit lib/core/pricing.json';
const MTIME_MARGIN_MS = 5 * 60 * 1000;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function expandHome(p, env) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(homeDir(env), p.slice(1)) : p;
}

// Claude data roots that contain projects/. Same rules as ccusage: CLAUDE_CONFIG_DIR is a
// comma-separated list (each entry a config dir or its projects/ dir) and, when set, is the only
// source; otherwise $XDG_CONFIG_HOME/claude (default ~/.config/claude) and ~/.claude.
export function claudeDataDirs(env = process.env) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const abs = slash(path.resolve(p));
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (!seen.has(key) && isDir(path.join(abs, 'projects'))) {
      seen.add(key);
      out.push(abs);
    }
  };
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) {
    for (const raw of env.CLAUDE_CONFIG_DIR.split(',').map((s) => s.trim()).filter(Boolean)) {
      let p = expandHome(raw, env);
      if (path.basename(p) === 'projects' && isDir(p)) p = path.dirname(p);
      add(p);
    }
    return out;
  }
  const home = homeDir(env);
  add(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude'));
  add(path.join(home, '.claude'));
  return out;
}

// Every *.jsonl under <dir>/projects (subagent transcripts included). With `since` (ms), files
// last written before the window are skipped: transcripts are append-only.
export function listTranscriptFiles(dirs, { since = null } = {}) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (since !== null) {
          try {
            if (fs.statSync(p).mtimeMs < since - MTIME_MARGIN_MS) continue;
          } catch {
            continue;
          }
        }
        files.push(slash(p));
      }
    }
  };
  for (const d of dirs) walk(path.join(d, 'projects'));
  return files.sort();
}

// <projects>/<project>/<session>.jsonl or <projects>/<project>/<session>/subagents/<agent>.jsonl
export function sessionFromPath(file) {
  const parts = slash(file).split('/');
  const i = parts.lastIndexOf('projects');
  const rel = i >= 0 ? parts.slice(i + 1) : parts;
  const base = rel[rel.length - 1].replace(/\.jsonl$/, '');
  if (rel.length >= 4 && rel[rel.length - 2] === 'subagents') {
    return { sessionId: rel[rel.length - 3], project: rel.slice(0, rel.length - 3).join('/') || 'unknown' };
  }
  return { sessionId: base, project: rel.length >= 2 ? rel[0] : 'unknown' };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function tokensOf(u) {
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const write = cc ? num(cc.ephemeral_5m_input_tokens) + write1h : num(u.cache_creation_input_tokens);
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_creation_tokens: write,
    cache_creation_1h_tokens: write1h,
    cache_read_tokens: num(u.cache_read_input_tokens),
  };
}

function tokenTotal(t) {
  return t.input_tokens + t.output_tokens + t.cache_creation_tokens + t.cache_read_tokens;
}

// One transcript line -> zero or more usage entries.
export function parseUsageLine(line, fileInfo = { sessionId: 'unknown', project: 'unknown' }) {
  if (!line || !line.includes('"usage"')) return [];
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const msg = o && typeof o === 'object' ? o.message : null;
  const u = msg && typeof msg === 'object' ? msg.usage : null;
  if (!u || typeof u !== 'object') return [];
  if (typeof o.timestamp !== 'string') return [];
  const ts = Date.parse(o.timestamp);
  if (Number.isNaN(ts)) return [];
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return [];
  if (o.version != null && !/^\d+\.\d+\.\d+/.test(String(o.version))) return [];
  if (o.sessionId === '' || o.requestId === '' || msg.id === '' || msg.model === '') return [];
  if (msg.model === '<synthetic>') return [];
  const messageId = typeof msg.id === 'string' ? msg.id : null;
  const base = {
    messageId,
    requestId: typeof o.requestId === 'string' ? o.requestId : null,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : fileInfo.sessionId,
    project: fileInfo.project,
    timestamp: ts,
    isSidechain: o.isSidechain === true,
    hasSpeed: typeof u.speed === 'string',
  };
  let model = typeof msg.model === 'string' ? msg.model : 'unknown';
  if (u.speed === 'fast') model = `${model}-fast`;
  const out = [{ ...base, model, tokens: tokensOf(u) }];
  if (Array.isArray(u.iterations) && line.includes('"advisor_message"')) {
    const advisors = u.iterations.filter(
      (it) => it && it.type === 'advisor_message' && typeof it.model === 'string' && it.model && typeof it.input_tokens === 'number' && typeof it.output_tokens === 'number',
    );
    advisors.forEach((it, index) => {
      out.push({ ...base, messageId: messageId ? `${messageId}:advisor:${index}` : null, model: it.model, hasSpeed: false, tokens: tokensOf(it) });
    });
  }
  return out;
}

export function readTranscript(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const info = sessionFromPath(file);
  const out = [];
  for (const line of text.split('\n')) out.push(...parseUsageLine(line, info));
  return out;
}

function shouldReplace(candidate, existing) {
  if (candidate.isSidechain !== existing.isSidechain) return existing.isSidechain;
  const c = tokenTotal(candidate.tokens);
  const e = tokenTotal(existing.tokens);
  if (c !== e) return c > e;
  return candidate.hasSpeed && !existing.hasSpeed;
}

function exactKey(e) {
  if (e.requestId) return `${e.messageId}\u0000r\u0000${e.requestId}`;
  const scoped = `${e.messageId}\u0000s\u0000${e.sessionId}`;
  return e.messageId.startsWith('msg_') ? scoped : `${scoped}\u0000${e.timestamp}`;
}

export function dedupEntries(entries) {
  const out = [];
  const exact = new Map();
  const replay = new Map();
  const register = (map, key, idx) => {
    const list = map.get(key);
    if (!list) map.set(key, [idx]);
    else if (!list.includes(idx)) list.push(idx);
  };
  const index = (e, idx) => {
    register(exact, exactKey(e), idx);
    register(replay, `${e.messageId}\u0000${e.sessionId}`, idx);
  };
  for (const e of entries) {
    if (!e.messageId) {
      out.push(e);
      continue;
    }
    let idx = (exact.get(exactKey(e)) || [])[0];
    if (idx === undefined) {
      // A sidechain replay of a parent message: same message and session, a sidechain on at least
      // one side, and the same timestamp unless both lines lack a requestId.
      idx = (replay.get(`${e.messageId}\u0000${e.sessionId}`) || []).find((i) => {
        const x = out[i];
        const requestless = !e.requestId && !x.requestId;
        return x.messageId === e.messageId && (requestless || x.timestamp === e.timestamp) && (e.isSidechain || x.isSidechain);
      });
    }
    if (idx !== undefined) {
      if (shouldReplace(e, out[idx])) {
        out[idx] = e;
        index(e, idx);
      }
      continue;
    }
    out.push(e);
    index(e, out.length - 1);
  }
  return out;
}

export function loadEntries(files) {
  const all = [];
  for (const f of files) all.push(...readTranscript(f));
  return dedupEntries(all);
}

function emptyTokens() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_creation_1h_tokens: 0, cache_read_tokens: 0, total_tokens: 0, messages: 0 };
}

function addTokens(acc, t) {
  acc.input_tokens += t.input_tokens;
  acc.output_tokens += t.output_tokens;
  acc.cache_creation_tokens += t.cache_creation_tokens;
  acc.cache_creation_1h_tokens += t.cache_creation_1h_tokens;
  acc.cache_read_tokens += t.cache_read_tokens;
  acc.total_tokens += tokenTotal(t);
  acc.messages += 1;
}

// Entries inside [start, end] (ms, inclusive), optionally limited to some session IDs.
export function filterEntries(entries, { start = null, end = null, sessions = null } = {}) {
  return entries.filter(
    (e) => (start === null || e.timestamp >= start) && (end === null || e.timestamp <= end) && (!sessions || sessions.includes(e.sessionId)),
  );
}

export function summarize(entries) {
  const by_model = {};
  const totals = emptyTokens();
  const sessions = new Set();
  for (const e of entries) {
    if (!by_model[e.model]) by_model[e.model] = emptyTokens();
    addTokens(by_model[e.model], e.tokens);
    addTokens(totals, e.tokens);
    sessions.add(e.sessionId);
  }
  return { by_model, totals, sessions: sessions.size };
}

// ---- pricing ----

export function loadPricing(file = PRICING_FILE) {
  return readJson(file, { models: {}, families: {} });
}

export function normalizeModel(model) {
  return String(model)
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[@-]\d{8}$/, '');
}

// Price row for a model ID, or null when unknown. Fast-mode usage is never priced (different rates).
export function priceFor(model, pricing) {
  if (/-fast$/.test(model)) return null;
  const m = normalizeModel(model);
  const models = (pricing && pricing.models) || {};
  if (models[m]) return models[m];
  const families = (pricing && pricing.families) || {};
  const fam = Object.keys(families).find((f) => m.includes(f));
  return fam ? families[fam] || null : null;
}

// USD for one token bucket, or null when any non-zero token type has no verified price.
export function costFor(t, price) {
  if (!price) return null;
  const parts = [
    [t.input_tokens, price.input],
    [t.output_tokens, price.output],
    [t.cache_creation_tokens - (t.cache_creation_1h_tokens || 0), price.cache_write],
    [t.cache_creation_1h_tokens || 0, price.cache_write_1h],
    [t.cache_read_tokens, price.cache_read],
  ];
  let usd = 0;
  for (const [n, p] of parts) {
    if (!n) continue;
    if (typeof p !== 'number') return null;
    usd += (n * p) / 1e6;
  }
  return Math.round(usd * 10000) / 10000;
}

// Adds cost_usd to each model row; returns { cost_usd_estimate, unpriced_models }.
export function applyCosts(by_model, pricing) {
  let total = 0;
  const unpriced = [];
  for (const [model, row] of Object.entries(by_model)) {
    row.cost_usd = costFor(row, priceFor(model, pricing));
    if (row.cost_usd === null) unpriced.push(model);
    else total += row.cost_usd;
  }
  return { cost_usd_estimate: Math.round(total * 10000) / 10000, unpriced_models: unpriced };
}

// ---- task window ----

// Usage record stored in state.json `usage`. Window = state.opened .. (state.closed || now).
export function computeTaskUsage(state, { now = Date.now(), env = process.env, sessions = null, dirs = null, pricing = null } = {}) {
  const start = Date.parse(state.opened);
  if (Number.isNaN(start)) throw new Error(`task ${state.id} has no valid "opened" timestamp`);
  const closed = state.closed ? Date.parse(state.closed) : NaN;
  const end = Number.isNaN(closed) ? now : closed;
  const roots = dirs || claudeDataDirs(env);
  const files = listTranscriptFiles(roots, { since: start });
  const entries = filterEntries(loadEntries(files), { start, end, sessions });
  const { by_model, totals, sessions: sessionCount } = summarize(entries);
  const { cost_usd_estimate, unpriced_models } = applyCosts(by_model, pricing || loadPricing());
  return {
    window: { start: iso(start), end: iso(end), open: Number.isNaN(closed) },
    by_model,
    totals,
    cost_usd_estimate,
    unpriced_models,
    sessions: sessionCount,
    session_filter: sessions || null,
    files_scanned: files.length,
    note: `${PRICING_NOTE}; every session active inside the window is counted`,
    computed_at: iso(now),
  };
}

// ---- daily (ccusage fallback) ----

export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Rows per local calendar day between since and until (YYYY-MM-DD, inclusive).
export function dailyUsage(entries, { since = null, until = null, pricing = null } = {}) {
  const days = {};
  for (const e of entries) {
    const date = localDate(e.timestamp);
    if ((since && date < since) || (until && date > until)) continue;
    if (!days[date]) days[date] = [];
    days[date].push(e);
  }
  const prices = pricing || loadPricing();
  const rows = Object.keys(days)
    .sort()
    .map((date) => {
      const { by_model, totals } = summarize(days[date]);
      const { cost_usd_estimate, unpriced_models } = applyCosts(by_model, prices);
      return { date, totals, models: Object.keys(by_model).sort(), cost_usd_estimate, unpriced_models };
    });
  const totals = emptyTokens();
  let cost = 0;
  for (const r of rows) {
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
    cost += r.cost_usd_estimate;
  }
  return { daily: rows, totals, cost_usd_estimate: Math.round(cost * 10000) / 10000 };
}

// ---- formatting ----

export function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(x) {
  return x === null || x === undefined ? 'n/a' : `$${Number(x).toFixed(2)}`;
}
