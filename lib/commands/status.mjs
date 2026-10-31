// hades status [<team>|<org>] [--json]
// Organizations -> teams (type, status) -> open tasks with stage and blocking defects. HADES v1
// single-file task records are counted as legacy. At most 40 lines for the whole company.
import { print, fail, allowFlags } from '../core/util.mjs';
import { findTeam } from '../core/config.mjs';
import { loadRegistry, validateRegistry, findOrg } from '../core/registry.mjs';
import { listTeamTasks, defectSummary } from './task.mjs';

export const MAX_LINES = 40;
export const FLAGS = [];

const HELP = `Usage: hades status [<team>|<org>] [--json]
Organizations, their teams (type, status) and open tasks with stage and blocking defects;
HADES v1 single-file task records are counted as legacy. <team> = name, alias or project path;
<org> = name or alias. --json prints everything.
Exit: 0 ok, 1 error (unknown team or organization).`;

const BOOLEANS = ['json', 'help'];

function fixBooleans(args) {
  for (const k of BOOLEANS) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.unshift(v);
    if (v !== undefined) args.flags[k] = true;
  }
}

function teamStatus(ctx, name, t) {
  const tasks = listTeamTasks(ctx, { name, ...t });
  const v2 = tasks.filter((x) => x.version === 2);
  const open = v2.filter((x) => x.open);
  return {
    team: name,
    type: t.type || 'main',
    status: t.status || 'active',
    project_path: t.project_path || '',
    team_dir: t.team_dir,
    counts: {
      open: open.length,
      done: v2.filter((x) => x.status === 'done').length,
      blocked: v2.filter((x) => x.status === 'blocked').length,
      legacy: tasks.filter((x) => x.version === 1).length,
      legacy_open: tasks.filter((x) => x.version === 1 && x.open).length,
    },
    open: open.map((x) => ({ id: x.id, title: x.title, size: x.size, stage: x.stage, defects: defectSummary(x.defects) })),
  };
}

export function collectStatus(ctx, reg, { org = null, team = null } = {}) {
  const orgs = [];
  const teams = Object.entries(reg.teams || {});
  const orgNames = Object.keys(reg.organizations || {});
  for (const [name, o] of Object.entries(reg.organizations || {})) {
    if (org && org !== name) continue;
    if (team && team.organization !== name) continue;
    orgs.push({
      organization: name,
      root_path: o.root_path || '',
      description: o.description || '',
      aliases: o.aliases || [],
      teams: teams.filter(([n, t]) => t.organization === name && (!team || team.name === n)).map(([n, t]) => teamStatus(ctx, n, t)),
    });
  }
  const orphans = teams.filter(([n, t]) => !orgNames.includes(t.organization) && (!team || team.name === n) && !org);
  if (orphans.length) {
    orgs.push({ organization: null, root_path: '', description: 'teams whose organization is not registered', aliases: [], teams: orphans.map(([n, t]) => teamStatus(ctx, n, t)) });
  }
  return orgs;
}

function teamLine(t) {
  const c = t.counts;
  const parts = [`open ${c.open}`, `done ${c.done}`];
  if (c.blocked) parts.push(`blocked ${c.blocked}`);
  if (c.legacy) parts.push(`legacy ${c.legacy}`);
  const blocking = t.open.reduce((n, x) => n + x.defects.blocking.length, 0);
  if (blocking) parts.push(`blocking defects ${blocking}`);
  return `  ${t.team}  ${t.type} ${t.status}  ${parts.join(', ')}`;
}

function taskLine(x) {
  const d = x.defects;
  const extra = [];
  if (d.blocking.length) extra.push(`blocking ${d.blocking.join(',')}`);
  if (d.blocked.length) extra.push(`blocked ${d.blocked.join(',')}`);
  if (d.open && !d.blocking.length) extra.push(`defects ${d.open} open`);
  const title = x.title.length > 50 ? `${x.title.slice(0, 47)}...` : x.title;
  return `    ${x.id}  ${(x.stage || 'close').padEnd(8)} ${x.size || '-'}  ${title}${extra.length ? `  [${extra.join('; ')}]` : ''}`;
}

export function renderStatus(data, { maxLines = MAX_LINES } = {}) {
  const head = [];
  const nTeams = data.organizations.reduce((n, o) => n + o.teams.length, 0);
  const nOpen = data.organizations.reduce((n, o) => n + o.teams.reduce((m, t) => m + t.counts.open, 0), 0);
  head.push(`vault ${data.vault}: ${data.organizations.filter((o) => o.organization).length} org(s), ${nTeams} team(s), ${nOpen} open task(s)`);
  if (data.problems.length) head.push(`registry: ${data.problems.length} problem(s), first: ${data.problems[0]}`);
  // detail 2: one line per open task; 1: one line of task IDs per team; 0: team lines only.
  const build = (detail) => {
    const lines = [...head];
    for (const o of data.organizations) {
      lines.push(o.organization ? `${o.organization}  ${o.root_path}` : '(no organization)');
      if (!o.teams.length) lines.push('  no teams');
      for (const t of o.teams) {
        lines.push(teamLine(t));
        if (detail === 2) for (const x of t.open) lines.push(taskLine(x));
        else if (detail === 1 && t.open.length) lines.push(`    ${t.open.map((x) => `${x.id}(${x.stage || 'close'})`).join(' ')}`.slice(0, 160));
      }
    }
    return lines;
  };
  let lines = build(2);
  if (lines.length > maxLines) lines = build(1);
  if (lines.length > maxLines) lines = build(0);
  if (lines.length > maxLines) {
    const cut = lines.length - (maxLines - 1);
    lines = [...lines.slice(0, maxLines - 1), `... ${cut} more line(s): hades status <org>`];
  }
  return lines.join('\n');
}

export async function run(args, ctx) {
  fixBooleans(args);
  if (args.flags.help) {
    print(HELP);
    return;
  }
  allowFlags(args, FLAGS);
  if (args.positional.length > 1) fail(`unexpected argument: ${args.positional[1]}`);
  const reg = loadRegistry(ctx);
  const query = args.positional[0];
  let filter = {};
  if (query) {
    const org = findOrg(reg, query);
    if (org) filter = { org: org.name };
    else {
      const team = findTeam(reg, query);
      if (!team) fail(`no team or organization matches "${query}" (hades org list, hades team list)`);
      filter = { team };
    }
  }
  const data = { vault: ctx.vault, problems: validateRegistry(reg), filter: filter.org ? { organization: filter.org } : filter.team ? { team: filter.team.name } : null, organizations: collectStatus(ctx, reg, filter) };
  if (args.flags.json) print(JSON.stringify(data, null, 2));
  else print(renderStatus(data));
}
