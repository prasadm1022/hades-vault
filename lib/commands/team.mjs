// hades team new <team> --org <org> --project <path> [--type main|sub] [--description "..."] [--aliases a,b] [--json]
// hades team resolve [<query>]        name, alias or path (default: current directory) -> JSON; exit 1 if none
// hades team list [--org <org>] [--json]
// hades team set <team> <command|env|security|branch-strategy|project> ...   the only writer of team.json settings
import fs from 'node:fs';
import path from 'node:path';
import { print, fail, slash, kebab, copyTemplateDir, render, readText, writeText, readJson, writeJson, git, run as runCmd, allowFlags, withLock } from '../core/util.mjs';
import { vaultPath, findTeam, requireTeam } from '../core/config.mjs';
import { loadRegistry, saveRegistry, addTeam, parseAliases, findOrg, TEAM_TYPES } from '../core/registry.mjs';
import { detectProject, mergeTeamProjects, normRel, loadStacksFor, COMMAND_KEYS } from '../core/detect.mjs';

export const ENV_NAMES = ['test', 'live'];
export const ENV_FIELDS = ['url', 'deploy', 'health', 'rollback', 'via_push', 'notes'];
export const SECURITY_KEYS = { semgrep_config: null, dast_live: ['baseline', 'none'], dast_test: ['baseline', 'full', 'api', 'none'] };
export const BRANCH_STRATEGIES = ['current-branch', 'feature-branch'];
const ENV_SHELL = ['deploy', 'health', 'rollback'];

const HELP = `Usage:
  hades team new <team> --org <org> --project <path> [--type main|sub] [--description "..."] [--aliases a,b] [--json]
      scaffolds <org_dir>/teams/<team>/ from templates/team/, fills team.json with "hades detect"
      (a missing project folder is created and git-initialised: greenfield), adds the team to ORG.md
      and registers it
  hades team resolve [<name|alias|path>]
      prints {team, organization, type, team_dir, project_path} (default: current directory); exit 1 if none
  hades team list [--org <org>] [--json]
  hades team set <team> command <${COMMAND_KEYS.join('|')}> "<cmd>" [--project <rel>]
  hades team set <team> env <${ENV_NAMES.join('|')}> <${ENV_FIELDS.join('|')}> "<value>"
  hades team set <team> security <${Object.keys(SECURITY_KEYS).join('|')}> <value>
  hades team set <team> branch-strategy <${BRANCH_STRATEGIES.join('|')}>
  hades team set <team> project add|remove <rel>
      the only way to change team.json (never edit it by hand). "" clears a value. via_push: true|false.
      dast_live: ${SECURITY_KEYS.dast_live.join('|')}; dast_test: ${SECURITY_KEYS.dast_test.join('|')}.
      Shell commands (command, deploy, health, rollback) are refused when the HADES guard blocks them.
Exit: 0 ok, 1 error, refused or no match.`;

const BOOLEANS = ['json', 'help'];
export const FLAGS = { new: ['org', 'project', 'type', 'description', 'aliases'], resolve: [], list: ['org'], set: ['project'] };

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
  if (sub === 'new') return teamNew(args, ctx);
  if (sub === 'resolve') return teamResolve(args, ctx);
  if (sub === 'list') return teamList(args, ctx);
  if (sub === 'set') return teamSet(args, ctx);
  fail(`unknown subcommand "team ${sub}"\n${HELP}`);
}

const isGitRepo = (dir) => {
  const r = git(dir, 'rev-parse', '--is-inside-work-tree');
  return r.code === 0 && r.stdout.trim() === 'true';
};

