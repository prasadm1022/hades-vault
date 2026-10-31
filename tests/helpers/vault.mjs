// Temp vault factory shared by the CLI tests. Every vault lives under the OS temp folder and the
// CLI runs with HADES_VAULT, HADES_WORKSPACE and HADES_CONFIG_FILE pointing there, so the engine's
// real hades.config.json is never written (and its vault/workspace are never used).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newState } from '../../lib/core/task.mjs';

export const slash = (p) => String(p).replace(/\\/g, '/');
export const ENGINE = slash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
export const BIN = `${ENGINE}/bin/hades.mjs`;
export const REAL_CONFIG = `${ENGINE}/hades.config.json`;

const temps = [];

export function tempDir(prefix = 'hades-test-') {
  const dir = slash(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
  temps.push(dir);
  return dir;
}

// Call from after(): removes every temp folder this process created.
export function cleanup() {
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // best effort: temp folder
    }
  }
}

let defaultConfig = null;

// Runs the CLI. Returns {code, out, err, lines, json()}.
export function runCli(args, { env = {}, cwd, configFile } = {}) {
  if (!configFile && !defaultConfig) defaultConfig = `${tempDir('hades-cfg-')}/hades.config.json`;
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: cwd || ENGINE,
    env: {
      ...process.env,
      HADES_DEBUG: '',
      HADES_VAULT: '',
      HADES_WORKSPACE: '',
      HADES_CONFIG_FILE: configFile || defaultConfig,
      ...env,
    },
    windowsHide: true,
  });
  const out = res.stdout || '';
  return {
    code: res.status,
    out,
    err: res.stderr || '',
    lines: out.replace(/\s+$/, '') ? out.replace(/\s+$/, '').split(/\r?\n/) : [],
    json() {
      return JSON.parse(out);
    },
  };
}

