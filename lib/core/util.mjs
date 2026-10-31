// Shared helpers for the HADES CLI. Keep this file dependency-free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export class HadesError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function fail(message, exitCode = 1) {
  throw new HadesError(message, exitCode);
}

export function print(line = '') {
  process.stdout.write(`${line}\n`);
}

// Prints JSON when --json is set, otherwise the human-readable text.
export function output(args, data, text) {
  if (args.flags.json) print(JSON.stringify(data, null, 2));
  else print(typeof text === 'function' ? text(data) : text);
}

// "--a b --c --d=e x y" -> { positional: ['x','y'], flags: { a:'b', c:true, d:'e' } }
// A flag followed by another flag or nothing is boolean; so is every flag named in `booleans`
// (camelCase), which never takes the next word as its value. Use "--" to pass the rest verbatim.
// `names` (not enumerable) maps each camelCase key to the flag as typed, for error messages.
export function parseArgs(argv, { booleans = [] } = {}) {
  const positional = [];
  const flags = {};
  const names = {};
  const bool = new Set(booleans);
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        const key = toCamel(a.slice(2, eq));
        names[key] = a.slice(2, eq);
        flags[key] = a.slice(eq + 1);
      } else {
        const key = toCamel(a.slice(2));
        names[key] = a.slice(2);
        const next = argv[i + 1];
        if (!bool.has(key) && next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  const out = { positional, flags, rest };
  Object.defineProperty(out, 'names', { value: names, enumerable: false });
  return out;
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// "dryRun" -> "dry-run" (messages use the spelling as typed when it is known).
export function flagName(args, key) {
  const typed = args && args.names && args.names[key];
  return typed || key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// The one flag check every command uses: refuses any flag outside `list` (camelCase keys; --help
// and --json are always allowed) with exit 1 "unknown flag --x". A typo such as --dryrun must
// never fall through to the real action.
export function allowFlags(args, list) {
  const ok = new Set(['help', 'json', ...(list || [])]);
  const bad = Object.keys(args.flags).filter((k) => !ok.has(k) && args.flags[k] !== undefined);
  if (bad.length) fail(`unknown flag ${bad.map((k) => `--${flagName(args, k)}`).join(', ')}`);
}

// Allowed flags of a command module for this invocation: its FLAGS is an array, or an object keyed
// by subcommand (an unknown or missing subcommand gets the union; the module then reports it).
export function commandFlags(mod, args) {
  const f = mod && mod.FLAGS;
  if (!f) return null;
  if (Array.isArray(f)) return f;
  const sub = args.positional[0];
  if (sub && Object.prototype.hasOwnProperty.call(f, sub)) return f[sub];
  return [...new Set(Object.values(f).flat())];
}

// Windows reports a file that another process is renaming or scanning as EPERM/EBUSY/EACCES for
// a few milliseconds; reads and renames retry on these codes.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.round(ms)));
}

function readFileRetry(file) {
  for (let i = 0; ; i++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (i >= 20 || !TRANSIENT.has(err.code)) throw err;
      sleepSync(5 * (i + 1));
    }
  }
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    fail(`missing file: ${file}`);
  }
  const raw = readFileRetry(file).replace(/^﻿/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`invalid JSON in ${file}: ${err.message}`);
  }
}

// Writes atomically (temp file + rename) so a crash never leaves half a file.
export function writeJson(file, data) {
  writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}

let tmpSeq = 0;

// The rename is retried on Windows sharing violations (another process reading or replacing the
// same file); the temp file is removed when the write finally fails.
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (i >= 40 || !TRANSIENT.has(err.code)) throw err;
        sleepSync(Math.min(10 * (i + 1), 100));
      }
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}

// ---- locking: parallel agents run CLI writes on the same task ----

// A lock is "<file>.lock", created exclusively. It is held only around one read-modify-write
// (milliseconds), so a lock older than LOCK_STALE_MS was left by a crashed process and is broken.
// Age is the only test: a short-lived CLI that released its lock and exited normally looks like a
// dead owner, so "owner process gone" would break live locks taken after it. Only the holder of
// "<lock>.break" may break a lock, which makes check-and-remove race-free.
// HADES_LOCK_STALE_MS / HADES_LOCK_WAIT_MS override the timings.
export const LOCK_STALE_MS = 15000;
export const LOCK_WAIT_MS = 30000;
const envMs = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

function lockAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function removeRetry(file) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(file, { force: true });
      return;
    } catch (err) {
      if (i >= 20 || !TRANSIENT.has(err.code)) throw err;
      sleepSync(5 * (i + 1));
    }
  }
}

