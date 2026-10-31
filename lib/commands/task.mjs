// hades task <new|show|stage|size|plan|item|coverage|commit|deploy|close|list|path> ...
// Task folders, the stage machine, the work plan and coverage. Formats: docs/file-formats.md.
// Output is short on purpose: agents read it. Exit 0 ok, 1 error/refused, 2 check red.
import fs from 'node:fs';
import path from 'node:path';
import { print, fail, slash, kebab, readJson, writeJson, updateJson, withLock, allowFlags, readText, writeText, render, today, nowIso, frontmatter, git } from '../core/util.mjs';
import { requireTeam } from '../core/config.mjs';
import {
  STAGES,
  STAGE_STATUS,
  SIZES,
  ENGINEER_ROLES,
  MAX_ROUNDS,
  resolveTask,
  newState,
  loadState,
  updateState,
  currentStage,
  loadDefects,
  blockingDefects,
  nextTaskId,
  tasksDir,
  withTasksLock,
  loadTeamJson,
} from '../core/task.mjs';
import { computeTaskUsage, claudeDataDirs } from '../core/usage.mjs';

export const PLAN_OWNERS = [...ENGINEER_ROLES, 'devops-engineer', 'tech-lead'];
export const ITEM_STATUS = ['todo', 'doing', 'done'];
export const DEPLOY_ENVS = ['test', 'live', 'none', 'pending-push'];
export const CLOSE_STATUS = ['done', 'blocked'];
// Defect sources whose critical/high defects keep a stage from passing. Integration-review
// findings block build (G3) and, as a backstop, qa; a failed deploy or health check blocks deploy.
export const STAGE_DEFECT_SOURCES = { build: ['review'], qa: ['qa', 'review'], deploy: ['deploy'], security: ['security'] };
// Flags per subcommand (checked by bin/hades.mjs and again by each subcommand).
export const FLAGS = {
  new: ['title', 'size', 'requestFile'],
  adopt: ['stage', 'size'],
  show: [],
  stage: ['note', 'model', 'force'],
  size: ['force'],
  plan: ['from'],
  item: [],
  coverage: [],
  commit: ['repo'],
  deploy: ['env', 'url', 'note'],
  close: ['status', 'note', 'force'],
  list: ['open'],
  path: [],
};
export const BOOLEAN_FLAGS = ['open', 'force'];
export const MARK = { done: '[x]', running: '[>]', pending: '[ ]', skipped: '[-]', failed: '[!]', blocked: '[!]' };
const OPEN_DEFECT = (d) => !['verified', 'wontfix'].includes(d.status);
const SLUG_MAX = 50;

const HELP = `Usage:
  hades task new <team> --title "..." [--size S|M|L] [--request-file <path>]   prints "<id> <folder>"
  hades task adopt <v1-task-id> [--stage <first stage to run>] [--size S|M|L]
                                                           v1 record -> v2 folder <id>-<slug>-v2 (the v1
                                                           files stay); prints "<id> <folder>"
  hades task show <task>                                   compact status
  hades task stage <task> <stage> <status> [--note "..."] [--model <m>] [--force]
  hades task size <task> <S|M|L> [--force]                 raise the size (lowering needs --force)
  hades task plan <task> --from <task folder>/work-plan.draft.json   validate and store the work plan
                                                           (AC -> work items checked; exit 2 = rejected)
  hades task item <task> <W#> <todo|doing|done>
  hades task coverage <task>                               AC -> work items -> test cases (exit 2 = gaps);
                                                           run before qa starts
  hades task commit <task> [--repo <path>]                 record the repo's HEAD commit (default: project path)
  hades task deploy <task> --env <test|live|none|pending-push> [--url <url>] [--note "..."]
  hades task close <task> --status <done|blocked> [--note "..."] [--force]
  hades task list [<team>] [--open]                        (default: the team of the current directory)
  hades task path <task>
All accept --json. Stages: ${STAGES.join(' ')} (release = the release commit).
Stage status: ${STAGE_STATUS.join(', ')}.
Rules (exit 1): a stage cannot be running/done while an earlier stage is pending, running or
failed (failed = retry it first), except that security (source-level) may run while deploy runs
or after it failed; DAST and security done wait for deploy. "blocked" = given up for this task:
later stages may continue where safe, and the next stage skips it. The close stage completes only
through "hades task close". qa running warns about AC without a test case.
Rules (exit 2): planning cannot be done unless work-plan.json covers every AC; qa cannot be done
unless every AC has a test case (hades task coverage); build (source review), qa (qa, review),
deploy (deploy) and security (security) cannot be done while a critical/high defect of those
sources is open, fixed or reopened; a task cannot close done while a stage before close is not
done or skipped, while any critical/high defect is unverified (also blocked), or (qa not skipped)
while an AC has no test case. --force overrides. "skipped" needs --note.
Exit: 0 ok, 1 error or refused, 2 check red.`;

const BOOLEANS = ['json', 'help', 'open', 'force'];

function fixBooleans(args) {
  for (const k of BOOLEANS) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.unshift(v);
    if (v !== undefined) args.flags[k] = true;
  }
}

function allow(args, allowed, maxPositional) {
  allowFlags(args, allowed);
  if (maxPositional !== undefined && args.positional.length > maxPositional) fail(`unexpected argument: ${args.positional[maxPositional]}`);
}

