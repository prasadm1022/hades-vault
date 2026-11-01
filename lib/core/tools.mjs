// Tool runtime: resolves, installs and runs every vendored third-party tool at its pinned version
// (tools/tools.lock.json), plus the argument builders for the MCP launchers used in agent
// frontmatter. Network is used only by setup (downloads, package installs) and bump (GitHub API).
//
// Resolution order (resolveTool):
//   1. env override HADES_TOOL_<NAME_UPPER_SNAKE> = absolute path of an executable, or of a
//      .mjs/.js/.cjs file (run with this Node) - used by tests and by owners with their own build
//   2. <engine>/.tools-bin/<name>/install.json written by "hades tools setup" (stale when its
//      tag/commit differ from the lock): kind "binary" | "node" | "docker" (image pinned by digest)
//   3. a binary on PATH whose cheaply reported version equals the pin
//   4. the pinned package runner (uvx / npx -y) or pinned Docker image (only if docker works)
//   otherwise HadesError "run: hades tools setup <name>".
// HADES_ENGINE_ROOT overrides the engine root for this module only (tests).
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { HadesError, readJson, writeJson, slash, run, kebab, clip, nowIso } from './util.mjs';
import { ENGINE } from './config.mjs';

const IS_WIN = process.platform === 'win32';
export const DEFAULT_AWS_MCP_ENDPOINT = 'https://aws-mcp.us-east-1.api.aws/mcp';
export const MCP_SERVERS = ['serena', 'rea', 'playwright', 'aws'];
export const ALIASES = { playwright: 'playwright-mcp', aws: 'mcp-proxy-for-aws', 'aws-mcp': 'mcp-proxy-for-aws', zap: 'zaproxy' };

// Per-tool recipes. env(root) = hardening environment for the local/PATH/runner forms;
// docker = container form (its env is passed with -e, host env is never forwarded).
const RECIPES = {
  rea: {
    runnable: true,
    npm: 'rea-agents',
    npmEntry: 'node_modules/rea-agents/scripts/rea.mjs',
    runners: ['npx'],
    env: () => ({ REA_MCP_INPUT_SCHEMA_PROFILE: 'compact', REA_LOG_LEVEL: 'warn', npm_config_ignore_scripts: 'true' }),
  },
  serena: {
    runnable: true,
    uvSource: true,
    python: '3.12',
    bin: 'serena',
    runners: ['uvx'],
    env: (root) => ({ SERENA_USAGE_REPORTING: 'false', SERENA_HOME: serenaHome(root) }),
  },
  ccusage: {
    runnable: true,
    npm: 'ccusage',
    npmEntry: 'node_modules/ccusage/src/cli.js',
    path: { bin: 'ccusage', versionArgs: ['--version'] },
    runners: ['npx'],
    env: () => ({ LOG_LEVEL: '0' }),
  },
  semgrep: {
    runnable: true,
    pypi: 'semgrep',
    bin: 'semgrep',
    path: { bin: 'semgrep', versionArgs: ['--version'] },
    runners: ['uvx', 'docker'],
    env: () => ({ SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_MCP_DISABLE_TRACING: 'true', SEMGREP_APP_TOKEN: undefined }),
    docker: {
      image: (v) => `semgrep/semgrep:${v}`,
      command: ['semgrep'],
      workdir: '/src',
      user: true,
      env: { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' },
    },
  },
  gitleaks: {
    runnable: true,
    release: true,
    bin: 'gitleaks',
    path: { bin: 'gitleaks', versionArgs: ['version'] },
    runners: ['docker'],
    env: () => ({}),
    docker: { image: (v) => `ghcr.io/gitleaks/gitleaks:v${v}`, command: [], workdir: '/src', network: 'none', user: true, env: {} },
  },
  trivy: {
    runnable: true,
    release: true,
    bin: 'trivy',
    path: { bin: 'trivy', versionArgs: ['--version'] },
    runners: ['docker'],
    env: (root) => ({
      TRIVY_CACHE_DIR: `${root}/${TRIVY_CACHE}`,
      TRIVY_DISABLE_TELEMETRY: 'true',
      TRIVY_SKIP_VERSION_CHECK: 'true',
      TRIVY_RUN_AS_PLUGIN: undefined,
    }),
    docker: {
      image: (v) => `aquasec/trivy:${v}`,
      command: [],
      workdir: '/src',
      user: true,
      cache: '/cache',
      env: { TRIVY_CACHE_DIR: '/cache', TRIVY_DISABLE_TELEMETRY: 'true', TRIVY_SKIP_VERSION_CHECK: 'true' },
    },
  },
  'playwright-mcp': {
    runnable: true,
    npm: '@playwright/mcp',
    npmEntry: 'cli.js',
    runners: ['npx'],
    env: (root) => (fs.existsSync(browsersDir(root)) ? { PLAYWRIGHT_BROWSERS_PATH: browsersDir(root) } : {}),
  },
  zaproxy: {
    runnable: true,
    runners: ['docker'],
    env: () => ({}),
    docker: { image: (v) => `zaproxy/zap-stable:${v}`, command: [], workdir: '/zap/wrk', addHost: true, env: { ZAP_SILENT: 'true' } },
  },
  'mcp-proxy-for-aws': {
    runnable: true,
    uvSource: true,
    python: '3.12',
    bin: 'mcp-proxy-for-aws',
    runners: ['uvx'],
    env: () => ({}),
  },
  'aws-agent-toolkit': { runnable: false, data: 'official AWS skills, rules and plugin definitions, read from tools/aws-agent-toolkit' },
};

// ---------------------------------------------------------------- paths and the lock file

export function engineRoot(ctx) {
  return slash(path.resolve(process.env.HADES_ENGINE_ROOT || (ctx && ctx.engine) || ENGINE));
}

export function lockPath(ctx) {
  return `${engineRoot(ctx)}/tools/tools.lock.json`;
}

export function lockfile(ctx) {
  return readJson(lockPath(ctx));
}

export function binRoot(ctx) {
  return `${engineRoot(ctx)}/.tools-bin`;
}

export function toolDir(ctx, name) {
  return `${binRoot(ctx)}/${name}`;
}

// Trivy's vulnerability DB cache, relative to the engine root. The one definition: the trivy recipe
// (local and Docker forms) and "hades gate" deps step both use it.
export const TRIVY_CACHE = '.tools-bin/trivy-cache';

export function trivyCacheDir(ctx) {
  return `${engineRoot(ctx)}/${TRIVY_CACHE}`;
}

function serenaHome(root) {
  return `${root}/.hades/serena-home`;
}

function browsersDir(root) {
  return `${root}/.tools-bin/playwright-browsers`;
}

function readLockNames() {
  try {
    const raw = fs.readFileSync(lockPath(null), 'utf8').replace(/^\uFEFF/, '');
    return Object.keys(JSON.parse(raw).tools || {});
  } catch {
    return Object.keys(RECIPES);
  }
}

export const TOOL_NAMES = Object.freeze(readLockNames());

export function recipe(name) {
  return RECIPES[canonicalName(name)] || null;
}

export function canonicalName(name) {
  const n = String(name || '').toLowerCase();
  return ALIASES[n] || n;
}

// "v8.30.1" -> "8.30.1", "rea-agents-6.5.0" -> "6.5.0", null -> null
export function tagVersion(tag) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(String(tag || ''));
  return m ? m[1] : null;
}

