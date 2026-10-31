// Task folders, the stage machine, defects and team.json access. Shared by task, defect, gate,
// usage and status commands. The CLI is the only writer of the JSON files handled here.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson, withLock, slash, fail, nowIso } from './util.mjs';
import { vaultPath, findTeam } from './config.mjs';

export const STAGES = ['intake', 'analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security', 'close'];
export const STAGE_STATUS = ['pending', 'running', 'done', 'skipped', 'failed', 'blocked'];
export const SIZES = ['S', 'M', 'L'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const DEFECT_STATUS = ['open', 'fixed', 'verified', 'reopened', 'blocked', 'wontfix'];
export const ENGINEER_ROLES = ['backend-engineer', 'frontend-engineer', 'aiml-data-engineer'];
export const DEFECT_OWNERS = [...ENGINEER_ROLES, 'devops-engineer', 'tech-lead'];
// qa = QA testing, security = cybersecurity testing, review = tech-lead integration review,
// deploy = failed deploy or health check.
export const DEFECT_SOURCES = ['qa', 'security', 'review', 'deploy'];
export const MAX_ROUNDS = 3;
const ID_RE = /^(.+)-(\d{3,})$/;

export function teamDir(ctx, team) {
  return vaultPath(ctx, team.team_dir);
}

export function tasksDir(ctx, team) {
  return `${teamDir(ctx, team)}/tasks`;
}

// Highest task number of a team, counting v2 task folders and v1 single-file records.
export function nextTaskId(ctx, team) {
  const dir = tasksDir(ctx, team);
  let max = 0;
  if (fs.existsSync(dir)) {
    const re = new RegExp(`^${team.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{3,})(?:-|\\.md$|$)`);
    for (const entry of fs.readdirSync(dir)) {
      const m = re.exec(entry);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${team.name}-${String(max + 1).padStart(3, '0')}`;
}

// Finds a v2 task folder by ID. Teams are tried by the ID prefix first (team names may contain dashes).
export function resolveTask(ctx, id) {
  const m = ID_RE.exec(String(id || ''));
  if (!m) fail(`not a task ID: ${id} (expected <team>-<NNN>)`);
  const team = findTeam(ctx.registry, m[1]);
  if (!team) fail(`no team "${m[1]}" for task ${id}`);
  const dir = tasksDir(ctx, team);
  // Only folders with a state.json are v2 task folders; v1 tasks may have "<id>-artifacts/" folders.
  const folder = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .find((e) => e.isDirectory() && (e.name === id || e.name.startsWith(`${id}-`)) && fs.existsSync(path.join(dir, e.name, 'state.json')))
    : null;
  if (!folder) fail(`task folder not found for ${id} in ${slash(dir)} (v1 records: "hades task adopt ${id}")`);
  const taskDir = slash(path.join(dir, folder.name));
  return { id, team, teamDir: teamDir(ctx, team), dir: taskDir };
}

export function newState({ id, team, organization, title, size }) {
  const at = nowIso();
  const stages = {};
  for (const s of STAGES) stages[s] = { status: 'pending' };
  stages.intake = { status: 'done', at, note: '' };
  return {
    id,
    team,
    organization,
    title,
    size: size || null,
    status: 'open',
    opened: at,
    closed: null,
    stage: 'analysis',
    stages,
    rounds: { qa: 0, security: 0 },
    commits: [],
    deploy: null,
    usage: null,
  };
}

export function loadState(task) {
  return readJson(`${task.dir}/state.json`);
}

export function saveState(task, state) {
  writeJson(`${task.dir}/state.json`, state);
}

// Locked read-modify-write of state.json (parallel agents write the same task).
export function updateState(task, mutate) {
  return updateJson(`${task.dir}/state.json`, undefined, mutate);
}

// The next stage to run: the first that is not done, skipped or blocked; null when the pipeline is
// complete. "failed" is retried (a new round); "blocked" is given up for this task and is not re-run.
export function currentStage(state) {
  return STAGES.find((s) => !['done', 'skipped', 'blocked'].includes(state.stages && state.stages[s] && state.stages[s].status)) || null;
}

export function loadDefects(task) {
  return readJson(`${task.dir}/defects.json`, { defects: [] });
}

export function saveDefects(task, data) {
  writeJson(`${task.dir}/defects.json`, data);
}

// Locked read-modify-write of defects.json: IDs are allocated inside the lock, so parallel
// "hades defect add" calls never hand out the same ID or drop a defect.
export function updateDefects(task, mutate) {
  return updateJson(`${task.dir}/defects.json`, () => ({ defects: [] }), (data) => {
    if (!Array.isArray(data.defects)) data.defects = [];
    return mutate(data);
  });
}

// Serialises creation of task folders of one team (the next task ID is read inside the lock).
export function withTasksLock(ctx, team, fn) {
  const dir = tasksDir(ctx, team);
  fs.mkdirSync(dir, { recursive: true });
  return withLock(`${dir}/.new-task`, fn);
}

// Defects that still block a gate: critical/high that are not verified, wontfix or blocked.
export function blockingDefects(data, source) {
  return data.defects.filter(
    (d) =>
      ['critical', 'high'].includes(d.severity) &&
      ['open', 'fixed', 'reopened'].includes(d.status) &&
      (!source || d.source === source),
  );
}

export function loadTeamJson(ctx, team) {
  const file = `${teamDir(ctx, team)}/team.json`;
  return readJson(file, { team: team.name, projects: [{ path: '.', stack: [], commands: {} }], environments: {} });
}

export function saveTeamJson(ctx, team, data) {
  writeJson(`${teamDir(ctx, team)}/team.json`, data);
}

// Absolute directory of a team.json project entry.
export function projectDir(team, project) {
  return slash(path.resolve(team.project_path, project.path || '.'));
}

// Gate logs live in the engine's runtime folder, never in the vault.
export function logsDir(ctx, taskId) {
  const dir = `${ctx.engine}/.hades/logs/${taskId}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