function str(flags, key, { required = false } = {}) {
  const v = flags[key];
  if (v === undefined) {
    if (required) fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    return undefined;
  }
  if (v === true) fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value`);
  return String(v);
}

function need(args, i, what) {
  const v = args.positional[i];
  if (v === undefined || v === '') fail(`missing ${what}\n${HELP}`);
  return v;
}

const SUBS = {
  new: taskNew,
  adopt: taskAdopt,
  show: taskShow,
  stage: taskStage,
  size: taskSize,
  plan: taskPlan,
  item: taskItem,
  coverage: taskCoverage,
  commit: taskCommit,
  deploy: taskDeploy,
  close: taskClose,
  list: taskList,
  path: taskPath,
};

export async function run(args, ctx) {
  fixBooleans(args);
  const sub = args.positional[0];
  if (args.flags.help || !sub || sub === 'help') {
    print(HELP);
    return;
  }
  if (!SUBS[sub]) fail(`unknown subcommand "task ${sub}"\n${HELP}`);
  args.positional.shift();
  await SUBS[sub](args, ctx);
}

function emit(args, data, text) {
  if (args.flags.json) print(JSON.stringify(data, null, 2));
  else if (text) print(typeof text === 'function' ? text() : text);
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = (id) => Number((/-(\d+)$/.exec(id) || [0, 0])[1]);

// ---------------------------------------------------------------- task records (v2 folders, v1 files)

const V1_CLOSED = new Set(['done', 'closed', 'complete', 'completed', 'cancelled', 'canceled', 'abandoned', 'superseded', 'wontfix', 'blocked', 'unknown']);

// HADES v1 single-file records "<id>-<slug>.md" whose frontmatter has the id (sibling notes files have none).
export function v1Records(dir, teamName) {
  if (!fs.existsSync(dir)) return [];
  const fileRe = new RegExp(`^${esc(teamName)}-\\d{3,}(?:-.*)?\\.md$`);
  const idRe = new RegExp(`^${esc(teamName)}-\\d{3,}$`);
  const out = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !fileRe.test(e.name)) continue;
    let fm;
    try {
      fm = frontmatter(fs.readFileSync(path.join(dir, e.name), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const id = fm.data.id;
    if (!id || !idRe.test(id) || !e.name.startsWith(id)) continue;
    const prev = out.get(id);
    if (prev && (prev.hasStatus || !fm.data.status)) continue;
    const heading = /^#\s+(.+)$/m.exec(fm.body);
    const fromHeading = heading ? heading[1].replace(new RegExp(`^${esc(id)}\\s*[-:\u2014\u2013]*\\s*`), '').trim() : '';
    const status = String(fm.data.status || 'unknown').toLowerCase().replace(/\s+/g, '-');
    out.set(id, {
      id,
      version: 1,
      title: fm.data.title || fromHeading || e.name.slice(id.length + 1, -3).replace(/-/g, ' '),
      status,
      open: !V1_CLOSED.has(status),
      size: fm.data.size || null,
      stage: null,
      file: slash(path.join(dir, e.name)),
      hasStatus: !!fm.data.status,
    });
  }
  return [...out.values()].map(({ hasStatus, ...r }) => r);
}

// HADES v2 task folders with their state and defects. Only folders with a state.json count (as in
// resolveTask): a v1 "<id>-artifacts/" folder is not a task.
export function v2Tasks(dir, teamName) {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^(${esc(teamName)}-\\d{3,})(?:-|$)`);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const m = re.exec(e.name);
    if (!m) continue;
    const folder = slash(path.join(dir, e.name));
    if (!fs.existsSync(`${folder}/state.json`)) continue;
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(`${folder}/state.json`, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      state = null;
    }
    let defects = { defects: [] };
    try {
      defects = JSON.parse(fs.readFileSync(`${folder}/defects.json`, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(defects.defects)) defects = { defects: [] };
    } catch {
      defects = { defects: [] };
    }
    out.push({
      id: m[1],
      version: 2,
      title: (state && state.title) || e.name.slice(m[1].length + 1).replace(/-/g, ' '),
      status: state ? state.status || 'open' : 'unknown',
      open: state ? (state.status || 'open') === 'open' : false,
      size: state ? state.size || null : null,
      stage: state && state.stages ? currentStage(state) : null,
      dir: folder,
      state,
      defects,
    });
  }
  return out;
}

export function listTeamTasks(ctx, team) {
  const dir = tasksDir(ctx, team);
  const v2 = v2Tasks(dir, team.name);
  const ids = new Set(v2.map((t) => t.id));
  const v1 = v1Records(dir, team.name).filter((t) => !ids.has(t.id));
  return [...v2, ...v1].sort((a, b) => num(a.id) - num(b.id));
}

// {open, bySeverity, blocking: [D#], blocked: [D#], total}
export function defectSummary(data, source) {
  const list = (data && Array.isArray(data.defects) ? data.defects : []).filter((d) => !source || d.source === source);
  const open = list.filter(OPEN_DEFECT);
  const bySeverity = {};
  for (const d of open) bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
  return {
    total: list.length,
    open: open.length,
    bySeverity,
    blocking: blockingDefects({ defects: list }).map((d) => d.id),
    blocked: list.filter((d) => d.status === 'blocked').map((d) => d.id),
  };
}

export function stageLine(state) {
  return STAGES.map((s) => `${s}${MARK[(state.stages && state.stages[s] && state.stages[s].status) || 'pending'] || '[?]'}`).join(' ');
}

// ---------------------------------------------------------------- new

function insertRequest(readme, request) {
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  const lines = readme.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s+Request\b/.test(l));
  if (i < 0) return `${readme.replace(/\s+$/, '')}${eol}${eol}## Request (verbatim)${eol}${eol}${request}${eol}`;
  lines.splice(i + 1, 0, '', request);
  return lines.join(eol);
}

export function slugOf(title) {
  return kebab(title).slice(0, SLUG_MAX).replace(/-+$/, '') || 'task';
}

function taskNew(args, ctx) {
  allow(args, FLAGS.new, 1);
  const team = requireTeam(ctx, need(args, 0, '<team>'));
  const title = String(str(args.flags, 'title', { required: true })).replace(/\s+/g, ' ').trim();
  if (!title) fail('--title is empty');
  let size = str(args.flags, 'size');
  if (size !== undefined) {
    size = size.toUpperCase();
    if (!SIZES.includes(size)) fail(`--size must be ${SIZES.join('|')} (is "${args.flags.size}")`);
  }
  let request = title;
  const requestFile = str(args.flags, 'requestFile');
  if (requestFile !== undefined) {
    if (!fs.existsSync(requestFile)) fail(`request file not found: ${requestFile}`);
    request = readText(requestFile).replace(/\s+$/, '');
    if (!request.trim()) fail(`request file is empty: ${requestFile}`);
  }
  const tpl = readText(`${ctx.engine}/templates/task/README.md`);
  // The ID is taken and the folder created inside the team's lock (parallel "task new" calls).
  const { id, dir, state } = withTasksLock(ctx, team, () => {
    const id = nextTaskId(ctx, team);
    const dir = slash(`${tasksDir(ctx, team)}/${id}-${slugOf(title)}`);
    if (fs.existsSync(dir)) fail(`task folder already exists: ${dir}`);
    const vars = { TASK_ID: id, TEAM: team.name, ORG: team.organization || '', TITLE: title, SIZE: size || '', DATE: today(), VAULT: slash(ctx.vault), ENGINE: ctx.engine };
    fs.mkdirSync(dir, { recursive: true });
    writeText(`${dir}/README.md`, insertRequest(render(tpl, vars), request));
    writeJson(`${dir}/defects.json`, { defects: [] });
    const state = newState({ id, team: team.name, organization: team.organization, title, size });
    writeJson(`${dir}/state.json`, state);
    return { id, dir, state };
  });
  emit(args, { id, dir, team: team.name, organization: team.organization, title, size: size || null, stage: state.stage }, `${id} ${dir}`);
}

// ---------------------------------------------------------------- adopt (HADES v1 record -> v2 folder)

