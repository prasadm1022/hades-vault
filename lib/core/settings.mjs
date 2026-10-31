// Claude Code settings.json helpers: locate, back up, merge and un-merge the entries HADES owns.
// Every change is recorded exactly so `hades install --uninstall` removes only what HADES added.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson, slash } from './util.mjs';

// Every tool the guard checks (Grep: searches through secret files; Serena's MCP tools edit and read
// files and are checked like Edit/Read). Claude Code matchers are regular expressions.
export const GUARD_MATCHER = 'Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|mcp__serena__.*';

// permissions.deny rules block in every permission mode, bypassPermissions included.
// Deny globs have no negation, so "Read(**/.env.*)" would also block .env.example; .env.* files
// are left to the guard hook and only the bare .env file is denied here.
export const DENY_RULES = [
  'Bash(git push *)',
  'Bash(git push)',
  'Bash(* git push *)',
  'Bash(git reset --hard *)',
  'Bash(git clean -f*)',
  'Bash(git filter-branch *)',
  'Bash(rm -rf /)',
  'Bash(rm -rf ~)',
  'Bash(gh pr create *)',
  'Bash(gh release *)',
  'Bash(npm publish *)',
  'Read(**/.env)',
];

// A path in a rendered command line: double-quoted when it holds whitespace (as hades install renders
// the agents' CLI lines), so "node <engine>/bin/hades.mjs" and the allow rules below stay one word.
export function shellPath(p) {
  const s = slash(p);
  return /\s/.test(s) ? `"${s}"` : s;
}

// The CLI line agents and skills use: node <engine>/bin/hades.mjs
export function hadesCli(engine) {
  return `node ${shellPath(`${slash(engine)}/bin/hades.mjs`)}`;
}

// The HADES CLI subcommands a guarded (default-mode) session may run without a prompt. Never run
// (starts a bypassPermissions session), install, migrate, tools or mcp.
export const SAFE_CLI = ['task *', 'defect *', 'gate *', 'team resolve *', 'team set *', 'team list*', 'detect *', 'status*', 'usage *', 'doctor*'];
// git commands of the routine PM/engineer flow, plain and as "git -C <repo> ...".
export const SAFE_GIT = ['add *', 'commit *', 'status*', 'diff*', 'log*', 'rev-parse *'];

// Allow rules matter in default/auto modes only (bypassPermissions ignores them).
export function allowRules(engine) {
  const cli = hadesCli(engine);
  return [
    ...SAFE_CLI.map((s) => `Bash(${cli} ${s})`),
    ...SAFE_GIT.map((s) => `Bash(git -C * ${s})`),
    ...SAFE_GIT.map((s) => `Bash(git ${s})`),
  ];
}

// The guard runs with the Node binary that ran "hades install" (absolute, quoted): a desktop app or
// IDE whose PATH has no node, or an old one, would otherwise make every guard call fail (open).
export function guardCommand(engine, node = process.execPath) {
  return `"${slash(node)}" "${slash(engine)}/hooks/guard.mjs"`;
}

// "onFailure": "block" makes newer Claude Code block the call when the hook itself cannot run;
// older versions ignore the key.
export function guardHookEntry(engine, node = process.execPath) {
  return { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: guardCommand(engine, node), timeout: 10, onFailure: 'block' }] };
}

// A hook command that runs this engine's guard, with any Node binary (node from PATH in older
// installs, an absolute path in newer ones).
export function isGuardCommand(command, engine) {
  if (typeof command !== 'string') return false;
  const guard = `${slash(engine)}/hooks/guard.mjs`;
  const norm = slash(command).trim();
  const win = process.platform === 'win32';
  const a = win ? norm.toLowerCase() : norm;
  const g = win ? guard.toLowerCase() : guard;
  return a.endsWith(`"${g}"`) || a.endsWith(` ${g}`);
}

// The Node binary of a registered guard hook ("node" when it relies on PATH), for doctor.
export function guardHookNode(settings, engine) {
  const list = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  for (const e of list) {
    for (const h of (e && Array.isArray(e.hooks) ? e.hooks : [])) {
      if (h && isGuardCommand(h.command, engine)) {
        const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(h.command);
        return m ? m[1] || m[2] : null;
      }
    }
  }
  return null;
}

