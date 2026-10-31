// Resolves where the engine, the vault and the workspace live, and loads the registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, slash, fail } from './util.mjs';

export const ENGINE = slash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
// HADES_CONFIG_FILE lets tests (and unusual setups) point at another config file.
export const CONFIG_FILE = process.env.HADES_CONFIG_FILE ? slash(path.resolve(process.env.HADES_CONFIG_FILE)) : `${ENGINE}/hades.config.json`;
export const REGISTRY_VERSION = 3;

// The vault used when none is configured: <engine>/.vault (git-ignored by the engine repository,
// with its own git repository). A legacy <engine>/vault (the default before .vault) that holds a
// registry.json is used instead while <engine>/.vault does not exist (hades doctor warns).
// HADES_DEFAULT_VAULT replaces this built-in default (tests use it to keep away from a real vault).
export const VAULT_DIR = '.vault';
export const LEGACY_VAULT_DIR = 'vault';

export function defaultVault(engine = ENGINE, env = process.env) {
  if (env.HADES_DEFAULT_VAULT) return slash(path.resolve(env.HADES_DEFAULT_VAULT));
  const root = slash(engine).replace(/\/+$/, '');
  const current = `${root}/${VAULT_DIR}`;
  const legacy = `${root}/${LEGACY_VAULT_DIR}`;
  if (!fs.existsSync(current) && fs.existsSync(`${legacy}/registry.json`)) return legacy;
  return current;
}

// A relative "vault" or "workspace" (in hades.config.json, HADES_VAULT / HADES_WORKSPACE or the
// "hades init" flags) is relative to the engine folder, never to the current directory (so
// "vault": ".vault" survives moving or renaming the engine folder).
export function configPath(value, engine = ENGINE) {
  return slash(path.resolve(engine, String(value)));
}

// True when p is the folder dir or below it (case-insensitive on Windows).
export function isInsideDir(p, dir) {
  const norm = (x) => {
    const v = slash(path.resolve(String(x))).replace(/\/+$/, '');
    return process.platform === 'win32' ? v.toLowerCase() : v;
  };
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(`${b}/`);
}

// Order: environment variables, then hades.config.json, then defaults.
export function resolvePaths() {
  const file = readJson(CONFIG_FILE, {});
  // A relative HADES_VAULT / HADES_WORKSPACE is relative to the engine too (as in the guard hook).
  const vault = process.env.HADES_VAULT ? configPath(process.env.HADES_VAULT) : file.vault ? configPath(file.vault) : defaultVault();
  const workspace = process.env.HADES_WORKSPACE ? configPath(process.env.HADES_WORKSPACE) : file.workspace ? configPath(file.workspace) : path.dirname(ENGINE);
  return {
    engine: ENGINE,
    vault: slash(path.resolve(vault)),
    workspace: slash(path.resolve(workspace)),
    configFile: CONFIG_FILE,
    config: file,
  };
}

export function loadContext({ needVault = true } = {}) {
  const paths = resolvePaths();
  const registryFile = `${paths.vault}/registry.json`;
  let registry = null;
  if (fs.existsSync(registryFile)) registry = readJson(registryFile);
  else if (needVault) fail(`no vault at ${paths.vault}. Run "hades init --vault <path>" first.`);
  return { ...paths, registryFile, registry };
}

// Absolute path of a vault-relative path such as "organizations/acme/teams/portal".
export function vaultPath(ctx, rel) {
  return slash(path.resolve(ctx.vault, rel));
}

// Finds a team by name, alias (case-insensitive) or by a path inside its project_path
// (the longest matching project_path wins). Returns null when nothing matches.
export function findTeam(registry, query) {
  if (!registry || !query) return null;
  const teams = registry.teams || {};
  const q = String(query).toLowerCase();
  for (const [name, t] of Object.entries(teams)) {
    if (name.toLowerCase() === q) return { name, ...t };
  }
  for (const [name, t] of Object.entries(teams)) {
    if ((t.aliases || []).some((a) => String(a).toLowerCase() === q)) return { name, ...t };
  }
  const asPath = slash(path.resolve(query)).toLowerCase();
  let best = null;
  for (const [name, t] of Object.entries(teams)) {
    const p = slash(t.project_path || '').toLowerCase().replace(/\/+$/, '');
    if (p && (asPath === p || asPath.startsWith(`${p}/`)) && (!best || p.length > best.len)) {
      best = { len: p.length, team: { name, ...t } };
    }
  }
  return best ? best.team : null;
}

export function requireTeam(ctx, query) {
  const team = findTeam(ctx.registry, query);
  if (!team) fail(`unknown team, alias or project path: ${query}`);
  return { ...team, dir: vaultPath(ctx, team.team_dir) };
}