export function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function envVarName(name) {
  return `HADES_TOOL_${canonicalName(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

// ---------------------------------------------------------------- executables

// PATH lookup without spawning a shell. On Windows only PATHEXT extensions are tried
// (extensionless npm shell shims are skipped).
export function findExe(name, env = process.env) {
  const raw = env.PATH || env.Path || '';
  const exts = IS_WIN
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  for (const dir of raw.split(path.delimiter)) {
    const d = dir.replace(/^"|"$/g, '').trim();
    if (!d) continue;
    for (const ext of exts) {
      const file = path.join(d, name + ext);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (!IS_WIN) fs.accessSync(file, fs.constants.X_OK);
        return slash(file);
      } catch {
        // not here
      }
    }
  }
  return null;
}

function spawnable(file) {
  return !(IS_WIN && /\.(cmd|bat)$/i.test(file));
}

// npm / npx without a shell. On Windows the .cmd shims cannot be spawned without a shell, so the
// npm CLI scripts next to the shim (or next to node.exe) are run with this Node instead.
export function npmCli(kind) {
  const file = kind === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
  const shim = findExe(kind);
  if (!IS_WIN) return shim ? { cmd: shim, args: [] } : null;
  const candidates = [];
  if (shim) candidates.push(path.join(path.dirname(shim), 'node_modules', 'npm', 'bin', file));
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', file));
  for (const c of candidates) if (fs.existsSync(c)) return { cmd: process.execPath, args: [slash(c)] };
  return null;
}

let dockerCache;
export function dockerAvailable() {
  const forced = process.env.HADES_DOCKER;
  if (forced === '0' || forced === 'false') return false;
  if (forced === '1' || forced === 'true') return true;
  if (dockerCache !== undefined) return dockerCache;
  const exe = findExe('docker');
  dockerCache = !!exe && run(exe, ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 }).code === 0;
  return dockerCache;
}

const probeCache = new Map();
function probeVersion(file, args, env) {
  const key = `${file}\0${args.join(' ')}`;
  if (!probeCache.has(key)) {
    const r = run(file, args, { timeout: 15000, env: mergeEnv(process.env, env) });
    probeCache.set(key, r.code === 0 ? parseVersion(`${r.stdout}\n${r.stderr}`) : null);
  }
  return probeCache.get(key);
}

// process.env + layers; a layer value of undefined/null removes the variable (case-insensitive on Windows).
export function mergeEnv(base, ...layers) {
  const out = { ...base };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer || {})) {
      if (IS_WIN) for (const key of Object.keys(out)) if (key !== k && key.toUpperCase() === k.toUpperCase()) delete out[key];
      if (v === undefined || v === null) delete out[k];
      else out[k] = String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- command builders (pure)

export function uvxArgs(name, version, root) {
  const r = RECIPES[name];
  if (r.uvSource) return [...(r.python ? ['-p', r.python] : []), '--from', `${root}/tools/${name}`, r.bin];
  return ['--from', `${r.pypi}==${version}`, r.bin];
}

export function npxArgs(name, version) {
  return ['-y', `${RECIPES[name].npm}@${version}`];
}

export function dockerImage(name, version) {
  return RECIPES[name].docker.image(version);
}

function bindMount(host, target, ro = false) {
  const src = slash(path.resolve(host));
  if (src.includes(',')) throw new HadesError(`cannot bind-mount a path containing a comma: ${src}`);
  return ['--mount', `type=bind,source=${src},target=${target}${ro ? ',readonly' : ''}`];
}

// docker run arguments up to and including the image (and the image command prefix).
// With mounts [{host, container, ro}]: exactly those bind mounts, -w = workdir or the first mount,
// plus the trivy cache at /cache unless a mount targets it. With cwd (no mounts): cwd is mounted at
// the recipe's workdir (tool paths relative to cwd) plus the cache. Without either: no mounts and
// no -w; the caller inserts its own after "run". containerName adds --name.
export function dockerRunArgs(name, { ref, cwd = null, root, uid = null, gid = null, mounts = null, workdir = null, containerName = null }) {
  const d = RECIPES[name].docker;
  const args = ['run', '--rm', '-i'];
  if (containerName) args.push('--name', containerName);
  const cache = () => (d.cache ? bindMount(`${root}/${TRIVY_CACHE}`, d.cache) : []);
  if (Array.isArray(mounts) && mounts.length) {
    for (const m of mounts) args.push(...bindMount(m.host, m.container, !!m.ro));
    args.push('-w', workdir || mounts[0].container);
    if (!mounts.some((m) => m.container === d.cache)) args.push(...cache());
  } else if (cwd) {
    args.push(...bindMount(cwd, d.workdir), '-w', d.workdir, ...cache());
  }
  if (d.network) args.push('--network', d.network);
  if (d.addHost) args.push('--add-host', 'host.docker.internal:host-gateway');
  if (d.user && uid !== null && uid !== undefined) args.push('--user', `${uid}:${gid ?? uid}`, '-e', 'HOME=/tmp');
  for (const [k, v] of Object.entries(d.env || {})) args.push('-e', `${k}=${v}`);
  args.push(ref, ...d.command);
  return args;
}

// projectDir null = no startup project. In the claude-code context Serena is single-project only
// when a project is given at startup (agent.py: _is_single_project), and that removes
// activate_project; without one, the agent activates the project it works on.
export function serenaArgs(projectDir = null) {
  return [
    'start-mcp-server',
    '--context', 'claude-code',
    ...(projectDir ? ['--project', projectDir] : []),
    '--agent-interface', 'tools',
    '--enable-web-dashboard', 'False',
    '--enable-gui-log-window', 'False',
    '--open-web-dashboard', 'False',
    '--mode', 'no-memories',
    '--log-level', 'WARNING',
  ];
}

export function playwrightArgs(outDir) {
  return [
    '--headless',
    '--isolated',
    '--browser', 'chromium',
    '--no-webmcp',
    '--output-dir', outDir,
    '--image-responses', 'omit',
    '--console-level', 'error',
    '--caps', 'testing',
  ];
}

// AWS settings from hades.config.json {"aws": {"profile" or "profiles", "region", "read_only"}}
// (plus an optional "endpoint" override) or AWS_PROFILE. The profile must be least-privilege
// ("hades doctor" FAILs on root). Never reads AWS credential or config files.
export function awsSettings(ctx, env = process.env) {
  const cfg = (ctx && ctx.config && ctx.config.aws) || {};
  const raw = cfg.profile ?? cfg.profiles ?? env.AWS_PROFILE ?? '';
  const profiles = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!profiles.length) {
    throw new HadesError('aws MCP server unavailable: no AWS profile configured (set "aws": {"profile": "<name>"} in hades.config.json or AWS_PROFILE)');
  }
  for (const p of profiles) if (!/^[A-Za-z0-9_.@+=:-]{1,128}$/.test(p)) throw new HadesError(`aws MCP server unavailable: invalid AWS profile name "${p}"`);
  const region = cfg.region ? String(cfg.region) : null;
  if (region && !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) throw new HadesError(`aws MCP server unavailable: invalid AWS region "${region}"`);
  const endpoint = String(cfg.endpoint || DEFAULT_AWS_MCP_ENDPOINT);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') throw new HadesError(`aws MCP server unavailable: endpoint must be an https URL: ${endpoint}`);
  return { profiles, region, endpoint, readOnly: cfg.read_only === true };
}

// The proxy signs with the endpoint's region; the configured region is the region the AWS MCP
// server operates in, passed as AWS_REGION metadata (never as --region, which is the signing region).
export function awsArgs(s) {
  return [
    s.endpoint,
    '--profile', ...s.profiles,
    ...(s.region ? ['--metadata', `AWS_REGION=${s.region}`] : []),
    ...(s.readOnly ? ['--read-only'] : []),
    '--disable-telemetry',
    '--log-level', 'ERROR',
  ];
}

// GitHub release asset names, from the tools' goreleaser name templates.
export function releaseAsset(name, tag, platform = process.platform, arch = process.arch, repo = null) {
  const v = tagVersion(tag);
  if (!v) return null;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const exe = platform === 'win32' ? '.exe' : '';
  let archive;
  if (name === 'gitleaks') {
    const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
    const a = { x64: 'x64', arm64: 'arm64', ia32: 'x32' }[arch];
    if (!os || !a) return null;
    archive = `gitleaks_${v}_${os}_${a}.${ext}`;
  } else if (name === 'trivy') {
    const os = { win32: 'windows', linux: 'Linux', darwin: 'macOS' }[platform];
    const a = { x64: '64bit', arm64: 'ARM64' }[arch];
    if (!os || !a || (platform === 'win32' && arch !== 'x64')) return null;
    archive = `trivy_${v}_${os}-${a}.${ext}`;
  } else {
    return null;
  }
  const base = `${String(repo || `https://github.com/${name === 'trivy' ? 'aquasecurity' : 'gitleaks'}/${name}`).replace(/\.git$/, '').replace(/\/+$/, '')}/releases/download/${tag}/`;
  return { archive, checksums: `${name}_${v}_checksums.txt`, bin: `${name}${exe}`, base };
}

// ---------------------------------------------------------------- resolution

function pinOf(ctx, name) {
  const lock = lockfile(ctx);
  const pin = lock.tools && lock.tools[name];
  if (!pin) throw new HadesError(`unknown tool: ${name} (known: ${Object.keys(lock.tools || {}).join(', ')})`);
  return pin;
}

function readInstall(ctx, name) {
  const file = `${toolDir(ctx, name)}/install.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { invalid: true };
  }
}