// Text of the first "## Request..." section of a v1 record (blockquote markers removed), or null.
export function v1Request(text) {
  const lines = String(text).split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s+Request\b/i.test(l));
  if (i < 0) return null;
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    body.push(l.replace(/^>\s?/, ''));
  }
  const out = body.join('\n').replace(/^\s+|\s+$/g, '');
  return out || null;
}

// Stages "skipped" by an adoption that starts at `first` (every stage before it).
export function adoptedState({ id, team, organization, title, size, first, record }) {
  const state = newState({ id, team, organization, title, size });
  const at = state.opened;
  for (const s of STAGES.slice(0, STAGES.indexOf(first))) state.stages[s] = { status: 'skipped', at, note: `v1 record: ${record}` };
  if (first === 'intake') state.stages.intake = { status: 'pending' };
  state.stage = currentStage(state);
  return state;
}

function taskAdopt(args, ctx) {
  allow(args, FLAGS.adopt, 1);
  const id = need(args, 0, '<v1-task-id>');
  const m = /^(.+)-(\d{3,})$/.exec(id);
  if (!m) fail(`not a task ID: ${id} (expected <team>-<NNN>)`);
  const team = requireTeam(ctx, m[1]);
  if (team.name !== m[1]) fail(`task ${id} does not belong to team ${team.name}`);
  const first = str(args.flags, 'stage') || 'analysis';
  if (!STAGES.includes(first) || first === 'close') fail(`--stage must be one of ${STAGES.filter((s) => s !== 'close').join(' ')} (is "${first}")`);
  let size = str(args.flags, 'size');
  if (size !== undefined) {
    size = size.toUpperCase();
    if (!SIZES.includes(size)) fail(`--size must be ${SIZES.join('|')} (is "${args.flags.size}")`);
  }
  const dir = tasksDir(ctx, team);
  const rec = v1Records(dir, team.name).find((r) => r.id === id);
  if (!rec) fail(`no HADES v1 record for ${id} in ${slash(dir)} (expected ${id}-<slug>.md with "id: ${id}" in its frontmatter)`);
  const recordName = path.basename(rec.file);
  const slug = recordName.slice(id.length + 1, -3) || slugOf(rec.title);
  const artifacts = fs.existsSync(`${dir}/${id}-artifacts`) && fs.statSync(`${dir}/${id}-artifacts`).isDirectory() ? `${id}-artifacts` : null;
  if (!size && SIZES.includes(String(rec.size || '').toUpperCase())) size = String(rec.size).toUpperCase();
  const recordText = readText(rec.file);
  const request = v1Request(frontmatter(recordText).body) || `See the v1 record: [${recordName}](../${recordName}) (no "## Request" section found).`;
  const legacy = `Legacy: HADES v1 record [${recordName}](../${recordName})${artifacts ? `, artifacts [${artifacts}/](../${artifacts}/)` : ''} (kept as they are; v1 status ${rec.status}).`;
  const tpl = readText(`${ctx.engine}/templates/task/README.md`);
  const folder = withTasksLock(ctx, team, () => {
    const existing = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith(`${id}-`) && fs.existsSync(path.join(dir, e.name, 'state.json')));
    if (existing) fail(`${id} already has a v2 task folder: ${slash(path.join(dir, existing.name))}`);
    const folder = slash(`${dir}/${id}-${slug}-v2`);
    if (fs.existsSync(folder)) fail(`folder already exists: ${folder}`);
    const vars = { TASK_ID: id, TEAM: team.name, ORG: team.organization || '', TITLE: rec.title, SIZE: size || '', DATE: today(), VAULT: slash(ctx.vault), ENGINE: ctx.engine };
    fs.mkdirSync(folder, { recursive: true });
    writeText(`${folder}/README.md`, insertLegacy(insertRequest(render(tpl, vars), request), legacy));
    writeJson(`${folder}/defects.json`, { defects: [] });
    writeJson(`${folder}/state.json`, adoptedState({ id, team: team.name, organization: team.organization, title: rec.title, size, first, record: recordName }));
    return folder;
  });
  if (!rec.open) process.stderr.write(`hades: warning: the v1 record of ${id} has status "${rec.status}"\n`);
  emit(args, { id, dir: folder, team: team.name, title: rec.title, size: size || null, stage: first, v1: { record: rec.file, artifacts: artifacts ? slash(`${dir}/${artifacts}`) : null, status: rec.status } }, `${id} ${folder}`);
}

// The "Legacy" line goes right above "## Request".
function insertLegacy(readme, line) {
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  const lines = readme.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s+Request\b/.test(l));
  if (i < 0) return `${readme.replace(/\s+$/, '')}${eol}${eol}${line}${eol}`;
  lines.splice(i, 0, line, '');
  return lines.join(eol);
}

// ---------------------------------------------------------------- show

function lastGate(dir) {
  const data = readJson(`${dir}/gates.json`, { runs: [] });
  const runs = Array.isArray(data.runs) ? data.runs : [];
  return runs.length ? runs[runs.length - 1] : null;
}

function gateFailing(run) {
  const failing = (run.steps || [])
    .filter((s) => s.status === 'fail' || s.status === 'error')
    .map((s) => `${s.project && s.project !== '.' ? `${s.project}:` : ''}${s.step}${s.status === 'error' ? '(error)' : ''}`);
  // A run that built and tested nothing (GATE EMPTY) is red too.
  if (Array.isArray(run.empty) && run.empty.length && !run.allow_empty) failing.push(`empty(no commands: ${run.empty.join(',')})`);
  return failing;
}

function readPlan(dir) {
  const plan = readJson(`${dir}/work-plan.json`, null);
  return plan && Array.isArray(plan.items) ? plan : null;
}