function breakStaleLock(lock, staleMs) {
  if (lockAge(lock) < staleMs) return false;
  const breaker = `${lock}.break`;
  try {
    fs.writeFileSync(breaker, String(process.pid), { flag: 'wx' });
  } catch {
    // another process is breaking it; a breaker left by a crash is itself stale after staleMs
    if (lockAge(breaker) >= staleMs) {
      try {
        removeRetry(breaker);
      } catch {
        // retried on the next round
      }
    }
    return false;
  }
  try {
    // Under the breaker nobody else may remove the lock and its (crashed) owner cannot: re-check
    // the age of the file that is there now, then remove it.
    if (lockAge(lock) < staleMs) return false;
    removeRetry(lock);
    return true;
  } catch {
    return false;
  } finally {
    try {
      removeRetry(breaker);
    } catch {
      // stale after staleMs
    }
  }
}

// Runs fn() while holding "<file>.lock"; waits with backoff up to LOCK_WAIT_MS, then exits 1.
export function withLock(file, fn, { staleMs = envMs('HADES_LOCK_STALE_MS', LOCK_STALE_MS), waitMs = envMs('HADES_LOCK_WAIT_MS', LOCK_WAIT_MS) } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid} ${os.hostname()} ${Date.now()} ${crypto.randomBytes(6).toString('hex')}`;
  const start = Date.now();
  let delay = 4;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && !TRANSIENT.has(err.code)) throw err;
      if (err.code === 'EEXIST' && breakStaleLock(lock, staleMs)) continue;
      if (Date.now() - start > waitMs) {
        fail(`timed out after ${Math.round(waitMs / 1000)}s waiting for ${slash(lock)} (another hades command holds it; delete it if none is running)`);
      }
      sleepSync(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileRetry(lock) === token) removeRetry(lock);
    } catch {
      // already broken as stale by another process
    }
  }
}

// Locked read-modify-write of a JSON file: mutate(data) changes data in place (a throw leaves the
// file untouched) and its return value is returned. fallback = the value of a missing file (a
// function is called for a fresh value).
export function updateJson(file, fallback, mutate) {
  return withLock(file, () => {
    const data = readJson(file, typeof fallback === 'function' ? fallback() : fallback);
    const ret = mutate(data);
    writeJson(file, data);
    return ret;
  });
}

export function readText(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    fail(`missing file: ${file}`);
  }
  return readFileRetry(file).replace(/^﻿/, '');
}

// Forward slashes everywhere: Claude Code, git and Node all accept them on Windows.
export function slash(p) {
  return p.replace(/\\/g, '/');
}

export function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Replaces {{KEY}} placeholders. Unknown keys are left in place so they are easy to spot.
export function render(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Copies a template directory, rendering every text file. Existing files are kept unless overwrite.
export function copyTemplateDir(src, dest, vars, { overwrite = false } = {}) {
  const written = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, render(entry.name, vars));
    if (entry.isDirectory()) {
      written.push(...copyTemplateDir(from, to, vars, { overwrite }));
    } else if (overwrite || !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, render(fs.readFileSync(from, 'utf8'), vars), 'utf8');
      written.push(to);
    }
  }
  return written;
}

// Runs a command without a shell. Returns { code, stdout, stderr }.
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  return {
    code: res.status === null ? (res.error ? 127 : 1) : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || (res.error ? String(res.error.message) : ''),
  };
}

// Runs a command line through the platform shell (needed for project commands such as "mvn test").
export function runShell(line, opts = {}) {
  return run(line, [], { shell: true, ...opts });
}

// Async shell run with a timeout that kills the whole process tree (a plain timeout on Windows
// kills cmd.exe and leaves its children running). Resolves { code, stdout, stderr, timedOut, ms }.
export function runShellAsync(line, { cwd, env, timeoutMs = 0, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // stdin is ignored so a command that waits for input fails fast instead of hanging until the timeout.
    const child = spawn(line, [], {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf, chunk) => (buf.length < maxBuffer ? buf + chunk : buf);
    child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())));
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs) : null;
    const done = (code, errMessage) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr: errMessage ? `${stderr}${errMessage}` : stderr, timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => done(127, String(err.message)));
    child.on('close', (code) => done(code === null ? 1 : code));
  });
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

// On Windows, "where" also lists extensionless npm shims that cannot be spawned; prefer a PATHEXT match.
export function which(cmd) {
  if (!/^[\w.-]+$/.test(cmd)) return null;
  if (process.platform !== 'win32') {
    const probe = run('sh', ['-c', `command -v ${cmd}`]);
    return probe.code === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : null;
  }
  const probe = run('where', [cmd]);
  if (probe.code !== 0) return null;
  const hits = probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';');
  return hits.find((h) => exts.includes(path.extname(h).toLowerCase())) || null;
}

export function git(cwd, ...args) {
  return run('git', ['-C', cwd, ...args]);
}

// Keeps the first `head` and last `tail` lines of long output; used to keep LLM-facing output small.
export function clip(text, { head = 15, tail = 25 } = {}) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length <= head + tail + 1) return lines.join('\n');
  return [...lines.slice(0, head), `... [${lines.length - head - tail} lines omitted] ...`, ...lines.slice(-tail)].join('\n');
}

// Minimal YAML-frontmatter reader for markdown files (flat key: value pairs only).
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!m) return { data, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(m[0].length) };
}
