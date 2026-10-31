// hades install [--scope user|project] [--workspace <dir>] [--autonomy guarded|full] [--dry-run] [--uninstall] [--json]
// Installs the engine's agents and skills into Claude Code (rendered, marked "hades-generated"),
// registers the guard hook and the permission rules in settings.json, and records everything in
// <engine>/.hades/install.json so doctor can check it and --uninstall can remove exactly that.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { print, fail, output, readJson, writeJson, writeText, slash, render, frontmatter, nowIso, allowFlags } from '../core/util.mjs';
import {
  claudeDirFor,
  settingsFileFor,
  readSettings,
  writeSettings,
  backupFile,
  desiredSettings,
  mergeSettings,
  unmergeSettings,
  emptyAdded,
  countAdded,
} from '../core/settings.mjs';

export const needsVault = false;
export const FLAGS = ['scope', 'autonomy', 'workspace', 'dryRun', 'uninstall'];
export const BOOLEAN_FLAGS = ['dryRun', 'uninstall'];

export const MARKER = 'hades-generated';
const SCOPES = ['user', 'project'];
const AUTONOMY = ['guarded', 'full'];

const HELP = `hades install [--scope user|project] [--workspace <dir>] [--autonomy guarded|full] [--dry-run] [--uninstall] [--json]
  user scope    -> ~/.claude (or CLAUDE_CONFIG_DIR): agents/hades/, skills/<name>/, settings.json
  project scope -> <workspace>/.claude (Claude Code reads it only for sessions started in <workspace>)
  --autonomy full (user scope only) sets permissions.defaultMode=bypassPermissions; deny rules and
  the guard hook keep blocking pushes, destructive git and secret reads in every mode. Without
  --autonomy a re-run keeps the autonomy of the recorded install (default guarded).
  Files without the "hades-generated" marker are never overwritten; --uninstall removes only what
  the recorded install added.`;

// ---- helpers ----

export function installSource(ctx) {
  return slash(path.resolve(process.env.HADES_INSTALL_SOURCE || ctx.engine));
}

export function manifestFile(ctx) {
  return `${ctx.engine}/.hades/install.json`;
}

export function loadManifest(ctx) {
  const m = readJson(manifestFile(ctx), { version: 1, installs: [] });
  if (!Array.isArray(m.installs)) m.installs = [];
  return m;
}