function taskShow(args, ctx) {
  allow(args, FLAGS.show, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const state = loadState(task);
  const defects = loadDefects(task);
  const ds = defectSummary(defects);
  const gate = lastGate(task.dir);
  const plan = readPlan(task.dir);
  const next = currentStage(state);
  const hint = nextHint(task, state, next);
  if (args.flags.json) {
    print(JSON.stringify({ ...state, dir: task.dir, next, hint, defects: ds, gate: gate ? { preset: gate.preset, at: gate.at, ok: gate.ok, failing: gateFailing(gate) } : null, plan: plan ? planCounts(plan) : null }, null, 2));
    return;
  }
  const lines = [];
  lines.push(`${state.id} ${state.title}`);
  lines.push(`size ${state.size || '?'} | status ${state.status}${state.closed ? ` (closed ${state.closed})` : ''} | opened ${state.opened || '?'} | team ${state.team} (org ${state.organization || '?'})`);
  lines.push(`stages ${stageLine(state)}`);
  const r = state.rounds || {};
  if (next) {
    const cur = state.stages[next] || {};
    const info = [cur.status || 'pending', cur.model].filter(Boolean).join(', ');
    lines.push(`next ${next} (${info}) | rounds qa ${r.qa || 0}/${MAX_ROUNDS} security ${r.security || 0}/${MAX_ROUNDS}`);
  } else {
    lines.push(`next none (pipeline complete) | rounds qa ${r.qa || 0}/${MAX_ROUNDS} security ${r.security || 0}/${MAX_ROUNDS}`);
  }
  if (hint) lines.push(`hint ${hint}`);
  const notes = STAGES.filter((s) => ['failed', 'blocked'].includes(state.stages[s] && state.stages[s].status)).slice(0, 3);
  for (const s of notes) lines.push(`${state.stages[s].status} ${s}: ${state.stages[s].note || '(no note)'}`.slice(0, 200));
  if (plan) {
    const c = planCounts(plan);
    lines.push(`plan ${c.items} item(s) in ${c.waves} wave(s): ${c.done} done, ${c.doing} doing, ${c.todo} todo`);
  } else lines.push('plan none');
  if (ds.open) {
    const sev = ['critical', 'high', 'medium', 'low'].filter((s) => ds.bySeverity[s]).map((s) => `${s} ${ds.bySeverity[s]}`).join(', ');
    const blocking = defects.defects.filter((d) => ds.blocking.includes(d.id)).map((d) => `${d.id}(${d.severity},${d.status},${d.source})`);
    lines.push(`defects ${ds.open} open (${sev}) | blocking ${blocking.length ? blocking.join(' ') : 'none'}${ds.blocked.length ? ` | blocked ${ds.blocked.join(' ')}` : ''}`);
  } else lines.push(`defects none open (${ds.total} total)`);
  if (gate) {
    const failing = gateFailing(gate);
    lines.push(`gate ${gate.preset}${gate.mode ? `(${gate.mode})` : ''} ${gate.ok ? 'ok' : 'FAIL'} ${gate.at || ''}${failing.length ? `: ${failing.join(', ')}` : ''}`);
  } else lines.push('gate none');
  const d = state.deploy;
  lines.push(d ? `deploy ${d.env}${d.url ? ` ${d.url}` : ''} ${d.at || ''}`.trimEnd() : 'deploy none');
  const commits = Array.isArray(state.commits) ? state.commits : [];
  lines.push(`commits ${commits.length}${commits.length ? `: ${commits.slice(-4).map((c) => `${c.hash} (${path.basename(c.repo || '')})`).join(', ')}${commits.length > 4 ? ', ...' : ''}` : ''}`);
  if (state.usage && state.usage.totals) {
    const cost = state.usage.cost_usd_estimate;
    lines.push(`usage ${state.usage.totals.total_tokens} tokens${cost !== undefined && cost !== null ? ` ~$${cost}` : ''}`);
  }
  lines.push(`folder ${task.dir}`);
  print(lines.join('\n'));
}

// The next action the CLI can check: AC -> test case coverage before qa starts (D7).
export function nextHint(task, state, next) {
  if (next !== 'qa' || ((state.stages && state.stages.qa && state.stages.qa.status) || 'pending') === 'running') return null;
  const c = coverage(task.dir);
  if (c.ok) return `coverage ok (${c.acs.length} AC, each with a work item and a test case): qa may start`;
  return `before qa: hades task coverage ${task.id} -> ${coverageGaps(c, 4)}`;
}

function planCounts(plan) {
  const items = plan.items;
  const c = { items: items.length, waves: new Set(items.map((i) => i.wave)).size, todo: 0, doing: 0, done: 0 };
  for (const i of items) c[ITEM_STATUS.includes(i.status) ? i.status : 'todo']++;
  return c;
}

// ---------------------------------------------------------------- stage

function taskStage(args, ctx) {
  allow(args, FLAGS.stage, 3);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const stage = need(args, 1, '<stage>');
  const status = need(args, 2, '<status>');
  if (!STAGES.includes(stage)) fail(`unknown stage "${stage}" (stages: ${STAGES.join(' ')})`);
  if (!STAGE_STATUS.includes(status)) fail(`unknown stage status "${status}" (${STAGE_STATUS.join(', ')})`);
  const note = str(args.flags, 'note');
  const model = str(args.flags, 'model');
  const force = !!args.flags.force;
  if (status === 'skipped' && !(note && note.trim())) fail('"skipped" needs --note "<why>"');
  // close done/skipped here would skip the close checks (stages, defects, coverage).
  if (stage === 'close' && ['done', 'skipped'].includes(status)) {
    fail(`refused: the close stage completes only through "hades task close ${task.id} --status done|blocked" (it runs the stage, defect and coverage checks)`);
  }
  const checkOrder = (state) => {
    if (!['done', 'running'].includes(status) || force) return;
    const earlier = STAGES.slice(0, STAGES.indexOf(stage));
    const st = (s) => (state.stages && state.stages[s] && state.stages[s].status) || 'pending';
    const pending = earlier.filter((s) => st(s) === 'pending');
    if (pending.length) fail(`refused: ${stage} cannot be ${status} while earlier stage(s) are pending: ${pending.join(', ')} (finish or skip them, or --force)`);
    // Source-level security may start while deploy runs; DAST (security done) waits for the deploy.
    const running = earlier.filter((s) => st(s) === 'running' && !(stage === 'security' && status === 'running' && s === 'deploy'));
    if (running.length) {
      fail(`refused: ${stage} cannot be ${status} while earlier stage(s) are running: ${running.join(', ')} (${stage === 'security' ? 'DAST runs after the deploy; ' : ''}finish them, or --force)`);
    }
    // failed = not finished: retry it first (a failed build must not be followed by qa or a
    // release). Source-level security still runs after a failed deploy.
    const failed = earlier.filter((s) => st(s) === 'failed' && !(stage === 'security' && s === 'deploy'));
    if (failed.length) fail(`refused: ${stage} cannot be ${status} while earlier stage(s) failed: ${failed.join(', ')} (re-run them, mark them blocked, or --force)`);
  };
  checkOrder(loadState(task));
  if (status === 'done' && stage === 'planning' && !force) {
    // AC -> work item coverage is checked at planning (the plan may predate a changed 01).
    const c = coverage(task.dir);
    if (!c.files.business || !c.acs.length || !c.files.plan || c.gaps.noItem.length) {
      const why = [!c.files.business ? 'no 01-business-solution.md' : !c.acs.length ? 'no AC-n ids in 01' : null, !c.files.plan ? 'no work-plan.json' : null, ...(c.files.plan ? c.gaps.noItem.map((a) => `${a} no work item`) : [])];
      fail(`refused: planning cannot be done: ${why.filter(Boolean).slice(0, 6).join('; ')} (hades task plan ${task.id} --from <task folder>/work-plan.draft.json, or --force)`, 2);
    }
  }
  if (status === 'done' && stage === 'qa' && !force) {
    // G4: every AC has a test case before qa can pass (QA tests per plan).
    const c = coverage(task.dir);
    if (!c.ok) fail(`refused: qa cannot be done: ${coverageGaps(c)} (hades task coverage ${task.id}; add the test cases to 06 and run them, or --force)`, 2);
  }
  if (status === 'done' && STAGE_DEFECT_SOURCES[stage] && !force) {
    const sources = STAGE_DEFECT_SOURCES[stage];
    const b = blockingDefects(loadDefects(task)).filter((d) => sources.includes(d.source));
    if (b.length) fail(`refused: ${stage} cannot pass while critical/high ${sources.join('/')} defects are not verified: ${b.map((d) => `${d.id} ${d.severity} ${d.status}`).join(', ')} (or --force)`, 2);
  }
  const warnings = [];
  // The stage machine is checked and updated inside the state lock (parallel agents).
  const { entry, state } = updateState(task, (state) => {
    if (!state.stages || typeof state.stages !== 'object') state.stages = {};
    checkOrder(state);
    const prev = state.stages[stage] || { status: 'pending' };
    const entry = { ...prev, status, at: nowIso() };
    if (note !== undefined) entry.note = note;
    if (model !== undefined) entry.model = model;
    if (!state.rounds || typeof state.rounds !== 'object') state.rounds = { qa: 0, security: 0 };
    if ((stage === 'qa' || stage === 'security') && status === 'running' && prev.status !== 'running') {
      state.rounds[stage] = (state.rounds[stage] || 0) + 1;
      if (state.rounds[stage] > MAX_ROUNDS) warnings.push(`warning: ${stage} round ${state.rounds[stage]} exceeds the limit of ${MAX_ROUNDS}; block what is still open`);
    }
    if (stage === 'qa' && status === 'running' && prev.status !== 'running') {
      const c = coverage(task.dir);
      if (!c.ok) warnings.push(`warning: coverage gaps before qa: ${coverageGaps(c)} (hades task coverage ${task.id})`);
    }
    state.stages[stage] = entry;
    state.stage = currentStage(state);
    return { entry, state };
  });
  const round = (stage === 'qa' || stage === 'security') && state.rounds[stage] ? ` (round ${state.rounds[stage]})` : '';
  emit(args, { id: task.id, stage, ...entry, rounds: state.rounds, next: state.stage, warnings }, () =>
    [`${task.id} ${stage} ${status}${round}; next: ${state.stage || 'none (pipeline complete)'}`, ...warnings].join('\n'),
  );
}

// ---------------------------------------------------------------- size

function setReadmeSize(dir, size) {
  const file = `${dir}/README.md`;
  if (!fs.existsSync(file)) return;
  const text = readText(file);
  const m = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
  if (!m || !/^size:.*$/m.test(m[0])) return;
  const head = m[0].replace(/^size:.*$/m, `size: ${size}`);
  writeText(file, head + text.slice(m[0].length));
}

function taskSize(args, ctx) {
  allow(args, FLAGS.size, 2);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const size = String(need(args, 1, '<S|M|L>')).toUpperCase();
  if (!SIZES.includes(size)) fail(`size must be ${SIZES.join('|')} (is "${args.positional[1]}")`);
  const prev = updateState(task, (state) => {
    const prev = state.size || null;
    if (prev && SIZES.indexOf(size) < SIZES.indexOf(prev) && !args.flags.force) fail(`refused: lowering the size ${prev} -> ${size} needs --force (a later role may raise it, never lower it)`);
    state.size = size;
    return prev;
  });
  if (prev !== size) setReadmeSize(task.dir, size);
  emit(args, { id: task.id, from: prev, size, changed: prev !== size }, `${task.id} size ${prev || '?'} -> ${size}${prev === size ? ' (unchanged)' : ''}`);
}

// ---------------------------------------------------------------- plan and coverage

const AC_RE = /\bAC-(\d+)\b/g;
const TC_RE = /\bTC-(\d+)\b/g;
const ids = (text, re) => [...new Set([...String(text).matchAll(re)].map((m) => m[0]))];
const byNum = (a, b) => num(a) - num(b);

export function readAcs(text) {
  return ids(text, AC_RE).sort(byNum);
}

// TC-n -> AC ids mentioned on its line. A TC on a heading line, or one without AC ids, also takes
// the AC ids of the following lines until the next TC line or heading.
export function parseTestCases(text) {
  const tcs = new Map();
  let current = [];
  let sticky = false;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s/.test(line);
    const tcIds = ids(line, TC_RE);
    const acIds = ids(line, AC_RE);
    if (tcIds.length) {
      for (const tc of tcIds) {
        if (!tcs.has(tc)) tcs.set(tc, new Set());
        for (const ac of acIds) tcs.get(tc).add(ac);
      }
      current = tcIds;
      sticky = heading || !acIds.length;
    } else if (heading) {
      current = [];
      sticky = false;
    } else if (sticky && acIds.length) {
      for (const tc of current) for (const ac of acIds) tcs.get(tc).add(ac);
    }
  }
  return new Map([...tcs.entries()].sort((a, b) => byNum(a[0], b[0])).map(([k, v]) => [k, [...v].sort(byNum)]));
}