function teamNew(args, ctx) {
  allow(args, ['org', 'project', 'type', 'description', 'aliases']);
  const name = args.positional[0];
  if (!name) fail(`missing <team>\n${HELP}`);
  if (args.positional.length > 1) fail(`unexpected argument: ${args.positional[1]}`);
  const orgQuery = str(args.flags, 'org', { required: true });
  const projectPath = slash(path.resolve(str(args.flags, 'project', { required: true }))).replace(/\/+$/, '');
  const type = str(args.flags, 'type') || 'main';
  if (!TEAM_TYPES.includes(type)) fail(`--type must be main or sub (is "${type}")`);
  const description = str(args.flags, 'description') || '';
  const aliases = parseAliases(str(args.flags, 'aliases'));

  const reg = loadRegistry(ctx);
  const org = findOrg(reg, orgQuery);
  if (!org) fail(`unknown organization "${orgQuery}" (create it: hades org new ${kebab(orgQuery) || '<org>'} --root <path>)`);
  if (fs.existsSync(projectPath) && !fs.statSync(projectPath).isDirectory()) fail(`project path is a file: ${projectPath}`);
  // Validates name, aliases and duplicates before anything is written.
  const entry = addTeam(reg, name, { organization: org.name, type, project_path: projectPath, description, aliases });
  const sharing = Object.entries(reg.teams).filter(([n, t]) => n !== name && slash(t.project_path || '').toLowerCase() === projectPath.toLowerCase()).map(([n]) => n);

  // Project folder: greenfield = create it and give it its own git repository (no commit).
  let project = 'existing';
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
    if (isGitRepo(projectPath)) project = 'created (inside an existing git repo)';
    else {
      let r = runCmd('git', ['init', '-q', '-b', 'main', projectPath]);
      if (r.code !== 0) r = runCmd('git', ['init', '-q', projectPath]);
      project = r.code === 0 ? 'created, git init' : 'created (git init failed: run it yourself)';
    }
  }

  const dir = vaultPath(ctx, entry.team_dir);
  const vars = {
    TEAM: name,
    TEAM_DIR: entry.team_dir,
    TEAM_TYPE: type,
    ORG: org.name,
    ORG_DIR: org.org_dir,
    ROOT_PATH: org.root_path || '',
    PROJECT_PATH: projectPath,
    DESCRIPTION: description,
    ALIASES: aliases.join(', '),
    DATE: entry.created,
    VAULT: slash(ctx.vault),
    ENGINE: ctx.engine,
  };
  const written = copyTemplateDir(`${ctx.engine}/templates/team`, dir, vars);

  // Detect stacks and commands of an existing project and merge them into team.json.
  let detected = [];
  let detect = null;
  if (project === 'existing') {
    const learned = loadStacksFor(ctx);
    for (const w of learned.warnings) process.stderr.write(`hades: warning: ${w}\n`);
    detected = detectProject(projectPath, { stacks: learned.stacks }).projects;
    const file = `${dir}/team.json`;
    const doc = readJson(file, null) || { team: name, projects: [] };
    const res = mergeTeamProjects(doc, detected, {});
    if (res.changed) writeJson(file, res.team);
    detect = { projects: detected.map((p) => ({ path: p.path, stacks: p.stacks })), filled: res.filled, added: res.added };
  }

  // One projects/<name>.md per team.json project (kept when present).
  const teamJson = readJson(`${dir}/team.json`, { projects: [] });
  const projectTpl = readText(`${ctx.engine}/templates/project.md`, '');
  const projectFiles = [];
  for (const p of Array.isArray(teamJson.projects) ? teamJson.projects : []) {
    const rel = normRel(p.path);
    const base = rel === '.' ? kebab(path.basename(projectPath)) || name : kebab(rel) || name;
    const file = `${dir}/projects/${base}.md`;
    if (!projectTpl || fs.existsSync(file)) continue;
    const abs = slash(path.resolve(projectPath, rel));
    writeText(file, render(projectTpl, { ...vars, PROJECT_PATH: abs }));
    projectFiles.push(slash(file));
  }

  const orgRow = addOrgRow(vaultPath(ctx, `${org.org_dir}/ORG.md`), { name, type, projectPath, description });
  saveRegistry(ctx, reg);

  const data = {
    team: name,
    ...entry,
    dir,
    files: written.length + projectFiles.length,
    project,
    detect,
    org_md: orgRow,
    ...(sharing.length ? { shares_project_with: sharing } : {}),
  };
  if (args.flags.json) {
    print(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [`team ${name} registered (${type}, org ${org.name})`, `dir      ${dir}`, `project  ${projectPath} (${project})`];
  if (detect) {
    lines.push(
      detected.length
        ? `detect   ${detected.map((p) => `${p.path} (${p.stacks.join(', ')})`).join('; ').slice(0, 200)}; ${detect.filled} command(s) in team.json`
        : 'detect   no known stack (fill team.json later: hades detect <path> --write <team>)',
    );
  }
  lines.push(`ORG.md   ${orgRow}${sharing.length ? `; warning: project path also used by ${sharing.join(', ')}` : ''}`);
  print(lines.join('\n'));
}

// Adds "| `team` | type | `path` | description |" to the table under "## Teams" in ORG.md.
// Best effort: anything unexpected leaves the file untouched.
export function addOrgRow(file, { name, type, projectPath, description }) {
  if (!fs.existsSync(file)) return 'no ORG.md';
  const text = readText(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => /^##\s+Teams\s*$/i.test(l));
  if (h < 0) return 'no teams table';
  let i = h + 1;
  while (i < lines.length && !/^#{1,2}\s/.test(lines[i]) && !/^\s*\|/.test(lines[i])) i++;
  if (i >= lines.length || !/^\s*\|/.test(lines[i]) || !/^\s*\|\s*Team\s*\|/i.test(lines[i])) return 'no teams table';
  if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) return 'no teams table';
  let end = i + 2;
  while (end < lines.length && /^\s*\|/.test(lines[end])) end++;
  for (let r = i + 2; r < end; r++) {
    const first = (lines[r].split('|')[1] || '').trim().replace(/^`|`$/g, '');
    if (first.toLowerCase() === name.toLowerCase()) return 'already listed';
  }
  const cell = (s) => String(s || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  lines.splice(end, 0, `| \`${name}\` | ${type} | \`${projectPath}\` | ${cell(description)} |`);
  writeText(file, lines.join(eol));
  return 'row added';
}

function teamResolve(args, ctx) {
  allow(args, []);
  if (args.positional.length > 1) fail(`one query only (quote paths with spaces)`);
  const query = args.positional[0] || process.cwd();
  const t = findTeam(ctx.registry, query);
  if (!t) fail(`no team matches "${query}" (hades team list)`);
  const out = { team: t.name, organization: t.organization, type: t.type || 'main', team_dir: t.team_dir, project_path: t.project_path };
  print(args.flags.json ? JSON.stringify(out, null, 2) : JSON.stringify(out));
}

function teamList(args, ctx) {
  allow(args, ['org']);
  if (args.positional.length) fail(`unexpected argument: ${args.positional[0]}`);
  const reg = loadRegistry(ctx);
  const orgQuery = str(args.flags, 'org');
  let orgName = null;
  if (orgQuery) {
    const org = findOrg(reg, orgQuery);
    if (!org) fail(`unknown organization "${orgQuery}"`);
    orgName = org.name;
  }
  const rows = Object.entries(reg.teams || {})
    .filter(([, t]) => !orgName || t.organization === orgName)
    .map(([name, t]) => ({ team: name, ...t, type: t.type || 'main', status: t.status || 'active' }));
  if (args.flags.json) {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    print(orgName ? `no teams in ${orgName}` : 'no teams (create one: hades team new <team> --org <org> --project <path>)');
    return;
  }
  const w = Math.max(...rows.map((r) => r.team.length));
  for (const r of rows) {
    const aliases = r.aliases && r.aliases.length ? ` [${r.aliases.join(', ')}]` : '';
    print(`${r.team.padEnd(w)}  ${r.type.padEnd(4)}  ${r.status.padEnd(6)}  ${r.organization}  ${r.project_path || '-'}${aliases}`);
  }
}

// ---------------------------------------------------------------- set (team.json)

const emptyCommands = () => Object.fromEntries(COMMAND_KEYS.map((k) => [k, '']));
const emptyEnv = () => ({ url: '', deploy: '', health: '', rollback: '', via_push: false, notes: '' });
const oneLine = (s) => String(s).replace(/\s*\r?\n\s*/g, ' ').trim();

// The positional values of a "set" form; a value after "--" counts as the last one.
function setArgs(args, rest, names) {
  const vals = [...rest];
  if (args.rest.length) vals.push(args.rest.join(' '));
  const usage = `hades team set <team> ${names.join(' ')}`;
  if (vals.length < names.length) fail(`missing ${names[vals.length]}\nUsage: ${usage}`);
  if (vals.length > names.length) fail(`unexpected argument: ${vals[names.length]} (quote values with spaces)\nUsage: ${usage}`);
  return vals;
}

function oneOf(value, list, what) {
  if (!list.includes(value)) fail(`${what} must be ${list.join('|')} (is "${value}")`);
  return value;
}

// Refuses a command line the guard would block. Project commands run through the platform shell
// from "hades gate" (no agent); environment commands are run by the devops engineer.
export async function guardRefusal(command, { cwd, agentType = null, shells = ['bash', 'cmd'] } = {}) {
  if (!String(command).trim()) return null;
  const { checkShell } = await import('../../hooks/guard.mjs');
  for (const shell of shells) {
    let b;
    try {
      b = checkShell(command, { shell, cwd, agentType });
    } catch (err) {
      b = { id: 'guard.error', message: `HADES guard: guard.error: the command could not be checked (${String((err && err.message) || err).slice(0, 120)}). Simplify it.` };
    }
    if (b) return b;
  }
  return null;
}

function relProject(raw) {
  const s = slash(String(raw || '').trim());
  if (!s) fail('project path is empty');
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s)) fail(`project path must be relative to the team's project_path (is "${raw}")`);
  const rel = normRel(s);
  if (rel === '..' || rel.startsWith('../')) fail(`project path leaves the team's project_path: ${raw}`);
  return rel;
}

async function teamSet(args, ctx) {
  allow(args, ['project']);
  const [query, what, ...rest] = args.positional;
  if (!query) fail(`missing <team>\n${HELP}`);
  if (!what) fail(`missing what to set (command, env, security, branch-strategy, project)\n${HELP}`);
  if (args.flags.project !== undefined && what !== 'command') fail('--project applies to "team set <team> command" only');
  const team = requireTeam(ctx, query);
  const file = `${team.dir}/team.json`;
  const root = slash(path.resolve(team.project_path || process.cwd()));
  let label;
  let value;
  let previous;
  let hint = '';
  // Arguments and guard checks first (async); then apply(doc) changes the freshly read team.json
  // inside its lock (detect --write and other team set calls may write it at the same time).
  let apply;

  if (what === 'command') {
    const [key, cmd] = setArgs(args, rest, ['<key>', '"<cmd>"']);
    oneOf(key, COMMAND_KEYS, 'command key');
    const rel = relProject(args.flags.project === undefined ? '.' : args.flags.project === true ? fail('--project needs a path from team.json') : args.flags.project);
    value = oneLine(cmd);
    const b = await guardRefusal(value, { cwd: path.resolve(root, rel) });
    if (b) fail(`refused: ${b.message}`);
    apply = (doc) => {
      const entry = doc.projects.find((p) => p && normRel(p.path) === rel);
      if (!entry) fail(`no project "${rel}" in team.json (projects: ${doc.projects.map((p) => normRel(p && p.path)).join(', ') || 'none'}); add it: hades team set ${team.name} project add ${rel}`);
      if (!entry.commands || typeof entry.commands !== 'object') entry.commands = emptyCommands();
      previous = entry.commands[key] ?? '';
      entry.commands[key] = value;
    };
    label = `projects[${rel}].commands.${key}`;
  } else if (what === 'env') {
    const [name, field, raw] = setArgs(args, rest, ['<env>', '<field>', '"<value>"']);
    oneOf(name, ENV_NAMES, 'environment');
    oneOf(field, ENV_FIELDS, 'environment field');
    if (field === 'via_push') {
      value = oneOf(String(raw).toLowerCase(), ['true', 'false'], 'via_push') === 'true';
    } else {
      value = oneLine(raw);
      if (field === 'url' && value && !/^https?:\/\/\S+$/i.test(value)) fail(`url must be an http(s) URL or "" (is "${value}")`);
      if (ENV_SHELL.includes(field)) {
        const b = await guardRefusal(value, { cwd: root, agentType: 'hades-devops-engineer', shells: ['bash', 'powershell'] });
        if (b) fail(`refused: ${b.message}`);
      }
    }
    apply = (doc) => {
      if (!doc.environments || typeof doc.environments !== 'object' || Array.isArray(doc.environments)) doc.environments = {};
      const env = { ...emptyEnv(), ...(doc.environments[name] && typeof doc.environments[name] === 'object' ? doc.environments[name] : {}) };
      previous = env[field];
      env[field] = value;
      doc.environments[name] = env;
    };
    label = `environments.${name}.${field}`;
  } else if (what === 'security') {
    const [key, raw] = setArgs(args, rest, ['<key>', '<value>']);
    oneOf(key, Object.keys(SECURITY_KEYS), 'security key');
    value = oneLine(raw);
    if (value && SECURITY_KEYS[key]) oneOf(value, SECURITY_KEYS[key], key);
    apply = (doc) => {
      if (!doc.security || typeof doc.security !== 'object' || Array.isArray(doc.security)) doc.security = {};
      previous = doc.security[key] ?? '';
      if (value) doc.security[key] = value;
      else delete doc.security[key];
    };
    label = `security.${key}`;
  } else if (what === 'branch-strategy') {
    const [raw] = setArgs(args, rest, [`<${BRANCH_STRATEGIES.join('|')}>`]);
    value = oneOf(raw, BRANCH_STRATEGIES, 'branch strategy');
    apply = (doc) => {
      previous = doc.branch_strategy ?? '';
      doc.branch_strategy = value;
    };
    label = 'branch_strategy';
  } else if (what === 'project') {
    const [op, raw] = setArgs(args, rest, ['<add|remove>', '<rel>']);
    oneOf(op, ['add', 'remove'], 'project operation');
    const rel = relProject(raw);
    label = `project ${rel}`;
    value = op === 'add' ? 'added' : 'removed';
    apply = (doc) => {
      const i = doc.projects.findIndex((p) => p && normRel(p.path) === rel);
      if (op === 'add') {
        if (i < 0) {
          doc.projects.push({ path: rel, stack: [], commands: emptyCommands() });
          hint = `; fill its commands: hades detect "${slash(path.resolve(root, rel))}" --write ${team.name}`;
        }
      } else {
        if (i < 0) fail(`no project "${rel}" in team.json (projects: ${doc.projects.map((p) => normRel(p && p.path)).join(', ') || 'none'})`);
        doc.projects.splice(i, 1);
      }
    };
  } else {
    fail(`unknown setting "${what}" (command, env, security, branch-strategy, project)\n${HELP}`);
  }

  const changed = withLock(file, () => {
    const doc = readJson(file, null) || { team: team.name, projects: [{ path: '.', stack: [], commands: emptyCommands() }] };
    if (!Array.isArray(doc.projects)) doc.projects = [];
    const before = JSON.stringify(doc);
    apply(doc);
    const changed = JSON.stringify(doc) !== before;
    if (changed) writeJson(file, doc);
    return changed;
  });
  if (args.flags.json) {
    print(JSON.stringify({ team: team.name, file: slash(file), set: label, value, ...(previous !== undefined ? { previous } : {}), changed }, null, 2));
    return;
  }
  const shown = what === 'project' ? `${label} ${value}` : value === '' ? `${label} cleared` : `${label} = ${JSON.stringify(value)}`;
  print(`team.json (${team.name}): ${shown}${changed ? '' : ' (unchanged)'}${hint}`);
}