// User-level Claude directory: CLAUDE_CONFIG_DIR wins (Claude Code reads settings, agents and
// skills from it), otherwise ~/.claude.
export function claudeHome(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim();
  return slash(path.resolve(dir || path.join(os.homedir(), '.claude')));
}

// user scope -> <claude home>; project scope -> <workspace>/.claude
export function claudeDirFor(scope, { workspace, env = process.env } = {}) {
  return scope === 'project' ? slash(path.resolve(workspace, '.claude')) : claudeHome(env);
}

export function settingsFileFor(claudeDir) {
  return `${slash(claudeDir)}/settings.json`;
}

export function readSettings(file) {
  return readJson(file, {});
}

export function writeSettings(file, data) {
  writeJson(file, data);
}

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Copies the file to <file>.hades-backup-<timestamp> before HADES changes it. Returns the backup path.
export function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  let target = `${file}.hades-backup-${stamp()}`;
  for (let i = 1; fs.existsSync(target); i++) target = `${file}.hades-backup-${stamp()}-${i}`;
  fs.copyFileSync(file, target);
  return slash(target);
}

// Order-insensitive for object keys, order-sensitive for arrays.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function jsonEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const keys = dotted.split('.');
  const parents = [];
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o || typeof o !== 'object') return;
    parents.push([o, k]);
    o = o[k];
  }
  if (o && typeof o === 'object') delete o[keys[keys.length - 1]];
  // Drop containers left empty by the removal.
  for (let i = parents.length - 1; i >= 0; i--) {
    const [p, k] = parents[i];
    if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k]) && Object.keys(p[k]).length === 0) delete p[k];
  }
}

// What HADES wants in a settings file.
//   desired = { hooks: [{event, entry}], deny: [...], allow: [...], keys: [{path, value}] }
export function desiredSettings(engine, { autonomy = 'guarded', scope = 'user', withHook = true } = {}) {
  const keys = [];
  if (autonomy === 'full' && scope === 'user') {
    keys.push({ path: 'permissions.defaultMode', value: 'bypassPermissions' });
    // Verified in the Claude Code CLI settings schema ("Whether the user has accepted the bypass
    // permissions mode dialog"); read from user/local/flag/policy settings, not project settings.
    keys.push({ path: 'skipDangerousModePermissionPrompt', value: true });
  }
  return {
    hooks: withHook ? [{ event: 'PreToolUse', entry: guardHookEntry(engine) }] : [],
    deny: [...DENY_RULES],
    allow: allowRules(engine),
    keys,
  };
}

export function emptyAdded() {
  return { hooks: [], deny: [], allow: [], keys: [] };
}

function hookPresent(settings, event, entry) {
  const list = settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  return list.some((e) => jsonEqual(e, entry));
}

// A guard registration in any form (the user may have edited the matcher or timeout; older installs
// run "node" from PATH).
export function hasGuardHook(settings, engine) {
  const list = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  return list.some((e) => e && Array.isArray(e.hooks) && e.hooks.some((h) => h && isGuardCommand(h.command, engine)));
}

// Tools of GUARD_MATCHER that no registered guard entry matches ([] = complete; null = no guard).
// A matcher of "*" or "" matches every tool.
export function guardMatcherGaps(settings, engine) {
  const list = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const entries = list.filter((e) => e && Array.isArray(e.hooks) && e.hooks.some((h) => h && isGuardCommand(h.command, engine)));
  if (!entries.length) return null;
  const covered = new Set();
  for (const e of entries) {
    const m = typeof e.matcher === 'string' ? e.matcher.trim() : '';
    if (m === '' || m === '*') return [];
    for (const t of m.split('|')) covered.add(t.trim());
  }
  return GUARD_MATCHER.split('|').filter((t) => !covered.has(t));
}

function rulePresent(settings, kind, rule) {
  const list = settings.permissions && Array.isArray(settings.permissions[kind]) ? settings.permissions[kind] : [];
  return list.includes(rule);
}

