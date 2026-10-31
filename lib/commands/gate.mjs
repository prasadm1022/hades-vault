// hades gate <task> [--preset ...] [--only a,b] [--project <rel>] [--timeout <min>] [--allow-empty] [--json]
// hades gate <task> --dast <url> [--mode baseline|full|api] [--openapi <url>] [--i-own-this-target]
// Runs quality gates, records evidence in <task>/gates.json and prints a few lines. Exit 2 = red.
import path from 'node:path';
import { print, fail, slash, nowIso, allowFlags } from '../core/util.mjs';
import { resolveTask, loadTeamJson, projectDir, logsDir } from '../core/task.mjs';
import {
  STEPS,
  PRESETS,
  CMD_STEPS,
  DAST_MODES,
  DEFAULT_TIMEOUT_MS,
  runCommandStep,
  runSecretsStep,
  runSastStep,
  runDepsStep,
  runDast,
  checkDastTarget,
  gitState,
  appendRun,
  emptyProjects,
  evidencePath,
  formatRun,
} from '../core/gate.mjs';

export const FLAGS = ['only', 'preset', 'project', 'timeout', 'allowEmpty', 'dast', 'mode', 'openapi', 'iOwnThisTarget'];
export const BOOLEAN_FLAGS = ['iOwnThisTarget', 'allowEmpty'];

const HELP = `Usage:
  hades gate <task> [--preset build|precommit|predeploy|security|full] [--only <steps>] [--project <rel>] [--timeout <minutes>] [--allow-empty] [--json]
  hades gate <task> --dast <url> [--mode baseline|full|api] [--openapi <url>] [--i-own-this-target] [--timeout <minutes>] [--json]
Steps: ${STEPS.join(', ')} (--only runs exactly these, instead of a preset)
Presets (default build): ${Object.entries(PRESETS).map(([k, v]) => `${k} = ${v.join(', ')}`).join('; ')}
Project commands come from team.json (hades team set); each is checked by the HADES guard first
(blocked = error, not run) and runs with CI=true, telemetry and colour off. Scanner findings of
severity critical/high fail a step. Full logs: <engine>/.hades/logs/<task>/.
A project whose selected build/lint/types/test steps all have no command (n/a), or a run whose
every step is n/a, is red: GATE EMPTY (set commands: hades detect --write, hades team set);
--allow-empty accepts it (a recorded waiver).
DAST: full/api are active scans, refused against the live host and, without --i-own-this-target,
against anything but the test url. team.json security.dast_live (baseline|none) and
security.dast_test (baseline|full|api|none) cap what runs against live and test.
Exit: 0 green, 2 red (also GATE EMPTY), 1 usage or setup error.`;

const normRel = (p) => slash(String(p || '.')).replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';

function selectSteps(flags) {
  if (flags.only !== undefined) {
    if (flags.only === true) fail('--only needs a comma-separated list of steps');
    const wanted = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((s) => !STEPS.includes(s));
    if (bad.length || !wanted.length) fail(`unknown step(s): ${bad.join(', ') || '(none)'} (steps: ${STEPS.join(', ')})`);
    return { preset: 'custom', steps: STEPS.filter((s) => wanted.includes(s)) };
  }
  const preset = flags.preset === undefined ? 'build' : String(flags.preset);
  if (!PRESETS[preset]) fail(`unknown preset "${preset}" (presets: ${Object.keys(PRESETS).join(', ')})`);
  return { preset, steps: PRESETS[preset] };
}

function timeoutOverride(flags) {
  if (flags.timeout === undefined) return null;
  const min = Number(flags.timeout);
  if (!Number.isFinite(min) || min <= 0) fail('--timeout needs a positive number of minutes');
  return Math.max(1, Math.round(min * 60 * 1000));
}

function repoStates(projects) {
  const repos = {};
  for (const p of projects) repos[p.rel] = gitState(p.dir);
  return repos;
}

// parseArgs gives a boolean flag the next word as its value ("--json portal-012"); give it back.
function fixBooleans(args) {
  for (const k of ['json', 'help', 'iOwnThisTarget', 'allowEmpty']) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.unshift(v);
    if (v !== undefined) args.flags[k] = true;
  }
}

