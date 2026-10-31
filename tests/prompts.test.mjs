// Contract checks for the prompt layer: agents/*.md, skills/*/SKILL.md, company/*.md,
// playbooks/**/*.md, templates/**, HADES.md and hooks/README.md against the CLI (bin/hades.mjs,
// lib/commands/*.mjs, exported constants), the engine's files and the vendored MCP servers.
// No network, no machine config: only files inside the engine repository are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, STAGE_STATUS, SIZES, DEFECT_SOURCES, DEFECT_OWNERS, MAX_ROUNDS } from '../lib/core/task.mjs';
import { PRESETS } from '../lib/core/gate.mjs';
import { COMMAND_KEYS } from '../lib/core/detect.mjs';
import { MCP_SERVERS } from '../lib/core/tools.mjs';
import { ENV_FIELDS, SECURITY_KEYS, BRANCH_STRATEGIES } from '../lib/commands/team.mjs';
import { renderVars } from '../lib/commands/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;
const isDir = (rel) => exists(rel) && fs.statSync(path.join(ROOT, rel)).isDirectory();

function walk(dir, keep = () => true) {
  const out = [];
  if (!isDir(dir)) return out;
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out.sort();
}

const AGENTS = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => /^hades-.+\.md$/.test(f)).map((f) => `agents/${f}`).sort();
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter((d) => exists(`skills/${d}/SKILL.md`)).map((d) => `skills/${d}/SKILL.md`).sort();
const COMPANY = walk('company', (f) => f.endsWith('.md'));
const PLAYBOOKS = walk('playbooks', (f) => f.endsWith('.md'));
const TEMPLATES = walk('templates');
const OTHER = ['HADES.md', 'hooks/README.md', 'agents/README.md'];
const ALL = [...AGENTS, ...SKILLS, ...COMPANY, ...PLAYBOOKS, ...TEMPLATES, ...OTHER];
// Files whose engine-relative references (`company/x.md`) point into the engine. Templates are
// vault-relative and technology playbooks cite project paths (`bin/rails`), so both are left out.
const ENGINE_RELATIVE = [...AGENTS, ...SKILLS, ...COMPANY, ...PLAYBOOKS.filter((f) => !f.startsWith('playbooks/tech/') || f.endsWith('/README.md')), ...OTHER];

// ---------------------------------------------------------------- minimal YAML (frontmatter)

function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  return m ? { yaml: m[1], body: text.replace(/\r\n/g, '\n').slice(m[0].length) } : null;
}

// Splits a flow list body on commas outside quotes.
function splitFlow(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (q === '"' && ch === '\\') cur += s[++i];
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  assert.equal(q, null, `unterminated quote in [${s}]`);
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scalar(raw, where) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    assert.ok(v.length > 1 && v.endsWith('"'), `${where}: unterminated string`);
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    assert.ok(v.length > 1 && v.endsWith("'"), `${where}: unterminated string`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('[')) {
    assert.ok(v.endsWith(']'), `${where}: unterminated flow list`);
    return splitFlow(v.slice(1, -1)).map((x) => scalar(x, where));
  }
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return Number(v);
  assert.doesNotMatch(v, /: |\s#|^[&*!|>%@`{[\]]/, `${where}: plain value needs quotes: ${v}`);
  return v;
}

// key: value, nested maps, block lists ("- x", "- key: value" maps), flow lists, quoted strings.
function parseYaml(text, where) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    assert.ok(!line.includes('\t'), `${where}:${i + 2}: tab in frontmatter`);
    if (line.trim() && !line.trim().startsWith('#')) lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), n: i + 2 });
  });
  let i = 0;
  const KEY = /^([A-Za-z_][\w-]*):(?: (.*))?$/;
  const isItem = (l) => l.text === '-' || l.text.startsWith('- ');
  function block(indent) {
    return isItem(lines[i]) ? list(indent) : map(indent);
  }
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const { text, n } = lines[i];
      const m = KEY.exec(text);
      assert.ok(m, `${where}:${n}: expected "key: value", got: ${text}`);
      assert.ok(!(m[1] in obj), `${where}:${n}: duplicate key ${m[1]}`);
      i++;
      if (m[2] !== undefined && m[2].trim() !== '') obj[m[1]] = scalar(m[2], `${where}:${n}`);
      else if (i < lines.length && lines[i].indent > indent) obj[m[1]] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && isItem(lines[i])) obj[m[1]] = list(indent);
      else obj[m[1]] = null;
    }
    if (i < lines.length) assert.ok(lines[i].indent < indent, `${where}:${lines[i].n}: bad indentation`);
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const { text, n } = lines[i];
      const rest = text.slice(1).trim();
      if (KEY.test(rest)) {
        lines[i] = { indent: indent + 2, text: rest, n };
        arr.push(map(indent + 2));
      } else {
        i++;
        arr.push(scalar(rest, `${where}:${n}`));
      }
    }
    return arr;
  }
  const doc = lines.length ? map(0) : {};
  assert.equal(i, lines.length, `${where}: frontmatter not fully parsed (line ${lines[i] && lines[i].n})`);
  return doc;
}

function frontmatterOf(file) {
  const fm = splitFrontmatter(read(file));
  assert.ok(fm, `${file}: no frontmatter`);
  return { data: parseYaml(fm.yaml, file), body: fm.body, yaml: fm.yaml };
}

const toolList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

// ---------------------------------------------------------------- CLI contract

