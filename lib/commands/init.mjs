// hades init [--vault <path>] [--workspace <path>] [--json]
// Writes hades.config.json (merged: unknown keys such as "aws" are kept) and scaffolds a vault from
// templates/vault/ when the vault path has no registry.json. HADES_CONFIG_FILE redirects the config
// file (tests); HADES_VAULT / HADES_WORKSPACE are the defaults when the flags are absent.
import fs from 'node:fs';
import path from 'node:path';
import { print, fail, readJson, writeJson, slash, copyTemplateDir, today, git, run as runCmd, allowFlags } from '../core/util.mjs';
import { ENGINE, CONFIG_FILE } from '../core/config.mjs';
import { validateRegistry } from '../core/registry.mjs';

export const needsVault = false;
export const FLAGS = ['vault', 'workspace'];

const HELP = `Usage: hades init [--vault <path>] [--workspace <path>] [--json]

Writes <engine>/hades.config.json (merged; other keys are kept) and, when <vault> has no
registry.json, scaffolds a vault from templates/vault/ and runs "git init" in it unless it is
already inside a git repository (nothing is committed).
  --vault <path>      vault folder (default: HADES_VAULT, the configured vault, else <engine>/vault)
  --workspace <path>  folder that holds the projects (default: HADES_WORKSPACE, the configured
                      workspace, else the engine's parent folder)
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

function pathFlag(flags, key) {
  const v = flags[key];
  if (v === undefined) return null;
  if (v === true || String(v).trim() === '') fail(`--${key} needs a path`);
  return slash(path.resolve(String(v)));
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

  const pick = (flag, env, key, dflt) => pathFlag(args.flags, flag) || (process.env[env] ? slash(path.resolve(process.env[env])) : null) || (existing[key] ? slash(path.resolve(String(existing[key]))) : null) || slash(path.resolve(dflt));
  const vault = pick('vault', 'HADES_VAULT', 'vault', `${ENGINE}/vault`);
  const workspace = pick('workspace', 'HADES_WORKSPACE', 'workspace', path.dirname(ENGINE));

  if (fs.existsSync(vault) && !fs.statSync(vault).isDirectory()) fail(`vault path is a file: ${vault}`);
  if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory()) fail(`workspace path is a file: ${workspace}`);

  // Merge: keep key order and unknown keys; only vault and workspace change.
  const config = { ...existing, vault, workspace };
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
    // Its own repository unless it lives (tracked, not ignored) inside another one.
    const probe = git(vault, 'rev-parse', '--is-inside-work-tree');
    const ignored = probe.code === 0 && git(vault, 'check-ignore', '-q', 'registry.json').code === 0;
    if (probe.code === 0 && probe.stdout.trim() === 'true' && !ignored) gitState = 'inside-repo';
    else {
      const res = runCmd('git', ['init', '-q', vault]);
      gitState = res.code === 0 ? 'init' : 'unavailable';
    }
  } else {
    const probe = git(vault, 'rev-parse', '--is-inside-work-tree');
    gitState = probe.code === 0 && probe.stdout.trim() === 'true' ? 'inside-repo' : 'none';
  }
  const registry = readJson(registryFile, null);
  const problems = registry ? validateRegistry(registry) : ['registry.json unreadable'];
  const counts = registry
    ? { version: registry.version, organizations: Object.keys(registry.organizations || {}).length, teams: Object.keys(registry.teams || {}).length }
    : null;
  const next = registry && registry.version !== 3 ? ['hades migrate', 'hades install'] : ['hades install', 'hades doctor'];

  const data = { configFile, config, configChanged, vault, workspace, scaffolded, files, git: gitState, registry: counts, problems, next };
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
  lines.push(`next       ${next.join(', then ')}`);
  print(lines.join('\n'));
}
