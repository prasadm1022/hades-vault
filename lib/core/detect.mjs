// Technology detection: fingerprints a directory tree with playbooks/stacks.json and derives
// non-interactive commands (install, build, lint, types, test, run, format). Deterministic and
// read-only: costs no model tokens. Used by "hades detect" and "hades team new".
// Learned fingerprints in <vault>/company/playbooks/stacks.json (same schema) are merged over the
// engine file by id (loadStacksFor).
//
// stacks.json is an array of stacks:
//   id, ecosystem (= playbooks/tech/<ecosystem>.md), priority (default 10; higher = more specific)
//   markers    [pattern | [pattern, ...]]  every entry must exist; an inner array means any of
//   content    [check]                     every check must pass
//   requires   [id]  one of these must match in the same directory; the stack joins its family
//   joins      [id]  joins that family when one of these matched, else forms its own
//   aux        true  its commands only fill fields that no primary family filled;
//              "solo" = only used when the directory has no primary family at all
//   standalone false never forms a project on its own in a subdirectory
//   fallback   true  only when no primary stack matched; in subdirectories only outside projects
//   workspace  {when, covers?}  descendants whose family ecosystem is covered fold into this project
//   variants   [{pm, when?, inherit?, vars, commands, note}]  first match wins; inherit = also
//              checked in ancestor directories up to the scan root; no "when" = default
//   commands   {key: cmd | [cmd | {when, cmd}]}  first candidate whose check passes and whose
//              placeholders resolve wins. Candidates gated on a project-declared task (script,
//              denoTask, composerScript, makeTarget) beat derived ones across the whole family.
//   note       added to the project's notes
// A family is a base stack plus the stacks that require/join it. Within a family the highest
// priority wins; across primary families the commands are joined with " && " (run: first only).
// Patterns: forward-slash paths relative to the directory; * ? {a,b} inside a segment; a
// trailing "/" requires a directory.
// Check: an object whose keys must all pass: exists (+count), file + has|regex (+flags),
//   json + key (+regex), script, denoTask, composerScript, makeTarget, dep, composerDep, pydep,
//   gem, stack, platform, not, any, all. It sets {match} (first matched path) and {script}.
// Placeholders: {python} (python on win32, else python3), {name} (directory name), {match},
//   {script} and variant vars such as {run} {npx} {argsep} {py} {pyx} {mvn} {gradle}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, slash, fail } from './util.mjs';

export const STACKS_FILE = slash(fileURLToPath(new URL('../../playbooks/stacks.json', import.meta.url)));
export const COMMAND_KEYS = ['install', 'build', 'lint', 'types', 'test', 'run', 'format'];
export const ECOSYSTEMS = [
  'javascript-typescript', 'python', 'jvm', 'go', 'rust', 'dotnet', 'php', 'ruby', 'mobile',
  'cpp-c', 'data-ml', 'infra', 'web-static', 'databases', 'elixir-erlang',
];
// Never scanned as projects nor matched by wildcards; every dot-directory is skipped as well.
export const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '__pycache__', 'coverage',
  'out', 'bin', 'obj', 'Pods', 'cdk.out', 'site-packages',
]);

const MAX_READ = 1024 * 1024;
const DECLARED = ['script', 'denoTask', 'composerScript', 'makeTarget'];
const CHECK_KEYS = new Set([
  'exists', 'count', 'file', 'has', 'regex', 'flags', 'json', 'key', 'script', 'denoTask',
  'composerScript', 'makeTarget', 'dep', 'composerDep', 'pydep', 'gem', 'stack', 'platform',
  'not', 'any', 'all',
]);
const PY_DEP_FILES = ['pyproject.toml', 'requirements*.txt', 'requirements/*.txt', 'Pipfile', 'setup.py', 'setup.cfg', 'environment.y{a,}ml'];
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];

export const skipDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name);
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const prio = (s) => (Number.isFinite(s.priority) ? s.priority : 10);
const uniq = (arr) => [...new Set(arr)];
const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

let stacksCache = null;
export function loadStacks(file = STACKS_FILE) {
  if (stacksCache && stacksCache.file === file) return stacksCache.stacks;
  const stacks = readJson(file);
  if (!Array.isArray(stacks)) fail(`${file}: expected an array of stacks`);
  stacksCache = { file, stacks };
  return stacks;
}