const normFile = (f) => slash(String(f).trim()).replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
const normProject = (p) => {
  const s = path.posix.normalize(slash(String(p ?? '.')) || '.').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return s === '' ? '.' : s;
};

function overlaps(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  return false;
}

// Validates a work plan. acs = AC ids from 01 (null = 01 missing); projects = team.json project paths.
// Returns {problems, warnings, items (normalized)}.
export function validatePlan(doc, { acs = null, projects = null, previous = null } = {}) {
  const problems = [];
  const warnings = [];
  const raw = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && Array.isArray(doc.items) ? doc.items : null;
  if (!raw) return { problems: ['work plan must be {"items": [...]}'], warnings, items: [] };
  if (!raw.length) problems.push('work plan has no items');
  const known = acs ? new Set(acs) : null;
  const byId = new Map();
  const items = [];
  raw.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      problems.push(`items[${i}]: must be an object`);
      return;
    }
    const where = typeof it.id === 'string' && it.id ? it.id : `items[${i}]`;
    if (typeof it.id !== 'string' || !/^W\d+$/.test(it.id)) problems.push(`${where}: id must be W<n>`);
    else if (byId.has(it.id)) problems.push(`${it.id}: duplicate id`);
    if (typeof it.title !== 'string' || !it.title.trim()) problems.push(`${where}: title missing`);
    if (!PLAN_OWNERS.includes(it.owner)) problems.push(`${where}: owner "${it.owner ?? ''}" is not a team engineer role (${PLAN_OWNERS.join(', ')})`);
    if (!Number.isInteger(it.wave) || it.wave < 1) problems.push(`${where}: wave must be a whole number >= 1`);
    const deps = it.depends_on === undefined ? [] : it.depends_on;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) problems.push(`${where}: depends_on must be a list of W ids`);
    const files = it.files;
    if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string' || !f.trim())) problems.push(`${where}: files must list at least one path`);
    const acc = it.acceptance === undefined ? [] : it.acceptance;
    if (!Array.isArray(acc) || acc.some((a) => typeof a !== 'string' || !/^AC-\d+$/.test(a))) problems.push(`${where}: acceptance must be a list of AC-n ids`);
    else if (known) for (const a of acc) if (!known.has(a)) problems.push(`${where}: ${a} is not in 01-business-solution.md`);
    if (typeof it.done_when !== 'string' || !it.done_when.trim()) problems.push(`${where}: done_when missing`);
    if (it.status !== undefined && !ITEM_STATUS.includes(it.status)) problems.push(`${where}: status must be ${ITEM_STATUS.join('|')}`);
    if (it.project !== undefined && typeof it.project !== 'string') problems.push(`${where}: project must be a path relative to the project root`);
    const project = normProject(typeof it.project === 'string' ? it.project : '.');
    if (projects && projects.length && !projects.includes(project)) warnings.push(`${where}: project "${project}" is not in team.json (${projects.join(', ')})`);
    const prev = previous && typeof it.id === 'string' ? previous.find((p) => p.id === it.id) : null;
    // A re-plan keeps the stored status of an existing item (a draft's "status": "todo" never
    // resets finished work; "hades task item <task> <W#> todo" does that deliberately).
    const kept = prev && ITEM_STATUS.includes(prev.status);
    const norm = {
      ...it,
      depends_on: Array.isArray(deps) ? deps : [],
      project,
      files: Array.isArray(files) ? files.map((f) => (typeof f === 'string' ? normFile(f) : f)) : files,
      acceptance: Array.isArray(acc) ? acc : [],
      status: kept ? prev.status : it.status || 'todo',
      ...(kept && prev.at ? { at: prev.at } : {}),
    };
    if (typeof it.id === 'string' && !byId.has(it.id)) byId.set(it.id, norm);
    items.push(norm);
  });
  for (const it of items) {
    for (const dep of it.depends_on) {
      const d = byId.get(dep);
      if (dep === it.id) problems.push(`${it.id}: depends on itself`);
      else if (!d) problems.push(`${it.id}: depends on unknown item ${dep}`);
      else if (Number.isInteger(d.wave) && Number.isInteger(it.wave) && !(d.wave < it.wave)) problems.push(`${it.id} (wave ${it.wave}) depends on ${dep} (wave ${d.wave}): dependencies must be in an earlier wave`);
    }
  }
  const waves = [...new Set(items.map((i) => i.wave).filter(Number.isInteger))].sort((a, b) => a - b);
  for (const w of waves) {
    const inWave = items.filter((i) => i.wave === w && Array.isArray(i.files));
    for (let a = 0; a < inWave.length; a++) {
      for (let b = a + 1; b < inWave.length; b++) {
        if (inWave[a].project !== inWave[b].project) continue;
        const shared = inWave[a].files.filter((f) => inWave[b].files.some((g) => overlaps(f, g)));
        if (shared.length) problems.push(`wave ${w}: ${inWave[a].id} and ${inWave[b].id} share ${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ', ...' : ''} (same-wave items run in parallel)`);
      }
    }
  }
  if (acs === null) problems.push('01-business-solution.md not found: AC coverage cannot be checked');
  else if (!acs.length) problems.push('no AC-n ids in 01-business-solution.md');
  else {
    const covered = new Set(items.flatMap((i) => i.acceptance));
    for (const ac of acs) if (!covered.has(ac)) problems.push(`${ac} is not covered by any work item`);
  }
  return { problems, warnings, items };
}

