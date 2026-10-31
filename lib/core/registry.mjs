// registry.json (vault root, schema version 3): load, validate, save, add organizations and teams.
// The CLI is the only writer. Format: docs/file-formats.md.
import path from 'node:path';
import { readJson, writeJson, slash, fail, today } from './util.mjs';
import { REGISTRY_VERSION } from './config.mjs';

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TEAM_TYPES = ['main', 'sub'];

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, organizations: {}, teams: {} };
}

export function registryFile(ctx) {
  return ctx.registryFile || `${slash(ctx.vault)}/registry.json`;
}

// Reads the registry fresh from disk (never the cached ctx.registry, so writers see the latest).
export function loadRegistry(ctx) {
  const file = registryFile(ctx);
  const reg = readJson(file, null);
  if (!reg || typeof reg !== 'object') fail(`no registry at ${file}. Run "hades init --vault <path>" first.`);
  if (!reg.organizations || typeof reg.organizations !== 'object') reg.organizations = {};
  if (!reg.teams || typeof reg.teams !== 'object') reg.teams = {};
  return reg;
}

// Atomic write (temp file + rename). "version" stays first and is always 3.
export function saveRegistry(ctx, reg) {
  const { version, ...rest } = reg;
  const doc = { version: REGISTRY_VERSION, ...rest };
  writeJson(registryFile(ctx), doc);
  ctx.registry = doc;
  return doc;
}

// "a, b,c" | ["a", "b,c"] -> ["a", "b", "c"] (trimmed, empties and duplicates dropped).
export function parseAliases(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of list) {
    for (const part of String(v).split(',')) {
      const a = part.trim();
      if (a && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
    }
  }
  return out;
}

const isAbs = (p) => path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('\\');

function checkRelDir(p, where, problems) {
  if (typeof p !== 'string' || !p) return problems.push(`${where}: missing`);
  if (p.includes('\\')) problems.push(`${where}: use forward slashes (${p})`);
  if (isAbs(p)) problems.push(`${where}: must be relative to the vault (${p})`);
  if (p.split(/[\\/]/).includes('..')) problems.push(`${where}: must stay inside the vault (${p})`);
  return undefined;
}

function checkPath(p, where, problems, { required = false } = {}) {
  if (p === undefined || p === null || p === '') {
    if (required) problems.push(`${where}: missing`);
    return;
  }
  if (typeof p !== 'string') return void problems.push(`${where}: must be a string`);
  if (p.includes('\\')) problems.push(`${where}: use forward slashes (${p})`);
}

// Returns a list of problems (empty = valid).
export function validateRegistry(reg) {
  const problems = [];
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return ['registry must be a JSON object'];
  if (reg.version !== REGISTRY_VERSION) problems.push(`version must be ${REGISTRY_VERSION} (is ${JSON.stringify(reg.version)}); run "hades migrate"`);
  const orgs = reg.organizations && typeof reg.organizations === 'object' ? reg.organizations : null;
  const teams = reg.teams && typeof reg.teams === 'object' ? reg.teams : null;
  if (!orgs) problems.push('organizations must be an object');
  if (!teams) problems.push('teams must be an object');

  // Every name and alias, to find alias collisions (case-insensitive, as lookups are).
  const owners = new Map(); // lower token -> [{kind, name, isAlias}]
  const note = (token, kind, name, isAlias) => {
    const k = String(token).toLowerCase();
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push({ kind, name, isAlias });
  };
  const checkAliases = (aliases, where, kind, name) => {
    if (aliases === undefined) return;
    if (!Array.isArray(aliases)) return void problems.push(`${where}.aliases: must be an array`);
    const seen = new Set();
    for (const a of aliases) {
      if (typeof a !== 'string' || !ALIAS_RE.test(a)) {
        problems.push(`${where}.aliases: invalid alias ${JSON.stringify(a)} (letters, digits, . _ -; no spaces or commas)`);
        continue;
      }
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      if (a.toLowerCase() !== name.toLowerCase()) note(a, kind, name, true);
    }
  };

  for (const [name, o] of Object.entries(orgs || {})) {
    const where = `organizations.${name}`;
    if (!NAME_RE.test(name)) problems.push(`${where}: name must be kebab-case`);
    if (!o || typeof o !== 'object') {
      problems.push(`${where}: must be an object`);
      continue;
    }
    note(name, 'org', name, false);
    checkRelDir(o.org_dir, `${where}.org_dir`, problems);
    checkPath(o.root_path, `${where}.root_path`, problems);
    checkAliases(o.aliases, where, 'org', name);
  }
  for (const [name, t] of Object.entries(teams || {})) {
    const where = `teams.${name}`;
    if (!NAME_RE.test(name)) problems.push(`${where}: name must be kebab-case`);
    if (!t || typeof t !== 'object') {
      problems.push(`${where}: must be an object`);
      continue;
    }
    note(name, 'team', name, false);
    if (!t.organization) problems.push(`${where}.organization: missing`);
    else if (!orgs || !orgs[t.organization]) problems.push(`${where}.organization: unknown organization "${t.organization}"`);
    if (t.type !== undefined && !TEAM_TYPES.includes(t.type)) problems.push(`${where}.type: must be main or sub (is ${JSON.stringify(t.type)})`);
    checkRelDir(t.team_dir, `${where}.team_dir`, problems);
    checkPath(t.project_path, `${where}.project_path`, problems);
    checkAliases(t.aliases, where, 'team', name);
  }

  // An alias may not equal another entry's alias, nor the name of any other team or organization.
  // Exception: a team alias may equal its own organization's name ("/hades acme" -> that team);
  // team resolution checks team names and aliases before organizations, so it stays unambiguous.
  for (const [token, list] of owners) {
    const aliases = list.filter((x) => x.isAlias);
    if (!aliases.length) continue;
    const orgOfTeam = (x) => reg.teams?.[x.name]?.organization;
    const relevant = list.filter(
      (x) => !(x.kind === 'org' && !x.isAlias && list.some((y) => y.kind === 'team' && y.isAlias && orgOfTeam(y) === x.name)),
    );
    const distinct = new Map(relevant.map((x) => [`${x.kind}:${x.name}`, x]));
    if (distinct.size < 2) continue;
    const who = [...distinct.values()].map((x) => `${x.kind === 'org' ? 'organization' : 'team'} ${x.name}${x.isAlias ? ' (alias)' : ''}`);
    problems.push(`alias "${token}" is ambiguous: ${who.join(', ')}`);
  }
  return problems;
}

