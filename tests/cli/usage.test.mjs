// Tests for transcript parsing (lib/core/usage.mjs) and hades usage. Fixture transcripts live in
// tests/fixtures/usage/claude/projects and contain streaming duplicates, a subagent transcript,
// a sidechain replay, progress/synthetic/invalid lines and entries outside the window.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const FIXTURE = `${ENGINE}/tests/fixtures/usage/claude`;
const u = await import(pathToFileURL(`${ENGINE}/lib/core/usage.mjs`).href);
const cmd = await import(pathToFileURL(`${ENGINE}/lib/commands/usage.mjs`).href);

const s = (p) => p.replace(/\\/g, '/');

// Fixed prices so the test does not depend on edits to lib/core/pricing.json.
const PRICING = {
  models: {
    'claude-opus-4-6': { input: 5, output: 25, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5 },
    'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_write_1h: 6, cache_read: 0.3 },
    'claude-fable-5-1': { input: 10, output: 50, cache_write: 12.5, cache_write_1h: 20, cache_read: 0.25 },
    'claude-haiku-5-5': { input: null, output: null, cache_write: null, cache_read: null },
  },
  families: { opus: null, sonnet: null, haiku: null, fable: null },
};

let tmp;
before(() => {
  tmp = s(fs.mkdtempSync(path.join(os.tmpdir(), 'hades-usage-')));
  fs.cpSync(FIXTURE, `${tmp}/claude`, { recursive: true });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('discovery', () => {
  test('CLAUDE_CONFIG_DIR is a comma list; projects/ dirs are accepted; invalid entries dropped', () => {
    const dirs = u.claudeDataDirs({ CLAUDE_CONFIG_DIR: ` ${tmp}/claude/projects , ${tmp}/missing,${tmp}/claude` });
    assert.deepEqual(dirs, [`${tmp}/claude`]);
    assert.deepEqual(u.claudeDataDirs({ CLAUDE_CONFIG_DIR: `${tmp}/missing` }), []);
  });

  test('without CLAUDE_CONFIG_DIR: XDG config dir and ~/.claude', () => {
    fs.mkdirSync(`${tmp}/home/.claude/projects`, { recursive: true });
    fs.mkdirSync(`${tmp}/xdg/claude/projects`, { recursive: true });
    assert.deepEqual(u.claudeDataDirs({ HOME: `${tmp}/home`, XDG_CONFIG_HOME: `${tmp}/xdg` }), [`${tmp}/xdg/claude`, `${tmp}/home/.claude`]);
    assert.deepEqual(u.claudeDataDirs({ HOME: `${tmp}/home` }), [`${tmp}/home/.claude`]);
  });

  test('lists main and subagent transcripts; mtime prunes old files', () => {
    const files = u.listTranscriptFiles([`${tmp}/claude`]).map((f) => f.slice(`${tmp}/claude/projects/`.length));
    assert.deepEqual(files, ['C--work-app/sess-a.jsonl', 'C--work-app/sess-a/subagents/agent-1.jsonl', 'C--work-other/sess-b.jsonl']);
    const old = new Date('2026-09-01T00:00:00Z');
    fs.utimesSync(`${tmp}/claude/projects/C--work-other/sess-b.jsonl`, old, old);
    const pruned = u.listTranscriptFiles([`${tmp}/claude`], { since: Date.parse('2026-10-10T00:00:00Z') });
    assert.equal(pruned.length, 2);
    const now = new Date();
    fs.utimesSync(`${tmp}/claude/projects/C--work-other/sess-b.jsonl`, now, now);
  });

  test('session and project from the path', () => {
    assert.deepEqual(u.sessionFromPath('/x/projects/P/abc.jsonl'), { sessionId: 'abc', project: 'P' });
    assert.deepEqual(u.sessionFromPath('C:/x/projects/P/abc/subagents/agent-1.jsonl'), { sessionId: 'abc', project: 'P' });
  });
});

describe('parsing and de-duplication', () => {
  test('line validity rules', () => {
    const info = { sessionId: 'f', project: 'p' };
    const line = (o) => JSON.stringify({ timestamp: '2026-10-10T10:00:00Z', version: '2.1.0', requestId: 'r', message: { id: 'msg_1', model: 'claude-opus-4-6', usage: { input_tokens: 1, output_tokens: 2 } }, ...o });
    assert.equal(u.parseUsageLine(line({}), info).length, 1);
    assert.equal(u.parseUsageLine(line({}), info)[0].sessionId, 'f', 'falls back to the file session');
    assert.equal(u.parseUsageLine(line({ version: 'x' }), info).length, 0);
    assert.equal(u.parseUsageLine(line({ requestId: '' }), info).length, 0);
    assert.equal(u.parseUsageLine(line({ timestamp: 'nope' }), info).length, 0);
    assert.equal(u.parseUsageLine(line({ message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }), info).length, 0);
    assert.equal(u.parseUsageLine(line({ message: { id: 'm', usage: { input_tokens: 1 } } }), info).length, 0, 'output_tokens required');
    assert.equal(u.parseUsageLine('{"usage": broken', info).length, 0);
  });

  test('cache_creation breakdown wins over cache_creation_input_tokens; fast suffix; advisor entries', () => {
    const [e] = u.parseUsageLine(
      JSON.stringify({ timestamp: '2026-10-10T10:00:00Z', message: { id: 'msg_x', model: 'm', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 999, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 }, speed: 'fast' } } }),
    );
    assert.equal(e.tokens.cache_creation_tokens, 5);
    assert.equal(e.tokens.cache_creation_1h_tokens, 3);
    assert.equal(e.model, 'm-fast');
    const adv = u.parseUsageLine(
      JSON.stringify({
        timestamp: '2026-10-10T10:00:00Z',
        requestId: 'r',
        message: { id: 'msg_y', model: 'claude-sonnet-4-6', usage: { input_tokens: 2, output_tokens: 3, iterations: [{ type: 'message', input_tokens: 1, output_tokens: 1 }, { type: 'advisor_message', model: 'claude-opus-4-6', input_tokens: 50, output_tokens: 7 }] } },
      }),
    );
    assert.equal(adv.length, 2);
    assert.equal(adv[1].model, 'claude-opus-4-6');
    assert.equal(adv[1].messageId, 'msg_y:advisor:0');
    assert.equal(adv[1].tokens.input_tokens, 50);
  });

  test('streaming chunks, subagent duplicates and sidechain replays collapse', () => {
    const entries = u.loadEntries(u.listTranscriptFiles([`${tmp}/claude`]));
    const ids = entries.map((e) => `${e.messageId}|${e.model}`).sort();
    assert.deepEqual(ids, [
      'msg_A1|claude-opus-4-6',
      'msg_A2|claude-opus-4-6',
      'msg_A3|claude-haiku-4-5-20251001',
      'msg_B1|claude-fable-5-1',
      'msg_B2|claude-opus-5-5-fast',
      'msg_S1|claude-sonnet-4-6',
    ]);
    const a1 = entries.find((e) => e.messageId === 'msg_A1');
    assert.equal(a1.tokens.output_tokens, 50, 'the later chunk with more tokens survives');
    assert.equal(a1.isSidechain, false, 'the parent copy survives a sidechain replay');
    assert.equal(entries.find((e) => e.messageId === 'msg_B2').tokens.output_tokens, 3, 'requestless msg_ ids collapse per session');
  });

  test('gateway ids without requestId only collapse at the same timestamp', () => {
    const mk = (ts, out) => ({ messageId: 'gw-1', requestId: null, sessionId: 's', timestamp: ts, isSidechain: false, hasSpeed: false, model: 'm', tokens: { input_tokens: 1, output_tokens: out, cache_creation_tokens: 0, cache_creation_1h_tokens: 0, cache_read_tokens: 0 } });
    assert.equal(u.dedupEntries([mk(1, 1), mk(2, 1)]).length, 2);
    assert.equal(u.dedupEntries([mk(1, 1), mk(1, 4)]).length, 1);
  });
});