function dockerSpec(ctx, name, ref, version, opts, note) {
  const root = engineRoot(ctx);
  const uid = !IS_WIN && typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = !IS_WIN && typeof process.getgid === 'function' ? process.getgid() : null;
  const mounts = Array.isArray(opts.mounts) && opts.mounts.length ? opts.mounts : null;
  if ((opts.cwd || mounts) && RECIPES[name].docker.cache) fs.mkdirSync(trivyCacheDir(ctx), { recursive: true });
  const mountNote = mounts
    ? `mounts: ${mounts.map((m) => m.container).join(', ')}`
    : opts.cwd
      ? `cwd is mounted at ${RECIPES[name].docker.workdir}, pass paths relative to it`
      : 'no mounts: insert your own -v/-w after "run" (or resolve with {cwd} or {mounts})';
  return {
    cmd: findExe('docker') || 'docker',
    args: dockerRunArgs(name, { ref, cwd: opts.cwd || null, root, uid, gid, mounts, workdir: opts.workdir || null, containerName: opts.containerName || null }),
    via: 'docker',
    version,
    env: {},
    note: `${note ? `${note}; ` : ''}${mountNote}`,
  };
}

// Local install from "hades tools setup". Returns a resolution, { stale } or null.
export function resolveLocal(ctx, name, pin, opts = {}) {
  const info = readInstall(ctx, name);
  if (!info) return null;
  if (info.invalid) return { stale: 'unreadable install.json' };
  if (info.tag !== pin.tag || info.commit !== pin.commit) {
    return { stale: `local copy is ${info.tag || info.commit || '?'}, pin is ${pin.tag || pin.commit}` };
  }
  const env = RECIPES[name].env(engineRoot(ctx));
  if (info.kind === 'docker') {
    if (!info.ref) return { stale: 'install.json has no image' };
    return dockerSpec(ctx, name, info.ref, info.version || null, opts, 'image pinned by digest at setup');
  }
  const dir = toolDir(ctx, name);
  const entry = slash(path.resolve(dir, String(info.entry || '')));
  if (!info.entry || !entry.startsWith(`${dir}/`) || !fs.existsSync(entry)) return { stale: 'installed entry point missing' };
  if (info.kind === 'node') return { cmd: process.execPath, args: [entry], via: 'local', version: info.version || null, env };
  if (!spawnable(entry)) return { stale: 'installed entry point is a shell script' };
  return { cmd: entry, args: [], via: 'local', version: info.version || null, env };
}

