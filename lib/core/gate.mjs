// Evidence engine behind "hades gate": runs project commands and scanners, writes full output to
// log files, and reduces it to a few lines (status, test counts, finding counts, first-failure
// excerpt) so an agent never has to read a 5,000-line build log.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runShellAsync, git, slash, kebab, updateJson, HadesError } from './util.mjs';
import { trivyCacheDir } from './tools.mjs';
import { checkShell } from '../../hooks/guard.mjs';

export { trivyCacheDir };
export const CMD_STEPS = ['build', 'lint', 'types', 'test'];
// Non-interactive, telemetry-free, colourless runs of project commands.
export const GATE_ENV = {
  CI: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
  NG_CLI_ANALYTICS: 'false',
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  FORCE_COLOR: '0',
  NO_COLOR: '1',
};
// The shell runShellAsync uses for team.json command lines.
export const COMMAND_SHELL = process.platform === 'win32' ? 'cmd' : 'bash';
export const SCAN_STEPS = ['secrets', 'sast', 'deps'];
export const STEPS = [...CMD_STEPS, ...SCAN_STEPS];
export const PRESETS = {
  build: ['build', 'lint', 'types', 'test'],
  precommit: ['build', 'test', 'secrets'],
  predeploy: ['build', 'test', 'secrets', 'sast', 'deps'],
  security: ['secrets', 'sast', 'deps'],
  full: [...STEPS],
};
export const DAST_MODES = ['baseline', 'full', 'api'];
export const SCANNER_TOOL = { secrets: 'gitleaks', sast: 'semgrep', deps: 'trivy', dast: 'zaproxy' };
export const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
export const EXCERPT_LINES = 25;
const MIN = 60 * 1000;
export const DEFAULT_TIMEOUT_MS = { build: 30 * MIN, lint: 30 * MIN, types: 30 * MIN, test: 45 * MIN, secrets: 30 * MIN, sast: 30 * MIN, deps: 30 * MIN, dast: 90 * MIN };
const MAX_LINE = 200;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Tool resolution: lib/core/tools.mjs resolveTool(ctx, name, {cwd, mounts, workdir, containerName}).
// setToolsApi swaps it (tests); fallbackTools is a minimal resolver that honours only the
// HADES_TOOL_<NAME> override.
// ---------------------------------------------------------------------------------------------
let toolsApi = null;
export async function tools() {
  if (!toolsApi) toolsApi = await import('./tools.mjs');
  return toolsApi;
}

// Test hook: replace the tool resolver (null restores the default).
export function setToolsApi(api) {
  toolsApi = api;
}