export function engineVersion(ctx) {
  return readJson(`${ctx.engine}/package.json`, {}).version || '0.0.0';
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function samePath(a, b) {
  const x = slash(path.resolve(a));
  const y = slash(path.resolve(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function findRecord(manifest, scope, claudeDir) {
  return manifest.installs.find((r) => r.scope === scope && samePath(r.claude_dir, claudeDir)) || null;
}

export function hasMarker(text) {
  return frontmatter(String(text).replace(/^﻿/, '')).data[MARKER] === 'true';
}

// Adds "hades-generated: true" and "hades-version: <v>" to the YAML frontmatter (replacing old values).
export function addMarker(text, version) {
  const t = String(text).replace(/^﻿/, '');
  const marker = [`${MARKER}: true`, `hades-version: ${version}`];
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (!m) return `---\n${marker.join('\n')}\n---\n${t}`;
  const eol = m[0].includes('\r\n') ? '\r\n' : '\n';
  const keep = m[1].split(/\r?\n/).filter((l) => !/^(hades-generated|hades-version)\s*:/.test(l));
  return `---${eol}${[...keep, ...marker].join(eol)}${eol}---${m[2] || eol}${t.slice(m[0].length)}`;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(slash(path.relative(base, p)));
  }
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function fileSha(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// Placeholders of agents/ and skills/, always with forward slashes (Claude Code, git and Node accept
// them on every OS). playbooks/ is never installed or rendered: it uses <engine>/<vault> wording.
// NODE = the absolute Node binary that ran "hades install": the agents' MCP servers start with it
// (command: "{{NODE}}"), like the guard hook, so a session whose PATH has no node, or an old one,
// still starts them.
export function renderVars(ctx, node = process.execPath) {
  const p = (x) => slash(String(x || ''));
  return { HADES_HOME: p(ctx.engine), HADES_VAULT: p(ctx.vault), HADES_WORKSPACE: p(ctx.workspace), NODE: p(node) };
}

// The Node binaries the installed agents' MCP servers run with (rendered "command:" values of their
// frontmatter), for doctor.
export function agentNodeCommands(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text).replace(/^﻿/, ''));
  if (!fm) return [];
  const out = new Set();
  for (const m of fm[1].matchAll(/^\s+command:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/gm)) out.add(m[1] ?? m[2] ?? m[3]);
  return [...out];
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An engine, vault or workspace path with whitespace ("C:/Users/Jane Doe/git/hades") is quoted
// wherever it was rendered unquoted, so a copied CLI line ("node <engine>/bin/hades.mjs task ...")
// stays one argument and matches the quoted allow rule. Paths already in quotes are left alone;
// trailing sentence punctuation stays outside the quotes. Paths without whitespace are unchanged.
export function quoteSpacedPaths(text, vars) {
  let out = String(text);
  const paths = [...new Set([vars.HADES_HOME, vars.HADES_VAULT, vars.HADES_WORKSPACE].filter((p) => p && /\s/.test(p)))].sort((a, b) => b.length - a.length);
  for (const p of paths) {
    const re = new RegExp(`(^|[^"'\\w/])(${reEsc(p)}(?:/[^\\s"'\`)\\]]*)?)`, 'gm');
    out = out.replace(re, (m, pre, token) => {
      const trail = /[.,;:]+$/.exec(token);
      const body = trail ? token.slice(0, -trail[0].length) : token;
      return `${pre}"${body}"${trail ? trail[0] : ''}`;
    });
  }
  return out;
}

// render() for installed files: placeholders, then quoting of paths with whitespace.
export function renderInstalled(text, vars) {
  return quoteSpacedPaths(render(text, vars), vars);
}

// Every file the engine would install into `claudeDir` (agents/ and skills/ only), rendered and
// marked, with its hash. node = the Node binary rendered into the agents (default: this process).
export function buildPlan(ctx, claudeDir, { node = process.execPath } = {}) {
  const src = installSource(ctx);
  const version = engineVersion(ctx);
  const vars = renderVars(ctx, node);
  const files = [];
  const warnings = [];
  const agentsDir = `${src}/agents`;
  if (fs.existsSync(agentsDir)) {
    for (const name of fs.readdirSync(agentsDir).sort()) {
      if (!name.toLowerCase().endsWith('.md') || !fs.statSync(`${agentsDir}/${name}`).isFile()) continue;
      if (!/^hades-/i.test(name)) {
        if (!/^readme/i.test(name)) warnings.push(`agents/${name} skipped: installable agents are named hades-<role>.md`);
        continue;
      }
      const text = addMarker(renderInstalled(fs.readFileSync(`${agentsDir}/${name}`, 'utf8'), vars), version);
      const content = Buffer.from(text, 'utf8');
      const id = frontmatter(text).data.name || name.replace(/\.md$/i, '');
      files.push({ kind: 'agent', name: id, unit: `agent:${name}`, rel: `agents/hades/${name}`, dest: `${claudeDir}/agents/hades/${name}`, content, sha256: sha256(content) });
    }
  } else warnings.push(`no agents/ folder in ${src}`);
  const skillsDir = `${src}/skills`;
  if (fs.existsSync(skillsDir)) {
    for (const skill of fs.readdirSync(skillsDir).sort()) {
      const dir = `${skillsDir}/${skill}`;
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(`${dir}/SKILL.md`)) continue;
      for (const rel of listFiles(dir)) {
        const raw = fs.readFileSync(`${dir}/${rel}`);
        let content = raw;
        if (!isBinary(raw)) {
          let text = renderInstalled(raw.toString('utf8'), vars);
          if (rel === 'SKILL.md') text = addMarker(text, version);
          content = Buffer.from(text, 'utf8');
        }
        files.push({ kind: 'skill', name: skill, unit: `skill:${skill}`, rel: `skills/${skill}/${rel}`, dest: `${claudeDir}/skills/${skill}/${rel}`, content, sha256: sha256(content), skillMd: rel === 'SKILL.md' });
      }
    }
  } else warnings.push(`no skills/ folder in ${src}`);
  return { src, version, files, warnings };
}

// Unmarked agent files under `root` whose frontmatter "name" is one of `names` (skipping `skipDir`).
function unmarkedAgentsNamed(root, names, skipDir = null) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = slash(path.join(dir, e.name));
      if (e.isDirectory()) {
        if (!skipDir || !samePath(p, skipDir)) walk(p);
      } else if (e.name.endsWith('.md')) {
        const text = readText(p);
        const name = text ? frontmatter(text.replace(/^﻿/, '')).data.name : null;
        if (name && names.has(name) && !hasMarker(text)) found.push({ kind: 'agent', name, path: p });
      }
    }
  };
  walk(root);
  return found;
}