// opts shape the Docker form only: {cwd} or {mounts: [{host, container, ro}], workdir, containerName}.
export function resolveTool(ctx, name, opts = {}) {
  const key = canonicalName(name);
  const pin = pinOf(ctx, key);
  const r = RECIPES[key];
  if (!r) throw new HadesError(`no run recipe for ${key}`);
  if (!r.runnable) throw new HadesError(`${key} is data (${r.data}), not a runnable tool`);
  const root = engineRoot(ctx);
  const version = tagVersion(pin.tag);
  const env = r.env(root);

  // 1. explicit override
  const ov = process.env[envVarName(key)];
  if (ov) {
    const file = slash(path.resolve(ov));
    if (!fs.existsSync(file)) throw new HadesError(`${envVarName(key)} points to a missing file: ${file}`);
    const script = /\.(m?js|cjs)$/i.test(file);
    return { cmd: script ? process.execPath : file, args: script ? [file] : [], via: 'env', version: null, env };
  }

  // 2. local install
  const local = resolveLocal(ctx, key, pin, opts);
  if (local && !local.stale) return local;
  const staleNote = local && local.stale ? `stale local install (${local.stale})` : null;

  // 3. PATH binary at the pinned version
  if (r.path && version) {
    const file = findExe(r.path.bin);
    if (file && spawnable(file) && probeVersion(file, r.path.versionArgs, env) === parseVersion(version)) {
      return { cmd: file, args: [], via: 'path', version, env, ...(staleNote ? { note: staleNote } : {}) };
    }
  }

  // 4. pinned package runner or image
  for (const runner of r.runners) {
    if (runner === 'uvx') {
      const uvx = findExe('uvx');
      if (!uvx || !spawnable(uvx)) continue;
      if (r.uvSource && !fs.existsSync(`${root}/tools/${key}/pyproject.toml`)) continue;
      if (!r.uvSource && !version) continue;
      return {
        cmd: uvx,
        args: uvxArgs(key, version, root),
        via: 'uvx',
        version,
        env,
        note: [staleNote, 'first run resolves packages (network)'].filter(Boolean).join('; '),
      };
    }
    if (runner === 'npx') {
      const npx = npmCli('npx');
      if (!npx || !version) continue;
      return {
        cmd: npx.cmd,
        args: [...npx.args, ...npxArgs(key, version)],
        via: 'npx',
        version,
        env: { ...env, npm_config_ignore_scripts: 'true' },
        note: [staleNote, 'first run downloads the package (network)'].filter(Boolean).join('; '),
      };
    }
    if (runner === 'docker' && version && dockerAvailable()) {
      return dockerSpec(ctx, key, dockerImage(key, version), version, opts, [staleNote, 'pinned tag, not yet pulled by setup'].filter(Boolean).join('; '));
    }
  }
  throw new HadesError(`${key} is not available${staleNote ? ` (${staleNote})` : ''}. run: hades tools setup ${key}`);
}

// Runs a tool synchronously without a shell: resolveTool's cmd with args.concat(toolArgs).
export function runTool(ctx, name, toolArgs = [], opts = {}) {
  const r = resolveTool(ctx, name, { cwd: opts.cwd || process.cwd() });
  const { env: extraEnv, ...rest } = opts;
  return run(r.cmd, r.args.concat(toolArgs.map(String)), {
    timeout: 60 * 60 * 1000,
    ...rest,
    env: mergeEnv(process.env, r.env, extraEnv),
  });
}

// Spawns with inherited stdio, forwards termination signals and resolves with the exit code.
export function execInherit(cmd, args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'inherit', env, cwd, windowsHide: true });
    } catch (err) {
      process.stderr.write(`hades: cannot start ${path.basename(cmd)}: ${err.message}\n`);
      resolve(1);
      return;
    }
    const signals = IS_WIN ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = (sig) => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    for (const s of signals) process.on(s, forward);
    const done = (code) => {
      for (const s of signals) process.off(s, forward);
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`hades: cannot start ${path.basename(cmd)}: ${err.message}\n`);
      done(1);
    });
    child.on('exit', (code, signal) => {
      if (code !== null) done(code);
      else done(signal ? 128 + (signalNumber(signal) || 1) : 1);
    });
  });
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGBREAK: 21 }[signal] || 0;
}

// ---------------------------------------------------------------- MCP launchers

// Per-project Serena data (project.yml, caches) lives here, never inside the project.
export function serenaDataRoot(ctx) {
  return `${engineRoot(ctx)}/.hades/serena`;
}

// The folder Serena resolves "project_serena_folder_location" to for a project. It is created
// before launch: an existing folder there wins over a <project>/.serena left by an earlier run.
export function serenaProjectFolder(ctx, projectDir) {
  return `${serenaDataRoot(ctx)}/${path.basename(slash(path.resolve(projectDir)))}`;
}

// Keys checked against tools/serena (src/serena/config/serena_config.py, serena_config.template.yml).
// Enforced on every launch: a missing trusted_project_path_patterns would default to ["**"].
function serenaEnforced(ctx) {
  return {
    agent_interface: 'tools',
    gui_log_window: 'false',
    web_dashboard: 'false',
    web_dashboard_open_on_launch: 'false',
    project_serena_folder_location: `"${serenaDataRoot(ctx)}/$projectFolderName"`,
    trusted_project_path_patterns: '[]',
  };
}

// Hardened Serena configuration (written once; Serena then maintains its "projects" list).
export function serenaConfigText(ctx) {
  const e = serenaEnforced(ctx);
  return `# Written by HADES ("hades mcp serena"). Hardened defaults: see tools/README.md.
language_backend: LSP
agent_interface: ${e.agent_interface}
line_ending: lf
gui_log_window: ${e.gui_log_window}
web_dashboard: ${e.web_dashboard}
web_dashboard_open_on_launch: ${e.web_dashboard_open_on_launch}
log_level: 30
trace_lsp_communication: false
tool_timeout: 240
excluded_tools:
  - execute_shell_command
included_optional_tools: []
base_modes:
  - editing
default_modes:
default_max_tool_answer_chars: 30000
token_count_estimator: CHAR_COUNT
symbol_info_budget: 10
project_serena_folder_location: ${e.project_serena_folder_location}
trusted_project_path_patterns: ${e.trusted_project_path_patterns}
projects: []
`;
}