// Learned fingerprints in the vault (same schema as the engine file).
export function vaultStacksFile(vault) {
  return `${slash(path.resolve(vault))}/company/playbooks/stacks.json`;
}

// Vault entries replace engine entries with the same id (in place); new ids are appended.
export function mergeStacks(base, extra) {
  const out = [...base];
  for (const s of extra) {
    const i = s && s.id ? out.findIndex((b) => b && b.id === s.id) : -1;
    if (i >= 0) out[i] = s;
    else out.push(s);
  }
  return out;
}

// Engine stacks with <vault>/company/playbooks/stacks.json merged over them when that file exists.
// An unreadable or invalid vault file is ignored with a warning, so detection keeps working.
// -> {stacks, files, warnings}
export function loadStacksFor(ctx) {
  const base = loadStacks();
  const file = ctx && ctx.vault ? vaultStacksFile(ctx.vault) : null;
  const engineOnly = (warning) => ({ stacks: base, files: [STACKS_FILE], warnings: warning ? [`${file} ignored: ${warning}`] : [] });
  if (!file || !fs.existsSync(file)) return engineOnly();
  let extra;
  try {
    extra = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return engineOnly(`invalid JSON (${err.message})`);
  }
  if (!Array.isArray(extra)) return engineOnly('expected an array of stacks');
  const merged = mergeStacks(base, extra);
  const problems = validateStacks(merged);
  if (problems.length) return engineOnly(`${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; +${problems.length - 3} more` : ''}`);
  return { stacks: merged, files: [STACKS_FILE, file], warnings: [] };
}

// ---------- file system (cached per detection run) ----------

function makeFs() {
  const dirs = new Map();
  const texts = new Map();
  const jsons = new Map();
  const globs = new Map();
  const fsx = {
    list(abs) {
      if (!dirs.has(abs)) {
        let entries = [];
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch {
          entries = [];
        }
        dirs.set(abs, entries);
      }
      return dirs.get(abs);
    },
    text(abs) {
      if (!texts.has(abs)) {
        let t = '';
        try {
          const st = fs.statSync(abs);
          if (st.isFile() && st.size <= MAX_READ) t = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
        } catch {
          t = '';
        }
        texts.set(abs, t);
      }
      return texts.get(abs);
    },
    json(abs) {
      if (!jsons.has(abs)) jsons.set(abs, parseJsonLoose(fsx.text(abs)));
      return jsons.get(abs);
    },
    glob(base, pattern) {
      const k = `${base}\0${pattern}`;
      if (!globs.has(k)) globs.set(k, glob(fsx, base, pattern));
      return globs.get(k);
    },
  };
  return fsx;
}

// JSON with comments and trailing commas (tsconfig.json, deno.jsonc). Returns null when invalid.
export function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonc(text));
    } catch {
      return null;
    }
  }
}

function stripJsonc(text) {
  let out = '';
  for (let i = 0, inStr = false; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  let res = '';
  for (let i = 0, inStr = false; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      res += c;
      if (c === '\\') res += out[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    res += c;
  }
  return res;
}

export function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

const segCache = new Map();
function segRegex(seg) {
  if (!segCache.has(seg)) {
    const src = seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    segCache.set(seg, new RegExp(`^${src}$`));
  }
  return segCache.get(seg);
}

// Paths (relative to base) matching the pattern, in pattern order then name order.
function glob(fsx, base, pattern) {
  const out = [];
  for (const p of expandBraces(pattern)) {
    const wantDir = p.endsWith('/');
    const segs = p.split('/').filter(Boolean);
    let cur = [''];
    for (let i = 0; i < segs.length && cur.length; i++) {
      const seg = segs[i];
      const last = i === segs.length - 1;
      const wild = /[*?]/.test(seg);
      const next = [];
      for (const rel of cur) {
        for (const e of fsx.list(rel ? join(base, rel) : base)) {
          if (wild ? !segRegex(seg).test(e.name) || (e.dir && skipDir(e.name)) : e.name !== seg) continue;
          if ((!last || wantDir) && !e.dir) continue;
          next.push(rel ? `${rel}/${e.name}` : e.name);
        }
      }
      cur = next;
    }
    for (const m of cur) if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// ---------- checks ----------

const reCache = new Map();
function cachedRegex(src, flags) {
  const k = `${flags}\0${src}`;
  if (!reCache.has(k)) reCache.set(k, new RegExp(src, flags));
  return reCache.get(k);
}

const pyDepRegex = (name) =>
  cachedRegex(`(^|[^A-Za-z0-9_.-])${name.replace(/[-_.]/g, '[-_.]')}(?=$|[^A-Za-z0-9_.-])`, 'im');
const gemRegex = (name) => cachedRegex(`^\\s*gem\\s+["']${name.replace(/[.+^$()|[\]\\*?{}]/g, '\\$&')}["']`, 'm');

export function makeTargets(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_][^:=#\s]*(?:[ \t]+[A-Za-z0-9_][^:=#\s]*)*)[ \t]*::?(?![:=])/.exec(line);
    if (m) for (const t of m[1].split(/[ \t]+/)) out.add(t);
  }
  return out;
}

function getPath(obj, key) {
  let cur = obj;
  for (const part of String(key).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const keysOf = (...objs) => new Set(objs.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])));