export const fallbackTools = {
  resolveTool(ctx, name) {
    const file = process.env[`HADES_TOOL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`];
    if (file) {
      return /\.(mjs|cjs|js)$/i.test(file)
        ? { cmd: process.execPath, args: [file], via: 'env', version: null }
        : { cmd: file, args: [], via: 'env', version: null };
    }
    throw new HadesError(`${name} is not installed - run: hades tools setup ${name}`);
  },
};

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------
export function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// ANSI stripped, progress-bar carriage returns collapsed, trailing blanks trimmed.
export function cleanLines(text) {
  return stripAnsi(text)
    .split('\n')
    .map((l) => {
      const parts = l.replace(/\r+$/, '').split('\r');
      return (parts.reverse().find((p) => p.trim()) || '').replace(/\s+$/, '');
    });
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]'],
  [/(\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1[REDACTED]@'],
];

// Best-effort masking of credential-looking values in anything the gate prints.
export function redact(line) {
  let out = String(line);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function cut(line, max = MAX_LINE) {
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

// ---------------------------------------------------------------------------------------------
// Failure excerpt
// ---------------------------------------------------------------------------------------------
// Strong: lines that almost always point at the failure itself, in any ecosystem.
const STRONG = [
  /\bFAIL(?:ED|URE|URES)?\b/, // jest/vitest FAIL, pytest/cargo FAILED, maven BUILD FAILURE, go --- FAIL, phpunit FAILURES!
  /Tests run:.*(?:Failures|Errors): [1-9]/, // junit / surefire
  /\bnpm (?:ERR!|error\b)/,
  /\berror [A-Z]{1,4}\d{2,}\b/, // error TS2322, error CS0103, error C2065
  /\berror\[E\d+\]/, // rustc
  /:\d+(?::\d+)?:?\s*(?:fatal )?error:/, // gcc/clang/go vet "file:line:col: error:"
  /^\s*\d+:\d+\s+error\s/, // eslint stylish
  /Traceback \(most recent call last\)/,
  /^\s*panic:|\bpanicked at\b|^fatal error:/,
  /\bAssertion(?:Error|FailedError| failed)\b|\bassertion\b.*\bfailed\b/i,
  /^\s*(?:[-+]\s)?(?:expected|received|actual|got)(?: value)?:\s/i, // jest, dotnet, rspec
  /\bexpected:? <.*> but was:? <.*>/, // junit 4/5
  /^\s*(?:left|right):\s/, // rust assert_eq
  /^\s*E\s{2,}\S/, // pytest error lines
  /^>\s{2,}\S/, // pytest failing line pointer
  /^\s*>\s*\d+\s*\|/, // jest/vitest code frame pointer
  /^\s+\w+_test\.go:\d+:/, // go t.Errorf output
  /[✗✕×✘✖●]/, // ✗ ✕ × ✘ ✖ ●
  /^\s*not ok\b/, // TAP / node:test
  /Failure\/Error:|^rspec \.\/\S+:\d+/, // rspec
  /Failed asserting|There (?:was|were) \d+ (?:failure|error)s?:/, // phpunit
  /^\s*\d+ failing\b/, // mocha
  /^\s*Failed\s+\S+\s+\[[\d.]+\s*m?s\]/, // dotnet test
  /^\* What went wrong:/, // gradle
  /\bBUILD FAILED\b|\bBuild failed\b/,
];
// Weak: error-ish lines that may also be noise (application log output during tests).
const WEAK = [/\berror\b:?/i, /\bERROR\b/, /\b[A-Z]\w*(?:Exception|Error)\b/, /\bfatal:/i, /\bfailed\b/i, /\bfailures?\b/i];
// Never shown: tool boilerplate and separators.
const NOISE = [
  /^\s*(?:\[\w+\]\s*)?[-=_*~⎯─]{5,}\s*$/,
  /re-run Maven|\[Help \d+\]|For more information about the errors|To see the full stack trace|Re-run Maven/i,
  /^\s*\[\w+\]\s*$/, // a bare log-level tag
  /npm (?:ERR!|error) (?:code\b|errno\b|path\b|command\b|cwd\b|syscall\b|A complete log|This is probably|Failed at the|Exit status|signal\b)/,
  /npm (?:ERR!|error)\s*$/,
  /Run with --(?:stacktrace|info|debug|scan)|Get more help at|^\* Try:/,
  /RUST_BACKTRACE=1|to rerun pass/,
];
const BENIGN = /\b0 (?:failed|failures?|errors?)\b|\bno (?:errors|failures)\b|Failures: 0, Errors: 0/i;

const isNoise = (l) => NOISE.some((re) => re.test(l));
// Dedupe key: Maven and friends repeat the same error with and without a level tag.
const norm = (l) => l.replace(/^\s*\[(?:ERROR|INFO|WARNING|WARN|DEBUG)\]\s*/, '').trim().replace(/\s+/g, ' ');

// The most relevant <= max lines: error-pattern matches with one line of context, deduplicated,
// strong matches first; falls back to the last lines when nothing matches.
export function extractExcerpt(text, max = EXCERPT_LINES) {
  const lines = cleanLines(text);
  const strong = [];
  const weak = [];
  lines.forEach((l, i) => {
    if (!l.trim() || isNoise(l)) return;
    if (STRONG.some((re) => re.test(l))) strong.push(i);
    else if (WEAK.some((re) => re.test(l)) && !BENIGN.test(l)) weak.push(i);
  });
  const picked = new Set();
  const seen = new Set();
  const take = (j) => {
    if (picked.size >= max || j < 0 || j >= lines.length || picked.has(j)) return;
    const l = lines[j];
    if (!l.trim() || isNoise(l)) return;
    const n = norm(l);
    if (seen.has(n)) return;
    seen.add(n);
    picked.add(j);
  };
  for (const i of [...strong, ...weak]) {
    if (picked.size >= max) break;
    if (seen.has(norm(lines[i]))) continue;
    take(i - 1);
    take(i);
    take(i + 1);
  }
  let chosen = [...picked].sort((a, b) => a - b).map((i) => lines[i]);
  if (!chosen.length) chosen = lines.filter((l) => l.trim() && !isNoise(l)).slice(-max);
  return chosen.map((l) => cut(redact(l))).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Test summaries -> { passed, failed }
// ---------------------------------------------------------------------------------------------
const n = (s) => (s === undefined ? 0 : Number(s));
const grab = (s, re) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : 0;
};
function sumAll(text, re, fn) {
  let found = false;
  const acc = { passed: 0, failed: 0 };
  for (const m of text.matchAll(re)) {
    found = true;
    const r = fn(m);
    acc.passed += r.passed;
    acc.failed += r.failed;
  }
  return found ? acc : null;
}

const SUMMARY_PARSERS = [
  // maven surefire / failsafe: aggregate lines have no "Time elapsed"
  (t) => {
    const all = [...t.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(.*)$/gm)];
    if (!all.length) return null;
    const agg = all.filter((m) => !/Time elapsed/.test(m[5]));
    const use = agg.length ? agg : all;
    return use.reduce(
      (a, m) => ({ passed: a.passed + n(m[1]) - n(m[2]) - n(m[3]) - n(m[4]), failed: a.failed + n(m[2]) + n(m[3]) }),
      { passed: 0, failed: 0 },
    );
  },
  // gradle: "12 tests completed, 2 failed, 1 skipped"
  (t) => sumAll(t, /(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/g, (m) => ({ passed: n(m[1]) - n(m[2]) - n(m[3]), failed: n(m[2]) })),
  // junit platform console launcher
  (t) => {
    const ok = /\[\s*(\d+) tests successful\s*\]/.exec(t);
    const ko = /\[\s*(\d+) tests failed\s*\]/.exec(t);
    return ok || ko ? { passed: ok ? n(ok[1]) : 0, failed: ko ? n(ko[1]) : 0 } : null;
  },
  // jest: "Tests:       2 failed, 1 skipped, 10 passed, 13 total"
  (t) => sumAll(t, /^\s*Tests:\s+(.*\d+ total)\s*$/gm, (m) => ({ passed: grab(m[1], /(\d+) passed/), failed: grab(m[1], /(\d+) failed/) })),
  // vitest: "      Tests  1 failed | 3 passed (4)"
  (t) => sumAll(t, /^\s*Tests\s{2,}(.*)\(\d+\)\s*$/gm, (m) => ({ passed: grab(m[1], /(\d+) passed/), failed: grab(m[1], /(\d+) failed/) })),
  // pytest: "==== 2 failed, 10 passed, 1 error in 0.12s ===="
  (t) =>
    sumAll(t, /^=+ (.*\b(?:passed|failed|errors?)\b.*?) in [\d.]+s\b.*=+\s*$/gm, (m) => ({
      passed: grab(m[1], /(\d+) passed/),
      failed: grab(m[1], /(\d+) failed/) + grab(m[1], /(\d+) errors?/),
    })),
  // python unittest: "Ran 10 tests in 0.01s" + "FAILED (failures=2, errors=1)" | "OK"
  (t) => {
    const ran = /^Ran (\d+) tests? in /m.exec(t);
    if (!ran) return null;
    const res = /^FAILED \(([^)]*)\)/m.exec(t);
    const f = res ? grab(res[1], /failures=(\d+)/) + grab(res[1], /errors=(\d+)/) : 0;
    const s = res ? grab(res[1], /skipped=(\d+)/) : grab(t, /^OK \(skipped=(\d+)\)/m);
    return { passed: n(ran[1]) - f - s, failed: f };
  },
  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored; ..."
  (t) => sumAll(t, /test result: \w+\. (\d+) passed; (\d+) failed/g, (m) => ({ passed: n(m[1]), failed: n(m[2]) })),
  // dotnet test (vstest and the newer terminal logger)
  (t) =>
    sumAll(t, /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+)/g, (m) => ({ passed: n(m[2]), failed: n(m[1]) })) ||
    sumAll(t, /Test summary: total: \d+, failed: (\d+), succeeded: (\d+)/gi, (m) => ({ passed: n(m[2]), failed: n(m[1]) })),
  // go test: per-test lines, else per-package lines
  (t) => {
    const p = (t.match(/^\s*--- PASS:/gm) || []).length;
    const f = (t.match(/^\s*--- FAIL:/gm) || []).length;
    if (p || f) return { passed: p, failed: f };
    const pp = (t.match(/^ok\s+\S+\t/gm) || []).length;
    const pf = (t.match(/^FAIL\t\S+/gm) || []).length;
    return pp || pf ? { passed: pp, failed: pf } : null;
  },
  // rspec: "10 examples, 2 failures, 1 pending"
  (t) => sumAll(t, /(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/g, (m) => ({ passed: n(m[1]) - n(m[2]) - n(m[3]), failed: n(m[2]) })),
  // phpunit
  (t) => {
    const ok = /^OK \((\d+) tests?, \d+ assertions?\)/m.exec(t);
    if (ok) return { passed: n(ok[1]), failed: 0 };
    const m = /^Tests: (\d+), Assertions: \d+(.*)$/m.exec(t);
    if (!m) return null;
    const f = grab(m[2], /Failures: (\d+)/) + grab(m[2], /Errors: (\d+)/);
    return { passed: n(m[1]) - f - grab(m[2], /Skipped: (\d+)/) - grab(m[2], /Incomplete: (\d+)/), failed: f };
  },
  // mocha: "  10 passing (2s)" / "  2 failing"
  (t) => {
    const p = /^\s*(\d+) passing\b/m.exec(t);
    const f = /^\s*(\d+) failing\b/m.exec(t);
    return p || f ? { passed: p ? n(p[1]) : 0, failed: f ? n(f[1]) : 0 } : null;
  },
  // TAP / node:test: "# pass 10" "# fail 2" (spec reporter uses "ℹ")
  (t) => {
    const p = /^(?:#|ℹ) pass (\d+)/m.exec(t);
    const f = /^(?:#|ℹ) fail (\d+)/m.exec(t);
    return p || f ? { passed: p ? n(p[1]) : 0, failed: f ? n(f[1]) : 0 } : null;
  },
];

export function parseTestSummary(text) {
  const t = cleanLines(text).join('\n');
  for (const parse of SUMMARY_PARSERS) {
    const r = parse(t);
    if (r) return { passed: Math.max(0, r.passed), failed: Math.max(0, r.failed) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Scanner reports -> { counts, findings: [{ severity, rule, file, line, extra }] }
// ---------------------------------------------------------------------------------------------
export function emptyCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

const SEMGREP_SEV = { CRITICAL: 'critical', ERROR: 'high', HIGH: 'high', WARNING: 'medium', MEDIUM: 'medium', INFO: 'low', LOW: 'low' };
const TRIVY_SEV = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'low' };
const ZAP_RISK = { 3: 'high', 2: 'medium', 1: 'low' };

// Project-relative, forward-slash path of a finding.
export function relFile(file, roots = []) {
  let f = slash(String(file || ''));
  for (const r of roots.filter(Boolean).map((x) => slash(x).replace(/\/+$/, ''))) {
    if (f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1);
  }
  return f.replace(/^\.\//, '');
}

function tally(findings) {
  const counts = emptyCounts();
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function finish(findings) {
  const rank = (s) => SEV_ORDER.indexOf(s);
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
  return { counts: tally(findings), findings };
}

// .gitleaksignore fingerprints (file:rule:line or commit:file:rule:line), backslashes normalised.
export function readGitleaksIgnore(projectDir) {
  const file = path.join(projectDir, '.gitleaksignore');
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => slash(l.trim()))
      .filter((l) => l && !l.startsWith('#')),
  );
}

export function parseGitleaks(report, { roots = [], ignore = new Set() } = {}) {
  const list = Array.isArray(report) ? report : [];
  const findings = [];
  for (const f of list) {
    const file = relFile(f.File, roots);
    const fp = slash(String(f.Fingerprint || ''));
    const relFp = `${file}:${f.RuleID}:${f.StartLine}`;
    if (ignore.has(fp) || ignore.has(relFp) || [...ignore].some((i) => relFile(i, roots) === relFp)) continue;
    // Never keep Secret/Match: only rule, file and line leave the report.
    findings.push({ severity: 'critical', rule: String(f.RuleID || 'secret'), file, line: f.StartLine || null });
  }
  return finish(findings);
}

export function parseSemgrep(report, { roots = [] } = {}) {
  const seen = new Set();
  const findings = [];
  for (const r of (report && report.results) || []) {
    if (r.extra && r.extra.is_ignored) continue;
    const sev = SEMGREP_SEV[String((r.extra && r.extra.severity) || '').toUpperCase()];
    if (!sev) continue; // INVENTORY / EXPERIMENT are not findings
    const key = [r.check_id, r.path, r.start && r.start.line, r.start && r.start.col, r.end && r.end.line].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ severity: sev, rule: String(r.check_id || 'rule'), file: relFile(r.path, roots), line: (r.start && r.start.line) || null });
  }
  return { ...finish(findings), errors: ((report && report.errors) || []).length };
}

export function parseTrivy(report, { roots = [] } = {}) {
  const findings = [];
  for (const res of (report && report.Results) || []) {
    const file = relFile(res.Target, roots);
    for (const v of res.Vulnerabilities || []) {
      findings.push({
        severity: TRIVY_SEV[String(v.Severity).toUpperCase()] || 'low',
        rule: String(v.VulnerabilityID || 'vuln'),
        file,
        line: null,
        extra: `${v.PkgName}@${v.InstalledVersion}${v.FixedVersion ? ` -> ${v.FixedVersion}` : ''}`,
      });
    }
    for (const m of res.Misconfigurations || []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      findings.push({
        severity: TRIVY_SEV[String(m.Severity).toUpperCase()] || 'low',
        rule: String(m.ID || m.AVDID || 'misconfig'),
        file,
        line: (m.CauseMetadata && m.CauseMetadata.StartLine) || null,
      });
    }
  }
  return finish(findings);
}

// ZAP traditional-json report: site[].alerts[] with riskcode 0..3. Informational is ignored.
export function parseZap(report) {
  const findings = [];
  const sites = Array.isArray(report && report.site) ? report.site : report && report.site ? [report.site] : [];
  for (const site of sites) {
    for (const a of site.alerts || []) {
      let code = Number(a.riskcode);
      if (Number.isNaN(code)) code = { high: 3, medium: 2, low: 1 }[String(a.riskdesc || a.risk || '').split(' ')[0].toLowerCase()] || 0;
      const sev = ZAP_RISK[code];
      if (!sev) continue;
      const uri = (a.instances && a.instances[0] && a.instances[0].uri) || site['@name'] || '';
      findings.push({
        severity: sev,
        rule: String(a.pluginid || a.alertRef || 'zap'),
        file: uri,
        line: null,
        extra: `${cut(String(a.alert || a.name || ''), 60)}${Number(a.count) > 1 ? ` x${a.count}` : ''}`,
      });
    }
  }
  return finish(findings);
}

export function formatFinding(f) {
  const rule = f.rule.length > 70 ? `...${f.rule.slice(-67)}` : f.rule;
  return redact(`${f.severity} ${rule} ${f.file}${f.line ? `:${f.line}` : ''}${f.extra ? ` ${f.extra}` : ''}`);
}

export function formatCounts(c) {
  const parts = SEV_ORDER.filter((s) => c && c[s]).map((s) => `${c[s]} ${s}`);
  return parts.length ? parts.join(', ') : 'no findings';
}

export function blocking(c) {
  return Boolean(c && (c.critical || c.high));
}

// ---------------------------------------------------------------------------------------------
// Docker helpers (used when a scanner resolves to its pinned image)
// ---------------------------------------------------------------------------------------------
// Host path in the form "docker run -v" accepts: native Windows path on Windows.
export function dockerMountPath(p, platform = process.platform) {
  if (platform === 'win32') {
    const w = path.win32.resolve(String(p).replace(/\//g, '\\'));
    return w.replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
  }
  return path.posix.resolve(String(p));
}

// Inserts options right after "run" so they work whatever image/command follows.
export function dockerArgs(baseArgs, { mounts = [], workdir, name, extra = [] } = {}, platform = process.platform) {
  const args = [...baseArgs];
  const i = args.indexOf('run');
  if (i < 0) return args;
  const add = [];
  if (name && !args.includes('--name')) add.push('--name', name);
  for (const m of mounts) {
    const src = dockerMountPath(m.host, platform);
    if (src.includes(',')) throw new HadesError(`cannot bind-mount a path containing a comma: ${slash(src)}`);
    add.push('--mount', `type=bind,source=${src},target=${m.container}${m.ro ? ',readonly' : ''}`);
  }
  if (workdir && !args.includes('-w') && !args.includes('--workdir')) add.push('-w', workdir);
  add.push(...extra);
  args.splice(i + 1, 0, ...add);
  return args;
}

// Bind mounts already present in docker run arguments (--mount type=bind,... and -v host:ctr).
export function existingMounts(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    let kind = null;
    let spec = null;
    if (a === '--mount' || a === '-v' || a === '--volume') {
      kind = a === '--mount' ? 'mount' : 'v';
      spec = String(args[++i] || '');
    } else if (a.startsWith('--mount=')) {
      kind = 'mount';
      spec = a.slice(8);
    } else if (a.startsWith('--volume=')) {
      kind = 'v';
      spec = a.slice(9);
    }
    if (kind === 'mount') {
      const kv = {};
      for (const part of spec.split(',')) {
        const eq = part.indexOf('=');
        if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
      }
      const host = kv.source || kv.src;
      const container = kv.target || kv.destination || kv.dst;
      if (host && container && (!kv.type || kv.type === 'bind')) out.push({ host, container });
    } else if (kind === 'v') {
      const m = /^(.+?):(\/[^:]*)(?::[a-zA-Z,]+)?$/.exec(spec);
      if (m) out.push({ host: m[1], container: m[2] });
    }
  }
  return out;
}

const samePath = (a, b) => {
  const n = (p) => slash(path.resolve(p)).replace(/\/+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// Adds the mounts a scan needs unless resolveTool already mounted that host path (it mounts the
// spawn cwd at the image workdir) or the target is taken. Returns the args and the full mount table.
export function planDocker(baseArgs, { want = [], name, workdir, extra = [] } = {}, platform = process.platform) {
  const have = existingMounts(baseArgs);
  const add = [];
  for (const m of want) {
    if (have.some((h) => samePath(h.host, m.host))) continue;
    if ([...have, ...add].some((h) => h.container === m.container)) continue;
    add.push(m);
  }
  const extraArgs = [];
  for (let i = 0; i < extra.length; i += 2) if (!baseArgs.includes(extra[i + 1])) extraArgs.push(extra[i], extra[i + 1]);
  return { args: dockerArgs(baseArgs, { mounts: add, workdir, name, extra: extraArgs }, platform), mounts: [...have, ...add] };
}

// process.env plus layers; a layer value of undefined removes the variable (case-insensitive on Windows).
export function mergeEnv(base, ...layers) {
  const out = { ...base };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer || {})) {
      if (process.platform === 'win32') for (const key of Object.keys(out)) if (key !== k && key.toUpperCase() === k.toUpperCase()) delete out[key];
      if (v === undefined || v === null) delete out[k];
      else out[k] = String(v);
    }
  }
  return out;
}

// Maps a host path into a container path through the mount table.
export function containerPath(hostPath, mounts) {
  const h = slash(path.resolve(hostPath));
  let best = null;
  for (const m of mounts) {
    const root = slash(path.resolve(m.host)).replace(/\/+$/, '');
    if ((h.toLowerCase() === root.toLowerCase() || h.toLowerCase().startsWith(`${root.toLowerCase()}/`)) && (!best || root.length > best.root.length)) {
      best = { root, m };
    }
  }
  if (!best) return h;
  return `${best.m.container.replace(/\/+$/, '')}${h.slice(best.root.length)}` || '/';
}

// ---------------------------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------------------------
function stamp() {
  return String(Date.now());
}

export function projectSlug(rel) {
  return kebab(rel === '.' || !rel ? 'root' : rel) || 'root';
}

const NOT_FOUND_WIN = /is not recognized as an internal or external command/;

// The guard's verdict on a team.json command line the CLI is about to run (no agent: agentType
// null). Null = allowed. A guard failure blocks: the CLI never runs what it could not check.
export function guardCommand(command, cwd, check = checkShell) {
  try {
    return check(String(command), { shell: COMMAND_SHELL, cwd, agentType: null });
  } catch (err) {
    return { id: 'guard.error', message: `HADES guard: guard.error: the command could not be checked (${String((err && err.message) || err).slice(0, 120)}). Simplify it with: hades team set.` };
  }
}

// build | lint | types | test: a team.json command line run through the platform shell, checked
// by the guard first, with GATE_ENV and a timeout that kills the whole process tree.
export async function runCommandStep({ step, project, dir, command, logDir, timeoutMs }) {
  const base = { project: project.rel, step };
  if (!command || !String(command).trim()) return { ...base, status: 'n/a' };
  const log = `${logDir}/${projectSlug(project.rel)}-${step}-${stamp()}.log`;
  if (!fs.existsSync(dir)) {
    fs.writeFileSync(log, `project directory not found: ${dir}\n`);
    return { ...base, status: 'error', ms: 0, log, cmd: command, note: 'project directory not found', excerpt: `project directory not found: ${dir}` };
  }
  const blocked = guardCommand(command, dir);
  if (blocked) {
    fs.writeFileSync(log, `$ ${command}\n[hades] not run: ${blocked.message}\n`);
    return { ...base, status: 'error', ms: 0, log, cmd: command, note: `blocked by the guard (${blocked.id})`, excerpt: blocked.message };
  }
  const res = await runShellAsync(command, { cwd: dir, env: mergeEnv(process.env, GATE_ENV), timeoutMs: timeoutMs || 0 });
  const full = `${res.stdout}${res.stderr ? `${res.stdout && !res.stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${res.stderr}` : ''}`;
  fs.writeFileSync(log, `${full}${res.timedOut ? `\n[hades] timeout after ${fmtDuration(timeoutMs)}\n` : ''}`);
  const text = full.length > MAX_LOG_BYTES ? full.slice(-MAX_LOG_BYTES) : full;
  const out = { ...base, status: 'pass', ms: res.ms, log, cmd: command };
  const tests = parseTestSummary(text);
  if (tests) out.tests = tests;
  if (res.timedOut) {
    out.status = 'fail';
    out.note = `timeout after ${fmtDuration(timeoutMs)}`;
    out.excerpt = extractExcerpt(text) || out.note;
  } else if (res.code === 127 || res.code === 9009 || (res.code !== 0 && NOT_FOUND_WIN.test(text))) {
    out.status = 'error';
    out.note = 'command not found';
    out.excerpt = extractExcerpt(text);
  } else if (res.code !== 0) {
    out.status = 'fail';
    out.note = `exit ${res.code}`;
    out.excerpt = extractExcerpt(text);
  }
  return out;
}

// Spawns a resolved tool without a shell. `want` lists the bind mounts a docker run needs, the
// first being the workdir. resolveTool gets them as {mounts}; planDocker then only adds what a
// resolver did not apply (it mounts nothing twice). build(P, docker) returns the tool arguments,
// with P mapping host paths into the container.
async function invokeTool(ctx, name, build, { cwd, want = [], env = {}, timeoutMs, log, dockerPrefix = [], dockerExtra = [] }) {
  const cname = `hades-${name}-${stamp()}`;
  let resolved;
  try {
    resolved = await (await tools()).resolveTool(ctx, name, { cwd, mounts: want, workdir: want[0] && want[0].container, containerName: cname });
  } catch (err) {
    return { missing: err && err.message ? err.message : String(err), log };
  }
  const docker = resolved.via === 'docker';
  let args = [...(resolved.args || [])];
  let P = (p) => slash(p);
  if (docker) {
    let plan;
    try {
      plan = planDocker(args, { want, name: cname, workdir: want[0] && want[0].container, extra: dockerExtra });
    } catch (err) {
      return { missing: err.message, log };
    }
    args = plan.args;
    P = (p) => containerPath(p, plan.mounts);
    if (dockerPrefix.length && args[args.length - 1] !== dockerPrefix[dockerPrefix.length - 1]) args = args.concat(dockerPrefix);
  }
  args = args.concat(build(P, docker).map(String));
  const childEnv = mergeEnv(process.env, resolved.env, env);
  const t0 = Date.now();
  const res = spawnSync(resolved.cmd, args, {
    cwd: docker ? undefined : cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - t0;
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  // A killed "docker run" client leaves its container running: remove it by name.
  if (timedOut && docker) spawnSync(/docker/i.test(path.basename(resolved.cmd)) ? resolved.cmd : 'docker', ['rm', '-f', cname], { windowsHide: true, encoding: 'utf8' });
  const notFound = res.error && res.error.code === 'ENOENT';
  const stdout = res.stdout || '';
  const stderr = res.stderr || (res.error && !timedOut ? String(res.error.message) : '');
  const head = `$ ${name} via ${resolved.via}${resolved.version ? ` ${resolved.version}` : ''}: ${[resolved.cmd, ...args].join(' ')}\n`;
  const tail = `${stderr ? `\n[stderr]\n${stderr}` : ''}${timedOut ? `\n[hades] timeout after ${fmtDuration(timeoutMs)}\n` : ''}`;
  fs.writeFileSync(log, `${head}${stdout}${tail}`);
  return { code: res.status === null ? (notFound ? 127 : 1) : res.status, stdout, stderr, ms, timedOut, notFound, via: resolved.via, log };
}

function readReport(file) {
  try {
    if (!fs.existsSync(file)) return { ok: false };
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
    return { ok: true, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { ok: false };
  }
}

function tailText(text, max = 8) {
  const lines = cleanLines(text).filter((l) => l.trim());
  return lines.slice(-max).map((l) => cut(redact(l))).join('\n');
}

// Shared tail of every scanner: exit-code check, report parse, status.
function scanResult(base, inv, report, expectedCodes, parse) {
  const out = { ...base, ms: inv.ms, ...(fs.existsSync(inv.log) ? { log: inv.log } : {}) };
  if (inv.missing) return { ...base, status: 'error', ms: 0, note: inv.missing, excerpt: inv.missing };
  if (inv.timedOut) return { ...out, status: 'fail', note: `timeout after ${fmtDuration(inv.timeoutMs)}`, excerpt: tailText(`${inv.stdout}\n${inv.stderr}`) };
  const rep = readReport(report);
  if (!expectedCodes.includes(inv.code) || !rep.ok) {
    const why = inv.notFound ? 'tool not found' : !expectedCodes.includes(inv.code) ? `tool exit ${inv.code}` : 'no report written';
    return { ...out, status: 'error', note: why, excerpt: tailText(`${inv.stdout}\n${inv.stderr}`) || why };
  }
  const parsed = parse(rep.data);
  const top = parsed.findings.slice(0, 5).map(formatFinding);
  return { ...out, status: blocking(parsed.counts) ? 'fail' : 'pass', report, counts: parsed.counts, top, ...(blocking(parsed.counts) ? { excerpt: top.join('\n') } : {}) };
}

export async function runSecretsStep(ctx, { project, dir, logDir, timeoutMs }) {
  const base = { project: project.rel, step: 'secrets' };
  const id = `${projectSlug(project.rel)}-secrets-${stamp()}`;
  const log = `${logDir}/${id}.log`;
  const report = `${logDir}/${id}.json`;
  const toml = path.join(dir, '.gitleaks.toml');
  const want = [
    { host: dir, container: '/src', ro: true },
    { host: logDir, container: '/out' },
  ];
  // The project's own .gitleaks.toml / .gitleaksignore are the allowlist; global overrides are not.
  const inv = await invokeTool(
    ctx,
    'gitleaks',
    (P) => [
      'dir', P(dir), '--no-banner', '--no-color', '--log-level', 'error', '--redact=100', '--exit-code', '2',
      '-f', 'json', '-r', P(report), '-i', P(dir), ...(fs.existsSync(toml) ? ['--config', P(toml)] : []),
    ],
    { cwd: dir, want, timeoutMs, log, env: { GITLEAKS_CONFIG: undefined, GITLEAKS_CONFIG_TOML: undefined } },
  );
  inv.timeoutMs = timeoutMs;
  const ignore = readGitleaksIgnore(dir);
  return scanResult(base, inv, report, [0, 2], (d) => parseGitleaks(d, { roots: [dir, '/src'], ignore }));
}

export async function runSastStep(ctx, { project, dir, logDir, timeoutMs, config }) {
  const base = { project: project.rel, step: 'sast' };
  const id = `${projectSlug(project.rel)}-sast-${stamp()}`;
  const log = `${logDir}/${id}.log`;
  const report = `${logDir}/${id}.json`;
  let cfg = String(config || 'p/default');
  if (cfg === 'auto') cfg = 'p/default'; // "auto" aborts when metrics are off
  const registry = /^(?:[prs]\/|r2c$|https?:\/\/)/.test(cfg);
  const want = [
    { host: dir, container: '/src', ro: true },
    { host: logDir, container: '/out' },
  ];
  let localCfg = null;
  if (!registry) {
    localCfg = slash(path.resolve(dir, cfg));
    const rel = path.relative(dir, localCfg);
    if (rel.startsWith('..') || path.isAbsolute(rel)) want.push({ host: path.dirname(localCfg), container: '/rules', ro: true });
  }
  const inv = await invokeTool(
    ctx,
    'semgrep',
    (P) => [
      'scan', '--config', localCfg ? P(localCfg) : cfg, '--metrics=off', '--disable-version-check', '--oss-only',
      '--quiet', '--json', '--output', P(report), P(dir),
    ],
    {
      cwd: dir,
      want,
      timeoutMs,
      log,
      env: {
        SEMGREP_SEND_METRICS: 'off',
        SEMGREP_ENABLE_VERSION_CHECK: '0',
        SEMGREP_MCP_DISABLE_TRACING: 'true',
        SEMGREP_APP_TOKEN: undefined,
        SEMGREP_OTEL_ENDPOINT: undefined,
      },
      dockerPrefix: ['semgrep'],
    },
  );
  inv.timeoutMs = timeoutMs;
  const out = scanResult(base, inv, report, [0, 1], (d) => parseSemgrep(d, { roots: [dir, '/src'] }));
  return { ...out, config: cfg };
}

// Offline flags only when the DBs are cached: trivy refuses --skip-db-update on a first run.
export function trivyOfflineFlags(cache) {
  if (!fs.existsSync(`${cache}/db/trivy.db`)) return [];
  const java = fs.existsSync(`${cache}/java-db/trivy-java.db`);
  return ['--skip-db-update', '--skip-check-update', '--offline-scan', ...(java ? ['--skip-java-db-update'] : [])];
}

export async function runDepsStep(ctx, { project, dir, logDir, timeoutMs }) {
  const base = { project: project.rel, step: 'deps' };
  const id = `${projectSlug(project.rel)}-deps-${stamp()}`;
  const log = `${logDir}/${id}.log`;
  const report = `${logDir}/${id}.json`;
  const cache = trivyCacheDir(ctx);
  fs.mkdirSync(cache, { recursive: true });
  const offline = trivyOfflineFlags(cache);
  const dbCached = offline.length > 0;
  // cwd = the logs folder (not the checkout), so trivy never auto-loads a project's trivy.yaml,
  // .trivyignore or trivy-secret.yaml; --config= and --ignorefile= switch them off explicitly too.
  const want = [
    { host: logDir, container: '/src' },
    { host: dir, container: '/project', ro: true },
    { host: cache, container: '/cache' },
  ];
  const inv = await invokeTool(
    ctx,
    'trivy',
    (P) => [
      'fs', '--scanners', 'vuln,misconfig', '--format', 'json', '--output', P(report), '--exit-code', '3',
      '--cache-dir', P(cache), '--disable-telemetry', '--skip-version-check', '--quiet', '--no-progress',
      '--list-all-pkgs=false', '--config=', '--ignorefile=', ...offline, P(dir),
    ],
    { cwd: logDir, want, timeoutMs, log, env: { TRIVY_RUN_AS_PLUGIN: undefined } },
  );
  inv.timeoutMs = timeoutMs;
  const out = scanResult(base, inv, report, [0, 3], (d) => parseTrivy(d, { roots: [dir, '/project'] }));
  return { ...out, ...(dbCached ? { offline: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// DAST
// ---------------------------------------------------------------------------------------------
function parseUrl(u) {
  try {
    return u ? new URL(u) : null;
  } catch {
    return null;
  }
}

// What team.json security allows per environment: dast_live baseline|none (default baseline),
// dast_test baseline|full|api|none (default full = any mode). Other targets are not capped here.
export const DAST_CAPS = { live: ['baseline', 'none'], test: ['baseline', 'full', 'api', 'none'] };
const CAP_ALLOWS = { none: [], baseline: ['baseline'], api: ['baseline', 'api'], full: ['baseline', 'full', 'api'] };

// Returns null when the scan may run, otherwise the refusal message.
export function checkDastTarget({ url, mode, openapi, teamJson, iOwnTarget }) {
  const u = parseUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return `invalid DAST target "${url}": expected an http(s) URL`;
  if (openapi && !parseUrl(openapi)) return `invalid --openapi URL "${openapi}"`;
  if (!DAST_MODES.includes(mode)) return `unknown --mode "${mode}" (use ${DAST_MODES.join('|')})`;
  const envs = (teamJson && teamJson.environments) || {};
  const sec = (teamJson && teamJson.security) || {};
  const live = parseUrl(envs.live && envs.live.url);
  const test = parseUrl(envs.test && envs.test.url);
  const targets = [u, parseUrl(openapi)].filter(Boolean);
  const onLive = live && targets.some((x) => x.hostname.toLowerCase() === live.hostname.toLowerCase());
  const onTest = !onLive && test && targets.some((x) => x.host.toLowerCase() === test.host.toLowerCase());
  // The owner's per-environment limits come first (hades team set <team> security dast_live|dast_test ...).
  if (onLive) {
    const cap = DAST_CAPS.live.includes(sec.dast_live) ? sec.dast_live : 'baseline';
    if (cap === 'none') return `refused: team.json security.dast_live is none: no DAST against the live environment (${live.hostname}); record DAST n/a with this reason`;
  }
  if (onTest) {
    const cap = DAST_CAPS.test.includes(sec.dast_test) ? sec.dast_test : 'full';
    if (!CAP_ALLOWS[cap].includes(mode)) {
      return cap === 'none'
        ? `refused: team.json security.dast_test is none: no DAST against the test environment (${test.host}); record DAST n/a with this reason`
        : `refused: --mode ${mode} exceeds team.json security.dast_test (${cap}); use --mode ${CAP_ALLOWS[cap].join(' or --mode ')}`;
    }
  }
  if (mode === 'baseline') return null;
  for (const t of targets) {
    if (live && t.hostname.toLowerCase() === live.hostname.toLowerCase()) {
      return `refused: --mode ${mode} is an active scan and ${t.hostname} is the live environment (team.json environments.live.url). Use --mode baseline against live.`;
    }
  }
  const isTest = test && u.host.toLowerCase() === test.host.toLowerCase();
  if (!isTest && !iOwnTarget) {
    return `refused: ${u.host} is not the team's test environment (${test ? test.host : 'none configured'}). Active scans need the test url, or --i-own-this-target for a system you own.`;
  }
  return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function zapArgs({ mode, target, openapi, jsonName, htmlName }) {
  const reports = ['-J', jsonName, '-r', htmlName];
  if (mode === 'baseline') {
    return ['zap-baseline.py', '-t', target, '-m', '1', '-T', '10', '-s', ...reports, '-z', '-silent -config spider.processform=false -config spider.postform=false'];
  }
  if (mode === 'full') {
    return ['zap-full-scan.py', '-t', target, '-m', '5', '-s', ...reports, '-z', '-silent -config scanner.maxScanDurationInMins=60 -config scanner.maxRuleDurationInMins=10'];
  }
  // api: -t is the definition; -O pins the scanned host to the validated target
  return ['zap-api-scan.py', '-t', openapi || target, '-f', 'openapi', ...(openapi ? ['-O', target] : []), '-s', ...reports, '-z', '-silent'];
}

export async function runDast(ctx, { url, mode, openapi, logDir, timeoutMs }) {
  const base = { step: 'dast', mode, target: url };
  const id = `dast-${mode}-${stamp()}`;
  const log = `${logDir}/${id}.log`;
  const jsonName = `${id}.json`;
  const report = `${logDir}/${jsonName}`;
  const want = [{ host: logDir, container: '/zap/wrk' }];
  // Inside the container "localhost" is the container itself; reach the host instead.
  const rewrite = (u) => {
    const p = parseUrl(u);
    if (!p || !LOCAL_HOSTS.has(p.hostname)) return u;
    p.hostname = 'host.docker.internal';
    return p.toString();
  };
  const inv = await invokeTool(
    ctx,
    'zaproxy',
    (P, docker) =>
      zapArgs({
        mode,
        target: docker ? rewrite(url) : url,
        openapi: openapi && docker ? rewrite(openapi) : openapi,
        jsonName,
        htmlName: `${id}.html`,
      }),
    { cwd: logDir, want, timeoutMs, log, dockerExtra: ['--add-host', 'host.docker.internal:host-gateway'] },
  );
  inv.timeoutMs = timeoutMs;
  // ZAP exit codes: 0 ok, 1 FAIL rule, 2 WARN, 3 any other failure (e.g. target unreachable)
  return scanResult(base, inv, report, [0, 1, 2], (d) => parseZap(d));
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------
export function gitState(dir) {
  if (!fs.existsSync(dir)) return { head: null, dirty: null };
  const h = git(dir, 'rev-parse', '--short', 'HEAD');
  if (h.code !== 0) return { head: null, dirty: null };
  const s = git(dir, 'status', '--porcelain');
  return { head: h.stdout.trim() || null, dirty: s.code === 0 ? s.stdout.trim().length > 0 : null };
}

// Locked: engineers of one wave run their gates in parallel on the same task.
export function appendRun(taskDir, run) {
  const file = `${taskDir}/gates.json`;
  updateJson(file, () => ({ runs: [] }), (data) => {
    if (!Array.isArray(data.runs)) data.runs = [];
    data.runs.push(run);
  });
  return file;
}

// Projects whose selected build/lint/types/test steps were all n/a: nothing was built or tested
// there. When every step of the run is n/a, every project of the run counts.
export function emptyProjects(steps) {
  const by = new Map();
  for (const s of steps) {
    if (!CMD_STEPS.includes(s.step)) continue;
    const p = s.project === undefined ? '.' : s.project;
    if (!by.has(p)) by.set(p, []);
    by.get(p).push(s);
  }
  const empty = [...by].filter(([, ss]) => ss.every((s) => s.status === 'n/a')).map(([p]) => p);
  if (!empty.length && steps.length && steps.every((s) => s.status === 'n/a')) return [...new Set(steps.map((s) => (s.project === undefined ? '.' : s.project)))];
  return empty;
}

export const GATE_EMPTY_LINE = 'GATE EMPTY (no commands configured: run hades detect --write or hades team set)';

// Path stored in gates.json: relative to the engine when inside it (as in docs/file-formats.md).
export function evidencePath(ctx, p) {
  if (!p) return p;
  const e = `${slash(ctx.engine).replace(/\/+$/, '')}/`;
  return slash(p).startsWith(e) ? slash(p).slice(e.length) : slash(p);
}

// ---------------------------------------------------------------------------------------------
// Text output (<= 30 lines)
// ---------------------------------------------------------------------------------------------
export function fmtDuration(ms) {
  if (ms === undefined || ms === null) return '';
  const s = ms / 1000;
  if (s < 100) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const LABEL = { pass: 'PASS', fail: 'FAIL', 'n/a': 'N/A', error: 'ERROR' };
const failing = (s) => s.status === 'fail' || s.status === 'error';

function stepName(s, multi) {
  if (s.step === 'dast') return `dast ${s.mode} ${s.target}`;
  return multi ? `${s.step} [${s.project}]` : s.step;
}

function stepDetail(s) {
  const bits = [];
  if (s.tests) bits.push(`${s.tests.passed} passed, ${s.tests.failed} failed`);
  if (s.counts) bits.push(formatCounts(s.counts));
  if (s.note && !(s.status === 'fail' && /^exit \d+$/.test(s.note) && s.tests)) bits.push(s.note);
  return bits.join('; ');
}

export function stepLine(s, multi, absLog) {
  if (s.status === 'n/a') return `N/A ${stepName(s, multi)} (no command)`;
  const detail = stepDetail(s);
  let line = `${LABEL[s.status]} ${stepName(s, multi)} (${fmtDuration(s.ms)})${detail ? ` ${detail}` : ''}`;
  if (failing(s)) {
    const where = s.status === 'fail' && s.report ? `report: ${absLog(s.report)}` : s.log ? `log: ${absLog(s.log)}` : '';
    if (where) line += ` - ${where}`;
  }
  return line;
}

export function formatRun(run, { absLog = (p) => p, maxLines = 30 } = {}) {
  const steps = run.steps;
  const projects = [...new Set(steps.filter((s) => s.project !== undefined).map((s) => s.project))];
  const multi = projects.length > 1;
  let lines = steps.map((s) => stepLine(s, multi, absLog));
  if (lines.length > 14) {
    // Many projects: one line per project for the green steps, one line per failing step.
    lines = [];
    for (const p of projects) {
      const mine = steps.filter((s) => s.project === p);
      const ok = mine.filter((s) => s.status === 'pass').map((s) => `${s.step} ${fmtDuration(s.ms)}`);
      const na = mine.filter((s) => s.status === 'n/a').map((s) => s.step);
      if (ok.length || na.length) lines.push(`[${p}] ${ok.length ? `PASS ${ok.join(', ')}` : ''}${ok.length && na.length ? '; ' : ''}${na.length ? `N/A ${na.join(', ')}` : ''}`);
      for (const s of mine.filter(failing)) lines.push(stepLine(s, true, absLog));
    }
    for (const s of steps.filter((x) => x.project === undefined)) lines.push(stepLine(s, multi, absLog));
  }
  const bad = steps.filter(failing);
  if (bad.length) {
    const first = bad[0];
    const budget = Math.max(3, Math.min(EXCERPT_LINES, maxLines - lines.length - 2));
    const ex = String(first.excerpt || first.note || '').split('\n').filter((l) => l.trim()).slice(0, budget);
    if (ex.length) {
      lines.push(`First failure: ${stepName(first, multi)}`);
      lines.push(...ex.map((l) => `  ${l}`));
    }
    if (run.empty && run.empty.length && !run.allow_empty) lines.push(`no command ran for project(s): ${run.empty.join(', ')}`);
    lines.push(`GATE RED (${bad.length} failing)`);
  } else if (run.empty && run.empty.length && !run.allow_empty) {
    // Nothing was built or tested: that is no evidence. Red until commands are set, or --allow-empty.
    if (steps.some((s) => s.status !== 'n/a')) lines.push(`no command ran for project(s): ${run.empty.join(', ')}`);
    lines.push(GATE_EMPTY_LINE);
  } else {
    const na = steps.filter((s) => s.status === 'n/a').length;
    const accepted = run.empty && run.empty.length ? '; empty accepted by --allow-empty' : '';
    lines.push(`GATE GREEN${na ? ` (${na} n/a${accepted})` : ''}`);
  }
  return lines.join('\n');
}