function cliContract() {
  const bin = read('bin/hades.mjs');
  const block = /const COMMANDS = \{([\s\S]*?)\n\};/.exec(bin);
  assert.ok(block, 'bin/hades.mjs has a COMMANDS table');
  const commands = {};
  const flags = {};
  for (const m of block[1].matchAll(/^\s+([a-z][a-z-]*): '([^']*)'/gm)) {
    const subs = new Set();
    const list = /:\s*([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)+)\s*$/.exec(m[2]);
    if (list) for (const s of list[1].split('|')) subs.add(s.trim());
    const file = `lib/commands/${m[1]}.mjs`;
    const known = new Set(['--json', '--help']);
    if (exists(file)) {
      const src = read(file);
      for (const x of src.matchAll(/\bsub === '([a-z][a-z-]*)'/g)) subs.add(x[1]);
      const table = /const SUBS = \{([\s\S]*?)\};/.exec(src);
      if (table) for (const x of table[1].matchAll(/^\s+([a-z][a-z-]*):/gm)) subs.add(x[1]);
      // Flags: every --flag the command's help and messages name, plus its allow(args, [...]) lists.
      for (const x of src.matchAll(/--[a-z][a-z0-9-]*/g)) known.add(x[0]);
      for (const x of src.matchAll(/allow\(args, \[([^\]]*)\]/g)) {
        for (const k of x[1].matchAll(/'([A-Za-z]+)'/g)) known.add(`--${k[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      }
    }
    subs.delete('help');
    commands[m[1]] = subs;
    flags[m[1]] = known;
  }
  assert.ok(Object.keys(commands).length >= 10, 'COMMANDS parsed');
  for (const name of Object.keys(commands)) assert.ok(exists(`lib/commands/${name}.mjs`), `command ${name} has lib/commands/${name}.mjs`);
  return { commands, flags };
}

function tokens(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^[[(]+/, '').replace(/[.,;:)\]]+$/, ''));
}

// Every "hades <command> ..." in a text: args run to the end of the code span or line.
function cliCalls(text) {
  const out = [];
  const re = /(?:(?<![\w/.@$-])hades|\/bin\/hades\.mjs) ([^\n`]*)/g;
  for (const m of text.matchAll(re)) {
    const lineNo = text.slice(0, m.index).split('\n').length;
    out.push({ line: lineNo, toks: tokens(m[1]) });
  }
  return out;
}

// A concrete value, a placeholder with alternatives (<a|b>) or a bare placeholder (<x>, null).
function alternatives(tok) {
  if (!tok) return null;
  const t = tok.replace(/^["']|["']$/g, '');
  if (/^[<[]/.test(t) && !t.includes('|')) return null;
  if (t.startsWith('$') || t === '...' || t.startsWith('--')) return null;
  return t.replace(/^[<[]|[>\]]$/g, '').split('|').filter(Boolean);
}

function checkValues(where, what, tok, allowed) {
  const alts = alternatives(tok);
  if (!alts) return;
  for (const a of alts) assert.ok(allowed.includes(a), `${where}: ${what} "${a}" not in {${allowed.join(', ')}}`);
}

function flagValue(toks, flag) {
  const i = toks.indexOf(flag);
  return i >= 0 ? toks[i + 1] : undefined;
}

// ---------------------------------------------------------------- MCP tool names

function serenaTools() {
  const dir = 'tools/serena/src/serena/tools';
  if (!isDir(dir)) return null;
  const names = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.py'))) {
    for (const m of read(`${dir}/${f}`).matchAll(/^class (\w+)\(([^)]*)\)/gm)) {
      if (!/\bTool\b|Editing/.test(m[2])) continue;
      const base = m[1].endsWith('Tool') ? m[1].slice(0, -4) : m[1];
      names.add(base.replace(/[A-Z]/g, (c, k) => (k ? '_' : '') + c.toLowerCase()));
    }
  }
  return names.size ? names : null;
}

function playwrightTools() {
  if (exists('tools/playwright-mcp/README.md')) {
    const s = new Set([...read('tools/playwright-mcp/README.md').matchAll(/^- \*\*(browser_[a-z_]+)\*\*/gm)].map((m) => m[1]));
    if (s.size) return s;
  }
  const research = '.hades/research/playwright-mcp.md';
  return exists(research) ? new Set(read(research).match(/\bbrowser_[a-z_]+\b/g)) : null;
}

function reaTools() {
  const src = 'tools/rea/src/contracts/toolEffects.ts';
  if (exists(src)) return new Set([...read(src).matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((m) => m[1]));
  const research = '.hades/research/rea.md';
  if (!exists(research)) return null;
  const s = new Set();
  for (const m of read(research).matchAll(/^- (?:executesForeignCode|mutatesDevice) \(\d+[^)]*\):(.*)$/gm)) {
    for (const n of m[1].split(',')) if (n.trim()) s.add(n.trim().replace(/\.$/, ''));
  }
  return s.size ? s : null;
}

const MCP_TOOLS = { serena: serenaTools(), playwright: playwrightTools(), rea: reaTools() };

function knownTool(server, name) {
  const set = MCP_TOOLS[server];
  if (!set) return true; // source not available here (submodule not checked out)
  if (name.endsWith('*')) return [...set].some((n) => n.startsWith(name.slice(0, -1)));
  return set.has(name);
}

// ================================================================ tests

test('agent frontmatter is valid YAML with the required fields', () => {
  assert.ok(AGENTS.length >= 11, `expected the full roster, found ${AGENTS.length}`);
  const KNOWN = new Set(['name', 'description', 'model', 'effort', 'maxTurns', 'permissionMode', 'omitClaudeMd', 'disallowedTools', 'tools', 'mcpServers', 'color', 'skills', 'memory', 'hooks', 'background', 'isolation', 'initialPrompt']);
  for (const file of AGENTS) {
    const { data, yaml } = frontmatterOf(file);
    for (const k of Object.keys(data)) assert.ok(KNOWN.has(k), `${file}: unknown frontmatter key ${k}`);
    assert.match(String(data.name), /^hades-[a-z]+(-[a-z]+)*$/, `${file}: name`);
    assert.equal(`agents/${data.name}.md`, file, `${file}: name matches the file name`);
    assert.ok(typeof data.description === 'string' && data.description.length >= 40, `${file}: description`);
    assert.ok(['opus', 'sonnet', 'haiku', 'fable'].includes(data.model), `${file}: model ${data.model}`);
    assert.equal(data.permissionMode, 'bypassPermissions', `${file}: permissionMode`);
    assert.equal(data.omitClaudeMd, true, `${file}: omitClaudeMd`);
    assert.ok(['low', 'medium', 'high'].includes(data.effort), `${file}: effort`);
    assert.ok(Number.isInteger(data.maxTurns) && data.maxTurns > 0, `${file}: maxTurns`);
    const denied = toolList(data.disallowedTools);
    for (const t of ['Agent', 'AskUserQuestion']) assert.ok(denied.includes(t), `${file}: disallowedTools lacks ${t}`);
    assert.equal(new Set(denied).size, denied.length, `${file}: duplicate disallowedTools`);
    const servers = [];
    if (data.mcpServers !== undefined) {
      assert.ok(Array.isArray(data.mcpServers), `${file}: mcpServers is a list`);
      for (const entry of data.mcpServers) {
        const keys = Object.keys(entry);
        assert.equal(keys.length, 1, `${file}: one server per mcpServers item`);
        const [name] = keys;
        assert.ok(MCP_SERVERS.includes(name), `${file}: unknown MCP server ${name}`);
        // hades install renders the absolute Node binary that ran it (renderVars NODE)
        assert.equal(entry[name].command, '{{NODE}}', `${file}: ${name} command`);
        assert.deepEqual(entry[name].args, ['{{HADES_HOME}}/bin/hades.mjs', 'mcp', name], `${file}: ${name} args`);
        servers.push(name);
      }
      // quoted: a rendered path is a YAML string whatever characters it holds
      for (const m of yaml.matchAll(/^\s*command:\s*(.*)$/gm)) assert.equal(m[1].trim(), '"{{NODE}}"', `${file}: command must be "{{NODE}}"`);
      for (const m of yaml.matchAll(/^\s*args:\s*\[(.*)\]\s*$/gm)) {
        for (const a of splitFlow(m[1])) assert.match(a, /^"[^"]*"$/, `${file}: args must be quoted (${a})`);
      }
    }
    for (const t of denied.filter((x) => x.startsWith('mcp__'))) {
      const m = /^mcp__([a-z]+)__([a-z0-9_]+)$/.exec(t);
      assert.ok(m, `${file}: malformed MCP tool id ${t}`);
      assert.ok(servers.includes(m[1]), `${file}: denies ${t} but does not declare server ${m[1]}`);
      assert.ok(knownTool(m[1], m[2]), `${file}: ${m[1]} has no tool "${m[2]}"`);
    }
    if (servers.includes('serena')) {
      for (const t of ['execute_shell_command', 'serena_repl', 'write_memory', 'onboarding']) {
        assert.ok(denied.includes(`mcp__serena__${t}`), `${file}: serena users deny ${t}`);
      }
    }
    if (servers.includes('playwright')) assert.ok(denied.includes('mcp__playwright__browser_run_code_unsafe'), `${file}: deny browser_run_code_unsafe`);
  }
});

test('skill frontmatter is valid YAML; names match their folders', () => {
  assert.ok(SKILLS.length >= 4);
  for (const file of SKILLS) {
    const { data } = frontmatterOf(file);
    assert.equal(`skills/${data.name}/SKILL.md`, file, `${file}: name matches the folder`);
    assert.ok(typeof data.description === 'string' && data.description.length >= 30, `${file}: description`);
  }
});

// The /hades skill is loaded once per PM session (not per spawn); 215 leaves room for the Resume section.
test('line budgets: agents <= 110 body lines, /hades skill <= 215, other skills <= 120, tech playbooks <= 70', () => {
  for (const file of AGENTS) {
    const n = lineCount(splitFrontmatter(read(file)).body);
    assert.ok(n <= 110, `${file}: ${n} body lines (limit 110)`);
  }
  for (const file of SKILLS) {
    const n = lineCount(read(file));
    const limit = file === 'skills/hades/SKILL.md' ? 215 : 120;
    assert.ok(n <= limit, `${file}: ${n} lines (limit ${limit})`);
  }
  for (const file of PLAYBOOKS.filter((f) => f.startsWith('playbooks/tech/'))) {
    const n = lineCount(read(file));
    assert.ok(n <= 70, `${file}: ${n} lines (limit 70)`);
  }
});

test('return contract: 8 lines for every agent; scout and curator exceptions', () => {
  const KEYS = ['STATUS', 'OUTPUT', 'SUMMARY', 'GATE', 'DEFECTS', 'DECISIONS', 'LESSONS', 'NEXT'];
  for (const file of AGENTS) {
    const ret = read(file).split('\n## Return\n')[1];
    assert.ok(ret, `${file}: has a "## Return" section`);
    if (file === 'agents/hades-scout.md') {
      assert.match(ret, /at most 40 `key: value` lines/, `${file}: scout returns up to 40 facts`);
      continue;
    }
    const keys = ret.split('\n').filter((l) => /^[A-Z]+: /.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(keys, KEYS, `${file}: return keys`);
  }
  assert.match(read('agents/hades-knowledge-curator.md'), /^OUTPUT: .*absolute/m, 'curator OUTPUT lists absolute vault paths');
});

test('placeholders: agents and skills use the installer vars; playbooks use <engine>/<vault> defined at the top', () => {
  const vars = Object.keys(renderVars({ engine: 'e', vault: 'v', workspace: 'w' })).sort();
  assert.deepEqual(vars, ['HADES_HOME', 'HADES_VAULT', 'HADES_WORKSPACE', 'NODE']);
  for (const file of [...AGENTS, ...SKILLS]) {
    const text = read(file);
    for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(vars.includes(m[1]), `${file}: {{${m[1]}}}`);
    for (const line of text.split(/\r?\n/).filter((l) => l.includes('{{NODE}}'))) {
      assert.match(line, /^ {6}command: "\{\{NODE\}\}"$/, `${file}: {{NODE}} only as an MCP server command`);
    }
    assert.doesNotMatch(text, /<engine>|<vault>/, `${file}: rendered files use {{HADES_HOME}}/{{HADES_VAULT}}`);
  }
  for (const file of PLAYBOOKS) {
    const text = read(file);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `${file}: playbooks are not rendered; use <engine>/<vault>`);
    if (/<engine>|<vault>/.test(text)) {
      const head = text.split('\n').slice(0, 15).join('\n');
      assert.ok(head.includes('`<engine>` = the directory of the hades CLI in your handover'), `${file}: defines <engine> at the top`);
      assert.ok(head.includes('`<vault>` = the vault root'), `${file}: defines <vault> at the top`);
    }
  }
});

test('every engine path referenced by the prompt layer exists', () => {
  const RUNTIME = /^(\.hades|\.tools-bin|vault|hades\.config\.json)(\/|$)/;
  const missing = [];
  let checked = 0;
  const check = (file, rel, kind) => {
    rel = rel.replace(/\/+$/, '');
    if (!rel || RUNTIME.test(rel)) return;
    const sub = /^tools\/([^/]+)\//.exec(rel);
    if (sub && (!isDir(`tools/${sub[1]}`) || !fs.readdirSync(path.join(ROOT, 'tools', sub[1])).length)) return;
    checked++;
    if (!(kind === 'dir' ? isDir(rel) : exists(rel))) missing.push(`${file}: ${rel}`);
  };
  for (const file of ALL) {
    const text = read(file)
      .replace(/\{\{HADES_HOME\}\}|\{\{ENGINE\}\}/g, '<engine>')
      .replace(/\$KIT(?=\/)/g, '<engine>/tools/aws-agent-toolkit');
    for (const m of text.matchAll(/<engine>((?:\/[A-Za-z0-9_.@+-]+)*)(\/?)([<*{$]?)/g)) {
      const p = m[1].replace(/[.,;:]+$/, '').slice(1);
      if (m[3] || (m[2] && !p)) check(file, p, 'dir');
      else check(file, p, m[2] ? 'dir' : 'any');
    }
    if (!ENGINE_RELATIVE.includes(file)) continue;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1].trim();
      if (/^(company|playbooks|docs|hooks|templates|bin|lib|skills|agents|tests)\/[A-Za-z0-9_./-]+$/.test(span)) check(file, span, 'any');
      else if (/^\.\.\/[A-Za-z0-9_./-]+$/.test(span)) check(file, path.posix.normalize(`${path.posix.dirname(file)}/${span}`), 'any');
    }
  }
  assert.ok(checked >= 50, `expected many path references, checked ${checked}`);
  assert.deepEqual(missing, [], `missing engine paths:\n${missing.join('\n')}`);
});

test('every "hades <command> <sub>" names a real command, subcommand, flag and value', () => {
  const { commands, flags } = cliContract();
  for (const s of ['team set', 'task plan', 'task coverage', 'defect add']) {
    const [c, sub] = s.split(' ');
    assert.ok(commands[c] && commands[c].has(sub), `CLI has "${s}"`);
  }
  const STATUS = { 'task close': ['done', 'blocked'], 'defect update': ['fixed', 'verified', 'reopened', 'wontfix'] };
  let seen = 0;
  for (const file of ALL) {
    for (const { line, toks } of cliCalls(read(file))) {
      const where = `${file}:${line}: hades ${toks.join(' ')}`;
      const [cmd, sub] = toks;
      if (!cmd || !/^[a-z][a-z-]*$/.test(cmd)) continue;
      seen++;
      assert.ok(commands[cmd], `${where}: unknown command "${cmd}"`);
      if (commands[cmd].size && sub && /^[a-z][a-z-]*$/.test(sub)) assert.ok(commands[cmd].has(sub), `${where}: unknown subcommand "${cmd} ${sub}"`);
      const own = toks.indexOf('--') < 0 ? toks : toks.slice(0, toks.indexOf('--')); // after " -- ": the tool's own args
      for (const t of own.filter((x) => /^--[a-z]/.test(x))) {
        assert.ok(flags[cmd].has(t.split('=')[0]), `${where}: "hades ${cmd}" has no flag ${t}`);
      }
      const key = `${cmd} ${sub}`;
      checkValues(where, '--source', flagValue(toks, '--source'), DEFECT_SOURCES);
      checkValues(where, '--owner', flagValue(toks, '--owner'), DEFECT_OWNERS);
      checkValues(where, '--preset', flagValue(toks, '--preset'), Object.keys(PRESETS));
      if (STATUS[key]) checkValues(where, '--status', flagValue(toks, '--status'), STATUS[key]);
      if (key === 'task deploy') checkValues(where, '--env', flagValue(toks, '--env'), ['test', 'live', 'none', 'pending-push']);
      if (key === 'task stage') {
        checkValues(where, 'stage', toks[3], STAGES);
        checkValues(where, 'stage status', toks[4], STAGE_STATUS);
      }
      if (key === 'task size') checkValues(where, 'size', toks[3], SIZES);
      if (key === 'task item') checkValues(where, 'item status', toks[4], ['todo', 'doing', 'done']);
      if (key === 'team set') {
        const what = toks[3];
        checkValues(where, 'team set', what, ['command', 'env', 'security', 'branch-strategy', 'project']);
        if (what === 'command') checkValues(where, 'command key', toks[4], COMMAND_KEYS);
        if (what === 'env') {
          checkValues(where, 'environment', toks[4], ['test', 'live']);
          checkValues(where, 'environment field', toks[5], ENV_FIELDS);
        }
        if (what === 'security') checkValues(where, 'security key', toks[4], Object.keys(SECURITY_KEYS));
        if (what === 'branch-strategy') checkValues(where, 'branch strategy', toks[4], BRANCH_STRATEGIES);
        if (what === 'project') checkValues(where, 'project action', toks[4], ['add', 'remove']);
      }
    }
  }
  assert.ok(seen >= 150, `expected many hades invocations, found ${seen}`);
});

test('MCP tool names in agent bodies and playbooks exist in the vendored servers', () => {
  const SERENA = /^(?:get|find|replace|insert|rename|safe|write|read|list|delete|edit|activate|initial|execute|serena|search|restart)_[a-z_]+$/;
  let checked = 0;
  for (const file of [...AGENTS, ...PLAYBOOKS]) {
    const text = file.startsWith('agents/') ? splitFrontmatter(read(file)).body : read(file);
    for (const n of new Set(text.match(/\bbrowser_[a-z_]+\*?/g) || [])) {
      checked++;
      assert.ok(knownTool('playwright', n), `${file}: Playwright MCP has no tool "${n}"`);
    }
    if (!file.startsWith('agents/')) continue;
    for (const m of text.matchAll(/`([a-z_]+)`/g)) {
      if (!SERENA.test(m[1])) continue;
      checked++;
      assert.ok(knownTool('serena', m[1]), `${file}: Serena has no tool "${m[1]}"`);
    }
  }
  assert.ok(checked >= 10, `expected tool names to check, found ${checked}`);
});

test('decisions are reflected: stages, defect sources, README sections, guard matcher, Node 22', () => {
  const stageList = STAGES.join(' ');
  for (const file of ['skills/hades/SKILL.md', 'company/pipeline.md']) assert.ok(read(file).includes(stageList), `${file} lists the stages in order`);
  const rows = [...read('HADES.md').matchAll(/^\| \d+ \| ([a-z]+) \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows, STAGES, 'HADES.md pipeline table follows the stage machine');
  for (const src of DEFECT_SOURCES) assert.match(read('skills/hades/SKILL.md'), new RegExp(`--source ${src}|source \`${src}\``), `PM skill handles defect source ${src}`);
  const readme = read('templates/task/README.md');
  assert.match(readme, /^## Decisions$/m, 'task README has a "## Decisions" section');
  assert.match(readme, /^## Lessons$/m, 'task README has a Lessons section');
  assert.match(read('hooks/README.md'), /"matcher": "Bash\|PowerShell\|Read\|Write\|Edit\|MultiEdit\|NotebookEdit\|Grep\|mcp__serena__\.\*"/, 'guard matcher');
  for (const file of ALL) assert.doesNotMatch(read(file), /\bNode(?:\.js)? *(?:>= *)?(?:1[0-9]|20|21)\b/, `${file}: Node >= 22`);
  const close = read('skills/hades/SKILL.md').split('**close**')[1];
  assert.ok(close.indexOf('hades task close') < close.indexOf('Vault commit'), 'close order: task close, then the vault commit');
});

test('no private names in engine files (outside tests/fixtures)', () => {
  // Stored reversed so this file does not contain them.
  const names = ['sargsam', 'siri', 'amrahp', 'draob-eciton', 'erdac-vog', 'tol-niw', 'asarp'].map((s) => [...s].reverse().join(''));
  const re = new RegExp(`\\b(?:${names.join('|')})\\b`, 'i');
  const SKIP_DIRS = new Set(['.git', 'node_modules', '.hades', '.tools-bin', 'vault', 'tests/fixtures']);
  const files = [];
  (function scan(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir || '.'), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(e.name) || (dir === 'tools')) continue; // tools/<name> = vendored data
        scan(rel);
      } else if (rel !== 'hades.config.json') files.push(rel);
    }
  })('');
  const hits = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      if (rel.startsWith('tests/') && line.includes('doesNotMatch')) return; // negative assertions name them
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.ok(files.length > 50, 'scanned the engine');
  assert.deepEqual(hits, [], `private names found:\n${hits.join('\n')}`);
});