function makeEnv(ctx, dir, matched) {
  const memo = new Map();
  const once = (k, fn) => {
    if (!memo.has(k)) memo.set(k, fn());
    return memo.get(k);
  };
  const json = (rel) => ctx.fsx.json(join(dir, rel));
  const env = {
    ctx,
    dir,
    matched,
    glob: (pattern) => ctx.fsx.glob(dir, pattern),
    text: (rel) => ctx.fsx.text(join(dir, rel)),
    json,
    scripts: () => once('scripts', () => scriptMap(json('package.json')?.scripts)),
    npmDeps: () => once('npmDeps', () => {
      const p = json('package.json') || {};
      return keysOf(p.dependencies, p.devDependencies, p.peerDependencies, p.optionalDependencies);
    }),
    denoTasks: () => once('deno', () => scriptMap((json('deno.json') || json('deno.jsonc'))?.tasks)),
    composerScripts: () => once('composerScripts', () => scriptMap(json('composer.json')?.scripts)),
    composerDeps: () => once('composerDeps', () => {
      const c = json('composer.json') || {};
      return keysOf(c.require, c['require-dev']);
    }),
    makeTargets: () => once('make', () => {
      const f = MAKEFILES.find((m) => env.glob(m).length);
      return f ? makeTargets(env.text(f)) : new Set();
    }),
    pyText: () => once('py', () => uniq(PY_DEP_FILES.flatMap((p) => env.glob(p))).map((f) => env.text(f)).join('\n')),
  };
  return env;
}

function scriptMap(obj) {
  const out = new Map();
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      // The placeholder "npm init" writes is not a test suite.
      if (k === 'test' && typeof v === 'string' && /no test specified/i.test(v)) continue;
      out.set(k, v);
    }
  }
  return out;
}

const NO = Object.freeze({ ok: false, vars: {} });