export async function run(args, ctx) {
  fixBooleans(args);
  allowFlags(args, FLAGS);
  const { flags } = args;
  if (flags.help) {
    print(HELP);
    return;
  }
  const taskId = args.positional[0];
  if (!taskId) fail(`missing <task>\n${HELP}`);
  const task = resolveTask(ctx, taskId);
  const team = task.team;
  const teamJson = loadTeamJson(ctx, team);
  const all = (Array.isArray(teamJson.projects) && teamJson.projects.length ? teamJson.projects : [{ path: '.', commands: {} }]).map((p) => ({
    ...p,
    rel: normRel(p.path),
    dir: projectDir(team, p),
  }));
  const override = timeoutOverride(flags);
  const logDir = logsDir(ctx, task.id);
  const abs = (p) => (p && !path.isAbsolute(p) ? slash(path.join(ctx.engine, p)) : p);

  let runObj;
  if (flags.dast !== undefined) {
    if (flags.dast === true) fail('--dast needs a target URL');
    const mode = flags.mode === undefined ? 'baseline' : String(flags.mode);
    if (!DAST_MODES.includes(mode)) fail(`unknown --mode "${mode}" (use ${DAST_MODES.join('|')})`);
    if (flags.openapi === true) fail('--openapi needs a URL');
    const refusal = checkDastTarget({
      url: String(flags.dast),
      mode,
      openapi: flags.openapi ? String(flags.openapi) : null,
      teamJson,
      iOwnTarget: Boolean(flags.iOwnThisTarget),
    });
    if (refusal) fail(refusal);
    const repos = repoStates(all);
    const step = await runDast(ctx, {
      url: String(flags.dast),
      mode,
      openapi: flags.openapi ? String(flags.openapi) : null,
      logDir,
      timeoutMs: override || DEFAULT_TIMEOUT_MS.dast,
    });
    runObj = finishRun(ctx, { preset: 'dast', mode, target: String(flags.dast), repos, steps: [step], allowEmpty: Boolean(flags.allowEmpty) });
  } else {
    const { preset, steps } = selectSteps(flags);
    let projects = all;
    if (flags.project !== undefined) {
      if (flags.project === true) fail('--project needs a project path from team.json');
      const want = normRel(flags.project);
      projects = all.filter((p) => p.rel === want);
      if (!projects.length) fail(`no project "${want}" in team.json (projects: ${all.map((p) => p.rel).join(', ')})`);
    }
    const repos = repoStates(projects);
    const security = teamJson.security || {};
    const results = [];
    for (const p of projects) {
      const commands = p.commands || {};
      for (const step of steps) {
        const timeoutMs = override || DEFAULT_TIMEOUT_MS[step];
        const common = { project: p, dir: p.dir, logDir, timeoutMs };
        let r;
        if (CMD_STEPS.includes(step)) r = await runCommandStep({ ...common, step, command: commands[step] });
        else if (step === 'secrets') r = await runSecretsStep(ctx, common);
        else if (step === 'sast') r = await runSastStep(ctx, { ...common, config: security.semgrep_config });
        else r = await runDepsStep(ctx, common);
        results.push(r);
      }
    }
    runObj = finishRun(ctx, { preset, repos, steps: results, allowEmpty: Boolean(flags.allowEmpty), ...(flags.only !== undefined ? { only: steps } : {}) });
  }

  appendRun(task.dir, runObj);
  if (flags.json) print(JSON.stringify(runObj, null, 2));
  else print(formatRun(runObj, { absLog: abs }));
  if (!runObj.ok) process.exitCode = 2;
}

// Builds the gates.json run object: logs/reports stored engine-relative, excerpts kept for failures.
function finishRun(ctx, { preset, mode, target, repos, steps, only, allowEmpty = false }) {
  const first = Object.values(repos)[0] || { head: null, dirty: null };
  const clean = steps.map((s) => {
    const out = { ...s };
    if (out.log) out.log = evidencePath(ctx, out.log);
    if (out.report) out.report = evidencePath(ctx, out.report);
    if (out.status !== 'fail' && out.status !== 'error') delete out.excerpt;
    return out;
  });
  // A gate that built and tested nothing is no evidence: red unless --allow-empty (a waiver).
  const empty = emptyProjects(clean);
  const failed = clean.some((s) => s.status === 'fail' || s.status === 'error');
  return {
    preset,
    ...(mode ? { mode, target } : {}),
    ...(only ? { only } : {}),
    at: nowIso(),
    head: first.head,
    dirty: first.dirty,
    repos,
    ok: !failed && (!empty.length || allowEmpty),
    ...(empty.length ? { empty } : {}),
    ...(empty.length && allowEmpty ? { allow_empty: true } : {}),
    steps: clean,
  };
}