function readTaskAcs(dir) {
  const file = `${dir}/01-business-solution.md`;
  return fs.existsSync(file) ? readAcs(readText(file)) : null;
}

function teamProjects(ctx, team) {
  const tj = loadTeamJson(ctx, team);
  return Array.isArray(tj.projects) ? tj.projects.map((p) => normProject(p && p.path)) : null;
}

function taskPlan(args, ctx) {
  allow(args, FLAGS.plan, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const from = str(args.flags, 'from', { required: true });
  if (!fs.existsSync(from)) fail(`work plan file not found: ${from}`);
  let doc;
  let problems;
  let warnings = [];
  let items = [];
  try {
    doc = JSON.parse(readText(from));
  } catch (err) {
    problems = [`invalid JSON in ${slash(from)}: ${err.message}`];
  }
  const acs = readTaskAcs(task.dir);
  const planFile = `${task.dir}/work-plan.json`;
  // Validated against the stored plan and written inside its lock ("task item" runs in parallel).
  withLock(planFile, () => {
    if (!problems) {
      const previous = (readPlan(task.dir) || { items: [] }).items;
      ({ problems, warnings, items } = validatePlan(doc, { acs, projects: teamProjects(ctx, task.team), previous }));
    }
    if (problems.length) return;
    const extra = doc && !Array.isArray(doc) ? Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'items')) : {};
    writeJson(planFile, { ...extra, items });
  });
  if (problems.length) {
    emit(args, { id: task.id, ok: false, problems, warnings }, () =>
      [`work plan rejected (${problems.length} problem(s)):`, ...problems.slice(0, 25).map((p) => `- ${p}`), ...(problems.length > 25 ? [`- ... ${problems.length - 25} more`] : []), ...warnings.map((w) => `warning: ${w}`)].join('\n'),
    );
    process.exitCode = 2;
    return;
  }
  const waves = [...new Set(items.map((i) => i.wave))].sort((a, b) => a - b);
  emit(args, { id: task.id, ok: true, items: items.length, waves: waves.length, acs: acs.length, warnings, file: `${task.dir}/work-plan.json` }, () => {
    const lines = [`work plan stored: ${items.length} item(s), ${waves.length} wave(s), ${acs.length}/${acs.length} AC covered`];
    for (const w of waves) {
      const list = items.filter((i) => i.wave === w).map((i) => `${i.id} ${i.owner}${i.depends_on.length ? ` (after ${i.depends_on.join(',')})` : ''}`);
      lines.push(`wave ${w}: ${list.join(', ')}`.slice(0, 300));
    }
    return [...lines.slice(0, 12), ...warnings.map((x) => `warning: ${x}`)].join('\n');
  });
}