export function evalCheck(check, env) {
  if (!check || typeof check !== 'object') return NO;
  const vars = {};
  const setMatch = (m) => {
    if (m !== undefined && vars.match === undefined) vars.match = /\s/.test(m) ? `"${m}"` : m;
  };
  const task = (names, available) => {
    const hit = list(names).find((n) => available.has(n));
    if (hit !== undefined && vars.script === undefined) vars.script = hit;
    return hit !== undefined;
  };
  if (check.exists !== undefined) {
    const found = uniq(list(check.exists).flatMap((p) => env.glob(p)));
    if (check.count !== undefined ? found.length !== check.count : !found.length) return NO;
    setMatch(found[0]);
  }
  if (check.file !== undefined) {
    const files = uniq(list(check.file).flatMap((p) => env.glob(p)));
    const re = check.regex !== undefined ? cachedRegex(check.regex, check.flags ?? 'm') : null;
    const hit = files.find((f) => {
      const t = env.text(f);
      return re ? re.test(t) : t.includes(check.has);
    });
    if (hit === undefined) return NO;
    setMatch(hit);
  }
  if (check.json !== undefined) {
    const re = check.regex !== undefined ? cachedRegex(check.regex, check.flags ?? '') : null;
    const files = uniq(list(check.json).flatMap((p) => env.glob(p)));
    const hit = files.find((f) => {
      const v = getPath(env.json(f), check.key);
      if (v === undefined || v === null) return false;
      return re ? re.test(typeof v === 'string' ? v : JSON.stringify(v)) : true;
    });
    if (hit === undefined) return NO;
    setMatch(hit);
  }
  if (check.script !== undefined && !task(check.script, env.scripts())) return NO;
  if (check.denoTask !== undefined && !task(check.denoTask, env.denoTasks())) return NO;
  if (check.composerScript !== undefined && !task(check.composerScript, env.composerScripts())) return NO;
  if (check.makeTarget !== undefined && !task(check.makeTarget, env.makeTargets())) return NO;
  if (check.dep !== undefined && !list(check.dep).some((d) => env.npmDeps().has(d))) return NO;
  if (check.composerDep !== undefined && !list(check.composerDep).some((d) => env.composerDeps().has(d))) return NO;
  if (check.pydep !== undefined) {
    const text = env.pyText();
    if (!list(check.pydep).some((d) => pyDepRegex(d).test(text))) return NO;
  }
  if (check.gem !== undefined) {
    const text = env.text('Gemfile');
    if (!list(check.gem).some((g) => gemRegex(g).test(text))) return NO;
  }
  if (check.stack !== undefined && !list(check.stack).some((id) => env.matched.has(id))) return NO;
  if (check.platform !== undefined && !list(check.platform).includes(env.ctx.platform)) return NO;
  if (check.not !== undefined && evalCheck(check.not, env).ok) return NO;
  if (check.any !== undefined) {
    const r = list(check.any).map((c) => evalCheck(c, env)).find((x) => x.ok);
    if (!r) return NO;
    Object.entries(r.vars).forEach(([k, v]) => { if (vars[k] === undefined) vars[k] = v; });
  }
  if (check.all !== undefined) {
    for (const c of list(check.all)) {
      const r = evalCheck(c, env);
      if (!r.ok) return NO;
      Object.entries(r.vars).forEach(([k, v]) => { if (vars[k] === undefined) vars[k] = v; });
    }
  }
  return { ok: true, vars };
}

const isDeclared = (when) => !!when && DECLARED.some((k) => when[k] !== undefined);

function matchStack(s, env) {
  for (const m of s.markers || []) if (!list(m).some((p) => env.glob(p).length)) return false;
  for (const c of s.content || []) if (!evalCheck(c, env).ok) return false;
  return true;
}

// ---------- one directory ----------

function detectDir(ctx, dir, { allowFallback }) {
  const matched = new Map();
  const env = makeEnv(ctx, dir, matched);
  const primary = ctx.stacks.filter((s) => !s.fallback);
  for (let pass = 0, changed = true; changed && pass < 4; pass++) {
    changed = false;
    for (const s of primary) {
      if (matched.has(s.id)) continue;
      if (s.requires && !s.requires.some((r) => matched.has(r))) continue;
      if (matchStack(s, env)) {
        matched.set(s.id, s);
        changed = true;
      }
    }
  }
  if (allowFallback && ![...matched.values()].some((s) => !s.aux)) {
    for (const s of ctx.stacks) {
      if (s.fallback && (!s.requires || s.requires.some((r) => matched.has(r))) && matchStack(s, env)) matched.set(s.id, s);
    }
  }
  return { dir, env, matched, stacks: ctx.stacks.filter((s) => matched.has(s.id)) };
}

function familyRoot(s, matched, seen = new Set()) {
  if (seen.has(s.id)) return s;
  seen.add(s.id);
  for (const r of [...(s.requires || []), ...(s.joins || [])]) {
    if (matched.has(r)) return familyRoot(matched.get(r), matched, seen);
  }
  return s;
}

function pickVariant(ctx, s, found) {
  const at = (env, inheritOnly) =>
    s.variants.find((v) => v.when && (!inheritOnly || v.inherit) && evalCheck(v.when, env).ok);
  let v = at(found.env, false);
  for (let d = found.dir; !v && d !== ctx.root; ) {
    const up = slash(path.dirname(d));
    if (up === d) break;
    d = up;
    v = at(makeEnv(ctx, d, found.matched), true);
  }
  return v || s.variants.find((x) => !x.when) || null;
}

function fill(template, vars, depth = 0) {
  let missing = false;
  const out = String(template).replace(/\{([A-Za-z]+)\}/g, (m, k) => {
    if (vars[k] === undefined || vars[k] === null) {
      missing = true;
      return m;
    }
    const v = String(vars[k]);
    if (depth >= 3 || !v.includes('{')) return v;
    const inner = fill(v, vars, depth + 1);
    if (inner === null) missing = true;
    return inner ?? m;
  });
  return missing ? null : out.trim();
}