// Removes exactly the recorded entries that are still present and unchanged.
// Returns { settings, removed } where removed has the same shape as `added`.
export function unmergeSettings(input, added) {
  const settings = structuredClone(input || {});
  const removed = emptyAdded();
  for (const h of added.hooks || []) {
    const list = settings.hooks && Array.isArray(settings.hooks[h.event]) ? settings.hooks[h.event] : null;
    if (!list) continue;
    const idx = list.findIndex((e) => jsonEqual(e, h.entry));
    if (idx < 0) continue;
    list.splice(idx, 1);
    removed.hooks.push(h);
    if (list.length === 0) delete settings.hooks[h.event];
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  for (const kind of ['deny', 'allow']) {
    for (const rule of added[kind] || []) {
      const list = settings.permissions && Array.isArray(settings.permissions[kind]) ? settings.permissions[kind] : null;
      if (!list) continue;
      const idx = list.indexOf(rule);
      if (idx < 0) continue;
      list.splice(idx, 1);
      removed[kind].push(rule);
      if (list.length === 0) delete settings.permissions[kind];
      if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
    }
  }
  for (const k of added.keys || []) {
    if (!jsonEqual(getPath(settings, k.path), k.value)) continue; // changed since: not ours any more
    if (k.had_previous) setPath(settings, k.path, k.previous);
    else deletePath(settings, k.path);
    removed.keys.push(k);
  }
  return { settings, removed };
}

function sameHook(a, b) {
  return a.event === b.event && jsonEqual(a.entry, b.entry);
}

// Applies `desired` on top of `input`. `previous` is what an earlier install recorded as added:
// entries it added that are no longer desired are removed first; entries it added that are still
// desired and present stay recorded as HADES-owned. Returns { settings, added, changes } where
// changes lists human-readable differences (empty = nothing to write).
export function mergeSettings(input, desired, previous = emptyAdded()) {
  const prev = { ...emptyAdded(), ...previous };
  const stale = {
    hooks: prev.hooks.filter((h) => !desired.hooks.some((d) => sameHook(d, h))),
    deny: prev.deny.filter((r) => !desired.deny.includes(r)),
    allow: prev.allow.filter((r) => !desired.allow.includes(r)),
    keys: prev.keys.filter((k) => !desired.keys.some((d) => d.path === k.path && jsonEqual(d.value, k.value))),
  };
  const { settings, removed } = unmergeSettings(input, stale);
  const changes = [];
  for (const h of removed.hooks) changes.push(`-hook ${h.event}`);
  for (const r of removed.deny) changes.push(`-deny ${r}`);
  for (const r of removed.allow) changes.push(`-allow ${r}`);
  for (const k of removed.keys) changes.push(`-${k.path}`);

  const added = emptyAdded();
  for (const h of desired.hooks) {
    const owned = prev.hooks.some((p) => sameHook(p, h));
    if (hookPresent(settings, h.event, h.entry)) {
      if (owned) added.hooks.push(h);
      continue;
    }
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
    if (!Array.isArray(settings.hooks[h.event])) settings.hooks[h.event] = [];
    settings.hooks[h.event].push(structuredClone(h.entry));
    added.hooks.push(h);
    changes.push(`+hook ${h.event}`);
  }
  for (const kind of ['deny', 'allow']) {
    for (const rule of desired[kind]) {
      if (rulePresent(settings, kind, rule)) {
        if (prev[kind].includes(rule)) added[kind].push(rule);
        continue;
      }
      if (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) settings.permissions = {};
      if (!Array.isArray(settings.permissions[kind])) settings.permissions[kind] = [];
      settings.permissions[kind].push(rule);
      added[kind].push(rule);
      changes.push(`+${kind} ${rule}`);
    }
  }
  for (const k of desired.keys) {
    const current = getPath(settings, k.path);
    const owned = prev.keys.find((p) => p.path === k.path && jsonEqual(p.value, k.value));
    if (jsonEqual(current, k.value)) {
      if (owned) added.keys.push(owned);
      continue;
    }
    added.keys.push({ path: k.path, value: k.value, had_previous: current !== undefined, previous: current === undefined ? null : current });
    setPath(settings, k.path, k.value);
    changes.push(`+${k.path}=${JSON.stringify(k.value)}`);
  }
  return { settings, added, changes };
}

export function countAdded(added) {
  return {
    hooks: (added.hooks || []).length,
    deny: (added.deny || []).length,
    allow: (added.allow || []).length,
    keys: (added.keys || []).length,
  };
}