// Organization by name or alias (case-insensitive); null when none.
export function findOrg(reg, query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  for (const [name, o] of Object.entries(reg.organizations || {})) if (name.toLowerCase() === q) return { name, ...o };
  for (const [name, o] of Object.entries(reg.organizations || {})) {
    if ((o.aliases || []).some((a) => String(a).toLowerCase() === q)) return { name, ...o };
  }
  return null;
}

// Every name/alias token already in use (lower case) -> description.
function tokensInUse(reg) {
  const used = new Map();
  for (const [name, o] of Object.entries(reg.organizations || {})) {
    used.set(name.toLowerCase(), `organization ${name}`);
    for (const a of o.aliases || []) used.set(String(a).toLowerCase(), `alias of organization ${name}`);
  }
  for (const [name, t] of Object.entries(reg.teams || {})) {
    if (!used.has(name.toLowerCase())) used.set(name.toLowerCase(), `team ${name}`);
    for (const a of t.aliases || []) used.set(String(a).toLowerCase(), `alias of team ${name}`);
  }
  return used;
}

function checkNewAliases(reg, name, aliases, kind) {
  const used = tokensInUse(reg);
  for (const a of aliases) {
    if (!ALIAS_RE.test(a)) fail(`invalid alias "${a}" (letters, digits, . _ -; no spaces)`);
    if (a.toLowerCase() === name.toLowerCase()) continue;
    const owner = used.get(a.toLowerCase());
    if (owner) fail(`alias "${a}" is already used: ${owner}`);
  }
  // The new name may not be someone else's alias (an alias would shadow or be shadowed by it).
  const owner = used.get(name.toLowerCase());
  if (owner && owner.startsWith('alias')) fail(`${kind} name "${name}" is already used: ${owner}`);
}

// Adds an organization (mutates reg). Refuses invalid names and duplicates by name or alias.
export function addOrganization(reg, name, { root_path, description = '', aliases = [], org_dir, created } = {}) {
  if (!NAME_RE.test(String(name || ''))) fail(`organization name must be kebab-case: ${name}`);
  if (reg.organizations[name]) fail(`organization "${name}" already exists`);
  if (!root_path) fail('organization needs a root path (--root <path>)');
  const list = parseAliases(aliases);
  checkNewAliases(reg, name, list, 'organization');
  const entry = {
    org_dir: org_dir || `organizations/${name}`,
    root_path: slash(String(root_path)).replace(/\/+$/, ''),
    description: String(description || ''),
    aliases: list,
    created: created || today(),
  };
  const before = new Set(validateRegistry(reg));
  reg.organizations[name] = entry;
  const added = validateRegistry(reg).filter((p) => !before.has(p));
  if (added.length) {
    delete reg.organizations[name];
    fail(`invalid organization: ${added.join('; ')}`);
  }
  return entry;
}

// Adds a team (mutates reg). Refuses invalid names, unknown organizations and duplicates.
export function addTeam(reg, name, { organization, type = 'main', project_path, team_dir, description = '', aliases = [], status = 'active', created } = {}) {
  if (!NAME_RE.test(String(name || ''))) fail(`team name must be kebab-case: ${name}`);
  if (reg.teams[name]) fail(`team "${name}" already exists`);
  const org = reg.organizations[organization];
  if (!org) fail(`unknown organization "${organization}" (create it with "hades org new")`);
  if (!TEAM_TYPES.includes(type)) fail(`team type must be main or sub (is "${type}")`);
  if (!project_path) fail('team needs a project path (--project <path>)');
  const list = parseAliases(aliases);
  checkNewAliases(reg, name, list, 'team');
  const entry = {
    organization,
    type,
    project_path: slash(String(project_path)).replace(/\/+$/, ''),
    team_dir: team_dir || `${org.org_dir || `organizations/${organization}`}/teams/${name}`,
    description: String(description || ''),
    aliases: list,
    status,
    created: created || today(),
  };
  const before = new Set(validateRegistry(reg));
  reg.teams[name] = entry;
  const added = validateRegistry(reg).filter((p) => !before.has(p));
  if (added.length) {
    delete reg.teams[name];
    fail(`invalid team: ${added.join('; ')}`);
  }
  return entry;
}
