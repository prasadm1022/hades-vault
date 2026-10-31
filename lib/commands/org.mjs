// hades org new <org> --root <path> [--description "..."] [--aliases a,b] [--json]
// hades org list [--json]
import fs from 'node:fs';
import path from 'node:path';
import { print, fail, slash, copyTemplateDir, today, allowFlags } from '../core/util.mjs';
import { vaultPath } from '../core/config.mjs';
import { loadRegistry, saveRegistry, addOrganization, parseAliases } from '../core/registry.mjs';

const HELP = `Usage:
  hades org new <org> --root <path> [--description "..."] [--aliases a,b] [--json]
      scaffolds organizations/<org>/ from templates/organization/ and registers it
      (<org> kebab-case; --root = the folder that holds the organization's projects)
  hades org list [--json]
      organizations and their teams
Exit: 0 ok, 1 error.`;

const BOOLEANS = ['json', 'help'];
export const FLAGS = { new: ['root', 'description', 'aliases'], list: [] };

// parseArgs gives a boolean flag the next word ("--json list"); give it back to the positionals.
function fixBooleans(args) {
  for (const k of BOOLEANS) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.unshift(v);
    if (v !== undefined) args.flags[k] = true;
  }
}

function allow(args, allowed) {
  allowFlags(args, allowed);
}

function str(flags, key, { required = false } = {}) {
  const v = flags[key];
  if (v === undefined) {
    if (required) fail(`--${key} is required\n${HELP}`);
    return undefined;
  }
  if (v === true) fail(`--${key} needs a value`);
  return String(v);
}

export async function run(args, ctx) {
  fixBooleans(args);
  const sub = args.positional[0];
  if (args.flags.help || !sub || sub === 'help') {
    print(HELP);
    return;
  }
  args.positional.shift();
  if (sub === 'new') return orgNew(args, ctx);
  if (sub === 'list') return orgList(args, ctx);
  fail(`unknown subcommand "org ${sub}"\n${HELP}`);
}

function orgNew(args, ctx) {
  allow(args, ['root', 'description', 'aliases']);
  const name = args.positional[0];
  if (!name) fail(`missing <org>\n${HELP}`);
  if (args.positional.length > 1) fail(`unexpected argument: ${args.positional[1]}`);
  const root = slash(path.resolve(str(args.flags, 'root', { required: true })));
  const description = str(args.flags, 'description') || '';
  const aliases = parseAliases(str(args.flags, 'aliases'));

  const reg = loadRegistry(ctx);
  const entry = addOrganization(reg, name, { root_path: root, description, aliases });
  const dir = vaultPath(ctx, entry.org_dir);
  const vars = {
    ORG: name,
    ORG_DIR: entry.org_dir,
    ROOT_PATH: entry.root_path,
    DESCRIPTION: description,
    ALIASES: aliases.join(', '),
    DATE: entry.created || today(),
    VAULT: slash(ctx.vault),
    ENGINE: ctx.engine,
  };
  const existed = fs.existsSync(dir);
  const written = copyTemplateDir(`${ctx.engine}/templates/organization`, dir, vars);
  saveRegistry(ctx, reg);
  const data = { organization: name, ...entry, dir, files: written.length };
  if (args.flags.json) {
    print(JSON.stringify(data, null, 2));
    return;
  }
  print(`org ${name} registered (root ${entry.root_path}${fs.existsSync(entry.root_path) ? '' : ', not created yet'})`);
  print(`dir ${dir} (${written.length} file(s) written${existed ? ', existing files kept' : ''})`);
}

export function orgRows(reg) {
  const teams = Object.entries(reg.teams || {});
  return Object.entries(reg.organizations || {}).map(([name, o]) => ({
    organization: name,
    ...o,
    teams: teams.filter(([, t]) => t.organization === name).map(([t, v]) => ({ team: t, type: v.type || 'main', status: v.status || 'active' })),
  }));
}

function orgList(args, ctx) {
  allow(args, []);
  if (args.positional.length) fail(`unexpected argument: ${args.positional[0]}`);
  const reg = loadRegistry(ctx);
  const rows = orgRows(reg);
  if (args.flags.json) {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    print('no organizations (create one: hades org new <org> --root <path>)');
    return;
  }
  const w = Math.max(...rows.map((r) => r.organization.length));
  for (const r of rows) {
    const teams = r.teams.length ? r.teams.map((t) => `${t.team} (${t.type}${t.status !== 'active' ? `, ${t.status}` : ''})`).join(', ') : 'no teams';
    const aliases = r.aliases && r.aliases.length ? ` [${r.aliases.join(', ')}]` : '';
    print(`${r.organization.padEnd(w)}  ${r.root_path || '-'}${aliases}  teams: ${teams}`);
  }
}