// ================================================================ review regressions
// Each test reproduces a confirmed review finding (id in the name) against the prompt layer and docs.

const section = (text, start, end) => {
  const i = text.indexOf(start);
  assert.ok(i >= 0, `section "${start}" exists`);
  const j = end ? text.indexOf(end, i + start.length) : -1;
  return j > i ? text.slice(i, j) : text.slice(i);
};
const SKILL = () => read('skills/hades/SKILL.md');
const LOCAL_DAST = 'hades gate <task> --dast http://localhost:<port> --mode full --i-own-this-target';

test('C7: the task README heading is "## Decisions"; no file still names "Assumptions & decisions"', () => {
  assert.match(read('templates/task/README.md'), /^## Decisions\n/m);
  for (const file of [...ALL, ...walk('docs', (f) => f.endsWith('.md'))]) {
    assert.doesNotMatch(read(file), /Assumptions & decisions/, `${file}: renamed heading`);
  }
  assert.match(SKILL(), /README `## Decisions` section/, 'the PM writes DECISIONS under ## Decisions');
});

test('pipeline:F1 + F2: every defect owner has a fix procedure; tech-lead fixes glue and may write the project', () => {
  for (const owner of DEFECT_OWNERS) {
    const file = `agents/hades-${owner}.md`;
    assert.ok(exists(file), `owner ${owner} has an agent`);
    assert.ok(read(file).includes(`--status fixed --by ${owner}`), `${file}: a fix procedure that marks its defects fixed`);
  }
  const tl = read('agents/hades-tech-lead.md');
  assert.match(tl, /\*\*fix <D#\.\.\.>\*\* \(defects owned by `tech-lead`\)/, 'tech lead lists fix mode');
  assert.match(tl, /Write scope: .*the project only for the skeleton, integration glue and glue defects/, 'tech lead write scope');
  assert.match(SKILL(), /owner `tech-lead` -> `hades-tech-lead` fix mode/, 'PM routes tech-lead defects to its fix mode');
  // QA and security send cross-cutting failures to the engineers of each layer, tech-lead only glue.
  for (const file of ['playbooks/qa-automation.md', 'playbooks/security-testing.md', 'company/pipeline.md']) {
    const text = read(file);
    assert.match(text, /one defect per\s+(affected\s+)?layer/, `${file}: cross-cutting -> one defect per layer`);
    assert.doesNotMatch(text, /cross-cutting (design flaw|integration)\)? -> `tech-lead`|`tech-lead` for cross-cutting/, `${file}: no cross-cutting defects for the tech lead`);
  }
  // The guard's role scope must allow what the prompt asks of the tech lead (skeleton, glue).
  const roles = JSON.parse(read('hooks/guard-policy.json')).roles;
  assert.ok(roles['hades-tech-lead'].includes('{projects}'), 'guard policy: hades-tech-lead may write registered projects');
  for (const file of AGENTS) {
    const scope = (read(file).match(/^- Write scope: (.*)$/m) || [])[1];
    if (!scope || /Never modify the project|only \(|inside `\{\{HADES_VAULT\}\}` only/.test(scope) || !/\bproject\b/.test(scope)) continue;
    const name = path.basename(file, '.md');
    assert.ok((roles[name] || []).includes('{projects}'), `${file} writes the project but guard role ${name} lacks {projects}`);
  }
});

test('pipeline:F4 / C6: with no deployed environment the running app is still security-tested locally', () => {
  for (const file of ['agents/hades-cybersecurity-engineer.md', 'playbooks/security-testing.md', 'skills/hades/SKILL.md', 'company/pipeline.md', 'company/security-policy.md']) {
    assert.ok(read(file).includes(LOCAL_DAST), `${file}: local DAST command`);
  }
  assert.doesNotMatch(read('company/pipeline.md'), /No deploy: source level only/, 'pipeline no longer skips runtime tests');
  const cyber = read('agents/hades-cybersecurity-engineer.md');
  assert.match(cyber, /`none`\/`pending-push`\/not provisioned/, 'cybersecurity engineer names the no-deploy cases');
  assert.match(cyber, /then stop it/, 'the local app is stopped afterwards');
});

test('pipeline:F5 + install-autonomy:F6 + opensource:OSS-4: guarded mode is documented exactly; PM git and CLI calls match allow rules', async () => {
  const doc = read('docs/autonomy-and-safety.md');
  assert.doesNotMatch(doc, /routine PM steps do not prompt/, 'the false claim is gone');
  assert.doesNotMatch(doc, /^HADES works without asking you anything after the requirements\./m);
  for (const s of ['hades run', '--autonomy full', 'What still prompts in guarded mode', 'Bash(git -C * add *)', 'never']) assert.ok(doc.includes(s), `autonomy doc mentions ${s}`);
  for (const file of ['README.md', 'docs/getting-started.md']) assert.match(read(file), /--autonomy full/, `${file}: names the prompt-free install`);
  const { allowRules } = await import('../lib/core/settings.mjs');
  const engine = '/opt/hades';
  const rules = allowRules(engine).map((r) => /^Bash\((.*)\)$/.exec(r)).filter(Boolean).map((m) => m[1]);
  const matches = (cmd) => rules.some((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(cmd));
  // Every git -C command the PM runs (the owner's push excepted) is pre-allowed.
  const pmGit = new Set();
  for (const file of ['skills/hades/SKILL.md', 'skills/hades-learn/SKILL.md']) {
    for (const m of read(file).matchAll(/`git -C (\S+) ([a-z-]+)([^`]*)`/g)) if (m[2] !== 'push') pmGit.add(`git -C /repo ${m[2]}${m[3]}`.replace(/<[^>]+>/g, 'x'));
  }
  assert.ok(pmGit.size >= 4, `PM git commands found: ${[...pmGit]}`);
  for (const cmd of pmGit) assert.ok(matches(cmd), `no allow rule matches the PM command "${cmd}"`);
  // The PM's routine CLI calls are pre-allowed; run/install/migrate/tools bump never are. The CLI
  // prefix is taken from the rules themselves (quoted or not), as install renders it.
  const cliRule = rules.find((r) => r.includes('/bin/hades.mjs'));
  assert.ok(cliRule, 'an allow rule for the hades CLI');
  const cli = /^(.*\/bin\/hades\.mjs"?) /.exec(cliRule)[1];
  for (const sub of ['task show portal-001', 'task stage portal-001 qa running --model sonnet', 'defect list portal-001 --open', 'gate portal-001 --preset build', 'team resolve portal', 'team set portal env test url "https://x"', 'detect /p --write portal', 'usage --task portal-001']) {
    assert.ok(matches(`${cli} ${sub}`), `routine "hades ${sub}" is pre-allowed`);
  }
  for (const sub of ['run "x"', 'install --autonomy full', 'migrate', 'tools bump trivy v1']) {
    assert.ok(!matches(`${cli} ${sub}`), `"hades ${sub}" must never be pre-allowed`);
  }
  // An engine path with a space is quoted in the rules (C4), so the rule still matches the call.
  for (const r of allowRules('/opt/my hades').filter((x) => x.includes('hades.mjs'))) assert.ok(r.includes('"/opt/my hades/bin/hades.mjs"'), `quoted engine path: ${r}`);
});

test('pipeline:F7: an S task spawns QA once (coverage precheck is M/L only)', () => {
  const qa = section(SKILL(), '**qa** -', '**release**');
  assert.match(qa, /^\*\*qa\*\* - M\/L: wait for the test-plan return; before `qa running`/, 'precheck limited to M/L');
  assert.match(qa, /S: write targeted TCs to 06\s+first, no plan spawn/, 'S writes its TCs in the execute spawn');
  assert.match(read('company/pipeline.md'), /PM, first message \(M\/L\): QA plan mode/);
  assert.match(SKILL(), /owner and files from 02 `## Changes by layer`/, 'S plan data the PM may read');
});

test('pipeline:F9: size L gets QA smoke tests on the deployed test environment', () => {
  const deploy = section(SKILL(), '**deploy** -', '**security**');
  assert.match(deploy, /`hades-qa-engineer`, smoke mode/, 'PM spawns QA smoke after an L test deploy');
  assert.match(SKILL(), /smoke TCs marked/, 'the test plan marks smoke TCs');
  assert.match(section(SKILL(), '## 4. Defect loop', '## 5.'), /smoke: then commit `fix\(qa\): \.\.\.`/, 'smoke fixes are committed and redeployed');
  const qa = read('agents/hades-qa-engineer.md');
  assert.match(qa, /\*\*smoke <url>\*\*/, 'QA has a smoke mode');
  assert.match(qa, /## Smoke mode/);
});

test('pipeline:F10: gate G8 has an owner (tech lead plans the docs) and a check (PM at release)', () => {
  assert.match(read('agents/hades-tech-lead.md'), /project\s+docs that describe it \(README, API spec, `\.env\.example`, CHANGELOG; gate G8\)/);
  const release = section(SKILL(), '**release** -', '**deploy**');
  assert.match(release, /G8: behaviour,\s+contract or config changed -> `git -C <repo> log -1 --stat <hash>`/);
  assert.match(release, /commit `docs\(<scope>\): \.\.\.`/);
  for (const role of ['backend', 'frontend', 'aiml-data']) assert.match(read(`agents/hades-${role}-engineer.md`), /change with the code \(gate G8\)/, `${role}: docs in items are in scope`);
});

test('pipeline:F11: the PM reads CONTEXT.md, its own notes and the role model overrides', () => {
  const s = SKILL();
  for (const p of ['`<team_dir>/CONTEXT.md`', '`<team_dir>/agents/project-manager.md`']) assert.ok(s.includes(p), `PM skill: ${p}`);
  assert.match(s, /Grep `\^model:` in\s+`<team_dir>\/agents\/` and\s+`\{\{HADES_VAULT\}\}\/company\/staff\/`/, 'PM collects model overrides');
  assert.match(s, /`model`: the role's override \(intake step 5\), else omit it/, 'overrides are applied on spawn');
  assert.match(read('company/model-routing.md'), /The PM collects them at intake/);
});

test('pipeline:F12: only committed HEAD is deployed; deploy config is committed before the deploy', () => {
  assert.match(read('agents/hades-devops-engineer.md'), /Deploy only the committed HEAD/);
  assert.doesNotMatch(read('agents/hades-devops-engineer.md'), /plus only the\s+deploy config you changed/);
  assert.doesNotMatch(read('playbooks/deployment.md'), /uncommitted changes only for deploy config/);
  const deploy = section(SKILL(), '**deploy** -', '**security**');
  assert.ok(deploy.indexOf('commit `chore(deploy): ...`') < deploy.indexOf('re-spawn DevOps to deploy the new HEAD'), 'commit, then deploy');
});

test('pipeline:F13: the PM enforces the QA/security stage round cap the CLI counts', () => {
  const loop = section(SKILL(), '## 4. Defect loop', '## 5.');
  assert.match(loop, /`hades task stage <task> <src> failed --note "new D#\.\.\."`, then `hades task stage <task> <src> running`/);
  const warn = /it prints `([^`]+)`/.exec(loop);
  assert.ok(warn, 'the skill quotes the CLI warning');
  const n = /(\d+)$/.exec(warn[1]);
  assert.ok(n && Number(n[1]) === MAX_ROUNDS, `the quoted limit is MAX_ROUNDS (${MAX_ROUNDS})`);
  assert.ok(read('lib/commands/task.mjs').includes(warn[1].replace(/\d+$/, '${MAX_ROUNDS}')), `the CLI prints "${warn[1]}"`);
});

test('pipeline:F15: the vault commit covers team.json and every vault file the task changed', () => {
  const close = section(SKILL(), '**close**', '## 4.');
  assert.ok(close.includes('`git -C {{HADES_VAULT}} add -A -- <team_dir> <org_dir> company registry.json`'), 'scoped add -A');
  assert.match(close, /minus the intake ones/, 'never foreign dirty files');
  assert.match(read('company/commit-policy.md'), /`team\.json` \(changed by `hades team set`/);
});

test('install-autonomy:F9: /hades-new-team moves Claude files with the forms the guard allows', () => {
  const s = read('skills/hades-new-team/SKILL.md');
  assert.ok(s.includes('`cp -r <repo>/.claude <team_dir>/legacy/<rel repo>/dot-claude`'), 'one directory copy into legacy');
  assert.ok(s.includes('`git -C <repo> rm -r -q -- .claude <other area C paths>`'), 'tracked: the folder as one path');
  assert.match(s, /owner action: delete <paths> \(guard-protected\)/, 'guard-protected leftovers go to the owner');
  assert.doesNotMatch(s, /untracked or ignored: delete it\./, 'no blanket delete');
});

test('opensource:OSS-3 / C8: every documented "/hades-<skill> ... --flag" exists in that skill', () => {
  const hints = {};
  for (const file of SKILLS) hints[frontmatterOf(file).data.name] = String(frontmatterOf(file).data['argument-hint'] || '');
  const sources = [...ALL, 'README.md', ...walk('docs', (f) => f.endsWith('.md')), ...walk('lib', (f) => f.endsWith('.mjs'))];
  let seen = 0;
  for (const file of sources) {
    for (const m of read(file).matchAll(/\/(hades(?:-[a-z]+)*) [^`\n"']*?(--[a-z][a-z-]*)/g)) {
      if (!hints[m[1]]) continue;
      seen++;
      assert.ok(hints[m[1]].includes(m[2]), `${file}: /${m[1]} ${m[2]} is not in the skill's argument-hint`);
    }
  }
  assert.ok(seen >= 3, `expected documented skill flags, found ${seen}`);
  const learn = read('skills/hades-learn/SKILL.md');
  assert.match(learn, /`--migrate` -> migrate mode/);
  assert.match(learn, /never notes/);
  assert.match(read('playbooks/knowledge-capture.md'), /^## Migrate mode/m);
  for (const s of ['.v1.md', 'hades-migrate', 'hades detect <project> --write <team>', 'hades team set', 'CONTEXT.md', 'predate the']) {
    assert.ok(section(read('playbooks/knowledge-capture.md'), '## Migrate mode', '## Quality bar').includes(s), `migrate mode covers ${s}`);
  }
});

test('opensource:OSS-5: the quick start onboards an existing path; the skill refuses a missing one', () => {
  const quick = section(read('README.md'), '## Quick start', '## Requirements');
  const m = /\/hades-new-team \S+ (\S+)/.exec(quick);
  assert.ok(m, 'quick start onboards a project');
  assert.ok(!m[1].startsWith('..'), `quick start path "${m[1]}" must be workspace-relative or absolute, not ../`);
  assert.match(read('skills/hades-new-team/SKILL.md'), /does not exist or is not a directory -> report it and stop \(never create it/);
});

test('opensource:OSS-7: docs/cli.md stage rules match the stage machine', async () => {
  const { STAGE_DEFECT_SOURCES } = await import('../lib/commands/task.mjs');
  const cli = read('docs/cli.md');
  const rules = section(cli, '### Stages and rules', '## Defects');
  for (const [stage, sources] of Object.entries(STAGE_DEFECT_SOURCES)) {
    const want = `\`${stage}\` <- ${sources.map((s) => `\`${s}\``).join(', ')}`;
    assert.ok(rules.includes(want), `cli.md documents ${want}`);
  }
  const exit2 = cli.split('\n').find((l) => l.startsWith('| 2 |'));
  for (const stage of ['planning', ...Object.keys(STAGE_DEFECT_SOURCES)]) assert.ok(exit2.includes(stage), `exit-2 row names ${stage} done`);
  assert.doesNotMatch(rules, /\(it is not `pending`\)/);
  assert.ok(cli.includes('| `hades task adopt <v1-task-id> [--stage <first stage to run>] [--size S\\|M\\|L]`'), 'task adopt documented');
  assert.match(cli, /GATE EMPTY \(no commands configured: run hades detect --write or hades team set\)/);
  assert.match(cli, /unknown flag --x/);
});

test('opensource:OSS-8: every NOTICE or legal-notice file of a vendored tool is listed', () => {
  const lock = JSON.parse(read('tools/tools.lock.json')).tools;
  const notices = read('THIRD_PARTY_NOTICES.md');
  let checked = 0;
  for (const [name, pin] of Object.entries(lock)) {
    const row = notices.split('\n').find((l) => l.startsWith('| [') && l.includes(`(${pin.repo || pin.url})`));
    assert.ok(row, `THIRD_PARTY_NOTICES has a row for ${name}`);
    if (!isDir(`tools/${name}`)) continue;
    for (const f of fs.readdirSync(path.join(ROOT, 'tools', name)).filter((x) => /^(NOTICE|LEGALNOTICE)(\.(md|txt))?$/i.test(x))) {
      checked++;
      assert.ok(row.includes(`\`${f}\``), `${name}: ${f} missing from its THIRD_PARTY_NOTICES row`);
    }
  }
  assert.match(notices, /Clarified\s+Artistic License/, 'ZAP Paros-derived parts named');
  if (isDir('tools/mcp-proxy-for-aws') && exists('tools/mcp-proxy-for-aws/NOTICE')) assert.ok(checked >= 3, `NOTICE files checked: ${checked}`);
});