function taskItem(args, ctx) {
  allow(args, FLAGS.item, 3);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const wid = String(need(args, 1, '<W#>')).toUpperCase();
  const status = need(args, 2, '<todo|doing|done>');
  if (!ITEM_STATUS.includes(status)) fail(`item status must be ${ITEM_STATUS.join('|')} (is "${status}")`);
  const warnings = [];
  // Locked: the engineers of one wave mark their items in parallel.
  const { plan, item } = updateJson(`${task.dir}/work-plan.json`, () => null, (plan) => {
    if (!plan || !Array.isArray(plan.items)) fail(`no work plan for ${task.id} (hades task plan ${task.id} --from <file>)`);
    const item = plan.items.find((i) => String(i.id).toUpperCase() === wid);
    if (!item) fail(`no work item ${wid} in ${task.id} (items: ${plan.items.map((i) => i.id).join(', ')})`);
    if (status !== 'todo') {
      const open = (item.depends_on || []).filter((d) => (plan.items.find((i) => i.id === d) || {}).status !== 'done');
      if (open.length) warnings.push(`warning: ${item.id} depends on ${open.join(', ')} (not done)`);
    }
    item.status = status;
    item.at = nowIso();
    return { plan, item };
  });
  const wave = plan.items.filter((i) => i.wave === item.wave);
  const c = planCounts(plan);
  emit(args, { id: task.id, item: item.id, status, wave: item.wave, waveDone: wave.filter((i) => i.status === 'done').length, waveItems: wave.length, ...c, warnings }, () =>
    [`${item.id} ${status}; wave ${item.wave}: ${wave.filter((i) => i.status === 'done').length}/${wave.length} done; plan: ${c.done}/${c.items} done`, ...warnings].join('\n'),
  );
}

export function coverage(dir) {
  const acs = readTaskAcs(dir);
  const plan = readPlan(dir);
  const testFile = `${dir}/06-test-plan.md`;
  const tcs = fs.existsSync(testFile) ? parseTestCases(readText(testFile)) : null;
  const rows = (acs || []).map((ac) => ({
    ac,
    items: plan ? plan.items.filter((i) => Array.isArray(i.acceptance) && i.acceptance.includes(ac)).map((i) => i.id) : [],
    tests: tcs ? [...tcs.entries()].filter(([, a]) => a.includes(ac)).map(([t]) => t) : [],
  }));
  const known = new Set(acs || []);
  const unknown = [];
  if (plan) for (const i of plan.items) for (const a of i.acceptance || []) if (!known.has(a)) unknown.push(`${i.id} -> ${a}`);
  if (tcs) for (const [t, a] of tcs) for (const x of a) if (!known.has(x)) unknown.push(`${t} -> ${x}`);
  const noItem = rows.filter((r) => !r.items.length).map((r) => r.ac);
  const noTest = rows.filter((r) => !r.tests.length).map((r) => r.ac);
  const unmapped = tcs ? [...tcs.entries()].filter(([, a]) => !a.length).map(([t]) => t) : [];
  return {
    acs: acs || [],
    files: { business: acs !== null, plan: !!plan, tests: tcs !== null },
    rows,
    gaps: { noItem, noTest },
    unknown,
    unmappedTests: unmapped,
    ok: acs !== null && acs.length > 0 && !noItem.length && !noTest.length,
  };
}

// One line naming what blocks full coverage (for warnings and hints).
export function coverageGaps(c, max = 6) {
  const parts = [];
  if (!c.files.business) parts.push('no 01-business-solution.md');
  else if (!c.acs.length) parts.push('no AC-n ids in 01');
  if (!c.files.plan) parts.push('no work-plan.json');
  if (!c.files.tests) parts.push('no 06-test-plan.md');
  const gaps = [...(c.files.plan ? c.gaps.noItem.map((a) => `${a} no work item`) : []), ...(c.files.tests ? c.gaps.noTest.map((a) => `${a} no test case`) : [])];
  parts.push(...gaps.slice(0, max));
  if (gaps.length > max) parts.push(`+${gaps.length - max} more`);
  return parts.join('; ') || 'none';
}

