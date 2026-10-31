// Checks the tool playbooks (playbooks/{code-navigation,security-testing,reverse-engineering,qa-automation}.md)
// against the CLI contract (docs/cli.md, docs/file-formats.md), the tool pins (tools/tools.lock.json) and,
// when the git submodules are checked out, the vendored tool sources (tool names, parameters, flags).
// No network, no Docker, no machine config: only files inside the engine repository are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const LIMITS = {
  'code-navigation.md': 80,
  'security-testing.md': 150,
  'reverse-engineering.md': 100,
  'qa-automation.md': 120,
};
const NAMES = Object.keys(LIMITS);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (p) => fs.existsSync(p);
const playbook = (name) => read(`playbooks/${name}`);
const allPlaybooks = () => NAMES.map((n) => ({ name: n, text: playbook(n) }));

// Inline code spans of a markdown text (single backticks; fenced blocks are not used in these files).
function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// Shell-like tokenizer good enough for documented command lines: keeps "quoted strings" together.
function tokens(line) {
  return line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

// docs/cli.md -> { "gate": {flags:Set, values:{"--preset":Set}}, "task show": {...}, ... }
function cliContract() {
  const map = {};
  for (const m of read('docs/cli.md').matchAll(/^\| `hades ([^`]+)`/gm)) {
    const toks = tokens(m[1].split(' -- ')[0]);
    const cmd = toks[0];
    const sub = toks[1] && /^[a-z][a-z-]*$/.test(toks[1]) ? toks[1] : null;
    const key = sub ? `${cmd} ${sub}` : cmd;
    const entry = (map[key] ||= { flags: new Set(['--json', '--help']), values: {} });
    for (let i = 0; i < toks.length; i++) {
      const flag = /^\[?(--[a-z][a-z-]*)/.exec(toks[i]);
      if (!flag) continue;
      entry.flags.add(flag[1]);
      const next = toks[i + 1] ? toks[i + 1].replace(/[[\]<>]/g, '') : '';
      if (next.includes('\\|')) {
        const set = (entry.values[flag[1]] ||= new Set());
        for (const v of next.split('\\|')) set.add(v);
      }
    }
  }
  return map;
}

function ownerRoles() {
  const text = read('docs/file-formats.md');
  const m = /Owner is a role name:([\s\S]*?)\.\n/.exec(text);
  assert.ok(m, 'docs/file-formats.md lists owner roles');
  return new Set([...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1]));
}

// Every documented "hades ..." invocation inside a code span, with its file.
function hadesInvocations() {
  const out = [];
  for (const { name, text } of allPlaybooks()) {
    for (const span of codeSpans(text)) {
      const m = /^(?:node \S*\/bin\/hades\.mjs|hades) (.+)$/.exec(span.trim());
      if (m) out.push({ name, line: m[1] });
    }
  }
  return out;
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '');
}

test('playbooks exist, start with a title and respect their line limits', () => {
  for (const name of NAMES) {
    const text = playbook(name);
    assert.match(text, /^# \S/, `${name} starts with a "# " title`);
    const lines = text.replace(/\n$/, '').split('\n').length;
    assert.ok(lines <= LIMITS[name], `${name} has ${lines} lines (limit ${LIMITS[name]})`);
  }
});

test('playbooks stay generic: no owner paths, only the engine placeholder, no floating versions', () => {
  for (const { name, text } of allPlaybooks()) {
    assert.doesNotMatch(text, /[A-Z]:[\\/]Users|\/home\/[a-z]|hades-vault|\bprasa/i, `${name} has a machine/owner path`);
    for (const p of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      assert.equal(p[1], 'HADES_HOME', `${name} uses unknown placeholder {{${p[1]}}}`);
    }
    for (const line of text.split('\n').filter((l) => l.includes('@latest'))) {
      assert.match(line, /never/i, `${name}: "@latest" outside a prohibition: ${line}`);
    }
    assert.doesNotMatch(text, /\r/, `${name} has CR line endings`);
  }
});

test('every hades command, flag and enumerated value in the playbooks is documented in docs/cli.md', () => {
  const cli = cliContract();
  const roles = ownerRoles();
  const pins = JSON.parse(read('tools/tools.lock.json')).tools;
  const seen = hadesInvocations();
  assert.ok(seen.length >= 15, `expected many documented invocations, found ${seen.length}`);
  for (const { name, line } of seen) {
    const [head, ...rest] = line.split(' -- ');
    const toks = tokens(head);
    const key2 = `${toks[0]} ${toks[1]}`;
    const key = cli[key2] ? key2 : toks[0];
    assert.ok(cli[key], `${name}: unknown command "hades ${line}"`);
    if (key === 'tools run' || key === 'tools setup') {
      const tool = toks[2];
      if (tool && !tool.startsWith('<')) assert.ok(pins[tool], `${name}: "${tool}" is not a pinned tool`);
      if (key === 'tools run') assert.ok(rest.length > 0, `${name}: "hades tools run" needs " -- <args>"`);
    }
    for (let i = 0; i < toks.length; i++) {
      if (!toks[i].startsWith('--')) continue;
      const flag = toks[i].split('=')[0];
      assert.ok(cli[key].flags.has(flag), `${name}: "hades ${key}" has no flag ${flag}`);
      const value = toks[i + 1] ? stripQuotes(toks[i + 1]) : '';
      if (!value || value.startsWith('<') || value.startsWith('$') || value.startsWith('--')) continue;
      const allowed = cli[key].values[flag];
      if (allowed && !(flag === '--status' && key === 'task close')) {
        assert.ok(allowed.has(value), `${name}: ${flag} ${value} not in {${[...allowed]}}`);
      }
      if (flag === '--owner') assert.ok(roles.has(value), `${name}: unknown owner role ${value}`);
    }
  }
});

test('playbook cross-references to engine files resolve', () => {
  for (const { name, text } of allPlaybooks()) {
    for (const m of text.matchAll(/`(?:\{\{HADES_HOME\}\}\/)?((?:playbooks|company|docs)\/[a-z0-9./-]+\.md)`/g)) {
      assert.ok(exists(path.join(ROOT, m[1])), `${name} references missing ${m[1]}`);
    }
  }
});

// ---- vendored-source checks (skipped when a submodule is not checked out) ----

function corpus(files) {
  const present = files.filter(exists);
  return present.length ? present.map((f) => fs.readFileSync(f, 'utf8')).join('\n') : null;
}

function listDir(dir, filter) {
  return exists(dir) ? fs.readdirSync(dir).filter(filter).map((f) => path.join(dir, f)) : [];
}

test('Serena tool and parameter names in code-navigation.md exist in the vendored source', (t) => {
  const dir = path.join(TOOLS, 'serena/src/serena/tools');
  const src = corpus(listDir(dir, (f) => f.endsWith('.py')));
  if (!src) return t.skip('serena submodule not checked out');
  const names = new Set();
  for (const m of src.matchAll(/^class (\w+)\(([^)]*)\)/gm)) {
    if (!/\bTool\b|Editing/.test(m[2])) continue;
    const base = m[1].endsWith('Tool') ? m[1].slice(0, -4) : m[1];
    names.add(base.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()));
  }
  assert.ok(names.has('find_symbol') && names.has('replace_symbol_body'), 'tool name derivation works');
  const text = playbook('code-navigation.md');
  const re = /\b(?:get|find|replace|insert|rename|safe|write|read|list|delete|edit|activate|initial|execute|serena|search|restart)_[a-z_]+\b|\bonboarding\b(?=`)/g;
  const used = new Set(codeSpans(text).flatMap((s) => s.match(re) || []));
  assert.ok(used.size >= 12, `expected the Serena tool set, found ${[...used]}`);
  for (const n of used) assert.ok(names.has(n), `Serena has no tool "${n}"`);
  for (const s of codeSpans(text)) {
    for (const p of s.matchAll(/\b([a-z_]+)=/g)) {
      assert.ok(src.includes(`${p[1]}:`), `Serena tools have no parameter "${p[1]}"`);
    }
  }
  const cfg = corpus([path.join(TOOLS, 'serena/src/serena/resources/serena_config.template.yml')]);
  if (cfg) assert.ok(cfg.includes('project_serena_folder_location'), 'folder-location setting exists');
});