// Same frontmatter "name" as one of ours elsewhere under <claudeDir>/agents: ambiguous agent IDs.
function duplicateAgentNames(claudeDir, files) {
  const names = new Set(files.filter((f) => f.kind === 'agent').map((f) => f.name));
  return unmarkedAgentsNamed(`${claudeDir}/agents`, names, `${claudeDir}/agents/hades`);
}

// Project-level agents/skills in <workspace>/.claude with the same names take precedence over a
// user-level install for sessions started there (e.g. a HADES v1 install). Never touched; reported.
export function shadowedBy(files, workspace) {
  if (!workspace) return [];
  const base = `${slash(path.resolve(workspace))}/.claude`;
  const out = [];
  for (const name of new Set(files.filter((f) => f.kind === 'skill').map((f) => f.name))) {
    const p = `${base}/skills/${name}/SKILL.md`;
    const text = readText(p);
    if (text !== null && !hasMarker(text)) out.push({ kind: 'skill', name, path: p });
  }
  out.push(...unmarkedAgentsNamed(`${base}/agents`, new Set(files.filter((f) => f.kind === 'agent').map((f) => f.name))));
  return out;
}

// Decides per file: write | update | unchanged | conflict, and which stale files to remove.
export function classify(plan, claudeDir, prevRecord) {
  const actions = [];
  const conflicts = [];
  const blockedUnits = new Set();
  const reasons = new Map();
  const recorded = new Set(((prevRecord && prevRecord.files) || []).map((f) => slash(path.resolve(f.path)).toLowerCase()));
  for (const f of plan.files) {
    if ((f.kind === 'agent' || f.skillMd) && fs.existsSync(f.dest)) {
      const text = readText(f.dest);
      if (text !== null && !hasMarker(text)) {
        blockedUnits.add(f.unit);
        reasons.set(f.unit, { rel: f.rel, path: f.dest, reason: 'exists without the hades-generated marker' });
      }
    }
  }
  // A skill folder without our SKILL.md is not ours: never overwrite a differing file in it.
  for (const f of plan.files) {
    if (f.kind !== 'skill' || f.skillMd || blockedUnits.has(f.unit) || !fs.existsSync(f.dest)) continue;
    const skillMd = plan.files.find((x) => x.unit === f.unit && x.skillMd);
    const owned = skillMd && fs.existsSync(skillMd.dest) && hasMarker(readText(skillMd.dest) || '');
    if (!owned && !recorded.has(slash(path.resolve(f.dest)).toLowerCase()) && fileSha(f.dest) !== f.sha256) {
      blockedUnits.add(f.unit);
      reasons.set(f.unit, { rel: f.rel, path: f.dest, reason: 'exists in a skill folder HADES does not own' });
    }
  }
  for (const unit of blockedUnits) conflicts.push({ unit, ...reasons.get(unit) });
  for (const f of plan.files) {
    if (blockedUnits.has(f.unit)) continue;
    if (!fs.existsSync(f.dest)) actions.push({ ...f, action: 'write' });
    else if (fileSha(f.dest) === f.sha256) actions.push({ ...f, action: 'unchanged' });
    else actions.push({ ...f, action: 'update' });
  }
  const wanted = new Set(plan.files.map((f) => slash(path.resolve(f.dest)).toLowerCase()));
  const removals = [];
  for (const old of (prevRecord && prevRecord.files) || []) {
    if (wanted.has(slash(path.resolve(old.path)).toLowerCase()) || !fs.existsSync(old.path)) continue;
    if (ownedOnDisk(old)) removals.push(old);
  }
  return { actions, conflicts, removals, duplicates: duplicateAgentNames(claudeDir, plan.files) };
}