function taskCoverage(args, ctx) {
  allow(args, FLAGS.coverage, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const c = coverage(task.dir);
  emit(args, { id: task.id, ...c }, () => {
    const lines = [];
    if (!c.files.business) lines.push('no 01-business-solution.md: no acceptance criteria');
    else if (!c.acs.length) lines.push('no AC-n ids in 01-business-solution.md');
    const missing = [!c.files.plan && 'work-plan.json', !c.files.tests && '06-test-plan.md'].filter(Boolean);
    if (c.rows.length) {
      const w1 = Math.max(2, ...c.rows.map((r) => r.ac.length));
      const w2 = Math.max(10, ...c.rows.map((r) => (r.items.join(',') || '-').length));
      lines.push(`${'AC'.padEnd(w1)}  ${'work items'.padEnd(w2)}  test cases`);
      for (const r of c.rows) lines.push(`${r.ac.padEnd(w1)}  ${(r.items.join(',') || '-').padEnd(w2)}  ${r.tests.join(',') || '-'}`);
    }
    if (missing.length) lines.push(`missing: ${missing.join(', ')}`);
    if (c.unknown.length) lines.push(`unknown AC refs: ${c.unknown.slice(0, 10).join('; ')}${c.unknown.length > 10 ? '; ...' : ''}`);
    if (c.unmappedTests.length) lines.push(`test cases without AC: ${c.unmappedTests.join(', ')}`);
    const gaps = [...c.gaps.noItem.map((a) => `${a} no work item`), ...c.gaps.noTest.map((a) => `${a} no test case`)];
    lines.push(c.ok ? `coverage ok: ${c.acs.length} AC, each with a work item and a test case` : `gaps: ${gaps.length ? gaps.join('; ') : 'no acceptance criteria'}`);
    return lines.join('\n');
  });
  if (!c.ok) process.exitCode = 2;
}

// ---------------------------------------------------------------- commit, deploy, close

function taskCommit(args, ctx) {
  allow(args, FLAGS.commit, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const repoFlag = str(args.flags, 'repo');
  const repo = slash(path.resolve(repoFlag || task.team.project_path || '.'));
  if (!fs.existsSync(repo)) fail(`repo not found: ${repo}`);
  const res = git(repo, 'log', '-1', '--format=%h%x09%s');
  if (res.code !== 0 || !res.stdout.trim()) fail(`no commit found in ${repo}: ${(res.stderr || '').split(/\r?\n/)[0] || 'empty history'}`);
  const [hash, ...rest] = res.stdout.trim().split('\t');
  const summary = rest.join('\t');
  const { dup, state } = updateState(task, (state) => {
    if (!Array.isArray(state.commits)) state.commits = [];
    const dup = state.commits.find((c) => c.hash === hash);
    if (!dup) state.commits.push({ repo, hash, summary });
    return { dup, state };
  });
  emit(args, { id: task.id, repo, hash, summary, recorded: !dup, commits: state.commits.length }, `${dup ? 'already recorded' : 'recorded'} ${hash} ${summary} (${path.basename(repo)}); commits: ${state.commits.length}`);
}

function taskDeploy(args, ctx) {
  allow(args, FLAGS.deploy, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const env = str(args.flags, 'env', { required: true });
  if (!DEPLOY_ENVS.includes(env)) fail(`--env must be ${DEPLOY_ENVS.join('|')} (is "${env}")`);
  const url = str(args.flags, 'url');
  if (url !== undefined && !/^https?:\/\/\S+$/i.test(url)) fail(`--url must be an http(s) URL (is "${url}")`);
  const note = str(args.flags, 'note');
  const state = updateState(task, (state) => {
    state.deploy = { env, url: url || '', at: nowIso(), ...(note ? { note } : {}) };
    return state;
  });
  emit(args, { id: task.id, deploy: state.deploy }, `${task.id} deploy ${env}${url ? ` ${url}` : ''} recorded`);
}

function taskClose(args, ctx) {
  allow(args, FLAGS.close, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  const status = str(args.flags, 'status', { required: true });
  if (!CLOSE_STATUS.includes(status)) fail(`--status must be ${CLOSE_STATUS.join('|')} (is "${status}")`);
  const note = str(args.flags, 'note');
  const force = !!args.flags.force;
  const stagesOf = (state) => {
    const stageOf = (s) => (state.stages && state.stages[s] && state.stages[s].status) || 'pending';
    return STAGES.filter((s) => s !== 'close').map((s) => [s, stageOf(s)]);
  };
  // done = the work is finished: every stage before close done or skipped (pending, running,
  // failed and blocked are not), no unverified critical/high defect, every AC with a test case.
  const checkDone = (state) => {
    if (status !== 'done' || force) return;
    const unfinished = stagesOf(state).filter(([, st]) => !['done', 'skipped'].includes(st));
    if (unfinished.length) {
      fail(`refused: cannot close done while stage(s) are not done or skipped: ${unfinished.map(([s, st]) => `${s} ${st}`).join(', ')} (finish them, close --status blocked, or --force)`, 2);
    }
    // Blocking defects plus critical/high ones that ran out of rounds: neither is verified.
    const data = loadDefects(task);
    const b = [...blockingDefects(data), ...data.defects.filter((d) => ['critical', 'high'].includes(d.severity) && d.status === 'blocked')];
    if (b.length) fail(`refused: cannot close done while critical/high defects are not verified: ${b.map((d) => `${d.id} ${d.severity} ${d.status}`).join(', ')} (close --status blocked, or --force)`, 2);
    if (state.stages && state.stages.qa && state.stages.qa.status === 'skipped') return;
    const c = coverage(task.dir);
    if (!c.ok) fail(`refused: cannot close done while acceptance criteria are untested: ${coverageGaps(c)} (hades task coverage ${task.id}; close --status blocked, or --force)`, 2);
  };
  checkDone(loadState(task));
  const at = nowIso();
  const { before, state } = updateState(task, (state) => {
    checkDone(state);
    const before = stagesOf(state);
    state.status = status;
    state.closed = at;
    if (!state.stages || typeof state.stages !== 'object') state.stages = {};
    state.stages.close = { ...(state.stages.close || {}), status: 'done', at, ...(note !== undefined ? { note } : {}) };
    state.stage = currentStage(state);
    return { before, state };
  });
  const warnings = [];
  const open = before.filter(([, st]) => st === 'pending').map(([s]) => s);
  const running = before.filter(([, st]) => st === 'running').map(([s]) => s);
  if (open.length) warnings.push(`warning: stage(s) still pending: ${open.join(', ')}`);
  if (running.length) warnings.push(`warning: stage(s) still running: ${running.join(', ')}`);
  // Usage recorded before close has an open window that misses the last spawns: record it again
  // with the final (closed) window.
  const usage = refreshUsage(task, state, warnings);
  emit(args, { id: task.id, status, closed: at, warnings, ...(usage ? { usage: { total_tokens: usage.totals.total_tokens, cost_usd_estimate: usage.cost_usd_estimate, window: usage.window } } : {}) }, [
    `${task.id} closed: ${status}`,
    ...(usage ? [`usage (final window ${usage.window.start} .. ${usage.window.end}): ${usage.totals.total_tokens} tokens ~$${usage.cost_usd_estimate}; update the README Usage line`] : []),
    ...warnings,
  ].join('\n'));
}

// Recomputes state.usage with the closed window when usage was recorded during the task (the PM
// runs "hades usage --task" before the curator and the close). Never fails the close.
function refreshUsage(task, state, warnings) {
  if (!state.usage || !state.closed) return null;
  try {
    const dirs = claudeDataDirs();
    if (!dirs.length) return null;
    const sessions = Array.isArray(state.usage.session_filter) && state.usage.session_filter.length ? state.usage.session_filter : null;
    const usage = computeTaskUsage(state, { sessions, dirs });
    updateState(task, (s) => {
      s.usage = usage;
    });
    return usage;
  } catch (err) {
    warnings.push(`warning: usage not refreshed: ${String(err && err.message ? err.message : err).split('\n')[0]}`);
    return null;
  }
}

// ---------------------------------------------------------------- list, path

function taskList(args, ctx) {
  allow(args, FLAGS.list, 1);
  const team = requireTeam(ctx, args.positional[0] || process.cwd());
  let tasks = listTeamTasks(ctx, team);
  if (args.flags.open) tasks = tasks.filter((t) => t.open);
  if (args.flags.json) {
    print(JSON.stringify(tasks.map(({ state, defects, ...t }) => ({ ...t, defects: t.version === 2 ? defectSummary(defects) : null })), null, 2));
    return;
  }
  if (!tasks.length) {
    print(`no ${args.flags.open ? 'open ' : ''}tasks for ${team.name}`);
    return;
  }
  const w = Math.max(...tasks.map((t) => t.id.length));
  for (const t of tasks) {
    const stage = t.version === 1 ? 'v1' : t.status === 'open' ? t.stage || '-' : '-';
    let extra = '';
    if (t.version === 2) {
      const s = defectSummary(t.defects);
      if (s.blocking.length) extra = ` [blocking ${s.blocking.join(',')}]`;
    }
    print(`${t.id.padEnd(w)}  ${String(t.status).padEnd(7)}  ${stage.padEnd(8)}  ${(t.size || '-').padEnd(1)}  ${t.title}${extra}`);
  }
}

function taskPath(args, ctx) {
  allow(args, FLAGS.path, 1);
  const task = resolveTask(ctx, need(args, 0, '<task>'));
  emit(args, { id: task.id, dir: task.dir }, task.dir);
}

