// hades init [--vault <path>] [--workspace <path>] [--json]
// Writes hades.config.json (merged: unknown keys such as "aws" are kept) and scaffolds a vault from
// templates/vault/ when the vault path has no registry.json. The default vault is <engine>/.vault
// (git-ignored by the engine repository, its own git repository); a vault inside the engine is
// written to the config relative to the engine (".vault"), so renaming the engine folder keeps it. HADES_CONFIG_FILE redirects the config
// file (tests); HADES_VAULT / HADES_WORKSPACE are the defaults when the flags are absent.
import fs from 'node:fs';
import path from 'node:path';
import { print, fail, readJson, writeJson, slash, copyTemplateDir, today, git, run as runCmd, allowFlags } from '../core/util.mjs';
import { ENGINE, CONFIG_FILE, defaultVault, configPath, isInsideDir } from '../core/config.mjs';
import { validateRegistry } from '../core/registry.mjs';

export const needsVault = false;
export const FLAGS = ['vault', 'workspace'];

const HELP = `Usage: hades init [--vault <path>] [--workspace <path>] [--json]

Writes <engine>/hades.config.json (merged; other keys are kept) and, when <vault> has no
registry.json, scaffolds a vault from templates/vault/ and runs "git init" in it (its own private
repository) unless it is tracked inside another git repository (nothing is committed).
  --vault <path>      vault folder (default: HADES_VAULT, the configured vault, else <engine>/.vault,
                      which the engine repository git-ignores; a vault inside the engine is stored
                      in hades.config.json relative to the engine)
  --workspace <path>  folder that holds the projects (default: HADES_WORKSPACE, the configured
                      workspace, else the engine's parent folder)
A relative path (flag, HADES_VAULT, HADES_WORKSPACE or config value) is relative to the engine
folder, not to the current folder. An existing vault inside the engine without a git repository of
its own gets one ("git init"; nothing committed).
Exit: 0 ok, 1 error.`;

const BOOLEANS = ['json', 'help'];

function prep(args) {
  for (const k of BOOLEANS) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.push(v);
    if (v !== undefined) args.flags[k] = true;
  }
  allowFlags(args, FLAGS);
}

// A relative path is relative to the engine (as in hades.config.json), not to the current folder:
// "hades init --vault .vault" is always <engine>/.vault.
function pathFlag(flags, key) {
  const v = flags[key];
  if (v === undefined) return null;
  if (v === true || String(v).trim() === '') fail(`--${key} needs a path`);
  return configPath(String(v));
}