test('opensource:OSS-9: docs/tools.md states how semgrep is installed and its integrity limits', () => {
  const doc = read('docs/tools.md');
  assert.doesNotMatch(doc, /Python tools install from the vendored `uv\.lock` with\s+hashes/, 'no blanket hash claim');
  assert.match(doc, /semgrep is the exception/);
  assert.match(doc, /without hash\s+checks/);
});

test('opensource:OSS-10: LICENSE is the unmodified MIT text', () => {
  const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
  const lines = read('LICENSE').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  assert.equal(lines[0], 'MIT License');
  assert.match(lines[2], /^Copyright \(c\) \d{4} \S/);
  assert.equal(lines.slice(4).join(' ').replace(/\s+/g, ' ').trim(), MIT, 'LICENSE body is exactly the MIT text, nothing appended');
  assert.match(read('README.md'), /\[MIT\]\(LICENSE\) covers the HADES source in this repository only/, 'the submodule note lives in README');
});

test('opensource:OSS-11: clone commands use the real repository URL', () => {
  for (const file of ['README.md', 'CONTRIBUTING.md', ...walk('docs', (f) => f.endsWith('.md'))]) {
    const text = read(file);
    assert.doesNotMatch(text, /github\.com\/<owner>/, `${file}: placeholder owner`);
    for (const m of text.matchAll(/git clone [^\n]*?(https:\/\/\S+)/g)) assert.equal(m[1], 'https://github.com/prasadm1022/hades.git', `${file}: clone URL`);
  }
});

