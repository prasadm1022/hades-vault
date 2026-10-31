// Resolves where the engine, the vault and the workspace live, and loads the registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, slash, fail } from './util.mjs';

export const ENGINE = slash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
// HADES_CONFIG_FILE lets tests (and unusual setups) point at another config file.
export const CONFIG_FILE = process.env.HADES_CONFIG_FILE ? slash(path.resolve(process.env.HADES_CONFIG_FILE)) : `${ENGINE}/hades.config.json`;
export const REGISTRY_VERSION = 3;

// Order: environment variables, then hades.config.json, then defaults.
export function resolvePaths() {
  const file = readJson(CONFIG_FILE, {});
  const vault = process.env.HADES_VAULT || file.vault || `${ENGINE}/vault`;
  const workspace = process.env.HADES_WORKSPACE || file.workspace || path.dirname(ENGINE);
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
