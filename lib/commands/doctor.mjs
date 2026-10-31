// hades doctor [--aws-profile <p>] [--json]
// One line per check: "OK|WARN|FAIL <check>: <detail> -> <fix>". Exit 2 when any check FAILs.
import fs from 'node:fs';
import path from 'node:path';
import { print, output, readJson, run as runCmd, slash, allowFlags } from '../core/util.mjs';
import { vaultPath, REGISTRY_VERSION, VAULT_DIR, LEGACY_VAULT_DIR, isInsideDir } from '../core/config.mjs';
import { validateRegistry } from '../core/registry.mjs';
import { loadStacks, validateStacks, vaultStacksFile, mergeStacks, STACKS_FILE } from '../core/detect.mjs';
import { readSettings, hasGuardHook, guardMatcherGaps, guardHookNode } from '../core/settings.mjs';
import { findExecutable, execFile } from './run.mjs';
import { loadManifest, inspectInstall, shadowedBy, agentNodeCommands } from './install.mjs';

export const needsVault = false;
export const FLAGS = ['awsProfile'];
export const MIN_CLAUDE = '2.1.271';
export const MIN_NODE = 22;

const HELP = `hades doctor [--aws-profile <profile>] [--json]
  Checks Node (>= ${MIN_NODE}), git, Claude Code, uv, Docker, config, vault (and, for a vault inside
  the engine, that the engine repository git-ignores it), registry, team folders,
  stack fingerprints (engine + vault), tool pins, installed files, the guard hook (its matcher and
  its Node binary), the Node binary of the installed agents' MCP servers and the AWS profile.
  One line per check with the fix. Exit 2 on any FAIL.
  AWS profiles: hades.config.json "aws": {"profile"} (or "profiles"), else AWS_PROFILE; --aws-profile checks one ad hoc.
  A profile resolving to the account root user is a FAIL: autonomous agents must not use root.`;

export function check(status, name, detail, fix = '') {
  return { status, check: name, detail, fix };
}

export function formatCheck(c) {
  return `${c.status} ${c.check}: ${c.detail}${c.status !== 'OK' && c.fix ? ` -> ${c.fix}` : ''}`;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function firstVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(text));
  return m ? m[1] : null;
}

// Everything that touches the machine goes through the probe, so checks can be unit-tested.
export function defaultProbe() {
  return {
    nodeVersion: process.versions.node,
    env: process.env,
    find: (cmd) => findExecutable(cmd),
    exec: (file, args, opts = {}) => execFile(file, args, { timeout: 30000, ...opts }),
    git: (cwd, ...args) => runCmd('git', ['-C', cwd, ...args], { timeout: 30000 }),
  };
}

// ---- prerequisites ----

export function checkNode(probe) {
  const major = parseInt(String(probe.nodeVersion).split('.')[0], 10);
  return major >= MIN_NODE ? check('OK', 'node', `v${probe.nodeVersion}`) : check('FAIL', 'node', `v${probe.nodeVersion} is too old`, `install Node.js ${MIN_NODE} or newer`);
}

export function checkGit(probe) {
  const git = probe.find('git');
  if (!git) return check('FAIL', 'git', 'not found on PATH', 'install git');
  const v = firstVersion(probe.exec(git, ['--version']).stdout);
  return check('OK', 'git', v ? `git ${v}` : slash(git));
}

export function checkClaude(probe) {
  const claude = probe.find('claude');
  if (!claude) return check('FAIL', 'claude', 'Claude Code CLI not found on PATH', 'install Claude Code (https://code.claude.com)');
  const v = firstVersion(probe.exec(claude, ['--version']).stdout);
  if (!v) return check('WARN', 'claude', `found ${slash(claude)} but could not read its version`, 'run "claude --version"');
  if (compareVersions(v, MIN_CLAUDE) < 0) {
    return check('WARN', 'claude', `${v} < ${MIN_CLAUDE}: newer agent frontmatter (omitClaudeMd and others) is ignored`, 'claude update');
  }
  return check('OK', 'claude', v);
}