function resolveKey(fam, key, env, variants, vars) {
  const lists = fam.stacks.map((s) => [...list(variants.get(s.id)?.commands?.[key]), ...list(s.commands?.[key])]);
  for (const declared of [true, false]) {
    for (const cands of lists) {
      for (const raw of cands) {
        const c = typeof raw === 'string' ? { cmd: raw } : raw;
        if (isDeclared(c.when) !== declared) continue;
        let local = {};
        if (c.when) {
          const r = evalCheck(c.when, env);
          if (!r.ok) continue;
          local = r.vars;
        }
        const out = fill(c.cmd, { ...vars, ...local });
        if (out !== null) return out;
      }
    }
  }
  return '';
}

const dockerName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'app';

function buildProject(ctx, found, rel) {
  const { env, matched, stacks } = found;
  const variants = new Map();
  for (const s of stacks) {
    if (!Array.isArray(s.variants)) continue;
    const v = pickVariant(ctx, s, found);
    if (v) variants.set(s.id, v);
  }
  const vars = {
    python: ctx.platform === 'win32' ? 'python' : 'python3',
    name: dockerName(path.basename(rel ? join(ctx.root, rel) : ctx.root)),
  };
  for (const v of variants.values()) {
    for (const [k, val] of Object.entries(v.vars || {})) if (!(k in vars)) vars[k] = val;
  }
  const fams = [];
  for (const s of stacks) {
    const root = familyRoot(s, matched);
    let f = fams.find((x) => x.root === root);
    if (!f) fams.push((f = { root, stacks: [], priority: -Infinity }));
    f.stacks.push(s);
    f.priority = Math.max(f.priority, prio(s));
  }
  for (const f of fams) f.stacks.sort((a, b) => prio(b) - prio(a));
  fams.sort((a, b) => b.priority - a.priority);
  const primaries = fams.filter((f) => !f.root.aux);
  const auxes = fams.filter((f) => f.root.aux && (f.root.aux !== 'solo' || !primaries.length));
  const commands = {};
  for (const key of COMMAND_KEYS) {
    const per = primaries.map((f) => resolveKey(f, key, env, variants, vars)).filter(Boolean);
    let value = key === 'run' ? per[0] || '' : uniq(per).join(' && ');
    for (const f of auxes) {
      if (value) break;
      value = resolveKey(f, key, env, variants, vars);
    }
    commands[key] = value || '';
  }
  const notes = [];
  for (const s of stacks) if (s.note) notes.push(s.note);
  const pms = [];
  for (const s of fams.flatMap((f) => f.stacks)) {
    const v = variants.get(s.id);
    if (v && v.note) notes.push(v.note);
    if (v && v.pm) pms.push([s.id, v.pm]);
  }
  for (const [id, pm] of pms.slice(1)) notes.push(`${id}: ${pm}`);
  return {
    path: rel || '.',
    stacks: stacks.map((s) => s.id),
    ecosystems: uniq(stacks.map((s) => s.ecosystem)),
    commands,
    packageManager: pms.length ? pms[0][1] : null,
    notes: uniq(notes),
  };
}

// ---------- the tree ----------