// Async CLI run (for tests that start several CLI processes at the same time).
export function runCliAsync(args, { env = {}, cwd, configFile } = {}) {
  if (!configFile && !defaultConfig) defaultConfig = `${tempDir('hades-cfg-')}/hades.config.json`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: cwd || ENGINE,
      env: { ...process.env, HADES_DEBUG: '', HADES_VAULT: '', HADES_WORKSPACE: '', HADES_CONFIG_FILE: configFile || defaultConfig, ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

export function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return slash(file);
}

export function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

// A git repository with one commit ("<message>"). Returns the short hash.
export function initRepo(dir, { message = 'feat: first', file = 'README.md' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFile(path.join(dir, file), `${message}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=HADES Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(dir, 'log', '-1', '--format=%h').stdout.trim();
}

export function commit(dir, message, file = 'CHANGES.md') {
  fs.appendFileSync(path.join(dir, file), `${message}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=HADES Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(dir, 'log', '-1', '--format=%h').stdout.trim();
}

/**
 * A registry v3 vault with organizations and teams written directly (no CLI), plus project folders.
 * orgs:  { name: { aliases?, description? } }
 * teams: { name: { org?, type?, aliases?, status?, project_path?, projects? } }
 */
export function makeVault({ orgs = { acme: {} }, teams = {} } = {}) {
  const root = tempDir('hades-vault-');
  const vault = `${root}/vault`;
  const work = `${root}/work`;
  const registry = { version: 3, organizations: {}, teams: {} };
  fs.mkdirSync(vault, { recursive: true });
  for (const [name, o] of Object.entries(orgs)) {
    registry.organizations[name] = {
      org_dir: `organizations/${name}`,
      root_path: `${work}/${name}`,
      description: o.description || '',
      aliases: o.aliases || [],
      created: '2026-10-31',
    };
    fs.mkdirSync(`${vault}/organizations/${name}`, { recursive: true });
  }
  for (const [name, t] of Object.entries(teams)) {
    const org = t.org || Object.keys(orgs)[0];
    const projectPath = t.project_path || `${work}/${org}/${name}`;
    const teamDir = `organizations/${org}/teams/${name}`;
    registry.teams[name] = {
      organization: org,
      type: t.type || 'main',
      project_path: projectPath,
      team_dir: teamDir,
      description: t.description || '',
      aliases: t.aliases || [],
      status: t.status || 'active',
      created: '2026-10-31',
    };
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(`${vault}/${teamDir}/tasks`, { recursive: true });
    const projects = t.projects || [{ path: '.', stack: [], commands: {} }];
    fs.writeFileSync(`${vault}/${teamDir}/team.json`, `${JSON.stringify({ team: name, projects, environments: {} }, null, 2)}\n`);
  }
  fs.writeFileSync(`${vault}/registry.json`, `${JSON.stringify(registry, null, 2)}\n`);
  const env = { HADES_VAULT: vault, HADES_WORKSPACE: work };
  const configFile = `${root}/hades.config.json`;
  const v = {
    root,
    vault,
    work,
    env,
    configFile,
    run: (args, opts = {}) => runCli(args, { cwd: opts.cwd, configFile, env: { ...env, ...(opts.env || {}) } }),
    runAsync: (args, opts = {}) => runCliAsync(args, { cwd: opts.cwd, configFile, env: { ...env, ...(opts.env || {}) } }),
    registry: () => JSON.parse(fs.readFileSync(`${vault}/registry.json`, 'utf8')),
    teamDir: (name) => `${vault}/${v.registry().teams[name].team_dir}`,
    tasksDir: (name) => `${v.teamDir(name)}/tasks`,
    taskDir: (id) => {
      const team = id.replace(/-\d+$/, '');
      const dir = v.tasksDir(team);
      const hit = fs.readdirSync(dir).find((n) => n === id || n.startsWith(`${id}-`));
      if (!hit) throw new Error(`no task folder for ${id}`);
      return `${dir}/${hit}`;
    },
    read: (rel) => fs.readFileSync(path.isAbsolute(rel) ? rel : `${vault}/${rel}`, 'utf8'),
    readJson: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    write: (file, text) => writeFile(path.isAbsolute(file) ? file : `${vault}/${file}`, text),
    // A v2 task folder written directly: state from newState plus overrides, defects, extra files.
    fakeTask: (team, n, { title = `Task ${n}`, size = 'M', status = 'open', stages = {}, defects = [], files = {} } = {}) => {
      const id = `${team}-${String(n).padStart(3, '0')}`;
      const dir = `${v.tasksDir(team)}/${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      const state = newState({ id, team, organization: v.registry().teams[team].organization, title, size });
      state.status = status;
      for (const [s, st] of Object.entries(stages)) state.stages[s] = typeof st === 'string' ? { status: st } : st;
      const cur = Object.keys(state.stages).find((s) => !['done', 'skipped'].includes(state.stages[s].status));
      state.stage = cur || null;
      writeFile(`${dir}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
      writeFile(`${dir}/defects.json`, `${JSON.stringify({ defects }, null, 2)}\n`);
      writeFile(`${dir}/README.md`, `# ${id} ${title}\n`);
      for (const [rel, text] of Object.entries(files)) writeFile(`${dir}/${rel}`, text);
      return { id, dir };
    },
    // A HADES v1 single-file task record.
    v1Task: (team, n, { slug = 'old-task', frontmatter = null, body = '' } = {}) => {
      const id = `${team}-${String(n).padStart(3, '0')}`;
      const fm = frontmatter === null ? { id, team, title: `Old ${n}`, status: 'DONE' } : frontmatter;
      const head = Object.keys(fm).length ? `---\n${Object.entries(fm).map(([k, val]) => `${k}: ${val}`).join('\n')}\n---\n\n` : '';
      return writeFile(`${v.tasksDir(team)}/${id}-${slug}.md`, `${head}# ${id} - ${slug}\n${body}`);
    },
  };
  return v;
}

// A defect record as the CLI writes it (for tests that seed defects.json directly).
export function defectRecord(id, { severity = 'high', source = 'qa', owner = 'backend-engineer', status = 'open', round = 0, title = `Defect ${id}` } = {}) {
  return { id, title, severity, source, owner, status, round, repro: '', evidence: '', refs: [], history: [{ at: '2026-10-31T10:00:00Z', status: 'open', by: 'qa-engineer', note: '' }] };
}