export function checkUv(probe) {
  const uvx = probe.find('uvx') || probe.find('uv');
  if (!uvx) return check('WARN', 'uv', 'uv/uvx not found (needed for serena, semgrep and the AWS MCP proxy)', 'install uv: https://docs.astral.sh/uv/');
  const v = firstVersion(probe.exec(uvx, ['--version']).stdout);
  return check('OK', 'uv', v ? `uvx ${v}` : slash(uvx));
}

export function checkDocker(probe) {
  const docker = probe.find('docker');
  if (!docker) return check('WARN', 'docker', 'not found (optional; needed for ZAP DAST scans)', 'install Docker if the team runs DAST');
  const v = firstVersion(probe.exec(docker, ['--version']).stdout);
  return check('OK', 'docker', v ? `docker ${v}` : slash(docker));
}

// ---- config, vault, teams ----

export function checkConfig(ctx, env = process.env) {
  const out = [];
  const fromEnv = env.HADES_VAULT || env.HADES_WORKSPACE;
  if (fs.existsSync(ctx.configFile)) out.push(check('OK', 'config', slash(ctx.configFile)));
  else if (fromEnv) out.push(check('OK', 'config', 'from HADES_VAULT / HADES_WORKSPACE'));
  else out.push(check('WARN', 'config', `no hades.config.json (vault defaults to ${ctx.vault})`, 'hades init --vault <path> --workspace <path>'));
  if (ctx.registry) out.push(check('OK', 'vault', ctx.vault));
  else out.push(check('FAIL', 'vault', `no registry.json in ${ctx.vault}`, 'hades init --vault <path>'));
  if (fs.existsSync(ctx.workspace) && fs.statSync(ctx.workspace).isDirectory()) out.push(check('OK', 'workspace', ctx.workspace));
  else out.push(check('FAIL', 'workspace', `${ctx.workspace} does not exist`, 'hades init --workspace <path>'));
  return out;
}

// A vault inside the engine (the default <engine>/.vault) must be git-ignored by the engine
// repository, so private client data can never be committed to (or published with) the engine.
// A legacy <engine>/vault (the default before .vault) gets a WARN suggesting the move to .vault.
export function checkVaultPlacement(ctx, probe = defaultProbe()) {
  const engine = slash(path.resolve(ctx.engine));
  const vault = slash(path.resolve(ctx.vault));
  if (!isInsideDir(vault, engine)) return [];
  const out = [];
  if (vault.toLowerCase() === engine.toLowerCase()) {
    return [check('FAIL', 'vault location', 'the vault is the engine folder itself', `move the vault to ${engine}/${VAULT_DIR} and run hades init --vault ${engine}/${VAULT_DIR}`)];
  }
  const rel = slash(path.relative(engine, vault));
  const inRepo = probe.git(engine, 'rev-parse', '--is-inside-work-tree');
  const noGit = (r) => r.code === 127 || /ENOENT/.test(String(r.stderr || ''));
  if (noGit(inRepo)) {
    out.push(check('WARN', 'vault location', `${rel} inside the engine: cannot verify that the engine repository git-ignores it (git not found)`, `install git, then hades doctor`));
  } else if (inRepo.code !== 0 || String(inRepo.stdout).trim() !== 'true') {
    out.push(check('OK', 'vault location', `${rel} inside the engine (the engine is not a git repository)`));
  } else {
    // trailing slash: a directory-only pattern ("/.vault/") also matches a folder that does not exist yet
    const ignored = probe.git(engine, 'check-ignore', '-q', '--', `${rel}/`);
    if (ignored.code === 0) out.push(check('OK', 'vault location', `${rel} inside the engine, git-ignored by the engine repository`));
    else if (ignored.code === 1) out.push(check('FAIL', 'vault location', `${rel} is inside the engine but NOT git-ignored: private data could be committed with the engine`, `add "/${rel}/" to ${engine}/.gitignore`));
    else out.push(check('WARN', 'vault location', `cannot tell whether the engine repository git-ignores ${rel}`, `git -C "${engine}" check-ignore -v ${rel}/`));
    // its own repository: otherwise "git -C <vault> ..." acts on the engine repository (and a push
    // would go to the engine's remote)
    if (fs.existsSync(vault)) {
      const top = probe.git(vault, 'rev-parse', '--show-toplevel');
      const t = String(top.stdout || '').trim();
      const same = (a, b) => slash(path.resolve(a)).replace(/\/+$/, '').toLowerCase() === slash(path.resolve(b)).replace(/\/+$/, '').toLowerCase();
      let real = vault;
      try {
        real = fs.realpathSync.native(vault);
      } catch {
        /* keep */
      }
      if (top.code === 0 && t && !same(t, vault) && !same(t, real)) {
        out.push(check('FAIL', 'vault repository', `${rel} is not its own git repository: git commands in it act on the repository at ${slash(t)} (a push would go to that repository's remote)`, `hades init (runs git init in ${vault}), or git init "${vault}"`));
      }
    }
  }
  if (rel.toLowerCase() === LEGACY_VAULT_DIR) {
    out.push(check('WARN', 'vault location', `legacy location ${rel} (the default is now ${VAULT_DIR})`, `move the folder to ${engine}/${VAULT_DIR}, then hades init --vault ${engine}/${VAULT_DIR}`));
  }
  return out;
}