// A recorded file may be deleted when it still carries the marker (agents, SKILL.md) or is
// byte-identical to what was installed (other skill files).
function ownedOnDisk(rec) {
  if (/\.md$/i.test(rec.path) && (rec.kind === 'agent' || /\/SKILL\.md$/i.test(rec.path))) {
    const text = readText(rec.path);
    return text !== null && hasMarker(text);
  }
  return fileSha(rec.path) === rec.sha256;
}

function removeEmptyDirs(dir, stopAt) {
  let d = slash(path.resolve(dir));
  const stop = slash(path.resolve(stopAt));
  while (d.length > stop.length && d.toLowerCase().startsWith(stop.toLowerCase())) {
    try {
      if (fs.readdirSync(d).length > 0) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = slash(path.dirname(d));
  }
}

// Temp file + rename, retried on Windows sharing violations (writeText accepts a Buffer as is).
function writeFileAtomic(file, content) {
  writeText(file, content);
}

function summarizeChanges(changes) {
  const counts = {};
  const other = [];
  for (const c of changes) {
    const m = /^([+-])(deny|allow) /.exec(c);
    if (m) counts[`${m[1]}${m[2]}`] = (counts[`${m[1]}${m[2]}`] || 0) + 1;
    else other.push(c);
  }
  const parts = [...other, ...Object.entries(counts).map(([k, n]) => `${k[0]}${n} ${k.slice(1)}`)];
  return parts.length ? parts.join(', ') : 'no changes';
}

function countBy(actions, kind) {
  const c = { write: 0, update: 0, unchanged: 0 };
  for (const a of actions) if (a.kind === kind) c[a.action]++;
  return c;
}

function unitCount(actions, kind) {
  return new Set(actions.filter((a) => a.kind === kind).map((a) => a.unit)).size;
}

// ---- command ----

export function parseInstallOptions(args, ctx) {
  const f = args.flags;
  const scope = f.scope === undefined ? 'user' : String(f.scope);
  if (!SCOPES.includes(scope)) fail(`--scope must be user or project, got "${f.scope}"`);
  // null = not given: install() keeps the autonomy of the recorded install (a bare re-run after an
  // engine update must not silently turn --autonomy full off).
  const autonomy = f.autonomy === undefined ? null : String(f.autonomy);
  if (autonomy !== null && !AUTONOMY.includes(autonomy)) fail(`--autonomy must be guarded or full, got "${f.autonomy}"`);
  if (f.workspace === true) fail('--workspace needs a directory');
  const workspace = slash(path.resolve(f.workspace ? String(f.workspace) : ctx.workspace));
  if (scope === 'project' && !fs.existsSync(workspace)) fail(`workspace not found: ${workspace}`);
  return { scope, autonomy, workspace, dryRun: !!f.dryRun, uninstall: !!f.uninstall };
}

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) return print(HELP);
  const opts = parseInstallOptions(args, ctx);
  const claudeDir = claudeDirFor(opts.scope, { workspace: opts.workspace });
  const result = opts.uninstall ? uninstall(ctx, opts, claudeDir) : install(ctx, opts, claudeDir);
  output(args, result, result.lines.join('\n'));
  if (result.conflicts && result.conflicts.length) process.exitCode = 2;
  return result;
}