test('Playwright MCP tool and parameter names in qa-automation.md exist in the vendored README', (t) => {
  const readme = corpus([path.join(TOOLS, 'playwright-mcp/README.md')]);
  if (!readme) return t.skip('playwright-mcp submodule not checked out');
  const tools = new Set([...readme.matchAll(/^- \*\*(browser_[a-z_]+)\*\*/gm)].map((m) => m[1]));
  for (const name of ['qa-automation.md', 'security-testing.md']) {
    const text = playbook(name);
    for (const n of new Set(text.match(/\bbrowser_[a-z_]+\b/g) || [])) {
      assert.ok(tools.has(n), `${name}: Playwright MCP has no tool "${n}"`);
    }
  }
  for (const s of codeSpans(playbook('qa-automation.md')).filter((x) => x.startsWith('browser_'))) {
    for (const p of s.matchAll(/[(,]\s*([a-zA-Z]+)\s*=/g)) {
      assert.ok(readme.includes(`\`${p[1]}\` (`), `Playwright MCP has no parameter "${p[1]}" (${s})`);
    }
  }
});

test('REA tool names and environment variables in reverse-engineering.md exist in the vendored source', (t) => {
  const effects = corpus([path.join(TOOLS, 'rea/src/contracts/toolEffects.ts')]);
  if (!effects) return t.skip('rea submodule not checked out');
  const names = new Set([...effects.matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((m) => m[1]));
  assert.ok(names.has('binary_session') && names.has('open_binary'), 'tool table parsed');
  const text = playbook('reverse-engineering.md');
  const re = /\b(?:inspect|analyze|compare|binary|open|close|search|get|trace|list|export|instrument|load)_[a-z0-9_]+\b/g;
  const used = new Set(codeSpans(text).flatMap((s) => s.match(re) || []));
  assert.ok(used.size >= 20, `expected the REA tool set, found ${used.size}`);
  for (const n of used) assert.ok(names.has(n), `REA has no tool "${n}"`);
  const docs = corpus(listDir(path.join(TOOLS, 'rea/docs'), (f) => f.endsWith('.md')));
  for (const v of new Set(text.match(/\b(?:REA|GHIDRA|JAVA)_[A-Z_]+\b/g) || [])) {
    assert.ok(docs && docs.includes(v), `REA docs never mention ${v}`);
  }
});

test('flags passed to vendored tools through "hades tools run" exist in those tools', (t) => {
  const sources = {
    semgrep: [path.join(TOOLS, 'semgrep/cli/src/semgrep/commands/scan.py')],
    gitleaks: listDir(path.join(TOOLS, 'gitleaks/cmd'), (f) => f.endsWith('.go')),
    trivy: ['trivy_image.md', 'trivy_filesystem.md'].map((f) =>
      path.join(TOOLS, 'trivy/docs/guide/references/configuration/cli', f)),
    rea: [path.join(TOOLS, 'rea/docs/cli.md')],
    serena: [path.join(TOOLS, 'serena/src/serena/cli.py')],
  };
  let checked = 0;
  for (const { name, line } of hadesInvocations()) {
    const m = /^tools run (\S+) -- (.+)$/.exec(line);
    if (!m || !sources[m[1]]) continue;
    const src = corpus(sources[m[1]]);
    if (!src) continue;
    for (const f of m[2].match(/--[a-z][a-z0-9-]*/g) || []) {
      const ok = src.includes(f) || src.includes(`"${f.slice(2)}"`);
      assert.ok(ok, `${name}: ${m[1]} has no flag ${f}`);
      checked++;
    }
  }
  if (!checked) t.skip('no vendored tool sources checked out');
});

// ---- review regressions (confirmed findings) ----

test('pipeline:F4 / C6 + C5: security-testing.md tests the locally run app and honours the team DAST settings', async () => {
  const text = playbook('security-testing.md');
  const local = 'hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target';
  assert.ok(text.includes(local), 'local DAST command when nothing is deployed');
  assert.match(text, /No deployed environment \(`08`: `none`, `pending-push`, not provisioned\)/);
  assert.match(text, /stop it afterwards/, 'the local app is stopped');
  const { SECURITY_KEYS } = await import('../lib/commands/team.mjs');
  for (const key of ['dast_live', 'dast_test']) {
    const m = new RegExp('security\\.' + key + '`\\s+\\(`([a-z|]+)`\\)').exec(text);
    assert.ok(m, `security-testing.md names ${key} with its values`);
    assert.deepEqual(m[1].split('|'), SECURITY_KEYS[key], `${key} values match hades team set`);
  }
});

test('pipeline:F2: QA and security route cross-cutting failures per layer; tech-lead owns glue only', () => {
  for (const name of ['qa-automation.md', 'security-testing.md']) {
    const text = playbook(name);
    assert.match(text, /one defect per\s+(affected\s+)?layer/, `${name}: one defect per layer`);
    assert.match(text, /glue between layers[^\n]*\n?[^\n]*-> `tech-lead`/, `${name}: tech-lead owns glue`);
    assert.doesNotMatch(text, /cross-cutting design flaw -> `tech-lead`|`tech-lead` for cross-cutting integration/, `${name}: old routing gone`);
  }
});

test('pipeline:F9: qa-automation.md defines the size-L smoke round on the test environment', () => {
  const text = playbook('qa-automation.md');
  assert.match(text, /Smoke round \(size L, after a deploy to test\): only the TCs `06` marks `smoke`/);
});