// The vault's own notes (scaffolded from templates/vault) name the engine folder; after the engine
// folder is renamed or moved they point at a folder that no longer holds the engine.
const VAULT_NOTES = ['CLAUDE.md', 'README.md', 'company/README.md', 'company/playbooks/README.md'];
const ENGINE_REF = [/Policies live in the engine at `([^`]+)`/g, /Engine: `([^`]+)`/g, /`node ([^`\s]+)\/bin\/hades\.mjs/g, /`([^`\s]+)\/(?:playbooks|company)\/[^`\s]+`/g];
export function checkVaultNotes(ctx) {
  if (!ctx.vault || !ctx.engine) return [];
  const engine = slash(path.resolve(ctx.engine)).replace(/\/+$/, '').toLowerCase();
  const stale = new Set();
  const files = [];
  for (const f of VAULT_NOTES) {
    let text;
    try {
      text = fs.readFileSync(`${ctx.vault}/${f}`, 'utf8');
    } catch {
      continue;
    }
    let hit = false;
    for (const rx of ENGINE_REF) {
      for (const m of text.matchAll(rx)) {
        const p = slash(m[1]).replace(/\/+$/, '');
        if (!path.isAbsolute(p) && !/^[A-Za-z]:\//.test(p)) continue;
        if (slash(path.resolve(p)).replace(/\/+$/, '').toLowerCase() === engine) continue;
        stale.add(p);
        hit = true;
      }
    }
    if (hit) files.push(f);
  }
  if (!stale.size) return [];
  return [check('WARN', 'vault notes', `${files.join(', ')} name the engine as ${[...stale].join(', ')} (the engine is ${slash(ctx.engine)})`, `replace ${[...stale][0]} with ${slash(ctx.engine)} in those files under ${slash(ctx.vault)}`)];
}

export function checkRegistry(ctx) {
  if (!ctx.registry) return [];
  const v = ctx.registry.version;
  if (v === REGISTRY_VERSION) {
    const out = [check('OK', 'registry', `version ${v}`)];
    const problems = validateRegistry(ctx.registry);
    if (problems.length) {
      const more = problems.length > 3 ? ` +${problems.length - 3} more` : '';
      out.push(check('FAIL', 'registry', `${problems.length} problem(s): ${problems.slice(0, 3).join('; ')}${more}`, `fix ${slash(ctx.registryFile || `${ctx.vault}/registry.json`)}`));
    }
    return out;
  }
  if (v === 2) return [check('WARN', 'registry', 'version 2 (HADES v1 vault)', 'hades migrate')];
  return [check('FAIL', 'registry', `unsupported version ${v}`, `expected ${REGISTRY_VERSION}; restore registry.json or run hades migrate`)];
}

export function checkTeams(ctx) {
  if (!ctx.registry) return [];
  const teams = Object.entries(ctx.registry.teams || {});
  if (teams.length === 0) return [check('OK', 'teams', 'none registered yet')];
  const out = [];
  const incomplete = [];
  let ok = 0;
  for (const [name, t] of teams) {
    if (!t.team_dir) {
      out.push(check('FAIL', `team ${name}`, 'no team_dir in registry.json', 'hades migrate'));
      continue;
    }
    const dir = vaultPath(ctx, t.team_dir);
    if (!fs.existsSync(dir)) {
      out.push(check('FAIL', `team ${name}`, `folder missing: ${dir}`, 'restore the folder or re-create the team'));
      continue;
    }
    const missing = ['team.json', 'CONTEXT.md'].filter((f) => !fs.existsSync(`${dir}/${f}`));
    if (missing.length) incomplete.push(`${name} (${missing.join('+')})`);
    else ok++;
  }
  if (ok === teams.length) return [check('OK', 'teams', `${ok} team(s), each with team.json and CONTEXT.md`)];
  if (incomplete.length) {
    const more = incomplete.length > 5 ? ` +${incomplete.length - 5} more` : '';
    out.push(check('WARN', 'teams', `${incomplete.length}/${teams.length} missing files: ${incomplete.slice(0, 5).join(', ')}${more}`, 'hades migrate (or hades detect <path> --write <team>)'));
  }
  if (out.length > 12) return [...out.slice(0, 12), check('WARN', 'teams', `${out.length - 12} more team problems`, 'hades doctor --json')];
  return out;
}

// ---- stack fingerprints (playbooks/stacks.json + <vault>/company/playbooks/stacks.json) ----

export function checkStacks(ctx, engineFile = STACKS_FILE) {
  const out = [];
  let base;
  try {
    base = engineFile === STACKS_FILE ? loadStacks() : JSON.parse(fs.readFileSync(engineFile, 'utf8'));
  } catch (err) {
    return [check('FAIL', 'stacks', `${engineFile}: ${String(err.message || err).slice(0, 160)}`, 'restore playbooks/stacks.json from git')];
  }
  const fmt = (p) => `${p.length} problem(s): ${p.slice(0, 3).join('; ')}${p.length > 3 ? ` +${p.length - 3} more` : ''}`;
  const problems = validateStacks(base);
  if (problems.length) out.push(check('FAIL', 'stacks', `${slash(engineFile)}: ${fmt(problems)}`, 'restore playbooks/stacks.json from git'));
  const file = ctx && ctx.vault ? vaultStacksFile(ctx.vault) : null;
  if (!file || !fs.existsSync(file)) {
    if (!problems.length) out.push(check('OK', 'stacks', `${Array.isArray(base) ? base.length : 0} engine fingerprints`));
    return out;
  }
  let extra;
  try {
    extra = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    out.push(check('FAIL', 'stacks', `${file}: invalid JSON (${String(err.message).slice(0, 120)}); detect ignores it`, 'fix the learned fingerprints file'));
    return out;
  }
  if (!Array.isArray(extra)) {
    out.push(check('FAIL', 'stacks', `${file}: expected an array of stacks; detect ignores it`, 'fix the learned fingerprints file'));
    return out;
  }
  const merged = validateStacks(mergeStacks(Array.isArray(base) ? base : [], extra));
  if (merged.length) out.push(check('FAIL', 'stacks', `${file}: ${fmt(merged)}; detect ignores it`, 'fix the learned fingerprints file'));
  else if (!problems.length) out.push(check('OK', 'stacks', `${base.length} engine + ${extra.length} learned fingerprints`));
  return out;
}

// ---- vendored tool pins ----

export function checkToolPins(ctx, probe) {
  const lockFile = `${ctx.engine}/tools/tools.lock.json`;
  if (!fs.existsSync(lockFile)) return [check('FAIL', 'tools', 'tools/tools.lock.json missing', 'restore it from git')];
  const lock = readJson(lockFile);
  const out = [];
  const names = Object.keys(lock.tools || {});
  for (const name of names) {
    const want = lock.tools[name].commit;
    const dir = `${ctx.engine}/tools/${name}`;
    // An uninitialised submodule is an empty folder; "git -C" there would answer for the parent repo.
    if (!fs.existsSync(`${dir}/.git`)) {
      out.push(check('WARN', `tool ${name}`, 'submodule not checked out', `git -C "${ctx.engine}" submodule update --init tools/${name}`));
      continue;
    }
    const res = probe.git(dir, 'rev-parse', 'HEAD');
    const head = res.code === 0 ? res.stdout.trim() : null;
    if (!head) out.push(check('WARN', `tool ${name}`, 'cannot read submodule commit', `git -C "${ctx.engine}" submodule update --init tools/${name}`));
    else if (head !== want) out.push(check('FAIL', `tool ${name}`, `at ${head.slice(0, 12)}, lock pins ${String(want).slice(0, 12)}`, `git -C "${ctx.engine}" submodule update tools/${name} (or hades tools bump)`));
  }
  if (out.length === 0) return [check('OK', 'tools', `${names.length}/${names.length} submodules at pinned commits`)];
  return out;
}

// Prefer the verify helper of lib/core/tools.mjs when it exists and returns a recognisable result.
export function fromVerifyResult(res) {
  const list = Array.isArray(res) ? res : res && (res.tools || res.results || res.checks);
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || !r.name) return null;
    const ok = r.ok === true || r.status === 'ok' || r.status === 'OK' || r.status === 'pass';
    if (ok) continue;
    if (r.status === 'not initialized' || (!r.actual && r.status !== 'mismatch')) {
      out.push(check('WARN', `tool ${r.name}`, `submodule ${r.status || 'not checked out'}`, `git submodule update --init tools/${r.name}`));
    } else if (r.actual && r.expected) {
      out.push(check('FAIL', `tool ${r.name}`, `at ${String(r.actual).slice(0, 12)}, lock pins ${String(r.expected).slice(0, 12)}`, `git submodule update tools/${r.name} (or hades tools bump)`));
    } else {
      out.push(check('FAIL', `tool ${r.name}`, String(r.detail || r.message || r.status || 'not at the pinned commit'), r.fix || 'hades tools verify'));
    }
  }
  return out.length ? out : [check('OK', 'tools', `${list.length}/${list.length} submodules at pinned commits`)];
}