describe('task window', () => {
  const state = { id: 'app-001', opened: '2026-10-10T00:00:00Z', closed: '2026-10-11T00:00:00Z' };

  test('sums tokens per model inside the window, with cost estimate', () => {
    const r = u.computeTaskUsage(state, { dirs: [`${tmp}/claude`], pricing: PRICING, now: Date.parse('2026-10-31T00:00:00Z') });
    assert.deepEqual(r.window, { start: '2026-10-10T00:00:00Z', end: '2026-10-11T00:00:00Z', open: false });
    assert.deepEqual(Object.keys(r.by_model).sort(), ['claude-fable-5-1', 'claude-opus-4-6', 'claude-opus-5-5-fast', 'claude-sonnet-4-6']);
    assert.deepEqual(r.by_model['claude-opus-4-6'], {
      input_tokens: 30,
      output_tokens: 80,
      cache_creation_tokens: 600,
      cache_creation_1h_tokens: 300,
      cache_read_tokens: 3000,
      total_tokens: 3710,
      messages: 2,
      cost_usd: 0.0085,
    });
    assert.equal(r.by_model['claude-sonnet-4-6'].total_tokens, 62);
    assert.equal(r.by_model['claude-fable-5-1'].cost_usd, 0.11);
    assert.equal(r.by_model['claude-opus-5-5-fast'].cost_usd, null, 'fast mode is not priced');
    assert.equal(r.totals.total_tokens, 6776);
    assert.equal(r.totals.messages, 5);
    assert.equal(r.sessions, 2);
    assert.equal(r.cost_usd_estimate, 0.1186);
    assert.deepEqual(r.unpriced_models, ['claude-opus-5-5-fast']);
    assert.equal(r.computed_at, '2026-10-31T00:00:00Z');
    assert.match(r.note, /estimate; edit lib\/core\/pricing\.json/);
  });

  test('open task runs to now; --session narrows', () => {
    const open = u.computeTaskUsage({ ...state, closed: null }, { dirs: [`${tmp}/claude`], pricing: PRICING, now: Date.parse('2026-10-31T00:00:00Z') });
    assert.equal(open.window.open, true);
    assert.ok(open.by_model['claude-haiku-4-5-20251001'], 'the 10-12 entry is inside an open window');
    const one = u.computeTaskUsage(state, { dirs: [`${tmp}/claude`], pricing: PRICING, sessions: ['sess-b'] });
    assert.equal(one.totals.total_tokens, 3004);
    assert.equal(one.sessions, 1);
  });

  test('formatTaskUsage stays within 3-6 lines', () => {
    const r = u.computeTaskUsage(state, { dirs: [`${tmp}/claude`], pricing: PRICING });
    const lines = cmd.formatTaskUsage('app-001', r).split('\n');
    assert.ok(lines.length >= 3 && lines.length <= 6, lines.join('\n'));
    assert.match(lines[0], /^usage app-001: 2026-10-10T00:00:00Z \.\. 2026-10-11T00:00:00Z; 2 session\(s\), 5 messages$/);
    assert.match(lines[1], /^  claude-fable-5-1: in 1\.0k out 2\.0k cache w 0 r 0 ~\$0\.11$/);
    assert.ok(lines.some((l) => /^total: 6\.8k tokens incl\. 1 more model\(s\) \(--json\) ~\$0\.12 \(estimate; edit lib\/core\/pricing\.json; unpriced: claude-opus-5-5-fast\)$/.test(l)), lines.join('\n'));
  });
});