// detectProject(dir, {maxDepth = 2, platform = process.platform, stacks})
//   -> {root, projects: [{path, stacks, ecosystems, commands, packageManager, notes}]}
// The root and every subdirectory up to maxDepth are fingerprinted. A subdirectory with its own
// manifest is its own project unless a workspace above it (npm/pnpm workspaces, Cargo/Gradle/
// Maven/Go/.NET/uv/mix workspaces, Flutter/React Native platform folders) already covers it.
export function detectProject(dir, opts = {}) {
  const root = slash(path.resolve(dir));
  let st = null;
  try {
    st = fs.statSync(root);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) fail(`not a directory: ${dir}`);
  const ctx = {
    root,
    platform: opts.platform || process.platform,
    stacks: opts.stacks || loadStacks(),
    fsx: makeFs(),
  };
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 2;
  const projects = [];
  const extra = new Map(); // project -> {covered: [], sub: []}

  const walk = (abs, rel, depth, owner, covers) => {
    const found = detectDir(ctx, abs, { allowFallback: !owner });
    let project = null;
    let nextCovers = covers;
    if (found.stacks.length) {
      const fams = uniq(found.stacks.map((s) => familyRoot(s, found.matched)).filter((r) => !r.aux));
      const cover = depth > 0 && fams.length ? covers.find((c) => fams.every((r) => c.ecos.has(r.ecosystem))) : null;
      if (cover) {
        extra.get(cover.project).covered.push(rel);
      } else if (depth === 0 || found.stacks.some((s) => s.standalone !== false)) {
        project = buildProject(ctx, found, rel);
        projects.push(project);
        extra.set(project, { covered: [], sub: [] });
        const ws = found.stacks.filter((s) => s.workspace && evalCheck(s.workspace.when, found.env).ok);
        if (ws.length) {
          const ecos = new Set(ws.flatMap((s) => s.workspace.covers || [familyRoot(s, found.matched).ecosystem]));
          nextCovers = [...covers, { ecos, project }];
        }
      } else if (owner) {
        extra.get(owner).sub.push(`${rel}/ (${found.stacks.map((s) => s.id).join(', ')})`);
      }
    }
    if (depth >= maxDepth) return;
    for (const e of ctx.fsx.list(abs)) {
      if (e.dir && !skipDir(e.name)) walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1, project || owner, nextCovers);
    }
  };
  walk(root, '', 0, null, []);

  const short = (arr) => (arr.length > 6 ? `${arr.slice(0, 6).join(', ')} +${arr.length - 6} more` : arr.join(', '));
  for (const p of projects) {
    const { covered, sub } = extra.get(p);
    const base = p.path === '.' ? '' : `${p.path}/`;
    const relTo = (r) => (base && r.startsWith(base) ? r.slice(base.length) : r);
    if (covered.length) p.notes.push(`workspace members: ${short(covered.map(relTo))}`);
    if (sub.length) p.notes.push(`also: ${short(sub.map(relTo))}`);
  }
  return { root, projects };
}

// ---------- team.json merge ----------

