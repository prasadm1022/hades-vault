// hades detect [<path>] [--write <team>] [--overwrite] [--depth <n>] [--json]
// Fingerprints a project tree and prints stacks and commands; --write stores them in team.json.
import fs from 'node:fs';
import path from 'node:path';
import { output, print, fail, readJson, writeJson, withLock, slash, allowFlags } from '../core/util.mjs';
import { loadContext, requireTeam } from '../core/config.mjs';
import { detectProject, mergeTeamProjects, normRel, loadStacksFor, COMMAND_KEYS } from '../core/detect.mjs';

export const needsVault = false;
export const FLAGS = ['write', 'depth', 'overwrite'];
export const BOOLEAN_FLAGS = ['overwrite'];

const HELP = `Usage: hades detect [<path>] [--write <team>] [--overwrite] [--depth <n>] [--json]

Fingerprints <path> (default: the team's project with --write, else the current directory) and
its subdirectories to depth 2 using playbooks/stacks.json, with the vault's learned
company/playbooks/stacks.json merged over it by id; prints stacks and commands per project.
  --write <team>  merge into the team's team.json: fills empty command fields, adds projects,
                  never touches environments
  --overwrite     with --write: also replace non-empty commands and the stack list
  --depth <n>     subdirectory depth (default 2)`;

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) {
    print(HELP);
    return;
  }
  const write = args.flags.write;
  if (write === true) fail('--write needs a team name, alias or project path');
  let team = null;
  if (write) {
    const full = ctx && ctx.registry ? ctx : loadContext({ needVault: true });
    team = requireTeam(full, String(write));
  }
  const target = args.positional[0] || (team ? team.project_path : '.');
  if (!target) fail(`team ${team.name} has no project_path; pass a path`);
  const abs = slash(path.resolve(target));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(`not a directory: ${target}`);
  const depth = args.flags.depth === undefined ? 2 : Number(args.flags.depth);
  if (!Number.isInteger(depth) || depth < 0) fail('--depth must be a whole number >= 0');

  const { stacks, files, warnings } = loadStacksFor(ctx);
  for (const w of warnings) process.stderr.write(`hades: warning: ${w}\n`);
  const result = detectProject(abs, { maxDepth: depth, stacks });
  const written = team ? writeTeam(team, abs, result.projects, !!args.flags.overwrite) : null;
  const learned = files.length > 1 ? { learned: files[1] } : {};
  output(args, { ...result, ...learned, ...(written ? { written } : {}) }, () => render(result, written, learned.learned));
}

function writeTeam(team, abs, projects, overwrite) {
  const projectRoot = slash(path.resolve(team.project_path || abs));
  const prefix = slash(path.relative(projectRoot, abs));
  if (prefix === '..' || prefix.startsWith('../') || path.isAbsolute(prefix)) {
    fail(`${abs} is outside the project of team ${team.name} (${projectRoot})`);
  }
  const rebased = projects.map((p) => ({ ...p, path: normRel(prefix ? `${prefix}/${p.path}` : p.path) }));
  const file = `${team.dir}/team.json`;
  // Locked read-modify-write: "hades team set" may write the same team.json at the same time.
  const res = withLock(file, () => {
    const doc = readJson(file, null) || { team: team.name, projects: [] };
    const r = mergeTeamProjects(doc, rebased, { overwrite });
    if (r.changed) writeJson(file, r.team);
    return r;
  });
  return {
    team: team.name,
    file: slash(file),
    changed: res.changed,
    added: res.added,
    removed: res.removed,
    filled: res.filled,
    replaced: res.replaced,
  };
}

function render(result, written, learned) {
  const lines = [];
  if (learned) lines.push(`stacks: engine + learned ${learned}`);
  if (!result.projects.length) lines.push(`no known stack in ${result.root}`);
  for (const p of result.projects) {
    lines.push(`${p.path}  ${p.stacks.join(', ')}${p.packageManager ? `  [${p.packageManager}]` : ''}`);
    const na = [];
    for (const k of COMMAND_KEYS) {
      if (p.commands[k]) lines.push(`  ${k.padEnd(8)}${p.commands[k]}`);
      else na.push(k);
    }
    if (na.length) lines.push(`  ${'n/a'.padEnd(8)}${na.join(', ')}`);
    for (const n of p.notes) lines.push(`  ${'note'.padEnd(8)}${n}`);
  }
  if (written) {
    const parts = [`+${written.added.length} project(s)`, `${written.filled} command(s) filled`];
    if (written.replaced) parts.push(`${written.replaced} replaced`);
    if (written.removed.length) parts.push(`placeholder removed: ${written.removed.join(', ')}`);
    lines.push(`team.json (${written.team}): ${written.changed ? parts.join(', ') : 'no change'}`);
  }
  return lines.join('\n');
}