const samePath = (a, b) => {
  const n = (x) => {
    const s = slash(path.resolve(String(x))).replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
};

// The git state of a vault folder: 'own' (it is the top of its own repository), 'inside-repo' (tracked
// inside another repository: no nested repository), else a repository is created ('init') when
// create is set ('unavailable' without git). A vault inside the engine, or one the surrounding
// repository git-ignores, always gets its own repository: git commands run in it would otherwise act
// on the surrounding (engine) repository, and a push would go to that repository's remote.
function vaultGit(vault, { inEngine, create }) {
  const top = git(vault, 'rev-parse', '--show-toplevel');
  if (top.code === 0) {
    const t = top.stdout.trim();
    let real = vault;
    try {
      real = fs.realpathSync.native(vault);
    } catch {
      /* keep */
    }
    if (samePath(t, vault) || samePath(t, real)) return 'own';
    const ignored = git(vault, 'check-ignore', '-q', 'registry.json').code === 0;
    if (!ignored && !inEngine) return 'inside-repo';
  } else if (!create) return 'none';
  const res = runCmd('git', ['init', '-q', vault]);
  return res.code === 0 ? 'init' : 'unavailable';
}

export async function run(args, ctx) {
  prep(args);
  if (args.flags.help) {
    print(HELP);
    return;
  }
  if (args.positional.length) fail(`unexpected argument: ${args.positional[0]}\n${HELP}`);
  const configFile = slash(path.resolve(process.env.HADES_CONFIG_FILE || (ctx && ctx.configFile) || CONFIG_FILE));
  const existing = readJson(configFile, {});
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) fail(`${configFile} must hold a JSON object`);

  const pick = (flag, env, key, dflt) => pathFlag(args.flags, flag) || (process.env[env] ? configPath(process.env[env]) : null) || (existing[key] ? configPath(existing[key]) : null) || slash(path.resolve(dflt));
  const vault = pick('vault', 'HADES_VAULT', 'vault', defaultVault());
  const workspace = pick('workspace', 'HADES_WORKSPACE', 'workspace', path.dirname(ENGINE));

  if (isInsideDir(ENGINE, vault)) fail(`the vault cannot be the engine folder or one of its parents: ${vault} (the default is ${ENGINE}/.vault)`);
  if (fs.existsSync(vault) && !fs.statSync(vault).isDirectory()) fail(`vault path is a file: ${vault}`);
  if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory()) fail(`workspace path is a file: ${workspace}`);

  // Merge: keep key order and unknown keys; only vault and workspace change. A vault inside the
  // engine is stored relative to it (resolvePaths resolves relative config paths against the engine).
  const inEngine = isInsideDir(vault, ENGINE);
  const storedVault = inEngine ? slash(path.relative(ENGINE, vault)) : vault;
  // Repointing away from a vault that still holds a registry: say so (its data is not moved).
  const previous = existing.vault ? configPath(existing.vault) : null;
  const left = previous && !samePath(previous, vault) && fs.existsSync(`${previous}/registry.json`) ? previous : null;
  const config = { ...existing, vault: storedVault, workspace };
  const configChanged = JSON.stringify(config) !== JSON.stringify(existing);
  if (configChanged) writeJson(configFile, config);

  const registryFile = `${vault}/registry.json`;
  let scaffolded = false;
  let files = 0;
  let gitState = 'existing';
  if (!fs.existsSync(registryFile)) {
    const vars = { ENGINE, VAULT: vault, WORKSPACE: workspace, DATE: today() };
    files = copyTemplateDir(`${ENGINE}/templates/vault`, vault, vars).length;
    scaffolded = true;
    // Its own repository unless it lives (tracked, not ignored) inside another one. A vault inside
    // the engine always gets its own repository: private data never joins the engine's history
    // (hades doctor FAILs when the engine repository does not git-ignore it).
    gitState = vaultGit(vault, { inEngine, create: true });
  } else {
    // An existing vault: 'own' and 'inside-repo' are kept; one inside the engine (or git-ignored by
    // the surrounding repository) without a repository of its own gets one now. A vault outside any
    // repository is left alone ('none').
    gitState = vaultGit(vault, { inEngine, create: false });
    if (gitState === 'own') gitState = 'repo';
  }
  const registry = readJson(registryFile, null);
  const problems = registry ? validateRegistry(registry) : ['registry.json unreadable'];
  const counts = registry
    ? { version: registry.version, organizations: Object.keys(registry.organizations || {}).length, teams: Object.keys(registry.teams || {}).length }
    : null;
  const next = registry && registry.version !== 3 ? ['hades migrate', 'hades install'] : ['hades install', 'hades doctor'];

  const notes = [];
  if (left) notes.push(`the config pointed at ${left}, which still holds a registry.json; its data stays there (move it into ${vault} yourself if this is a move)`);
  if (!scaffolded && gitState === 'init') notes.push(`${vault} had no git repository of its own (git commands in it acted on the surrounding repository): ran git init, nothing committed`);
  const data = { configFile, config, configChanged, vault, workspace, scaffolded, files, git: gitState, registry: counts, problems, next, notes };
  if (args.flags.json) {
    print(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [];
  lines.push(`config     ${configFile} (${configChanged ? 'written' : 'unchanged'})`);
  if (scaffolded) {
    const g = { init: 'git init', 'inside-repo': 'inside an existing git repo', unavailable: 'git not available: run "git init" yourself' }[gitState];
    lines.push(`vault      ${vault} (scaffolded ${files} file(s); ${g}; nothing committed)`);
  } else {
    lines.push(`vault      ${vault} (existing: registry v${counts ? counts.version : '?'}, ${counts ? counts.organizations : 0} org(s), ${counts ? counts.teams : 0} team(s)${problems.length ? `, ${problems.length} problem(s): hades doctor` : ''})`);
  }
  lines.push(`workspace  ${workspace}${fs.existsSync(workspace) ? '' : ' (does not exist yet)'}`);
  for (const n of notes) lines.push(`note       ${n}`);
  lines.push(`next       ${next.join(', then ')}`);
  print(lines.join('\n'));
}