export function install(ctx, opts, claudeDir) {
  const lines = [];
  const plan = buildPlan(ctx, claudeDir);
  const manifest = loadManifest(ctx);
  const prev = findRecord(manifest, opts.scope, claudeDir);
  const { actions, conflicts, removals, duplicates } = classify(plan, claudeDir, prev);
  // --autonomy given -> that; else the recorded install's; else guarded.
  const kept = !opts.autonomy && prev && AUTONOMY.includes(prev.autonomy);
  const autonomy = opts.autonomy || (kept ? prev.autonomy : 'guarded');

  const settingsFile = settingsFileFor(claudeDir);
  const guardFile = `${ctx.engine}/hooks/guard.mjs`;
  const withHook = fs.existsSync(guardFile);
  const desired = desiredSettings(ctx.engine, { autonomy, scope: opts.scope, withHook });
  const current = readSettings(settingsFile);
  const merged = mergeSettings(current, desired, prev ? prev.settings_added : emptyAdded());

  const tag = opts.dryRun ? 'DRY RUN ' : '';
  lines.push(`${tag}hades install (${opts.scope} scope) -> ${claudeDir}`);
  const a = countBy(actions, 'agent');
  const s = countBy(actions, 'skill');
  lines.push(`agents: ${unitCount(actions, 'agent')} (${a.write} new, ${a.update} updated, ${a.unchanged} unchanged) -> agents/hades/`);
  lines.push(`skills: ${unitCount(actions, 'skill')} (${s.write} new files, ${s.update} updated, ${s.unchanged} unchanged)`);
  if (removals.length) lines.push(`stale: ${removals.length} file(s) from the previous install removed`);
  const changeText = summarizeChanges(merged.changes);
  let backup = null;

  const keptNote = kept ? ' (kept from the previous install; --autonomy guarded|full changes it)' : '';
  if (autonomy === 'full' && opts.scope === 'user') {
    lines.push(`WARN autonomy full${keptNote}: permissions.defaultMode=bypassPermissions for EVERY Claude Code session of this user; deny rules and the guard hook still block pushes, destructive git and secret reads`);
  } else if (autonomy === 'full') {
    lines.push(`WARN autonomy full${keptNote} has no effect in project settings (Claude Code honours bypassPermissions only from user/managed settings or --permission-mode) -> use "hades run" or --scope user`);
  } else if (merged.changes.some((c) => /^-permissions\.defaultMode\b/.test(c))) {
    // Say what really happens: an explicit --autonomy guarded removes the mode a full install added.
    lines.push('autonomy guarded: removed permissions.defaultMode=bypassPermissions added by the previous --autonomy full install');
  } else {
    lines.push(`autonomy guarded${keptNote}: permissions.defaultMode untouched`);
  }
  if (opts.scope === 'project') lines.push(`note: project settings apply only to Claude Code sessions started in ${opts.workspace}`);
  if (!withHook) lines.push(`WARN ${guardFile} missing: guard hook not registered`);
  if (!fs.existsSync(`${ctx.vault}/registry.json`)) lines.push(`WARN no vault at ${ctx.vault}: installed agents point there -> hades init, then re-run hades install`);
  for (const w of plan.warnings) lines.push(`WARN ${w}`);
  for (const d of duplicates) lines.push(`WARN agent name "${d.name}" is also defined in ${d.path} -> remove or rename it (same-name agents are ambiguous)`);
  if (opts.scope === 'user') {
    for (const sh of shadowedBy(plan.files, opts.workspace)) {
      lines.push(`WARN ${sh.kind} "${sh.name}" in ${sh.path} overrides this install in sessions started in ${opts.workspace} (project > user) -> remove it, or use --scope project`);
    }
  }
  for (const c of conflicts) lines.push(`CONFLICT ${c.rel} ${c.reason} -> move it away and re-run (not overwritten)`);

  if (opts.dryRun) {
    for (const x of actions) if (x.action !== 'unchanged') lines.push(`  ${x.action} ${x.rel}`);
    for (const r of removals) lines.push(`  remove ${slash(path.relative(claudeDir, r.path))}`);
    lines.push(`settings: ${settingsFile}: ${changeText}`);
    return { dryRun: true, scope: opts.scope, autonomy, claude_dir: claudeDir, settings_file: settingsFile, actions: actions.map(strip), conflicts, removals, settings_changes: merged.changes, lines };
  }

  for (const x of actions) if (x.action !== 'unchanged') writeFileAtomic(x.dest, x.content);
  for (const r of removals) {
    fs.rmSync(r.path, { force: true });
    removeEmptyDirs(path.dirname(r.path), claudeDir);
  }
  if (merged.changes.length) {
    backup = backupFile(settingsFile);
    writeSettings(settingsFile, merged.settings);
  }
  lines.push(`settings: ${settingsFile}: ${changeText}${backup ? ` (backup ${path.basename(backup)})` : ''}`);

  const record = {
    scope: opts.scope,
    claude_dir: claudeDir,
    settings_file: settingsFile,
    workspace: opts.scope === 'project' ? opts.workspace : null,
    autonomy,
    engine: ctx.engine,
    node: slash(process.execPath),
    engine_version: plan.version,
    source: plan.src,
    vault: ctx.vault,
    installed_at: nowIso(),
    files: actions.map((x) => ({ path: x.dest, rel: x.rel, kind: x.kind, name: x.name, sha256: x.sha256 })),
    settings_added: merged.added,
  };
  manifest.version = 1;
  manifest.installs = manifest.installs.filter((r) => r !== prev);
  manifest.installs.push(record);
  writeJson(manifestFile(ctx), manifest);
  lines.push(`manifest: ${manifestFile(ctx)}`);
  return { scope: opts.scope, autonomy, claude_dir: claudeDir, settings_file: settingsFile, backup, actions: actions.map(strip), conflicts, removals, settings_changes: merged.changes, settings_added: countAdded(merged.added), lines };
}