export async function checkTools(ctx, probe) {
  try {
    const mod = await import('../core/tools.mjs');
    const fn = typeof mod.verify === 'function' ? mod.verify : typeof mod.verifyTools === 'function' ? mod.verifyTools : null;
    if (fn) {
      const lines = fromVerifyResult(await fn(ctx));
      if (lines) return lines;
    }
  } catch {
    // tools.mjs missing or its verify failed: fall back to git rev-parse below
  }
  return checkToolPins(ctx, probe);
}

// ---- installed files and settings ----

function sameFile(a, b) {
  const x = slash(path.resolve(a));
  const y = slash(path.resolve(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// The Node binary the guard hook or the agents' MCP servers run with ("hades install" renders the
// absolute path of the Node that ran it): it must exist and be Node >= MIN_NODE. "node" from PATH
// (older installs) depends on the PATH of whatever starts Claude Code. bad = status when it cannot run.
export function checkNodeBinary(probe, name, node, fix, bad = 'FAIL') {
  if (!node) return null;
  if (!path.isAbsolute(node)) return check('WARN', name, `runs "${node}" from PATH (older install); a session without Node ${MIN_NODE}+ on PATH cannot start it`, `${fix} (renders the absolute Node path)`);
  if (!fs.existsSync(node)) return check(bad, name, `${slash(node)} not found`, `${fix} (with the Node ${MIN_NODE}+ you use now)`);
  const version = sameFile(node, process.execPath) ? process.versions.node : firstVersion(probe.exec(node, ['--version']).stdout);
  if (!version) return check('WARN', name, `cannot read the version of ${slash(node)}`, `run "${slash(node)}" --version`);
  if (parseInt(version, 10) < MIN_NODE) return check(bad, name, `${slash(node)} is v${version} (< ${MIN_NODE})`, `install Node.js ${MIN_NODE} or newer, then ${fix}`);
  return check('OK', name, `${slash(node)} (v${version})`);
}

// The distinct MCP "command:" values of the installed agents of a recorded install.
export function installedAgentNodes(rec) {
  const nodes = new Set();
  for (const f of (rec.files || []).filter((x) => x.kind === 'agent')) {
    let text = '';
    try {
      text = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue; // reported as missing by inspectInstall
    }
    for (const c of agentNodeCommands(text)) nodes.add(c);
  }
  return [...nodes];
}

export function checkInstall(ctx, probe = defaultProbe()) {
  const out = [];
  const guardFile = `${ctx.engine}/hooks/guard.mjs`;
  if (!fs.existsSync(guardFile)) out.push(check('FAIL', 'guard', `${guardFile} missing`, 'restore hooks/guard.mjs from git'));
  const manifest = loadManifest(ctx);
  if (manifest.installs.length === 0) {
    out.push(check('WARN', 'install', 'agents, skills and hooks are not installed', 'hades install'));
    return out;
  }
  for (const rec of manifest.installs) {
    const label = `install ${rec.scope}`;
    const fix = `hades install --scope ${rec.scope}${rec.scope === 'project' && rec.workspace ? ` --workspace "${rec.workspace}"` : ''}`;
    const { missing, modified, outdated } = inspectInstall(ctx, rec);
    const agents = (rec.files || []).filter((f) => f.kind === 'agent').length;
    const skills = new Set((rec.files || []).filter((f) => f.kind === 'skill').map((f) => f.name)).size;
    if (missing.length) out.push(check('WARN', label, `${missing.length} installed file(s) missing: ${missing.slice(0, 3).join(', ')}`, fix));
    if (modified.length) out.push(check('WARN', label, `${modified.length} installed file(s) changed by hand: ${modified.slice(0, 3).join(', ')}`, `${fix} (overwrites them)`));
    if (outdated.length) out.push(check('WARN', label, `${outdated.length} file(s) differ from the engine sources: ${outdated.slice(0, 3).join(', ')}`, fix));
    if (!missing.length && !modified.length && !outdated.length) out.push(check('OK', label, `${agents} agents, ${skills} skills in ${rec.claude_dir}, current`));
    // A missing or too old Node only costs the agents their MCP tools (they fall back to Grep/Read).
    for (const node of installedAgentNodes(rec)) out.push(checkNodeBinary(probe, `mcp node ${rec.scope}`, node, fix, 'WARN'));
    if (rec.scope === 'user') {
      const shadows = shadowedBy(rec.files || [], ctx.workspace);
      if (shadows.length) {
        out.push(check('WARN', label, `${shadows.length} same-name project-level item(s) in ${ctx.workspace}/.claude override it there: ${shadows.slice(0, 4).map((x) => `${x.kind} ${x.name}`).join(', ')}`, 'remove them (old HADES v1 copies?) or hades install --scope project'));
      }
    }
    let settings = null;
    try {
      settings = readSettings(rec.settings_file);
    } catch (err) {
      out.push(check('FAIL', `hook ${rec.scope}`, `cannot read ${rec.settings_file}: ${err.message}`, 'fix the JSON, then re-run hades install'));
      continue;
    }
    if (!hasGuardHook(settings, ctx.engine)) {
      out.push(check('FAIL', `hook ${rec.scope}`, `guard hook not registered in ${rec.settings_file}`, fix));
      continue;
    }
    const gaps = guardMatcherGaps(settings, ctx.engine) || [];
    if (gaps.length) out.push(check('WARN', `hook ${rec.scope}`, `guard matcher in ${rec.settings_file} misses ${gaps.join(', ')}`, fix));
    else out.push(check('OK', `hook ${rec.scope}`, `guard registered in ${rec.settings_file}`));
    // A guard that cannot start blocks every guarded call (onFailure: block) or, on Claude Code
    // versions without onFailure, lets it through unchecked.
    const node = checkNodeBinary(probe, `hook node ${rec.scope}`, guardHookNode(settings, ctx.engine), fix);
    if (node) out.push(node);
  }
  return out;
}

// ---- AWS ----

// The profiles the AWS MCP proxy will sign with: same precedence as awsSettings() in
// lib/core/tools.mjs (hades.config.json aws.profile, then aws.profiles, then AWS_PROFILE).
// --aws-profile checks one profile ad hoc instead.
export function awsProfiles(ctx, flags = {}, env = process.env) {
  if (typeof flags.awsProfile === 'string' && flags.awsProfile.trim()) return { profiles: [flags.awsProfile.trim()], source: '--aws-profile' };
  const cfg = (ctx.config && ctx.config.aws) || {};
  const fromCfg = cfg.profile ?? cfg.profiles;
  const raw = fromCfg ?? env.AWS_PROFILE ?? '';
  const profiles = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  return profiles.length ? { profiles, source: fromCfg !== undefined && fromCfg !== null ? 'hades.config.json' : 'AWS_PROFILE' } : null;
}

export function maskArn(arn) {
  return String(arn).replace(/:(\d{8})(\d{4}):/, (m, a, b) => `:********${b}:`);
}

function checkAwsProfile(probe, aws, profile, source) {
  if (!/^[A-Za-z0-9_.@+=:-]{1,128}$/.test(profile)) return check('FAIL', 'aws', `invalid profile name from ${source}`, 'use a plain profile name');
  const res = probe.exec(aws, ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], { timeout: 30000 });
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${res.code}`;
    return check('WARN', 'aws', `profile ${profile} (${source}) not usable: ${why.slice(0, 160)}`, `aws login --profile ${profile} (or aws sso login --profile ${profile})`);
  }
  let arn = '';
  try {
    arn = JSON.parse(res.stdout).Arn || '';
  } catch {
    return check('WARN', 'aws', `profile ${profile}: unreadable sts output`, `aws sts get-caller-identity --profile ${profile}`);
  }
  if (/:root$/.test(arn)) {
    return check('FAIL', 'aws', `profile ${profile} uses ROOT credentials (${maskArn(arn)}); autonomous agents must never use root`, 'create a least-privilege IAM role (or SSO permission set) and point the profile at it');
  }
  return check('OK', 'aws', `profile ${profile} (${source}) -> ${maskArn(arn)}`);
}

export function checkAws(ctx, probe, flags = {}) {
  const aws = probe.find('aws');
  if (!aws) return [check('WARN', 'aws', 'aws CLI not found (AWS checks skipped)', 'install AWS CLI v2 if a team deploys to AWS')];
  const p = awsProfiles(ctx, flags, probe.env);
  if (!p) return [check('WARN', 'aws', 'no AWS profile configured', 'set "aws": {"profile": "<name>"} in hades.config.json or AWS_PROFILE (only for AWS deploys)')];
  return p.profiles.slice(0, 3).map((profile) => checkAwsProfile(probe, aws, profile, p.source));
}

// ---- command ----

export async function runChecks(ctx, probe = defaultProbe(), flags = {}) {
  const results = [checkNode(probe), checkGit(probe), checkClaude(probe), checkUv(probe), checkDocker(probe)];
  results.push(...checkConfig(ctx, probe.env));
  results.push(...checkVaultPlacement(ctx, probe));
  results.push(...checkVaultNotes(ctx));
  results.push(...checkRegistry(ctx));
  results.push(...checkTeams(ctx));
  results.push(...checkStacks(ctx));
  results.push(...(await checkTools(ctx, probe)));
  results.push(...checkInstall(ctx, probe));
  results.push(...checkAws(ctx, probe, flags));
  return results;
}

export function summaryLine(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  return `doctor: ${n('OK')} ok, ${n('WARN')} warn, ${n('FAIL')} fail`;
}

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) return print(HELP);
  const results = await runChecks(ctx, defaultProbe(), args.flags);
  const failed = results.some((r) => r.status === 'FAIL');
  output(args, { ok: !failed, checks: results }, [...results.map(formatCheck), summaryLine(results)].join('\n'));
  if (failed) process.exitCode = 2;
  return results;
}