describe('pricing', () => {
  test('model id normalisation and lookup', () => {
    assert.equal(u.normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(u.normalizeModel('us.anthropic.claude-opus-4-6-v1:0'), 'claude-opus-4-6');
    assert.equal(u.normalizeModel('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(u.priceFor('claude-opus-4-6-20260101', PRICING).input, 5);
    assert.equal(u.priceFor('claude-opus-9-9', PRICING), null, 'unknown versions fall back to the null family price');
    assert.equal(u.priceFor('claude-opus-4-6-fast', PRICING), null);
  });

  test('cost is null when a used token type has no verified price', () => {
    assert.equal(u.costFor({ input_tokens: 1e6, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }, { input: 3, output: 15, cache_read: null }), 3);
    assert.equal(u.costFor({ input_tokens: 1, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 5 }, { input: 3, output: 15, cache_read: null }), null);
  });

  test('shipped pricing.json is well-formed and marked as an estimate', () => {
    const p = u.loadPricing();
    assert.match(p.$comment, /estimate; edit pricing\.json/);
    for (const [m, row] of Object.entries(p.models)) {
      for (const k of ['input', 'output', 'cache_write', 'cache_read']) assert.ok(row[k] === null || typeof row[k] === 'number', `${m}.${k}`);
    }
    for (const f of ['opus', 'sonnet', 'haiku', 'fable']) assert.ok(f in p.families);
  });
});

describe('daily report', () => {
  test('built-in parser groups by local day and honours since/until', () => {
    const entries = u.loadEntries(u.listTranscriptFiles([`${tmp}/claude`]));
    const all = u.dailyUsage(entries, { pricing: PRICING });
    const days = new Set(entries.map((e) => u.localDate(e.timestamp)));
    assert.equal(all.daily.length, days.size);
    assert.equal(all.totals.total_tokens, entries.reduce((a, e) => a + e.tokens.input_tokens + e.tokens.output_tokens + e.tokens.cache_creation_tokens + e.tokens.cache_read_tokens, 0));
    const last = u.localDate(Date.parse('2026-10-12T09:00:00Z'));
    const only = u.dailyUsage(entries, { since: last, until: last, pricing: PRICING });
    assert.equal(only.daily.length, 1);
    assert.deepEqual(only.daily[0].unpriced_models, ['claude-haiku-4-5-20251001']);
    const text = cmd.formatDaily({ source: 'test', since: last, until: last, ...only });
    assert.match(text.split('\n')[1], new RegExp(`^${last}\\s+110 tok\\s+\\$0\\.00 \\+unpriced  haiku-4-5$`));
  });

  test('ccusage JSON is converted to the same shape', () => {
    const r = cmd.fromCcusage(
      { daily: [{ date: '2026-10-30', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalTokens: 10, totalCost: 1.23456, modelsUsed: ['claude-opus-4-6'] }], totals: { totalTokens: 10, totalCost: 1.23456 } },
      '2026-10-30',
      null,
    );
    assert.equal(r.daily[0].cost_usd_estimate, 1.2346);
    assert.match(cmd.formatDaily(r), /2026-10-30\s+10 tok\s+\$1\.23\s+opus-4-6/);
  });

  test('resolver result shapes', () => {
    assert.deepEqual(cmd.toolCommand({ cmd: 'node', args: ['cli.js'], via: 'local' }), { cmd: 'node', args: ['cli.js'] });
    assert.deepEqual(cmd.toolCommand('/bin/ccusage'), { cmd: '/bin/ccusage', args: [] });
    assert.equal(cmd.toolCommand(null), null);
    assert.equal(cmd.toolCommand({ available: false, cmd: 'x' }), null);
  });
});

describe('command (subprocess, temp vault)', () => {
  function setupVault() {
    const vault = `${tmp}/vault`;
    const teamDir = 'organizations/acme/teams/app';
    fs.mkdirSync(`${vault}/${teamDir}/tasks/app-001-demo`, { recursive: true });
    fs.writeFileSync(
      `${vault}/registry.json`,
      JSON.stringify({ version: 3, organizations: { acme: { org_dir: 'organizations/acme' } }, teams: { app: { organization: 'acme', type: 'main', project_path: tmp, team_dir: teamDir } } }),
    );
    fs.writeFileSync(`${vault}/${teamDir}/tasks/app-001-demo/state.json`, JSON.stringify({ id: 'app-001', team: 'app', opened: '2026-10-10T00:00:00Z', closed: '2026-10-11T00:00:00Z', usage: null }));
    return `${vault}/${teamDir}/tasks/app-001-demo/state.json`;
  }

  const env = () => ({ ...process.env, HADES_VAULT: `${tmp}/vault`, HADES_WORKSPACE: tmp, CLAUDE_CONFIG_DIR: `${tmp}/claude` });
  const hades = (...args) => spawnSync(process.execPath, [`${ENGINE}/bin/hades.mjs`, 'usage', ...args], { encoding: 'utf8', env: env() });

  test('usage --task stores state.usage', () => {
    const stateFile = setupVault();
    const r = hades('--task', 'app-001');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage app-001: /);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.usage.totals.total_tokens, 6776);
    assert.equal(typeof st.usage.cost_usd_estimate, 'number');
    for (const k of ['window', 'by_model', 'totals', 'cost_usd_estimate', 'computed_at']) assert.ok(k in st.usage, k);
  });

  test('period report falls back to the built-in parser', () => {
    setupVault();
    const r = hades('--since', '2026-10-01', '--until', '2026-10-31', '--no-ccusage');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage 2026-10-01\.\.2026-10-31 \(source: hades transcripts \(ccusage: disabled by --no-ccusage\)\)/);
    assert.match(r.stdout, /\ntotal\s+6\.9k tok/);
    const bad = hades('--since', '10/01/2026');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--since must be YYYY-MM-DD/);
  });
});