// Sets top-level "key: value" lines (replacing an old value and its indented/list continuation).
export function hardenSerenaConfig(text, enforced) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(enforced)) {
    const line = `${key}: ${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i < 0) {
      lines.push(line);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && /^(?:\s+\S|-(?:\s|$))/.test(lines[j])) j++;
    lines.splice(i, j - i, line);
  }
  return `${lines.join(eol)}${eol}`;
}

// Seeds <SERENA_HOME>/serena_config.yml once and re-applies the enforced keys on every launch.
export function ensureSerenaConfig(ctx) {
  const home = serenaHome(engineRoot(ctx));
  const file = `${home}/serena_config.yml`;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, serenaConfigText(ctx), 'utf8');
    return file;
  }
  const text = fs.readFileSync(file, 'utf8');
  const hardened = hardenSerenaConfig(text, serenaEnforced(ctx));
  if (hardened !== text) fs.writeFileSync(file, hardened, 'utf8');
  return file;
}

export function playwrightOutputDir(ctx, projectDir) {
  const hash = crypto.createHash('sha1').update(projectDir.toLowerCase()).digest('hex').slice(0, 8);
  return `${engineRoot(ctx)}/.hades/playwright/${kebab(path.basename(projectDir)) || 'project'}-${hash}`;
}

// { cmd, args, env, cwd, via, project } for "hades mcp <server>". No side effects except fs reads.
// Serena gets a startup project only from --project: Claude Code starts MCP servers in the session
// directory (normally the whole workspace), so the cwd is never taken as Serena's project; the
// agent calls activate_project(<Project>) first (playbooks/code-navigation.md).
export function mcpSpec(ctx, server, { project, env = process.env } = {}) {
  const projectDir = slash(path.resolve(project || process.cwd()));
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new HadesError(`project directory not found: ${projectDir}`);
  const name = String(server || '').toLowerCase();
  if (name === 'serena') {
    const r = resolveTool(ctx, 'serena');
    const startup = project ? projectDir : null;
    return { cmd: r.cmd, args: [...r.args, ...serenaArgs(startup)], env: r.env, cwd: projectDir, via: r.via, project: startup };
  }
  if (name === 'rea') {
    const r = resolveTool(ctx, 'rea');
    const pass = {};
    for (const k of ['GHIDRA_INSTALL_DIR', 'JAVA_HOME']) if (env[k]) pass[k] = env[k];
    return { cmd: r.cmd, args: [...r.args, 'mcp'], env: { ...r.env, ...pass }, cwd: projectDir, via: r.via };
  }
  if (name === 'playwright') {
    const r = resolveTool(ctx, 'playwright-mcp');
    return { cmd: r.cmd, args: [...r.args, ...playwrightArgs(playwrightOutputDir(ctx, projectDir))], env: r.env, cwd: projectDir, via: r.via };
  }
  if (name === 'aws') {
    const s = awsSettings(ctx, env);
    const r = resolveTool(ctx, 'mcp-proxy-for-aws');
    return { cmd: r.cmd, args: [...r.args, ...awsArgs(s)], env: { ...r.env, AWS_MCP_PROXY_PROFILES: s.profiles.join(' ') }, cwd: projectDir, via: r.via };
  }
  throw new HadesError(`unknown MCP server "${server}" (one of: ${MCP_SERVERS.join(', ')})`);
}

// ---------------------------------------------------------------- integrity helpers

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// "<sha256>  <file>" or "<sha256> *<file>" lines -> Map(file -> sha256)
export function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

export function verifyChecksum(file, expected) {
  return typeof expected === 'string' && /^[0-9a-f]{64}$/i.test(expected) && sha256File(file) === expected.toLowerCase();
}

// Days between the release date and now; ok when >= cooldown days.
export function cooldownCheck(released, cooldownDays, now = new Date()) {
  const t = Date.parse(released);
  if (Number.isNaN(t)) return { ok: false, days: null };
  const days = Math.floor((now.getTime() - t) / 86400000);
  return { ok: days >= cooldownDays, days };
}

// ---------------------------------------------------------------- network (setup and bump only)

const DOWNLOAD_HOSTS = [/^github\.com$/, /^api\.github\.com$/, /(^|\.)githubusercontent\.com$/];

function request(url, { headers = {}, timeoutMs = 120000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.some((re) => re.test(u.hostname))) {
      reject(new HadesError(`refusing to download from ${u.protocol}//${u.host}`));
      return;
    }
    const req = https.get(u, { headers: { 'User-Agent': 'hades-tools', ...headers }, timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new HadesError('too many redirects'));
        const next = new URL(res.headers.location, u);
        const h = { ...headers };
        if (next.host !== u.host) delete h.Authorization;
        return resolve(request(next.toString(), { headers: h, timeoutMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new HadesError(`HTTP ${res.statusCode} for ${u.host}${u.pathname}`);
        err.httpStatus = res.statusCode;
        return reject(err);
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms (${u.host})`)));
    req.on('error', reject);
  });
}

export async function downloadFile(url, dest, { maxBytes = 512 * 1024 * 1024, headers } = {}) {
  const res = await request(url, { headers });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new HadesError(`download exceeds ${maxBytes} bytes`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res, meter, fs.createWriteStream(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function fetchText(url, { headers, maxBytes = 4 * 1024 * 1024 } = {}) {
  const res = await request(url, { headers });
  const chunks = [];
  let bytes = 0;
  for await (const c of res) {
    bytes += c.length;
    if (bytes > maxBytes) throw new HadesError(`response from ${new URL(url).host} too large`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function githubJson(apiPath) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return JSON.parse(await fetchText(`https://api.github.com${apiPath}`, { headers }));
}

export function parseGithubRepo(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  if (!m) throw new HadesError(`not a GitHub repository URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// ---------------------------------------------------------------- setup

function must(res, what) {
  if (res.code !== 0) {
    const tail = clip(`${res.stderr || ''}\n${res.stdout || ''}`.trim(), { head: 0, tail: 8 });
    throw new HadesError(`${what} failed (exit ${res.code})${tail ? `:\n${tail}` : ''}`);
  }
  return res;
}

function safeRemove(ctx, dir) {
  const rootBin = path.resolve(binRoot(ctx));
  const target = path.resolve(dir);
  if (!target.startsWith(rootBin + path.sep)) throw new HadesError(`refusing to delete outside .tools-bin: ${slash(target)}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function freshDir(ctx, dir) {
  safeRemove(ctx, dir);
  fs.mkdirSync(dir, { recursive: true });
  return slash(dir);
}

function writeInstall(ctx, name, pin, info) {
  writeJson(`${toolDir(ctx, name)}/install.json`, { tool: name, tag: pin.tag, commit: pin.commit, ...info, at: nowIso() });
}

function venvBin(venv, bin) {
  return IS_WIN ? `${venv}/Scripts/${bin}.exe` : `${venv}/bin/${bin}`;
}

function npm(args, opts = {}) {
  const cli = npmCli('npm');
  if (!cli) throw new HadesError('npm not found on PATH');
  return run(cli.cmd, [...cli.args, ...args], { timeout: 30 * 60 * 1000, ...opts });
}

function requireExe(name, hint) {
  const exe = findExe(name);
  if (!exe || !spawnable(exe)) throw new HadesError(`${name} not found on PATH${hint ? ` (${hint})` : ''}`);
  return exe;
}

// Confirms the pinned version exists on the npm registry; returns its dist.integrity.
function npmPinnedIntegrity(pkg, version) {
  const res = must(npm(['view', `${pkg}@${version}`, 'version', 'dist.integrity', '--json'], { timeout: 120000 }), `npm view ${pkg}@${version}`);
  let data = null;
  try {
    data = JSON.parse(res.stdout || 'null');
  } catch {
    data = null;
  }
  if (!data || data.version !== version) throw new HadesError(`${pkg}@${version} is not published on the npm registry`);
  return data['dist.integrity'] || null;
}

function installedPackageVersion(dir, pkg) {
  const file = `${dir}/node_modules/${pkg}/package.json`;
  return fs.existsSync(file) ? readJson(file).version : null;
}

function npmInstallPinned(ctx, name, pin, extraEnv = {}) {
  const r = RECIPES[name];
  const v = tagVersion(pin.tag);
  const integrity = npmPinnedIntegrity(r.npm, v);
  const dir = freshDir(ctx, toolDir(ctx, name));
  fs.writeFileSync(`${dir}/package.json`, `${JSON.stringify({ name: `hades-tool-${name}`, private: true }, null, 2)}\n`);
  must(
    npm(['install', '--prefix', dir, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${r.npm}@${v}`], {
      cwd: dir,
      env: mergeEnv(process.env, extraEnv),
    }),
    `npm install ${r.npm}@${v}`,
  );
  const got = installedPackageVersion(dir, r.npm);
  if (got !== v) throw new HadesError(`installed ${r.npm} is ${got}, expected ${v}`);
  return { dir, v, integrity };
}

function nodeSatisfiesRea(ver) {
  const [maj, min] = ver.split('.').map(Number);
  return (maj === 22 && min >= 19) || (maj === 24 && min >= 11) || maj >= 26;
}

function uvSync(ctx, name, pin) {
  const r = RECIPES[name];
  const uv = requireExe('uv', 'install uv: https://docs.astral.sh/uv/');
  const src = `${engineRoot(ctx)}/tools/${name}`;
  if (!fs.existsSync(`${src}/uv.lock`)) throw new HadesError(`vendored source missing: ${src} (run: git submodule update --init tools/${name})`);
  const dir = freshDir(ctx, toolDir(ctx, name));
  const venv = `${dir}/venv`;
  const args = ['sync', '--project', src, '--frozen', '--no-dev', '--no-editable', ...(r.python ? ['--python', r.python] : [])];
  must(
    run(uv, args, { timeout: 30 * 60 * 1000, env: mergeEnv(process.env, { UV_PROJECT_ENVIRONMENT: venv, VIRTUAL_ENV: undefined }) }),
    `uv sync (${name})`,
  );
  const entry = venvBin(venv, r.bin);
  if (!fs.existsSync(entry)) throw new HadesError(`uv sync did not produce ${entry}`);
  writeInstall(ctx, name, pin, { version: tagVersion(pin.tag), kind: 'binary', entry: path.posix.relative(dir, entry), source: `vendored source tools/${name} + uv.lock (frozen)` });
  return { ok: true, via: 'local', version: tagVersion(pin.tag), detail: `built from tools/${name} with uv.lock (frozen, no dev deps)` };
}

function dockerPull(image) {
  const docker = requireExe('docker');
  must(run(docker, ['pull', '--quiet', image], { timeout: 60 * 60 * 1000 }), `docker pull ${image}`);
  const i = run(docker, ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image]);
  const ref = i.stdout.trim();
  return i.code === 0 && /@sha256:[0-9a-f]{64}$/.test(ref) ? ref : image;
}

function setupDocker(ctx, name, pin, reason) {
  if (!dockerAvailable()) throw new HadesError(`${reason ? `${reason}; ` : ''}Docker is not available`);
  const v = tagVersion(pin.tag);
  const image = dockerImage(name, v);
  const ref = dockerPull(image);
  freshDir(ctx, toolDir(ctx, name));
  writeInstall(ctx, name, pin, { version: v, kind: 'docker', image, ref });
  return { ok: true, via: 'docker', version: v, detail: `image ${ref}${reason ? ` (${reason})` : ''}` };
}

function extractArchive(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Windows: System32 bsdtar reads zip; a GNU tar from Git for Windows on PATH would not.
  const tar = IS_WIN ? `${slash(process.env.SystemRoot || 'C:/Windows')}/System32/tar.exe` : 'tar';
  if (IS_WIN && !fs.existsSync(tar)) throw new HadesError('tar.exe not found in System32 (Windows 10 1803 or newer is required)');
  must(run(tar, ['-xf', archive, '-C', dest], { timeout: 10 * 60 * 1000 }), `extract ${path.basename(archive)}`);
}

async function setupRelease(ctx, name, pin) {
  const r = RECIPES[name];
  const v = tagVersion(pin.tag);
  const asset = releaseAsset(name, pin.tag, process.platform, process.arch, pin.repo);
  if (!asset) return setupDocker(ctx, name, pin, `no ${name} release build for ${process.platform}-${process.arch}`);
  const tmp = slash(path.join(binRoot(ctx), `.download-${name}-${process.pid}`));
  freshDir(ctx, tmp);
  try {
    let expected;
    let got;
    try {
      const sums = parseChecksums(await fetchText(asset.base + asset.checksums));
      expected = sums.get(asset.archive);
      if (!expected) {
        const err = new HadesError(`${asset.archive} is not listed in ${asset.checksums}; refusing`);
        err.integrity = true;
        throw err;
      }
      got = await downloadFile(asset.base + asset.archive, `${tmp}/${asset.archive}`);
    } catch (err) {
      if (err.integrity || !dockerAvailable()) throw err;
      return setupDocker(ctx, name, pin, `release download failed: ${err.message}`);
    }
    if (got.sha256 !== expected || !verifyChecksum(`${tmp}/${asset.archive}`, expected)) {
      throw new HadesError(`checksum mismatch for ${asset.archive}: expected ${expected}, got ${got.sha256}; refusing to install`);
    }
    const out = `${tmp}/x`;
    extractArchive(`${tmp}/${asset.archive}`, out);
    const bin = `${out}/${asset.bin}`;
    if (!fs.existsSync(bin)) throw new HadesError(`${asset.archive} does not contain ${asset.bin}`);
    const dir = freshDir(ctx, toolDir(ctx, name));
    fs.copyFileSync(bin, `${dir}/${asset.bin}`);
    if (!IS_WIN) fs.chmodSync(`${dir}/${asset.bin}`, 0o755);
    if (fs.existsSync(`${out}/LICENSE`)) fs.copyFileSync(`${out}/LICENSE`, `${dir}/LICENSE`);
    const ver = run(`${dir}/${asset.bin}`, r.path.versionArgs, { timeout: 30000, env: mergeEnv(process.env, r.env(engineRoot(ctx))) });
    if (parseVersion(`${ver.stdout}\n${ver.stderr}`) !== v) throw new HadesError(`${asset.bin} reports "${(ver.stdout || ver.stderr).trim().split(/\r?\n/)[0]}", expected ${v}`);
    if (name === 'trivy') fs.mkdirSync(trivyCacheDir(ctx), { recursive: true });
    writeInstall(ctx, name, pin, { version: v, kind: 'binary', entry: asset.bin, source: asset.base + asset.archive, sha256: expected });
    return { ok: true, via: 'local', version: v, detail: `release ${asset.archive} sha256 ${expected.slice(0, 16)}... verified` };
  } finally {
    safeRemove(ctx, tmp);
  }
}

// semgrep: pinned wheel into a private venv, dependencies constrained by the vendored cli/uv.lock.
function setupSemgrep(ctx, name, pin, opts) {
  const v = tagVersion(pin.tag);
  try {
    const uv = requireExe('uv', 'install uv: https://docs.astral.sh/uv/');
    const dir = freshDir(ctx, toolDir(ctx, name));
    const venv = `${dir}/venv`;
    const env = mergeEnv(process.env, { VIRTUAL_ENV: undefined });
    must(run(uv, ['venv', venv, '--python', '3.12'], { timeout: 10 * 60 * 1000, env }), 'uv venv');
    const python = IS_WIN ? `${venv}/Scripts/python.exe` : `${venv}/bin/python`;
    const install = ['pip', 'install', '--python', python, `semgrep==${v}`];
    let constrained = false;
    const lockDir = `${engineRoot(ctx)}/tools/semgrep/cli`;
    if (fs.existsSync(`${lockDir}/uv.lock`)) {
      const exp = run(uv, ['export', '--project', lockDir, '--frozen', '--no-dev', '--no-emit-project', '--no-hashes', '--format', 'requirements-txt'], { timeout: 120000, env });
      const lines = exp.code === 0 ? exp.stdout.split(/\r?\n/).filter((l) => /^[A-Za-z0-9._-]+==[^\s;]+(\s*;.*)?$/.test(l.trim())) : [];
      if (lines.length) {
        fs.writeFileSync(`${dir}/constraints.txt`, `${lines.join('\n')}\n`);
        install.push('--constraint', `${dir}/constraints.txt`);
        constrained = true;
      }
    }
    must(run(uv, install, { timeout: 30 * 60 * 1000, env }), `uv pip install semgrep==${v}`);
    const entry = venvBin(venv, 'semgrep');
    const ver = run(entry, ['--version'], { timeout: 120000, env: mergeEnv(process.env, RECIPES.semgrep.env()) });
    if (parseVersion(ver.stdout) !== v) throw new HadesError(`semgrep reports "${(ver.stdout || ver.stderr).trim().split(/\r?\n/)[0]}", expected ${v}`);
    writeInstall(ctx, name, pin, { version: v, kind: 'binary', entry: path.posix.relative(dir, entry), source: `PyPI semgrep==${v}${constrained ? ' constrained by tools/semgrep/cli/uv.lock' : ''}` });
    return { ok: true, via: 'local', version: v, detail: `PyPI wheel in private venv${constrained ? ', deps pinned by vendored uv.lock' : ''}` };
  } catch (err) {
    if (opts.noDocker || !dockerAvailable()) throw err;
    return setupDocker(ctx, name, pin, `wheel install failed: ${String(err.message).split('\n')[0]}`);
  }
}

function setupRea(ctx, name, pin, opts) {
  const v = tagVersion(pin.tag);
  const warn = nodeSatisfiesRea(process.versions.node) ? '' : `; warning: Node ${process.versions.node} is below rea's engines (^22.19.0 || ^24.11.0 || >=26)`;
  if (opts.fromSource) {
    if (IS_WIN) throw new HadesError('rea --from-source is not supported on Windows: the native addon ships only in the npm package');
    const dir = freshDir(ctx, toolDir(ctx, name));
    const src = `${dir}/src`;
    fs.cpSync(`${engineRoot(ctx)}/tools/rea`, src, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
    const env = mergeEnv(process.env, { HUSKY: '0', TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' });
    must(npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: src, env }), 'npm ci (rea)');
    must(npm(['run', 'compile'], { cwd: src, env }), 'npm run compile (rea)');
    writeInstall(ctx, name, pin, { version: v, kind: 'node', entry: 'src/scripts/rea.mjs', source: 'vendored source tools/rea (npm ci --ignore-scripts + compile)' });
    return { ok: true, via: 'local', version: v, detail: `built from tools/rea (hardened)${warn}` };
  }
  const { v: got, integrity } = npmInstallPinned(ctx, name, pin);
  writeInstall(ctx, name, pin, { version: got, kind: 'node', entry: RECIPES.rea.npmEntry, source: `npm rea-agents@${got} --ignore-scripts`, integrity });
  return { ok: true, via: 'local', version: got, detail: `npm rea-agents@${got} (--ignore-scripts), integrity ${integrity || 'n/a'}${warn}` };
}

function setupCcusage(ctx, name, pin) {
  const { dir, v, integrity } = npmInstallPinned(ctx, name, pin);
  const entry = `${dir}/${RECIPES.ccusage.npmEntry}`;
  const ver = run(process.execPath, [entry, '--version'], { timeout: 30000 });
  if (parseVersion(ver.stdout) !== v) throw new HadesError(`ccusage native binary missing or wrong version ("${(ver.stdout || ver.stderr).trim().split(/\r?\n/)[0]}")`);
  writeInstall(ctx, name, pin, { version: v, kind: 'node', entry: RECIPES.ccusage.npmEntry, source: `npm ccusage@${v} --ignore-scripts`, integrity });
  return { ok: true, via: 'local', version: v, detail: `npm ccusage@${v} (--ignore-scripts), integrity ${integrity || 'n/a'}` };
}

// Playwright MCP: the vendored package.json + package-lock.json (sha512-pinned playwright-core) are
// installed with npm ci; browsers go to .tools-bin/playwright-browsers.
function setupPlaywright(ctx, name, pin) {
  const v = tagVersion(pin.tag);
  const src = `${engineRoot(ctx)}/tools/playwright-mcp`;
  if (!fs.existsSync(`${src}/package-lock.json`)) throw new HadesError(`vendored source missing: ${src}`);
  const pkg = readJson(`${src}/package.json`);
  if (pkg.version !== v) throw new HadesError(`tools/playwright-mcp is ${pkg.version}, pin is ${v}`);
  const dir = freshDir(ctx, toolDir(ctx, name));
  for (const f of ['package.json', 'package-lock.json', 'cli.js', 'index.js', 'index.d.ts', 'config.d.ts', 'LICENSE']) {
    if (fs.existsSync(`${src}/${f}`)) fs.copyFileSync(`${src}/${f}`, `${dir}/${f}`);
  }
  must(npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir }), 'npm ci (playwright-mcp)');
  const browsers = browsersDir(engineRoot(ctx));
  fs.mkdirSync(browsers, { recursive: true });
  must(
    run(process.execPath, [`${dir}/cli.js`, 'install-browser', 'chromium'], { cwd: dir, timeout: 30 * 60 * 1000, env: mergeEnv(process.env, { PLAYWRIGHT_BROWSERS_PATH: browsers }) }),
    'playwright install chromium',
  );
  writeInstall(ctx, name, pin, { version: v, kind: 'node', entry: 'cli.js', source: 'vendored tools/playwright-mcp + package-lock.json (npm ci)' });
  return { ok: true, via: 'local', version: v, detail: `vendored lockfile (npm ci --omit=dev), chromium in .tools-bin/playwright-browsers` };
}

const SETUP = {
  rea: setupRea,
  serena: (ctx, name, pin) => {
    const res = uvSync(ctx, name, pin);
    ensureSerenaConfig(ctx);
    return res;
  },
  ccusage: setupCcusage,
  semgrep: setupSemgrep,
  gitleaks: setupRelease,
  trivy: setupRelease,
  'playwright-mcp': setupPlaywright,
  zaproxy: (ctx, name, pin) => setupDocker(ctx, name, pin, null),
  'mcp-proxy-for-aws': uvSync,
};

// Installs one tool into .tools-bin/<name>/. Returns { name, ok, via, version, detail, skipped? }.
export async function setupTool(ctx, name, opts = {}) {
  const key = canonicalName(name);
  const pin = pinOf(ctx, key);
  const r = RECIPES[key];
  if (!r || !r.runnable) return { name: key, ok: true, via: 'data', version: null, detail: 'nothing to install (read in place)', skipped: true };
  if (!opts.force) {
    const cur = resolveLocal(ctx, key, pin);
    if (cur && !cur.stale) return { name: key, ok: true, via: cur.via, version: cur.version, detail: 'already set up (use --force to reinstall)', skipped: true };
  }
  fs.mkdirSync(binRoot(ctx), { recursive: true });
  const res = await SETUP[key](ctx, key, pin, opts);
  return { name: key, ...res };
}

// ---------------------------------------------------------------- verify and bump

export function verifyTools(ctx) {
  const lock = lockfile(ctx);
  const root = engineRoot(ctx);
  return Object.entries(lock.tools || {}).map(([name, pin]) => {
    const dir = `${root}/tools/${name}`;
    if (!fs.existsSync(`${dir}/.git`)) return { name, expected: pin.commit, actual: null, ok: false, status: 'not initialized' };
    const res = run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const actual = res.code === 0 ? res.stdout.trim() : null;
    const ok = !!actual && actual === pin.commit;
    return { name, expected: pin.commit, actual, ok, status: ok ? 'ok' : actual ? 'mismatch' : 'unreadable' };
  });
}

export async function bumpTool(ctx, name, ref, { force = false, now = new Date() } = {}) {
  const key = canonicalName(name);
  const lock = lockfile(ctx);
  const pin = lock.tools && lock.tools[key];
  if (!pin) throw new HadesError(`unknown tool: ${name}`);
  const isSha = /^[0-9a-f]{40}$/i.test(String(ref));
  if (isSha && pin.tag) throw new HadesError(`${key} is pinned by tag; bump it to a tag, not a commit`);
  if (!isSha && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(String(ref))) throw new HadesError(`invalid tag: ${ref}`);
  const { owner, repo } = parseGithubRepo(pin.repo);
  const commit = await githubJson(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha || '')) throw new HadesError(`GitHub did not resolve ${ref}`);
  let released = commit.commit && commit.commit.committer && commit.commit.committer.date;
  if (!isSha) {
    try {
      const rel = await githubJson(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(ref)}`);
      if (rel && rel.published_at) released = rel.published_at;
    } catch (err) {
      if (err.httpStatus !== 404) throw err;
    }
  }
  const days = Number(lock.policy && lock.policy.cooldown_days) || 14;
  const age = cooldownCheck(released, days, now);
  if (!age.ok && !force) {
    throw new HadesError(`${key} ${ref} was released ${String(released).slice(0, 10)} (${age.days ?? '?'} days ago); the cooldown policy is ${days} days. Use --force to override.`, 2);
  }
  const dir = `${engineRoot(ctx)}/tools/${key}`;
  if (!fs.existsSync(`${dir}/.git`)) throw new HadesError(`submodule not initialized: tools/${key} (run: git submodule update --init tools/${key})`);
  // Fetch from upstream: origin is a fork, which may lag; GitHub serves the commit from the fork too.
  must(run('git', ['-C', dir, 'fetch', '--depth', '1', `${pin.repo}.git`, ...(isSha ? [commit.sha] : ['tag', ref, '--no-tags'])], { timeout: 10 * 60 * 1000 }), 'git fetch');
  must(run('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', isSha ? commit.sha : `refs/tags/${ref}`]), 'git checkout');
  const head = must(run('git', ['-C', dir, 'rev-parse', 'HEAD']), 'git rev-parse').stdout.trim();
  if (head !== commit.sha) throw new HadesError(`tools/${key} is at ${head.slice(0, 12)} but GitHub resolves ${ref} to ${commit.sha.slice(0, 12)}; lock not updated`);
  const from = pin.tag || pin.commit.slice(0, 12);
  pin.commit = head;
  if (!isSha) pin.tag = ref;
  pin.released = String(released).slice(0, 10);
  writeJson(lockPath(ctx), lock);
  return { name: key, from, to: isSha ? head.slice(0, 12) : ref, commit: head, released: pin.released, days: age.days, forced: !age.ok };
}