test('opensource:OSS-12: private reporting must be enabled by the maintainer; SECURITY.md has a fallback', () => {
  const sec = read('SECURITY.md');
  assert.match(sec, /private vulnerability reporting\*?\s+enabled/i);
  assert.match(sec, /contains \*\*no details\*\*/, 'detail-free public fallback');
  assert.match(read('docs/getting-started.md'), /## \d+\. Publishing checklist[\s\S]*Private vulnerability reporting/);
});

test('Resume: /hades <team> continue <task-id> handles v2 tasks and adopts v1 records without touching them', () => {
  const resume = section(SKILL(), '## 6. Resume', null);
  for (const s of ['`hades task show <task-id>` exits 0', '`hades task adopt <task-id> --stage <that stage> [--size <S|M|L>]`', '`<task-id>-artifacts/`', 'RESUME.md', 'Never move or edit v1 files']) {
    assert.ok(resume.includes(s), `Resume section: ${s}`);
  }
  assert.match(SKILL(), /argument-hint: ".*<team> continue <task-id>"/);
  assert.match(read('docs/migration-from-v1.md'), /^## Resuming a v1 task/m);
});

test('final polish: safety docs quote the real guard matcher and failure behaviour; Serena activation; deploy blocked', async () => {
  const { GUARD_MATCHER } = await import('../lib/core/settings.mjs');
  const docs = ['docs/autonomy-and-safety.md', 'README.md', 'SECURITY.md', 'hooks/README.md'];
  for (const file of docs) {
    const text = read(file);
    const found = [...text.matchAll(/Bash\|PowerShell\|[A-Za-z_|.*]+/g)].map((m) => m[0]);
    assert.ok(found.length >= 1, `${file} names the guard matcher`);
    for (const m of found) assert.equal(m, GUARD_MATCHER, `${file}: matcher`);
    assert.doesNotMatch(text, /fails? open on its own (bugs|internal errors)/i, `${file}: stale fail-open claim`);
    assert.match(text, /guard\.limit/, `${file}: budget blocks`);
  }
  for (const file of ['README.md', 'SECURITY.md', 'docs/autonomy-and-safety.md']) assert.match(read(file), /high-risk keyword/, `${file}: fail closed on high-risk keywords`);
  const serenaUsers = AGENTS.filter((f) => /^\s+- serena:/m.test(read(f)));
  assert.ok(serenaUsers.length >= 8, `serena users: ${serenaUsers.length}`);
  for (const file of [...serenaUsers, 'playbooks/code-navigation.md']) {
    assert.match(read(file).replace(/\s+/g, ' '), /`activate_project` with the absolute `<Project>` path/, `${file}: activate_project first`);
  }
  assert.match(read('docs/cli.md'), /they call `activate_project` with the absolute `<Project>` path before the first symbol tool/);
  assert.match(section(SKILL(), '**deploy** -', '**security**'), /still red after it -> stage `blocked`, not `failed`/);
});
