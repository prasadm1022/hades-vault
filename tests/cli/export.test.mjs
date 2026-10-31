// Tests for hades export: every target's files (rendered, marked, valid JSON/TOML/YAML frontmatter),
// project and user scope, merge into existing JSON configs with a backup, conflicts and --force,
// --dry-run, fallbacks, and the generated guard hooks actually running guard.mjs. Temp dirs only:
// a temp vault and workspace, and HOME/USERPROFILE/APPDATA pointing at a temp home.
// Run: node --test tests/cli/export.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeVault, cleanup, tempDir, ENGINE, slash } from '../helpers/vault.mjs';

after(cleanup);

const ROLES = fs.readdirSync(`${ENGINE}/agents`).filter((f) => /^hades-.+\.md$/.test(f)).map((f) => f.slice(0, -3)).sort();
const SKILLS = ['hades', 'hades-new-team', 'hades-learn', 'hades-status'];
const NODE = slash(process.execPath);
const WIN = process.platform === 'win32';

// A temp vault + workspace and a temp home; run(args) runs the CLI with both.
function setup() {
  const v = makeVault({ teams: { portal: {} } });
  const home = tempDir('hades-home-');
  const env = { HOME: home, USERPROFILE: home, APPDATA: `${home}/AppData/Roaming`, CODEX_HOME: '', COPILOT_HOME: '', CLINE_MCP_SETTINGS_PATH: '', HADES_GUARD_LOG: `${home}/guard.log` };
  const ws = tempDir('hades-ws-');
  return { v, home, ws, run: (args, extra = {}) => v.run(args, { env: { ...env, ...extra } }) };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => JSON.parse(read(f));
const exists = (f) => fs.existsSync(f);
const backups = (dir, base) => (exists(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.hades-backup-`)) : []);

// Our YAML frontmatter subset: "key: value" lines (nested by two spaces); quoted values are JSON.
function frontmatterOf(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `frontmatter in ${text.slice(0, 80)}`);
  const data = {};
  const stack = [{ indent: -1, obj: data }];
  for (const line of m[1].split('\n')) {
    const lm = /^( *)("[^"]+"|[A-Za-z0-9_-]+):(?: (.*))?$/.exec(line);
    assert.ok(lm, `frontmatter line: ${line}`);
    const indent = lm[1].length;
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const key = lm[2].startsWith('"') ? JSON.parse(lm[2]) : lm[2];
    const parent = stack[stack.length - 1].obj;
    if (lm[3] === undefined) {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      const raw = lm[3];
      parent[key] = /^["[]/.test(raw) ? JSON.parse(raw) : /^\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

// Our TOML subset: key = <JSON string|number|array> or key = '''multi-line literal'''.
function tomlOf(text) {
  const data = {};
  let table = data;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const h = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (h) {
      table = data;
      for (const k of h[1].split('.')) table = table[k] ||= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+) = (.*)$/.exec(line);
    assert.ok(kv, `toml line: ${line}`);
    if (kv[2] === "'''") {
      const end = lines.indexOf("'''", i + 1);
      assert.ok(end > i, 'closed literal string');
      table[kv[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else table[kv[1]] = JSON.parse(kv[2]);
  }
  return data;
}

function noPlaceholders(file) {
  const text = read(file);
  assert.doesNotMatch(text.replace(/`\{\{HADES_(HOME|VAULT)\}\}` = /g, ''), /\{\{(HADES_HOME|HADES_VAULT|HADES_WORKSPACE|NODE)\}\}/, `${file} is rendered`);
}

const EXPECT = {
  'agents-md': { files: ['AGENTS.md'] },
  codex: { files: ['AGENTS.md', ...SKILLS.map((s) => `.agents/skills/${s}/SKILL.md`), ...ROLES.map((r) => `.codex/agents/${r}.toml`), '.codex/config.toml', '.codex/hooks.json'] },
  cursor: { files: ['AGENTS.md', ...SKILLS.map((s) => `.cursor/skills/${s}/SKILL.md`), ...ROLES.map((r) => `.cursor/agents/${r}.md`), '.cursor/mcp.json', '.cursor/hooks.json'] },
  gemini: { files: ['GEMINI.md', ...SKILLS.map((s) => `.gemini/commands/${s}.toml`), ...ROLES.map((r) => `.gemini/agents/${r}.md`), '.gemini/settings.json'] },
  copilot: { files: ['AGENTS.md', ...SKILLS.map((s) => `.github/skills/${s}/SKILL.md`), ...ROLES.map((r) => `.github/agents/${r}.agent.md`), '.github/hooks/hades-guard.json'] },
  windsurf: { files: ['AGENTS.md', ...SKILLS.map((s) => `.devin/skills/${s}/SKILL.md`), ...ROLES.map((r) => `.devin/agents/${r}.md`), '.devin/mcp_config.json', '.devin/hooks.v1.json'] },
  cline: { files: ['AGENTS.md', ...SKILLS.map((s) => `.cline/skills/${s}/SKILL.md`), '.clinerules/hooks/PreToolUse', '.cline/hooks/PreToolUse.sh'] },
  opencode: { files: ['AGENTS.md', ...SKILLS.map((s) => `.opencode/commands/${s}.md`), ...ROLES.map((r) => `.opencode/agents/${r}.md`), '.opencode/plugins/hades-guard.js', 'opencode.json'] },
};

describe('hades export: every target (project scope)', () => {
  test('the engine has the roles and skills the export maps', () => {
    assert.ok(ROLES.length >= 11, ROLES.join(','));
    for (const s of SKILLS) assert.ok(exists(`${ENGINE}/skills/${s}/SKILL.md`), s);
  });

  for (const [target, want] of Object.entries(EXPECT)) {
    test(`${target}: writes exactly its files, rendered and marked`, () => {
      const { ws, run } = setup();
      const r = run(['export', target, '--dir', ws, '--json']);
      assert.equal(r.code, 0, r.err + r.out);
      const res = r.json();
      assert.equal(res.exported, target);
      assert.equal(res.dir, ws);
      assert.deepEqual(res.files.map((f) => f.rel).sort(), [...want.files].sort());
      assert.ok(res.files.every((f) => f.action === 'write'), JSON.stringify(res.files.filter((f) => f.action !== 'write')));
      assert.deepEqual(res.conflicts, []);
      for (const rel of want.files) {
        const file = `${ws}/${rel}`;
        assert.ok(exists(file), rel);
        noPlaceholders(file);
        const text = read(file);
        if (rel.endsWith('.json')) JSON.parse(text);
        else assert.match(text, /hades-generated/, `${rel} is marked`);
        assert.doesNotMatch(text, /\r/, `${rel}: LF only`);
      }
    });
  }

  test('agents-md: the whole PM procedure in single-agent mode, inside the HADES block', () => {
    const { ws, run, v } = setup();
    assert.equal(run(['export', 'agents-md', '--dir', ws]).code, 0);
    const text = read(`${ws}/AGENTS.md`);
    assert.match(text, /^<!-- hades-generated:begin \(hades export agents-md/);
    assert.match(text, /<!-- hades-generated:end -->\n$/);
    assert.match(text, /^### Single-agent mode on an AGENTS\.md agent/m);
    assert.match(text, /^An AGENTS\.md agent has no HADES role agents/m);
    assert.match(text, /No HADES guard hook runs here: you alone keep the hard rules/);
    assert.doesNotMatch(text, /--format agents-md/, 'no guard format for agents-md');
    assert.match(text, /`Usage: n\/a \(not Claude Code\)`/);
    assert.ok(text.includes(`\`${ENGINE}/agents/hades-<role>.md\``), 'role prompts read by path');
    assert.ok(text.includes(`\`{{HADES_HOME}}\` = \`${ENGINE}\``) && text.includes(`\`{{HADES_VAULT}}\` = \`${v.vault}\``), 'placeholder mapping for the role files');
    assert.match(text, /^### \/hades - Project Manager$/m, 'procedure headings demoted under ## HADES');
    assert.match(text, /^#### 4\. Defect loop/m);
    for (const s of ['hades-new-team', 'hades-learn', 'hades-status']) assert.ok(text.includes(`${ENGINE}/skills/${s}/SKILL.md`), s);
    assert.ok(Buffer.byteLength(text) < 32 * 1024, 'fits the Codex 32 KiB instruction budget');
  });

  test('codex: underscore agent names, effort, literal developer_instructions; MCP block; hook', () => {
    const { ws, run } = setup();
    const out = run(['export', 'codex', '--dir', ws]);
    assert.equal(out.code, 0);
    // The unattended hint: the workspace is no git repository, the CLI writes <engine>/.hades, gates need the network.
    assert.match(out.out, /todo: Unattended: codex exec -C <dir> --skip-git-repo-check .*-c sandbox_workspace_write\.network_access=true .*--add-dir \S+\/\.hades '\$hades /);
    for (const r of ROLES) {
      const a = tomlOf(read(`${ws}/.codex/agents/${r}.toml`));
      assert.equal(a.name, r.replace(/-/g, '_'));
      assert.ok(a.description.startsWith('HADES '), r);
      assert.ok(['low', 'medium', 'high'].includes(a.model_reasoning_effort), r);
      assert.match(a.developer_instructions, /^> HADES role agent on Codex: never spawn/);
      if (r !== 'hades-scout') assert.match(a.developer_instructions, /^STATUS: done \| partial \| blocked$/m, 'the return contract is kept');
      assert.equal(a.model, undefined, 'Claude model aliases are not Codex models');
    }
    const cfg = tomlOf(read(`${ws}/.codex/config.toml`));
    assert.deepEqual(Object.keys(cfg.mcp_servers), ['serena', 'rea', 'playwright', 'aws']);
    for (const [n, s] of Object.entries(cfg.mcp_servers)) {
      assert.equal(s.command, NODE);
      assert.deepEqual(s.args, [`${ENGINE}/bin/hades.mjs`, 'mcp', n]);
    }
    const hooks = readJson(`${ws}/.codex/hooks.json`);
    const g = hooks.hooks.PreToolUse[0];
    assert.match(g.matcher, /Bash\|apply_patch\|Edit\|Write\|mcp__serena__/);
    assert.match(g.hooks[0].command, /hooks\/guard\.mjs"? --format codex$/);
    const skill = frontmatterOf(read(`${ws}/.agents/skills/hades/SKILL.md`));
    assert.equal(skill.data.name, 'hades');
    assert.match(skill.body, /Running on Codex/);
    assert.match(skill.body, /`\$ARGUMENTS` = the text the owner typed after `\$hades`/);
    assert.match(skill.body, /`hades_backend_engineer`/);
    assert.match(skill.body, /^# \/hades - Project Manager$/m);
    assert.match(skill.body, /`hades usage` counts Claude Code sessions only/);
  });

  test('cursor: readonly scout, stdio MCP servers, four fail-closed hooks', () => {
    const { ws, run } = setup();
    assert.equal(run(['export', 'cursor', '--dir', ws]).code, 0);
    assert.equal(frontmatterOf(read(`${ws}/.cursor/agents/hades-scout.md`)).data.readonly, true);
    assert.equal(frontmatterOf(read(`${ws}/.cursor/agents/hades-backend-engineer.md`)).data.readonly, undefined);
    const fm = frontmatterOf(read(`${ws}/.cursor/skills/hades/SKILL.md`)).data;
    assert.equal(fm['disable-model-invocation'], true);
    const mcp = readJson(`${ws}/.cursor/mcp.json`).mcpServers;
    assert.deepEqual(mcp.serena, { type: 'stdio', command: NODE, args: [`${ENGINE}/bin/hades.mjs`, 'mcp', 'serena'] });
    const hooks = readJson(`${ws}/.cursor/hooks.json`);
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution', 'preToolUse']);
    for (const list of Object.values(hooks.hooks)) {
      assert.equal(list[0].failClosed, true);
      assert.match(list[0].command, /--format cursor$/);
    }
    assert.equal(hooks.hooks.preToolUse[0].matcher, 'Write|Delete');
  });

  test('gemini: per-agent MCP servers, turn and time limits, read-only scout tools, BeforeTool hook, {{args}}', () => {
    const { ws, run } = setup();
    assert.equal(run(['export', 'gemini', '--dir', ws]).code, 0);
    const sec = frontmatterOf(read(`${ws}/.gemini/agents/hades-cybersecurity-engineer.md`)).data;
    assert.deepEqual(Object.keys(sec.mcpServers), ['serena', 'rea', 'playwright']);
    assert.deepEqual(sec.mcpServers.rea, { command: NODE, args: [`${ENGINE}/bin/hades.mjs`, 'mcp', 'rea'] });
    assert.equal(sec.kind, 'local');
    assert.equal(sec.max_turns, 120);
    assert.ok(sec.timeout_mins >= 60);
    const analyst = frontmatterOf(read(`${ws}/.gemini/agents/hades-business-analyst.md`)).data;
    assert.equal(analyst.mcpServers, undefined, 'no MCP for the analyst');
    const scout = frontmatterOf(read(`${ws}/.gemini/agents/hades-scout.md`)).data;
    assert.ok(scout.tools.includes('read_file') && scout.tools.includes('mcp_serena_find_symbol'));
    assert.ok(!scout.tools.includes('write_file') && !scout.tools.includes('mcp_serena_create_text_file'));
    const cmd = tomlOf(read(`${ws}/.gemini/commands/hades.toml`));
    assert.match(cmd.prompt, /Owner request: \{\{args\}\}$/);
    assert.match(cmd.prompt, /Running on Gemini CLI/);
    const def = readJson(`${ws}/.gemini/settings.json`).hooks.BeforeTool[0];
    assert.equal(def.hooks[0].name, 'hades-guard');
    assert.match(def.hooks[0].command, /--format gemini$/);
    assert.match(def.matcher, /run_shell_command/);
    assert.match(read(`${ws}/GEMINI.md`), /## HADES/);
  });

  test('copilot: tools and per-agent mcp-servers mirror the Claude frontmatter; PreToolUse hook file', () => {
    const { ws, run } = setup();
    assert.equal(run(['export', 'copilot', '--dir', ws]).code, 0);
    const scout = frontmatterOf(read(`${ws}/.github/agents/hades-scout.agent.md`)).data;
    assert.ok(!scout.tools.includes('edit'), 'scout cannot edit');
    assert.ok(scout.tools.includes('serena/find_symbol') && !scout.tools.includes('serena/create_text_file'));
    assert.ok(!scout.tools.some((t) => /execute_shell_command|serena_repl|write_memory/.test(t)), 'no Serena shell or memory tools');
    const qa = frontmatterOf(read(`${ws}/.github/agents/hades-qa-engineer.agent.md`)).data;
    assert.ok(qa.tools.includes('edit') && qa.tools.includes('playwright/*') && qa.tools.includes('serena/create_text_file'));
    assert.deepEqual(qa['mcp-servers'].playwright, { type: 'local', command: NODE, args: [`${ENGINE}/bin/hades.mjs`, 'mcp', 'playwright'], tools: ['*'] });
    const h = readJson(`${ws}/.github/hooks/hades-guard.json`);
    assert.equal(h.version, 1);
    assert.equal(h.hooks.PreToolUse[0].timeoutSec, 30);
    assert.match(h.hooks.PreToolUse[0].command, /--format copilot$/);
    assert.equal(frontmatterOf(read(`${ws}/.github/skills/hades/SKILL.md`)).data['argument-hint'], '<team-or-alias> <requirements> | <team> continue <task-id>');
  });

  test('windsurf (Devin): sonnet roles keep their model, scout allowed-tools, MCP and hook files', () => {
    const { ws, run } = setup();
    assert.equal(run(['export', 'devin', '--dir', ws]).code, 0, 'alias devin');
    assert.equal(frontmatterOf(read(`${ws}/.devin/agents/hades-backend-engineer.md`)).data.model, 'sonnet');
    assert.equal(frontmatterOf(read(`${ws}/.devin/agents/hades-software-architect.md`)).data.model, undefined, 'opus is not a documented Devin alias');
    const scout = frontmatterOf(read(`${ws}/.devin/agents/hades-scout.md`)).data;
    assert.ok(scout['allowed-tools'].includes('exec') && scout['allowed-tools'].includes('mcp__serena__find_symbol'));
    assert.ok(!scout['allowed-tools'].includes('write') && !scout['allowed-tools'].includes('edit'));
    assert.deepEqual(Object.keys(readJson(`${ws}/.devin/mcp_config.json`).mcpServers), ['serena', 'rea', 'playwright', 'aws']);
    const h = readJson(`${ws}/.devin/hooks.v1.json`);
    assert.match(h.PreToolUse[0].matcher, /exec\|/);
    assert.match(h.PreToolUse[0].hooks[0].command, /--format windsurf$/);
  });

  test('cline: single-agent skills, executable shell hook, MCP left to the user scope', () => {
    const { ws, run } = setup();
    const r = run(['export', 'cline', '--dir', ws]);
    assert.equal(r.code, 0);
    assert.match(r.out, /todo: .*cline mcp add serena -- /);
    const skill = frontmatterOf(read(`${ws}/.cline/skills/hades/SKILL.md`));
    assert.match(skill.body, /Single-agent mode on Cline/);
    assert.match(skill.body, /prefer a new task \(`\/newtask`\)/);
    const hook = read(`${ws}/.clinerules/hooks/PreToolUse`);
    assert.match(hook, /^#!\/bin\/sh\n# hades-generated: true/);
    assert.ok(hook.includes(`exec "${NODE}" "${ENGINE}/hooks/guard.mjs" --format cline`));
    if (!WIN) assert.equal(fs.statSync(`${ws}/.clinerules/hooks/PreToolUse`).mode & 0o111, 0o111, 'executable');
    // The Cline CLI reads .cline/hooks/ (not .clinerules/hooks/): the same hook there, so CLI runs are guarded too.
    assert.equal(read(`${ws}/.cline/hooks/PreToolUse.sh`), hook);
    if (!WIN) assert.equal(fs.statSync(`${ws}/.cline/hooks/PreToolUse.sh`).mode & 0o111, 0o111, 'executable');
  });

  test('opencode: subagents with task/edit/MCP denies, commands with $ARGUMENTS, plugin, opencode.json', () => {
    const { ws, run, v } = setup();
    assert.equal(run(['export', 'opencode', '--dir', ws]).code, 0);
    const scout = frontmatterOf(read(`${ws}/.opencode/agents/hades-scout.md`)).data;
    assert.equal(scout.mode, 'subagent');
    assert.equal(scout.steps, 25);
    assert.equal(scout.permission.task, 'deny');
    assert.equal(scout.permission.edit, 'deny');
    assert.equal(scout.permission['aws_*'], 'deny');
    assert.equal(scout.permission.serena_create_text_file, 'deny');
    const devops = frontmatterOf(read(`${ws}/.opencode/agents/hades-devops-engineer.md`)).data;
    assert.equal(devops.permission['aws_*'], undefined, 'devops keeps aws');
    assert.equal(devops.permission['serena_*'], 'deny');
    const cmd = read(`${ws}/.opencode/commands/hades.md`);
    assert.match(cmd, /\$ARGUMENTS/);
    assert.doesNotMatch(cmd, /^- `\$ARGUMENTS` =/m, 'OpenCode substitutes $ARGUMENTS itself');
    const cfg = readJson(`${ws}/opencode.json`);
    assert.equal(cfg.$schema, 'https://opencode.ai/config.json');
    assert.deepEqual(cfg.mcp.serena, { type: 'local', command: [NODE, `${ENGINE}/bin/hades.mjs`, 'mcp', 'serena'], enabled: true });
    assert.deepEqual(cfg.permission.bash, { 'git push': 'deny', 'git push *': 'deny' });
    assert.equal(cfg.permission.external_directory[`${v.vault}/**`], 'allow');
    const plugin = read(`${ws}/.opencode/plugins/hades-guard.js`);
    assert.ok(plugin.includes(`const NODE = ${JSON.stringify(NODE)};`));
    assert.match(plugin, /export const HadesGuard = async/);
  });
});

describe('hades export: re-runs, merges, conflicts, --force, --dry-run', () => {
  test('a second run changes nothing and makes no backups', () => {
    const { ws, run } = setup();
    for (const t of Object.keys(EXPECT)) {
      const dir = `${ws}/${t}`;
      fs.mkdirSync(dir);
      assert.equal(run(['export', t, '--dir', dir]).code, 0, t);
      const again = run(['export', t, '--dir', dir, '--json']);
      assert.equal(again.code, 0, t);
      assert.deepEqual([...new Set(again.json().files.map((f) => f.action))], ['unchanged'], t);
    }
    const all = (d) => fs.readdirSync(d, { recursive: true }).map(String);
    assert.deepEqual(all(ws).filter((f) => f.includes('hades-backup')), []);
  });

  test('several targets in one folder share one HADES block in AGENTS.md', () => {
    const { ws, run } = setup();
    run(['export', 'codex', '--dir', ws]);
    const before = read(`${ws}/AGENTS.md`);
    const r = run(['export', 'cursor', '--dir', ws, '--json']);
    assert.equal(r.json().files.find((f) => f.rel === 'AGENTS.md').action, 'unchanged');
    assert.equal(read(`${ws}/AGENTS.md`), before);
    assert.match(before, /`\/name`; in Codex `\$name`/);
  });

  test('JSON configs are merged: unrelated keys and servers kept, backup first', () => {
    const { ws, run } = setup();
    const mine = { command: 'uvx', args: ['my-server'] };
    fs.mkdirSync(`${ws}/.cursor`);
    fs.writeFileSync(`${ws}/.cursor/mcp.json`, JSON.stringify({ mcpServers: { mine }, other: { keep: true } }));
    fs.writeFileSync(`${ws}/.cursor/hooks.json`, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: 'my-check' }], stop: [{ command: 'x' }] } }));
    const r = run(['export', 'cursor', '--dir', ws, '--json']);
    assert.equal(r.code, 0, r.out);
    const mcp = readJson(`${ws}/.cursor/mcp.json`);
    assert.deepEqual(mcp.mcpServers.mine, mine);
    assert.deepEqual(mcp.other, { keep: true });
    assert.deepEqual(Object.keys(mcp.mcpServers), ['mine', 'serena', 'rea', 'playwright', 'aws']);
    const hooks = readJson(`${ws}/.cursor/hooks.json`);
    assert.equal(hooks.hooks.beforeShellExecution[0].command, 'my-check');
    assert.match(hooks.hooks.beforeShellExecution[1].command, /--format cursor$/);
    assert.deepEqual(hooks.hooks.stop, [{ command: 'x' }]);
    assert.equal(backups(`${ws}/.cursor`, 'mcp.json').length, 1);
    assert.equal(backups(`${ws}/.cursor`, 'hooks.json').length, 1);
    const files = r.json().files;
    assert.equal(files.find((f) => f.rel === '.cursor/mcp.json').action, 'merge');
    assert.ok(files.find((f) => f.rel === '.cursor/mcp.json').backup);
    // our stale entry (another node) is updated in place, extra keys the user added are kept
    const cur = readJson(`${ws}/.cursor/mcp.json`);
    cur.mcpServers.serena.command = '/old/node';
    cur.mcpServers.serena.env = { X: '1' };
    fs.writeFileSync(`${ws}/.cursor/mcp.json`, JSON.stringify(cur));
    assert.equal(run(['export', 'cursor', '--dir', ws]).code, 0);
    const after2 = readJson(`${ws}/.cursor/mcp.json`).mcpServers.serena;
    assert.equal(after2.command, NODE);
    assert.deepEqual(after2.env, { X: '1' });
  });

  test('a foreign server of the same name is a CONFLICT (exit 2) until --force', () => {
    const { ws, run } = setup();
    fs.mkdirSync(`${ws}/.devin`);
    const theirs = { command: 'uvx', args: ['serena', 'start-mcp-server'] };
    fs.writeFileSync(`${ws}/.devin/mcp_config.json`, JSON.stringify({ mcpServers: { serena: theirs } }));
    const r = run(['export', 'windsurf', '--dir', ws]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^CONFLICT \.devin\/mcp_config\.json: MCP server "serena" exists with another command -> kept/m);
    const cfg = readJson(`${ws}/.devin/mcp_config.json`).mcpServers;
    assert.deepEqual(cfg.serena, theirs);
    assert.ok(cfg.rea && cfg.aws, 'the other servers were still added');
    const f = run(['export', 'windsurf', '--dir', ws, '--force']);
    assert.equal(f.code, 0, f.out);
    assert.equal(readJson(`${ws}/.devin/mcp_config.json`).mcpServers.serena.command, NODE);
  });

  test('an AGENTS.md of the user is kept until --force, which appends the block after a backup', () => {
    const { ws, run } = setup();
    fs.writeFileSync(`${ws}/AGENTS.md`, '# My rules\n\nUse tabs.\n');
    const r = run(['export', 'copilot', '--dir', ws]);
    assert.equal(r.code, 2);
    assert.match(r.out, /^CONFLICT AGENTS\.md: exists without a HADES block -> kept/m);
    assert.equal(read(`${ws}/AGENTS.md`), '# My rules\n\nUse tabs.\n');
    assert.ok(exists(`${ws}/.github/hooks/hades-guard.json`), 'the rest was written');
    const f = run(['export', 'copilot', '--dir', ws, '--force']);
    assert.equal(f.code, 0, f.out);
    const text = read(`${ws}/AGENTS.md`);
    assert.ok(text.startsWith('# My rules\n\nUse tabs.\n\n<!-- hades-generated:begin'), text.slice(0, 120));
    assert.equal(backups(ws, 'AGENTS.md').length, 1);
    // the block is ours from now on: later exports update it without --force
    fs.writeFileSync(`${ws}/AGENTS.md`, text.replace('## HADES', '## HADES (old)').concat('\nMore of mine.\n'));
    const again = run(['export', 'copilot', '--dir', ws]);
    assert.equal(again.code, 0, again.out);
    const final = read(`${ws}/AGENTS.md`);
    assert.ok(final.includes('## HADES\n') && !final.includes('(old)'));
    assert.ok(final.startsWith('# My rules') && final.endsWith('\nMore of mine.\n'), 'user text around the block kept');
  });

  test('an unmarked file at a generated path is kept until --force (backup kept)', () => {
    const { ws, run } = setup();
    fs.mkdirSync(`${ws}/.cursor/skills/hades`, { recursive: true });
    fs.writeFileSync(`${ws}/.cursor/skills/hades/SKILL.md`, '---\nname: hades\n---\nmine\n');
    const r = run(['export', 'cursor', '--dir', ws, '--json']);
    assert.equal(r.code, 2);
    assert.equal(r.json().conflicts[0].rel, '.cursor/skills/hades/SKILL.md');
    assert.equal(read(`${ws}/.cursor/skills/hades/SKILL.md`), '---\nname: hades\n---\nmine\n');
    const f = run(['export', 'cursor', '--dir', ws, '--force', '--json']);
    assert.equal(f.code, 0);
    assert.equal(f.json().files.find((x) => x.rel === '.cursor/skills/hades/SKILL.md').action, 'overwrite');
    assert.match(read(`${ws}/.cursor/skills/hades/SKILL.md`), /hades-generated: true/);
    assert.equal(backups(`${ws}/.cursor/skills/hades`, 'SKILL.md').length, 1);
  });

  test('invalid JSON is a conflict; --force replaces it after a backup', () => {
    const { ws, run } = setup();
    fs.mkdirSync(`${ws}/.gemini`);
    fs.writeFileSync(`${ws}/.gemini/settings.json`, '{ oops');
    const r = run(['export', 'gemini', '--dir', ws]);
    assert.equal(r.code, 2);
    assert.match(r.out, /CONFLICT \.gemini\/settings\.json: is not a JSON object/);
    assert.equal(read(`${ws}/.gemini/settings.json`), '{ oops');
    assert.equal(run(['export', 'gemini', '--dir', ws, '--force']).code, 0);
    assert.equal(readJson(`${ws}/.gemini/settings.json`).hooks.BeforeTool.length, 1);
    assert.equal(backups(`${ws}/.gemini`, 'settings.json').length, 1);
  });

  test('codex config.toml: the block is appended to a user file (backup); our tables outside it are a conflict', () => {
    const { ws, run } = setup();
    fs.mkdirSync(`${ws}/.codex`);
    fs.writeFileSync(`${ws}/.codex/config.toml`, 'model = "gpt-x"\n\n[mcp_servers.github]\ncommand = "gh"\n');
    assert.equal(run(['export', 'codex', '--dir', ws]).code, 0);
    const text = read(`${ws}/.codex/config.toml`);
    assert.ok(text.startsWith('model = "gpt-x"\n\n[mcp_servers.github]\ncommand = "gh"\n\n# >>> hades-generated:begin'), text.slice(0, 100));
    assert.deepEqual(Object.keys(tomlOf(text).mcp_servers), ['github', 'serena', 'rea', 'playwright', 'aws']);
    assert.equal(backups(`${ws}/.codex`, 'config.toml').length, 1);
    const ws2 = tempDir('hades-ws-');
    fs.mkdirSync(`${ws2}/.codex`);
    fs.writeFileSync(`${ws2}/.codex/config.toml`, '[mcp_servers.serena]\ncommand = "uvx"\n');
    const c = run(['export', 'codex', '--dir', ws2, '--force']);
    assert.equal(c.code, 2, 'duplicate TOML tables cannot be merged, even with --force');
    assert.match(c.out, /CONFLICT \.codex\/config\.toml: defines mcp_servers serena outside the HADES block/);
    assert.equal(read(`${ws2}/.codex/config.toml`), '[mcp_servers.serena]\ncommand = "uvx"\n');
  });

  test('--dry-run writes nothing and reports what it would do', () => {
    const { ws, run } = setup();
    const r = run(['export', 'opencode', '--dir', ws, '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.lines[0], /^DRY RUN hades export opencode \(project scope\)/);
    assert.deepEqual(fs.readdirSync(ws), []);
    const j = run(['export', 'opencode', '--dir', ws, '--dry-run', '--json']).json();
    assert.equal(j.dry_run, true);
    assert.ok(j.files.length > 10 && j.files.every((f) => f.action === 'write'));
    assert.deepEqual(fs.readdirSync(ws), []);
  });
});

describe('hades export: user scope, fallbacks, errors', () => {
  const USER = {
    codex: ['.codex/AGENTS.md', '.agents/skills/hades/SKILL.md', '.codex/agents/hades-scout.toml', '.codex/config.toml', '.codex/hooks.json'],
    cursor: ['.cursor/skills/hades/SKILL.md', '.cursor/agents/hades-scout.md', '.cursor/mcp.json', '.cursor/hooks.json'],
    gemini: ['.gemini/GEMINI.md', '.gemini/commands/hades.toml', '.gemini/agents/hades-scout.md', '.gemini/settings.json'],
    copilot: ['.copilot/copilot-instructions.md', '.copilot/skills/hades/SKILL.md', '.copilot/agents/hades-scout.agent.md', '.copilot/hooks/hades-guard.json'],
    windsurf: WIN
      ? ['AppData/Roaming/devin/AGENTS.md', 'AppData/Roaming/devin/skills/hades/SKILL.md', 'AppData/Roaming/devin/agents/hades-scout.md', 'AppData/Roaming/devin/mcp_config.json', 'AppData/Roaming/devin/config.json']
      : ['.config/devin/AGENTS.md', '.config/devin/skills/hades/SKILL.md', '.config/devin/agents/hades-scout.md', '.config/devin/mcp_config.json', '.config/devin/config.json'],
    cline: ['.cline/skills/hades/SKILL.md', '.cline/data/settings/cline_mcp_settings.json', 'Documents/Cline/Hooks/PreToolUse', '.cline/hooks/PreToolUse.sh'],
    opencode: ['.config/opencode/AGENTS.md', '.config/opencode/commands/hades.md', '.config/opencode/agents/hades-scout.md', '.config/opencode/plugins/hades-guard.js', '.config/opencode/opencode.json'],
  };
  for (const [target, files] of Object.entries(USER)) {
    test(`${target} --scope user writes into the agent's home folder`, () => {
      const { home, run } = setup();
      const r = run(['export', target, '--scope', 'user', '--json']);
      assert.equal(r.code, 0, r.err + r.out);
      const res = r.json();
      assert.equal(res.scope, 'user');
      assert.equal(res.dir, null);
      for (const f of files) assert.ok(exists(`${home}/${f}`), `${target}: ${f}`);
      assert.ok(res.files.every((f) => f.rel.startsWith('~/')), JSON.stringify(res.files.map((f) => f.rel)));
    });
  }

  test('user-scope specifics: Devin hooks under "hooks", Cline MCP defaults, CODEX_HOME', () => {
    const { home, run } = setup();
    run(['export', 'windsurf', '--scope', 'user']);
    const devin = WIN ? `${home}/AppData/Roaming/devin` : `${home}/.config/devin`;
    assert.match(readJson(`${devin}/config.json`).hooks.PreToolUse[0].hooks[0].command, /--format windsurf$/);
    run(['export', 'cline', '--scope', 'user']);
    assert.deepEqual(readJson(`${home}/.cline/data/settings/cline_mcp_settings.json`).mcpServers.aws, { command: NODE, args: [`${ENGINE}/bin/hades.mjs`, 'mcp', 'aws'], disabled: false, autoApprove: [] });
    const codexHome = `${home}/elsewhere`;
    assert.equal(run(['export', 'codex', '--scope', 'user'], { CODEX_HOME: codexHome }).code, 0);
    assert.ok(exists(`${codexHome}/hooks.json`) && exists(`${codexHome}/agents/hades-tech-lead.toml`));
  });

  test('roo and aider fall back to agents-md with a note', () => {
    for (const [name, re] of [['roo', /Roo Code was shut down/], ['aider', /read: AGENTS\.md/]]) {
      const { ws, run } = setup();
      const r = run(['export', name, '--dir', ws, '--json']);
      assert.equal(r.code, 0);
      const j = r.json();
      assert.equal(j.target, name);
      assert.equal(j.exported, 'agents-md');
      assert.equal(j.fallback, true);
      assert.match(j.notes[0], re);
      assert.match(read(`${ws}/AGENTS.md`), /Single-agent mode on (Roo Code|Aider)/);
    }
  });

  test('bad usage exits 1 and writes nothing', () => {
    const { ws, run, home } = setup();
    const cases = [
      [['export'], /usage: hades export <target>/],
      [['export', 'vim', '--dir', ws], /unknown target "vim"\. Targets: agents-md, codex/],
      [['export', 'codex', '--scope', 'team', '--dir', ws], /--scope must be project or user/],
      [['export', 'codex', '--dir', `${ws}/missing`], /directory not found/],
      [['export', 'codex', '--scope', 'user', '--dir', ws], /--dir applies to --scope project only/],
      [['export', 'agents-md', '--scope', 'user'], /agents-md has no user scope/],
      [['export', 'codex', 'extra', '--dir', ws], /unexpected argument "extra"/],
      [['export', 'codex', '--dir', ws, '--forse'], /unknown flag --forse/],
    ];
    for (const [args, re] of cases) {
      const r = run(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.err, re, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(ws), []);
    assert.deepEqual(fs.readdirSync(home), []);
  });

  test('a folder inside a registered project is exported with a WARN (HADES keeps projects clean)', () => {
    const { v, run } = setup();
    const project = v.registry().teams.portal.project_path;
    const r = run(['export', 'agents-md', '--dir', project]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^WARN .* is inside the project of team "portal"/m);
  });

  test('--help prints the usage', () => {
    const { run } = setup();
    const r = run(['export', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^hades export <target>/);
  });
});

describe('the exported guard hooks run the guard', () => {
  // The hook command line exactly as the platform would run it (through the platform shell).
  function runHook(command, payload, env) {
    return spawnSync(command, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  }

  test('cursor and codex hook commands block a push and allow a status', () => {
    const { ws, run, home } = setup();
    run(['export', 'cursor', '--dir', ws]);
    run(['export', 'codex', '--dir', ws]);
    const env = { HADES_GUARD_LOG: `${home}/guard.log` };
    const cursor = readJson(`${ws}/.cursor/hooks.json`).hooks.beforeShellExecution[0].command;
    const deny = runHook(cursor, { hook_event_name: 'beforeShellExecution', command: 'git push origin main', cwd: ws }, env);
    assert.equal(JSON.parse(deny.stdout).permission, 'deny', deny.stderr);
    const allow = runHook(cursor, { hook_event_name: 'beforeShellExecution', command: 'git status', cwd: ws }, env);
    assert.equal(JSON.parse(allow.stdout).permission, 'allow', allow.stderr);
    const codex = readJson(`${ws}/.codex/hooks.json`).hooks.PreToolUse[0].hooks[0].command;
    assert.equal(runHook(codex, { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: ws }, env).status, 2);
    assert.equal(runHook(codex, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: ws }, env).status, 0);
  });

  test('the OpenCode plugin throws on a refused call and passes an allowed one', async () => {
    const { ws, run, home } = setup();
    run(['export', 'opencode', '--dir', ws]);
    const saved = process.env.HADES_GUARD_LOG;
    process.env.HADES_GUARD_LOG = `${home}/guard.log`;
    try {
      const mod = await import(pathToFileURL(`${ws}/.opencode/plugins/hades-guard.js`).href);
      const hooks = await mod.HadesGuard({ directory: ws });
      await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, { args: { command: 'git push' } }), /HADES guard: git\.push/);
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's' }, { args: { command: 'git status' } });
      await assert.rejects(hooks['tool.execute.before']({ tool: 'write', sessionID: 's' }, { args: { filePath: `${ws}/opencode.json`, content: '{}' } }), /self\.protect/);
    } finally {
      if (saved === undefined) delete process.env.HADES_GUARD_LOG;
      else process.env.HADES_GUARD_LOG = saved;
    }
  });
});