export function normRel(p) {
  const s = path.posix.normalize(slash(String(p ?? '.')) || '.').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

const isPlaceholder = (e) =>
  (!Array.isArray(e.stack) || !e.stack.length) &&
  !Object.values(e.commands && typeof e.commands === 'object' ? e.commands : {}).some(Boolean);

// Merges detected projects into a team.json document (returns a new one). Fills empty command
// fields only, unless overwrite. Adds missing projects. Drops scaffold placeholders (no stack, no
// commands) that detection did not confirm. Never touches anything but "projects".
export function mergeTeamProjects(teamDoc, detected, { overwrite = false } = {}) {
  const doc = structuredClone(teamDoc && typeof teamDoc === 'object' ? teamDoc : {});
  const before = JSON.stringify(doc);
  if (!Array.isArray(doc.projects)) doc.projects = [];
  const added = [];
  const removed = [];
  let filled = 0;
  let replaced = 0;
  const seen = new Set();
  for (const p of detected) {
    const key = normRel(p.path);
    seen.add(key);
    const entry = doc.projects.find((e) => e && normRel(e.path) === key);
    if (!entry) {
      doc.projects.push({
        path: key,
        stack: [...p.stacks],
        commands: Object.fromEntries(COMMAND_KEYS.map((k) => [k, p.commands[k] || ''])),
      });
      added.push(key);
      filled += COMMAND_KEYS.filter((k) => p.commands[k]).length;
      continue;
    }
    const stack = Array.isArray(entry.stack) ? entry.stack : [];
    entry.stack = overwrite && p.stacks.length ? [...p.stacks] : [...stack, ...p.stacks.filter((s) => !stack.includes(s))];
    if (!entry.commands || typeof entry.commands !== 'object') entry.commands = {};
    for (const k of COMMAND_KEYS) {
      const cur = entry.commands[k];
      const det = p.commands[k] || '';
      if (!cur) {
        entry.commands[k] = det;
        if (det) filled++;
      } else if (overwrite && det && cur !== det) {
        entry.commands[k] = det;
        replaced++;
      }
    }
  }
  if (detected.length) {
    doc.projects = doc.projects.filter((e) => {
      const drop = e && !seen.has(normRel(e.path)) && isPlaceholder(e);
      if (drop) removed.push(normRel(e.path));
      return !drop;
    });
  }
  return { team: doc, added, removed, filled, replaced, changed: JSON.stringify(doc) !== before };
}

// ---------- validation (used by tests and doctor) ----------

export function validateStacks(stacks) {
  const errors = [];
  if (!Array.isArray(stacks)) return ['stacks.json must be an array'];
  const ids = new Set();
  for (const s of stacks) if (s && s.id) ids.add(s.id);
  const seen = new Set();
  const checkCheck = (c, where) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return errors.push(`${where}: check must be an object`);
    const keys = Object.keys(c);
    if (!keys.length) errors.push(`${where}: empty check`);
    for (const k of keys) if (!CHECK_KEYS.has(k)) errors.push(`${where}: unknown check key "${k}"`);
    if ((c.has !== undefined || c.regex !== undefined) && c.file === undefined && c.json === undefined) errors.push(`${where}: has/regex need file or json`);
    if (c.file !== undefined && c.json !== undefined) errors.push(`${where}: file and json in one check`);
    if (c.file !== undefined && c.has === undefined && c.regex === undefined) errors.push(`${where}: file needs has or regex`);
    if (c.json !== undefined && c.key === undefined) errors.push(`${where}: json needs key`);
    if (c.count !== undefined && c.exists === undefined) errors.push(`${where}: count needs exists`);
    if (c.regex !== undefined) {
      try {
        new RegExp(c.regex, c.flags ?? 'm');
      } catch (err) {
        errors.push(`${where}: bad regex: ${err.message}`);
      }
    }
    for (const id of list(c.stack)) if (!ids.has(id)) errors.push(`${where}: unknown stack "${id}"`);
    if (c.not !== undefined) checkCheck(c.not, `${where}.not`);
    for (const x of list(c.any)) checkCheck(x, `${where}.any`);
    for (const x of list(c.all)) checkCheck(x, `${where}.all`);
    return undefined;
  };
  const checkCommands = (cmds, where) => {
    if (cmds === undefined) return;
    if (!cmds || typeof cmds !== 'object') return errors.push(`${where}: commands must be an object`);
    for (const [k, v] of Object.entries(cmds)) {
      if (!COMMAND_KEYS.includes(k)) errors.push(`${where}: unknown command "${k}"`);
      for (const c of list(v)) {
        if (typeof c === 'string') continue;
        if (!c || typeof c.cmd !== 'string') errors.push(`${where}.${k}: candidate needs cmd`);
        else if (c.when !== undefined) checkCheck(c.when, `${where}.${k}.when`);
      }
    }
    return undefined;
  };
  for (const s of stacks) {
    const where = s && s.id ? s.id : '?';
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) errors.push(`${where}: id must be kebab-case`);
    if (seen.has(s.id)) errors.push(`${where}: duplicate id`);
    seen.add(s.id);
    if (!ECOSYSTEMS.includes(s.ecosystem)) errors.push(`${where}: unknown ecosystem "${s.ecosystem}"`);
    if (s.aux !== undefined && s.aux !== true && s.aux !== 'solo') errors.push(`${where}: aux must be true or "solo"`);
    if (!(s.markers && s.markers.length) && !(s.content && s.content.length)) errors.push(`${where}: needs markers or content`);
    for (const m of s.markers || []) for (const p of list(m)) if (typeof p !== 'string' || !p) errors.push(`${where}: bad marker`);
    (s.content || []).forEach((c, i) => checkCheck(c, `${where}.content[${i}]`));
    for (const r of [...(s.requires || []), ...(s.joins || [])]) if (!ids.has(r)) errors.push(`${where}: unknown stack "${r}"`);
    if (s.workspace) {
      checkCheck(s.workspace.when, `${where}.workspace`);
      for (const e of list(s.workspace.covers)) if (!ECOSYSTEMS.includes(e)) errors.push(`${where}.workspace: unknown ecosystem "${e}"`);
    }
    checkCommands(s.commands, where);
    for (const [i, v] of (s.variants || []).entries()) {
      if (typeof v.pm !== 'string') errors.push(`${where}.variants[${i}]: needs pm`);
      if (v.when !== undefined) checkCheck(v.when, `${where}.variants[${i}]`);
      checkCommands(v.commands, `${where}.variants[${i}]`);
    }
    if (s.variants && !s.variants.some((v) => !v.when)) errors.push(`${where}: variants need a default (no "when")`);
  }
  return errors;
}