// cli F13: the PM records usage before the curator and the close, so the stored window stays open
// and misses that work. "hades task close" records it again with the final window.
describe('usage at close', () => {
  const env = () => ({ ...process.env, HADES_VAULT: `${tmp}/vault-close`, HADES_WORKSPACE: tmp, CLAUDE_CONFIG_DIR: `${tmp}/claude`, HADES_DEBUG: '' });
  const hades = (...args) => spawnSync(process.execPath, [`${ENGINE}/bin/hades.mjs`, ...args], { encoding: 'utf8', env: env() });
  function setupTask(usage) {
    const vault = `${tmp}/vault-close`;
    const teamDir = 'organizations/acme/teams/app';
    const dir = `${vault}/${teamDir}/tasks/app-001-demo`;
    fs.rmSync(vault, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${vault}/registry.json`, JSON.stringify({ version: 3, organizations: { acme: { org_dir: 'organizations/acme' } }, teams: { app: { organization: 'acme', type: 'main', project_path: tmp, team_dir: teamDir } } }));
    const stages = Object.fromEntries(['intake', 'analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security', 'close'].map((s) => [s, { status: 'pending' }]));
    fs.writeFileSync(`${dir}/state.json`, JSON.stringify({ id: 'app-001', team: 'app', status: 'open', opened: '2026-10-10T00:00:00Z', closed: null, stages, usage }));
    fs.writeFileSync(`${dir}/defects.json`, '{"defects":[]}');
    return `${dir}/state.json`;
  }

  test('close recomputes a recorded usage with the closed window', () => {
    const early = { window: { start: '2026-10-10T00:00:00Z', end: '2026-10-10T10:01:00Z', open: true }, totals: { total_tokens: 1 }, cost_usd_estimate: 0, session_filter: null };
    const stateFile = setupTask(early);
    const r = hades('task', 'close', 'app-001', '--status', 'blocked', '--note', 'test');
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.usage.window.open, false);
    assert.equal(st.usage.window.end, st.closed);
    assert.equal(st.usage.totals.total_tokens, 6886, 'every entry up to the close is counted (also the 2026-10-12 one)');
    assert.match(r.stdout, /^usage \(final window 2026-10-10T00:00:00Z \.\. .+\): 6886 tokens ~\$[\d.]+; update the README Usage line$/m);
  });

  test('the session filter of the recorded usage is kept; no recorded usage = no scan', () => {
    const stateFile = setupTask({ window: { start: 'x', end: 'y', open: true }, totals: { total_tokens: 1 }, session_filter: ['sess-b'] });
    assert.equal(hades('task', 'close', 'app-001', '--status', 'blocked').status, 0);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(st.usage.session_filter, ['sess-b']);
    assert.ok(st.usage.totals.total_tokens > 0 && st.usage.totals.total_tokens < 6886, String(st.usage.totals.total_tokens));
    const none = setupTask(null);
    const r = hades('task', 'close', 'app-001', '--status', 'blocked');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /usage/);
    assert.equal(JSON.parse(fs.readFileSync(none, 'utf8')).usage, null);
  });
});