function strip(x) {
  return { action: x.action, kind: x.kind, name: x.name, rel: x.rel, sha256: x.sha256 };
}

export function uninstall(ctx, opts, claudeDir) {
  const lines = [];
  const manifest = loadManifest(ctx);
  const rec = findRecord(manifest, opts.scope, claudeDir);
  const tag = opts.dryRun ? 'DRY RUN ' : '';
  if (!rec) {
    lines.push(`${tag}hades uninstall (${opts.scope} scope): nothing recorded for ${claudeDir}`);
    return { removed: [], kept: [], lines };
  }
  const removed = [];
  const kept = [];
  for (const f of rec.files) {
    if (!fs.existsSync(f.path)) continue;
    if (ownedOnDisk(f)) removed.push(f);
    else kept.push(f);
  }
  const current = readSettings(rec.settings_file);
  const un = unmergeSettings(current, rec.settings_added || emptyAdded());
  const rc = countAdded(un.removed);
  const settingsText = `-${rc.hooks} hook, -${rc.deny} deny, -${rc.allow} allow, -${rc.keys} keys`;
  lines.push(`${tag}hades uninstall (${opts.scope} scope) -> ${claudeDir}`);
  lines.push(`files: ${removed.length} removed, ${kept.length} kept (changed or unmarked since install)`);
  for (const k of kept) lines.push(`  kept ${k.rel || k.path}`);
  if (opts.dryRun) {
    lines.push(`settings: ${rec.settings_file}: ${settingsText}`);
    return { dryRun: true, removed: removed.map((f) => f.rel), kept: kept.map((f) => f.rel), settings_removed: rc, lines };
  }
  for (const f of removed) {
    fs.rmSync(f.path, { force: true });
    removeEmptyDirs(path.dirname(f.path), claudeDir);
  }
  let backup = null;
  if (rc.hooks + rc.deny + rc.allow + rc.keys > 0) {
    backup = backupFile(rec.settings_file);
    writeSettings(rec.settings_file, un.settings);
  }
  lines.push(`settings: ${rec.settings_file}: ${settingsText}${backup ? ` (backup ${path.basename(backup)})` : ''}`);
  manifest.installs = manifest.installs.filter((r) => r !== rec);
  writeJson(manifestFile(ctx), manifest);
  return { removed: removed.map((f) => f.rel), kept: kept.map((f) => f.rel), settings_removed: rc, backup, lines };
}

// For doctor: compares a recorded install with disk and with a fresh render of the engine sources.
export function inspectInstall(ctx, rec) {
  const missing = [];
  const modified = [];
  for (const f of rec.files || []) {
    const sha = fileSha(f.path);
    if (sha === null) missing.push(f.rel || f.path);
    else if (sha !== f.sha256) modified.push(f.rel || f.path);
  }
  let outdated = [];
  try {
    // Rendered with the Node of that install: running doctor with another Node is not a change.
    const plan = buildPlan(ctx, rec.claude_dir, { node: rec.node || process.execPath });
    const recorded = new Map((rec.files || []).map((f) => [slash(path.resolve(f.path)).toLowerCase(), f.sha256]));
    const planned = new Set();
    for (const f of plan.files) {
      const key = slash(path.resolve(f.dest)).toLowerCase();
      planned.add(key);
      if (recorded.get(key) !== f.sha256) outdated.push(f.rel);
    }
    for (const f of rec.files || []) if (!planned.has(slash(path.resolve(f.path)).toLowerCase())) outdated.push(f.rel || f.path);
  } catch (err) {
    outdated = [`(engine sources unreadable: ${err.message})`];
  }
  return { missing, modified, outdated };
}
