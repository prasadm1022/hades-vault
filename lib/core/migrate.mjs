// HADES v1 -> v2 vault migration: the deterministic half of "hades migrate".
// Judgement work (splitting role notes, writing CONTEXT.md, completing team.json) is left to the
// LLM pass (/hades-learn <team> --migrate); this module only leaves "hades-migrate: TODO" markers.
//
// Every change is planned on an in-memory overlay first (so --dry-run reports exactly what a real
// run does), then replayed in order. Files with uncommitted changes are never touched unless
// includeDirty is set. Running twice changes nothing the second time.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, writeText, slash, render, run, today, fail } from './util.mjs';

export const MARKER = 'hades-migrate: TODO';
export const ENV_TODO = 'TODO(hades-migrate): fill from TEAM.md Environments';
export const V2_MARK = '<!-- hades: v2 -->';
const ORGS_BEGIN = '<!-- hades:orgs -->';
const ORGS_END = '<!-- /hades:orgs -->';

export const V2_ROLES = [
  'project-manager', 'tech-lead', 'backend-engineer', 'frontend-engineer', 'aiml-data-engineer',
  'qa-engineer', 'business-analyst', 'software-architect', 'devops-engineer', 'cybersecurity-engineer',
];
export const STAFF_ROLES = ['business-analyst', 'software-architect', 'devops-engineer', 'cybersecurity-engineer'];
// v1 team note -> v2 team note (plain renames).
export const NOTE_RENAMES = {
  'senior-qa-engineer': 'qa-engineer',
  'senior-aiml-engineer': 'aiml-data-engineer',
  'security-engineer': 'cybersecurity-engineer',
};
// v1 notes that split into backend-engineer + frontend-engineer; kept as <name>.v1.md for the LLM pass.
export const NOTE_SPLITS = ['senior-fullstack-engineer', 'uiux-engineer'];

// v1 framework file -> engine path (relative to the engine root) and a note for MIGRATION.md.
export const ROLE_TARGETS = {
  'project-manager': ['HADES.md', 'the PM is the main session; protocol in HADES.md'],
  'business-analyst': ['agents/hades-business-analyst.md', 'agent hades-business-analyst'],
  'software-architect': ['agents/hades-software-architect.md', 'agent hades-software-architect'],
  'devops-engineer': ['agents/hades-devops-engineer.md', 'agent hades-devops-engineer'],
  'security-engineer': ['agents/hades-cybersecurity-engineer.md', 'agent hades-cybersecurity-engineer'],
  'senior-qa-engineer': ['agents/hades-qa-engineer.md', 'agent hades-qa-engineer'],
  'senior-aiml-engineer': ['agents/hades-aiml-data-engineer.md', 'agent hades-aiml-data-engineer'],
  'senior-fullstack-engineer': ['agents/hades-backend-engineer.md', 'split: hades-backend-engineer + hades-frontend-engineer'],
  'uiux-engineer': ['agents/hades-frontend-engineer.md', 'agent hades-frontend-engineer (UI/UX + frontend)'],
};
export const SKILL_TARGETS = {
  implementation: ['company/pipeline.md', 'build stage'],
  'testing-qa': ['playbooks/qa-automation.md', ''],
  'security-review': ['playbooks/security-testing.md', ''],
  'devops-ci': ['playbooks/deployment.md', ''],
  'ui-ux-design': ['playbooks/ui-ux-design.md', ''],
  'ai-ml-engineering': ['playbooks/tech/data-ml.md', ''],
  'architecture-design': ['agents/hades-software-architect.md', ''],
  'requirements-analysis': ['agents/hades-business-analyst.md', ''],
  'code-review': ['agents/hades-tech-lead.md', 'integration review'],
  'git-commit': ['company/commit-policy.md', ''],
  'knowledge-capture': ['playbooks/knowledge-capture.md', ''],
  'task-intake': ['skills/hades/SKILL.md', 'intake stage'],
};
export const WORKFLOW_TARGETS = {
  'task-lifecycle': ['company/pipeline.md', ''],
  'handover-protocol': ['company/handover.md', ''],
  'model-routing': ['company/model-routing.md', ''],
  'quality-gates': ['company/quality-gates.md', ''],
  'commit-policy': ['company/commit-policy.md', ''],
};
// v1 framework folders superseded by the engine; moved to archive/v1/<same path>.
export const ARCHIVE_DIRS = ['company/roles', 'company/skills', 'company/workflow', 'company/templates', 'scripts', '.claude/skills'];
const ROOT_DOCS = ['HADES.md', 'CLAUDE.md', 'README.md'];
const COMMAND_KEYS = ['install', 'build', 'lint', 'types', 'test', 'run', 'format'];

// ---------------------------------------------------------------------------------------------
// Pure text transforms (exported for tests)

const SEP = '[/\\\\]';
const NAME = '[A-Za-z0-9_-]+';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const vaultPattern = (v) => slash(String(v)).replace(/\/+$/, '').split('/').map(esc).join(SEP);

// Rewrites references to v1 framework files (company/roles|skills|workflow|templates and the vault
// HADES.md) to absolute engine paths. Matches absolute forms under any of `vaults`, {{VAULT}}/,
// <vault>/ and ../ prefixes, and bare relative "company/..." forms that are not part of a longer
// path. Only exact v1 file names are mapped; anything else is left alone.
export function rewriteV1Paths(text, { engine, vaults = [] }) {
  const eng = slash(engine).replace(/\/+$/, '');
  const abs = [...new Set(vaults.filter(Boolean).map(vaultPattern))].map((p) => `${p}${SEP}`);
  const prefixes = [...abs, `\\{\\{VAULT\\}\\}${SEP}`, `<vault>${SEP}`, `(?:\\.\\.${SEP})+`];
  const pre = `(?:${prefixes.join('|')}|(?<![A-Za-z0-9_.{}<>/\\\\-]))`;
  let count = 0;
  const swap = (table) => (m, name) => {
    const hit = table[String(name).toLowerCase()];
    if (!hit) return m;
    count++;
    return `${eng}/${hit[0]}`;
  };
  let out = text;
  out = out.replace(new RegExp(`${pre}company${SEP}roles${SEP}(${NAME})\\.md(?![A-Za-z0-9_-])`, 'gi'), swap(ROLE_TARGETS));
  out = out.replace(
    new RegExp(`${pre}company${SEP}skills${SEP}(${NAME})(?:${SEP}SKILL\\.md)?(?![A-Za-z0-9_/\\\\-])`, 'gi'),
    swap(SKILL_TARGETS),
  );
  out = out.replace(new RegExp(`${pre}company${SEP}workflow${SEP}(${NAME})\\.md(?![A-Za-z0-9_-])`, 'gi'), swap(WORKFLOW_TARGETS));
  out = out.replace(
    new RegExp(`${pre}company${SEP}templates${SEP}([A-Za-z0-9_-]+(?:[./\\\\][A-Za-z0-9_-]+)*)(?![A-Za-z0-9_-])`, 'gi'),
    (m, rest) => {
      count++;
      return `${eng}/templates/${rest.replace(/\\/g, '/')}`;
    },
  );
  if (abs.length) {
    out = out.replace(new RegExp(`(?:${abs.join('|')})HADES\\.md(?![A-Za-z0-9_-])`, 'gi'), () => {
      count++;
      return `${eng}/HADES.md`;
    });
  }
  return { text: out, count };
}

// v1 team note -> v2 team note: frontmatter name = v2 role, no "extends:", "role:" and "team:"
// present; the "Read the base role first: .../company/roles/<x>.md" line removed (agents carry the
// base role now). Keeps line endings, BOM and every other line.
export function normalizeNote(raw, { role, team }) {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text = bom ? raw.slice(1) : raw;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/.exec(text);
  const fm = m ? m[1].split(/\r?\n/) : [];
  let body = m ? text.slice(m[0].length) : `${eol}${eol}${text}`;
  const out = [];
  let hasRole = false;
  let hasTeam = false;
  const fmHasRole = fm.some((l) => /^role\s*:/.test(l));
  for (const line of fm) {
    const key = (/^([A-Za-z0-9_-]+)\s*:/.exec(line) || [])[1];
    if (key === 'extends') continue;
    if (key === 'name') {
      out.push(`name: ${role}`);
      if (!fmHasRole) {
        out.push(`role: ${role}`);
        hasRole = true;
      }
    } else if (key === 'role') {
      if (!hasRole) out.push(`role: ${role}`);
      hasRole = true;
    } else if (key === 'team') {
      out.push(`team: ${team}`);
      hasTeam = true;
    } else {
      out.push(line);
    }
  }
  if (!hasRole) out.unshift(`role: ${role}`);
  if (!hasTeam) out.push(`team: ${team}`);

  const lines = body.split(/\r?\n/);
  const kept = [];
  const baseLine = /Read the base role first:.*company[/\\]roles[/\\][A-Za-z0-9_-]+\.md/i;
  for (let i = 0; i < lines.length; i++) {
    if (baseLine.test(lines[i])) {
      const prevBlank = kept.length > 0 && kept[kept.length - 1].trim() === '';
      if (prevBlank && i + 1 < lines.length && lines[i + 1].trim() === '') i++;
      continue;
    }
    kept.push(lines[i]);
  }
  body = kept.join(eol);
  return `${bom}---${eol}${out.join(eol)}${eol}---${body}`;
}

// Splits a markdown table row into cells; pipes inside code spans and "\|" do not split.
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// First table under the first "##" heading matching `re`: { header, rows } or null.
function sectionTable(lines, re) {
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const table = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;
    if (/^\s*\|/.test(l)) table.push(splitRow(l));
    else if (table.length) break;
  }
  if (table.length < 2) return null;
  const rows = table.slice(1).filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
  return { header: table[0].map((h) => h.toLowerCase()), rows };
}

const firstCode = (cell) => (/`([^`]+)`/.exec(cell) || [])[1];

function projectFromCell(cell, projectPath) {
  const c = String(cell || '').trim();
  let tok = c.startsWith('`') ? firstCode(c) : c.split(/\s+/)[0];
  if (!tok) return null;
  tok = slash(tok.trim());
  if (/^[A-Za-z]:\/|^\//.test(tok)) {
    const root = slash(projectPath || '').replace(/\/+$/, '').toLowerCase();
    const t = tok.replace(/\/+$/, '');
    if (!root) return null;
    if (t.toLowerCase() === root) return '.';
    if (!t.toLowerCase().startsWith(`${root}/`)) return null;
    tok = t.slice(root.length + 1);
  }
  if (tok === '.' || tok === './') return '.';
  tok = tok.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(tok) || tok.split('/').includes('..')) return null;
  return tok;
}

const ROOTISH = /^(|\.|-+|—|–|n\/a|root|\(root\)|project root|repo root|repository root|project_path)$/i;
const SAME = /^(same|same as above|ditto|"|〃)\b/i;
const PURPOSE_KEYS = {
  install: 'install', build: 'build', compile: 'build', test: 'test', tests: 'test', unit: 'test',
  lint: 'lint', linting: 'lint', type: 'types', types: 'types', typecheck: 'types', tsc: 'types',
  run: 'run', dev: 'run', format: 'format',
};

// "build + test", "lint / type-check" -> ['build','test'], ['lint','types']; a part maps by its first word.
export function purposeKeys(purpose) {
  const p = String(purpose || '').toLowerCase().replace(/\([^)]*\)/g, ' ');
  const keys = [];
  for (const part of p.split(/\/|\+|,|&|\band\b/)) {
    const first = part.split(/[^a-z]+/).filter(Boolean)[0];
    const key = first && PURPOSE_KEYS[first];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Best-effort team.json data from a v1 TEAM.md: projects from the Projects/Repositories table,
// commands from the Commands table (Purpose | Directory | Command), branch strategy from the field
// table. Rows that cannot be placed are counted in `unplaced`.
export function parseTeamMd(text, { projectPath = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const projects = [];
  const pt = sectionTable(lines, /^##\s+(projects|repositories)\b/i);
  if (pt) {
    for (const r of pt.rows) {
      const p = projectFromCell(r[0], projectPath);
      if (p && !projects.some((x) => x.path.toLowerCase() === p.toLowerCase())) projects.push({ path: p });
    }
  }
  if (!projects.length) projects.push({ path: '.' });
  const commands = new Map(projects.map((p) => [p.path, Object.fromEntries(COMMAND_KEYS.map((k) => [k, '']))]));
  const base = path.basename(slash(projectPath || '').replace(/\/+$/, '')).toLowerCase();
  const placeDir = (d) => {
    const lc = d.toLowerCase();
    const hit = projects.find((p) => p.path.toLowerCase() === lc);
    if (hit) return hit.path;
    if (base && lc === base && commands.has('.')) return '.';
    return null;
  };
  let unplaced = 0;
  const ct = sectionTable(lines, /^##\s+commands\b/i);
  if (ct) {
    const col = (re, dflt) => {
      const i = ct.header.findIndex((h) => re.test(h));
      return i >= 0 ? i : dflt;
    };
    const ip = col(/purpose|task|what/, 0);
    const id = col(/dir|where|folder|path/, 1);
    const ic = col(/command/, 2);
    let prevDirs = ['.'];
    for (const r of ct.rows) {
      const dirCell = String(r[id] || '').replace(/`/g, '').trim();
      const dirs = SAME.test(dirCell)
        ? prevDirs
        : dirCell.split(/\s+\/\s+|\s*,\s*|\s+and\s+/).map((d) => {
            const n = slash(d.trim()).replace(/^\.\//, '').replace(/\/+$/, '');
            return ROOTISH.test(n) ? '.' : n;
          });
      prevDirs = dirs;
      const keys = purposeKeys(r[ip]);
      const cmd = firstCode(String(r[ic] || ''));
      if (!keys.length || !cmd || /^none\b/i.test(cmd)) continue;
      for (const d of dirs) {
        const p = placeDir(d);
        if (!p) {
          unplaced++;
          continue;
        }
        const c = commands.get(p);
        for (const k of keys) if (!c[k]) c[k] = cmd.trim();
      }
    }
  }
  const bs = /^\|\s*branch_strategy\s*\|\s*`?([A-Za-z0-9_-]+)`?\s*\|/m.exec(text || '');
  return {
    projects: projects.map((p) => ({ path: p.path, stack: [], commands: commands.get(p.path) })),
    branch_strategy: bs ? bs[1] : 'current-branch',
    unplaced,
  };
}

// The path map as rows for company/MIGRATION.md.
export function pathMapRows(engine) {
  const eng = slash(engine).replace(/\/+$/, '');
  const rows = [];
  for (const [k, [t, n]] of Object.entries(ROLE_TARGETS)) rows.push([`company/roles/${k}.md`, `${eng}/${t}`, n]);
  for (const [k, [t, n]] of Object.entries(SKILL_TARGETS)) rows.push([`company/skills/${k}/SKILL.md`, `${eng}/${t}`, n]);
  for (const [k, [t, n]] of Object.entries(WORKFLOW_TARGETS)) rows.push([`company/workflow/${k}.md`, `${eng}/${t}`, n]);
  rows.push(['company/templates/<path>', `${eng}/templates/<path>`, 'v2 scaffolds differ; see the engine']);
  rows.push(['HADES.md (vault root)', `${eng}/HADES.md`, 'the vault HADES.md is now a pointer']);
  return rows;
}

export function migrationDoc(engine) {
  const eng = slash(engine).replace(/\/+$/, '');
  const cell = (s) => (s ? `\`${s}\`` : '');
  const out = [
    '# HADES v1 -> v2 migration map',
    '',
    `Written by \`hades migrate\`. The HADES v1 framework files of this vault were moved to`,
    '`archive/v1/`; their v2 equivalents live in the engine at',
    `\`${eng}\`. References in vault notes were rewritten with this table (task records under`,
    '`tasks/` and `legacy/` folders are history and were left as they were).',
    '',
    '| v1 (vault) | v2 | Note |',
    '|---|---|---|',
    ...pathMapRows(eng).map(([a, b, n]) => `| ${cell(a)} | ${cell(b)} | ${n} |`),
    '',
    '## Team role notes (`<team_dir>/agents/`)',
    '',
    '| v1 | v2 |',
    '|---|---|',
    ...Object.entries(NOTE_RENAMES).map(([a, b]) => `| \`${a}.md\` | \`${b}.md\` |`),
    '| `senior-fullstack-engineer.md` | `backend-engineer.md` + `frontend-engineer.md`; old note kept as `senior-fullstack-engineer.v1.md` until the LLM pass splits it |',
    '| `uiux-engineer.md` | `frontend-engineer.md`; old note kept as `uiux-engineer.v1.md` until the LLM pass merges it |',
    '| (none) | `tech-lead.md` and any other missing role of the ten-role roster, from the engine templates |',
    '',
    `Company staff (${STAFF_ROLES.join(', ')}) keep team notes in`,
    '`agents/<role>.md` and company-wide notes in `company/staff/<role>.md`.',
    '',
    `Open items carry \`<!-- ${MARKER} ... -->\` markers (\`team.json\`: "${ENV_TODO}");`,
    'run `/hades-learn <team> --migrate` per team to resolve them.',
    '',
  ];
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Planning overlay

class Overlay {
  constructor(root) {
    this.root = root;
    this.map = new Map(); // rel -> { kind: 'file', content?, src? } | { kind: 'gone' }
    this.ops = [];
  }
  abs(rel) {
    return `${this.root}/${rel}`;
  }
  isFile(rel) {
    const o = this.map.get(rel);
    if (o) return o.kind === 'file';
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }
  read(rel) {
    const o = this.map.get(rel);
    if (o && o.kind === 'gone') return null;
    if (o && o.content !== undefined) return o.content;
    try {
      return fs.readFileSync(this.abs(o && o.src ? o.src : rel), 'utf8');
    } catch {
      return null;
    }
  }
  write(rel, content, step) {
    this.map.set(rel, { kind: 'file', content });
    this.ops.push({ step, op: 'write', path: rel, content });
  }
  move(from, to, step) {
    const o = this.map.get(from);
    this.map.set(to, o && o.kind === 'file' ? { ...o } : { kind: 'file', src: from });
    this.map.set(from, { kind: 'gone' });
    this.ops.push({ step, op: 'move', path: from, to });
  }
  // Files under `dir` (vault-relative, '' = root); `skipDir(rel)` prunes directories.
  list(dir = '', skipDir = () => false) {
    const found = new Set();
    const walk = (rel) => {
      let entries;
      try {
        entries = fs.readdirSync(rel ? this.abs(rel) : this.root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skipDir(r)) walk(r);
        } else if (e.isFile()) found.add(r);
      }
    };
    walk(dir);
    const prefix = dir ? `${dir}/` : '';
    for (const [rel, o] of this.map) {
      if (prefix && !rel.startsWith(prefix)) continue;
      if (o.kind === 'gone') found.delete(rel);
      else if (!rel.split('/').slice(0, -1).some((_, i, a) => skipDir(a.slice(0, i + 1).join('/')))) found.add(rel);
    }
    return [...found].sort();
  }
}

// ---------------------------------------------------------------------------------------------
// Git helpers

// Read-only: GIT_OPTIONAL_LOCKS=0 stops "git status" from refreshing the index (a dry run writes nothing).
function gitInfo(vault) {
  const ro = { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const probe = run('git', ['-C', vault, 'rev-parse', '--is-inside-work-tree'], ro);
  if (probe.code !== 0 || probe.stdout.trim() !== 'true') return { git: false, dirty: new Set(), tracked: new Set() };
  const prefix = run('git', ['-C', vault, 'rev-parse', '--show-prefix'], ro).stdout.trim();
  const st = run('git', ['-C', vault, 'status', '--porcelain=v1', '-z', '-uall'], ro);
  if (st.code !== 0) fail(`git status failed in ${vault}: ${st.stderr.trim().split('\n')[0]}`);
  const dirty = new Set();
  const parts = st.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const paths = [rec.slice(3)];
    if (/[RC]/.test(xy)) paths.push(parts[++i]);
    for (const p of paths) {
      if (!p) continue;
      if (prefix && !p.startsWith(prefix)) continue;
      dirty.add(p.slice(prefix.length).replace(/\/$/, ''));
    }
  }
  const ls = run('git', ['-C', vault, 'ls-files', '-z'], ro);
  const tracked = new Set(ls.stdout.split('\0').filter(Boolean));
  return { git: true, dirty, tracked };
}

// ---------------------------------------------------------------------------------------------
// The migration

const DEFAULT_SECURITY = { semgrep_config: 'p/default', dast_live: 'baseline', dast_test: 'full' };
const emptyEnv = () => ({ url: '', deploy: '', health: '', rollback: '', via_push: false, notes: ENV_TODO });

function builtinRoleNote(role, team) {
  return [
    '---', `role: ${role}`, `team: ${team}`, '---', `# ${role} - team ${team} notes`, '',
    '## Overrides', '<!-- `model: <name>` changes the default for this team; empty = defaults -->', '',
    '## Project notes', '',
  ].join('\n');
}

function builtinStaffNote(role) {
  return [
    '---', `role: ${role}`, 'scope: company', '---', `# ${role} - company notes`, '',
    '## Overrides', '<!-- `model: <name>` changes the default for every team; empty = agent default -->', '',
    '## Company notes', '',
  ].join('\n');
}

function builtinContext(team, t) {
  return [`# ${team} - context`, '', '## Purpose', t.description || '', ''].join('\n');
}

function hadesPointer(engine) {
  return [
    V2_MARK,
    '# HADES',
    '',
    `The HADES protocol lives in the engine: read \`${engine}/HADES.md\` and follow it.`,
    'This vault holds company data only (registry, organizations, teams, knowledge, task records).',
    `CLI: \`node ${engine}/bin/hades.mjs <command>\`. The v1 protocol is kept in \`archive/v1/HADES.md\`.`,
    '',
  ].join('\n');
}

function builtinClaude(engine) {
  return [
    '# HADES vault',
    '',
    `This folder is a HADES vault (private company data), not a code project. Policies live in the engine at \`${engine}\`.`,
    'Dispatch work with `/hades <team> <task>`; `/hades-status` lists teams and open tasks.',
    'Never push from here or from any project: the owner reviews and pushes. Never write secret values into vault files.',
    '',
  ].join('\n');
}

function builtinReadme(engine) {
  return [
    '# HADES vault',
    '',
    'Private company data for HADES: organizations, teams, knowledge and task records.',
    '',
    `Engine: \`${engine}\`.`,
    '',
  ].join('\n');
}

export function orgTable(registry) {
  const rows = ['| Organization | Main teams | Sub teams |', '|---|---|---|'];
  const teams = Object.entries(registry.teams || {});
  for (const org of Object.keys(registry.organizations || {})) {
    const of = (type) => teams.filter(([, t]) => t.organization === org && (t.type || 'main') === type).map(([n]) => n).join(', ');
    rows.push(`| ${org} | ${of('main')} | ${of('sub')} |`);
  }
  return rows.join('\n');
}

function withOrgTable(text, registry, eol = '\n') {
  const block = `${ORGS_BEGIN}${eol}${orgTable(registry).split('\n').join(eol)}${eol}${ORGS_END}`;
  const i = text.indexOf(ORGS_BEGIN);
  const j = text.indexOf(ORGS_END);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + ORGS_END.length);
  return `${text.replace(/\s+$/, '')}${eol}${eol}## Organizations${eol}${eol}${block}${eol}`;
}

function normAliases(a) {
  const list = Array.isArray(a) ? a : a == null ? [] : [a];
  const out = [];
  for (const x of list) {
    for (const s of String(x).split(',')) {
      const v = s.trim();
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

function insertAfterHeading(text, headingRe, line) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => headingRe.test(l));
  if (i < 0) return `${text.replace(/\s+$/, '')}\n\n## Project notes\n${line}\n`;
  lines.splice(i + 1, 0, line);
  return lines.join('\n');
}

/**
 * Migrates the vault at ctx.vault. opts: { dryRun, includeDirty }.
 * ctx: { vault, engine, registryFile?, configFile? }. Returns the report (see docs/cli.md).
 */
export function migrateVault(ctx, { dryRun = false, includeDirty = false } = {}) {
  const vault = slash(path.resolve(ctx.vault));
  const engine = slash(ctx.engine).replace(/\/+$/, '');
  const registryRel = 'registry.json';
  const configFile = ctx.configFile || `${engine}/hades.config.json`;
  const tpl = slash(process.env.HADES_TEMPLATES_DIR || `${engine}/templates`);
  const tplFile = (rel) => {
    try {
      return fs.readFileSync(`${tpl}/${rel}`, 'utf8').replace(/^﻿/, '');
    } catch {
      return null;
    }
  };

  const registry = readJson(`${vault}/${registryRel}`);
  const fromVersion = registry.version;
  if (fromVersion !== 2 && fromVersion !== 3) fail(`unsupported registry version ${JSON.stringify(fromVersion)} (expected 2, or 3 = already migrated)`);

  const { git, dirty, tracked } = gitInfo(vault);
  const vfs = new Overlay(vault);
  const report = {
    vault,
    engine,
    dryRun,
    includeDirty,
    registry: { from: fromVersion, to: 3 },
    alreadyMigrated: fromVersion === 3,
    git,
    steps: {
      registry: { changed: false, config: [] },
      roles: { renamed: 0, kept: 0, created: 0, frontmatter: 0 },
      archive: { moved: 0 },
      paths: { files: 0, refs: 0, map: false },
      company: { created: 0, docs: [] },
      teams: { teamJson: 0, context: 0, unplacedCommands: 0 },
    },
    dirty: [...dirty].sort(),
    skipped: [],
    todos: [],
    warnings: [],
    actions: [],
    changes: 0,
    next: [],
  };
  const isDirty = (rel) => !includeDirty && dirty.has(rel);
  const skip = (rel, step, reason) => report.skipped.push({ path: rel, step, reason });
  const todo = (rel, marker) => report.todos.push({ path: rel, marker });
  // Writes `content` to `rel` unless unchanged or dirty. Returns true when planned.
  const put = (rel, content, step) => {
    const cur = vfs.read(rel);
    if (cur === content) return false;
    if (cur !== null && isDirty(rel)) {
      skip(rel, step, 'uncommitted changes');
      return false;
    }
    vfs.write(rel, content, step);
    return true;
  };

  // --- registry + hades.config.json ------------------------------------------------------------
  const vaults = [vault, registry.vault];
  let config = {};
  if (fs.existsSync(configFile)) config = readJson(configFile);
  if (config.vault) vaults.push(config.vault);
  const reg = {};
  for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(registry)))) {
    if (k === 'vault' || k === 'git_root' || k === 'hierarchy') continue;
    reg[k] = k === 'version' ? 3 : v;
  }
  if (!('version' in reg)) reg.version = 3;
  for (const o of Object.values(reg.organizations || {})) {
    if ('aliases' in o) o.aliases = normAliases(o.aliases);
  }
  for (const t of Object.values(reg.teams || {})) {
    t.aliases = normAliases(t.aliases);
    if (!t.status) t.status = 'active';
    if (!t.type) t.type = 'main';
  }
  let configChanges = null;
  if (JSON.stringify(reg) !== JSON.stringify(registry)) {
    if (isDirty(registryRel)) {
      skip(registryRel, 'registry', 'uncommitted changes');
    } else {
      vfs.write(registryRel, `${JSON.stringify(reg, null, 2)}\n`, 'registry');
      report.steps.registry.changed = true;
      const next = { ...config };
      if (registry.vault && !config.vault) {
        next.vault = vault;
        report.steps.registry.config.push('vault');
        const declared = slash(path.resolve(String(registry.vault))).toLowerCase();
        if (declared !== vault.toLowerCase()) {
          report.warnings.push(`registry "vault" was ${slash(String(registry.vault))}; hades.config.json gets the migrated vault ${vault}`);
        }
      }
      if (registry.git_root && !config.workspace) {
        next.workspace = slash(String(registry.git_root)).replace(/\/+$/, '');
        report.steps.registry.config.push('workspace');
      }
      if (report.steps.registry.config.length) configChanges = next;
    }
  }
  const registryNow = reg;

  // --- archive v1 framework files --------------------------------------------------------------
  const v1Framework = ARCHIVE_DIRS.some((d) => vfs.list(d).length > 0);
  const archive = (rel) => {
    const to = `archive/v1/${rel}`;
    if (isDirty(rel)) return skip(rel, 'archive', 'uncommitted changes');
    if (vfs.isFile(to)) return skip(rel, 'archive', `conflict: ${to} exists`);
    vfs.move(rel, to, 'archive');
    report.steps.archive.moved++;
  };
  for (const d of ARCHIVE_DIRS) for (const f of vfs.list(d)) archive(f);
  if (v1Framework && vfs.isFile('company/README.md') && !vfs.isFile('archive/v1/company/README.md')) archive('company/README.md');

  // --- role notes per team ---------------------------------------------------------------------
  const teams = Object.entries(registryNow.teams || {});
  const orgs = registryNow.organizations || {};
  const teamVars = (name, t) => ({
    TEAM: name,
    TEAM_NAME: name,
    ORG: t.organization || '',
    ORG_NAME: t.organization || '',
    ORG_DIR: (orgs[t.organization] || {}).org_dir || `organizations/${t.organization}`,
    TEAM_TYPE: t.type || 'main',
    TEAM_DIR: t.team_dir,
    PROJECT_PATH: t.project_path || '',
    DESCRIPTION: t.description || '',
    ALIASES: (t.aliases || []).join(', '),
    VAULT: vault,
    HADES_VAULT: vault,
    ENGINE: engine,
    HADES_HOME: engine,
    DATE: today(),
  });
  const liveTeams = [];
  for (const [name, t] of teams) {
    const teamRel = slash(t.team_dir || `organizations/${t.organization}/teams/${name}`).replace(/^\.?\/+|\/+$/g, '');
    if (!fs.existsSync(`${vault}/${teamRel}`)) {
      report.warnings.push(`team ${name}: folder ${teamRel} missing, skipped`);
      continue;
    }
    liveTeams.push([name, t, teamRel]);
    const ag = `${teamRel}/agents`;
    const blocked = new Set();
    const fresh = new Set();
    for (const [v1, v2] of Object.entries(NOTE_RENAMES)) {
      const src = `${ag}/${v1}.md`;
      const dst = `${ag}/${v2}.md`;
      if (!vfs.isFile(src)) continue;
      blocked.add(v2);
      if (vfs.isFile(dst)) skip(src, 'roles', `conflict: ${v2}.md exists`);
      else if (isDirty(src)) skip(src, 'roles', 'uncommitted changes');
      else {
        vfs.move(src, dst, 'roles');
        report.steps.roles.renamed++;
        blocked.delete(v2);
      }
    }
    const splitFrom = [];
    let splitBlocked = false;
    for (const v1 of NOTE_SPLITS) {
      const src = `${ag}/${v1}.md`;
      const keep = `${ag}/${v1}.v1.md`;
      if (!vfs.isFile(src)) continue;
      if (vfs.isFile(keep)) {
        skip(src, 'roles', `conflict: ${v1}.v1.md exists`);
        splitBlocked = true;
      } else if (isDirty(src)) {
        skip(src, 'roles', 'uncommitted changes');
        splitBlocked = true;
      } else {
        vfs.move(src, keep, 'roles');
        report.steps.roles.kept++;
        splitFrom.push(v1);
      }
    }
    const vars = teamVars(name, t);
    for (const role of V2_ROLES) {
      const dst = `${ag}/${role}.md`;
      if (vfs.isFile(dst) || blocked.has(role)) continue;
      const split = role === 'backend-engineer' || role === 'frontend-engineer';
      if (split && splitBlocked) continue;
      const tplText = tplFile(`team/agents/${role}.md`);
      let text = tplText !== null ? render(tplText, { ...vars, ROLE: role }) : builtinRoleNote(role, name);
      const sources = split ? splitFrom.filter((s) => role === 'frontend-engineer' || s === 'senior-fullstack-engineer') : [];
      if (sources.length) {
        const marker = `<!-- ${MARKER} split notes from ${sources.map((s) => `${s}.v1.md`).join(' and ')} -->`;
        text = insertAfterHeading(text, /^##\s+Project notes\s*$/, marker);
        todo(dst, marker);
      }
      vfs.write(dst, text.endsWith('\n') ? text : `${text}\n`, 'roles');
      fresh.add(dst);
      report.steps.roles.created++;
    }
    for (const role of V2_ROLES) {
      const p = `${ag}/${role}.md`;
      if (fresh.has(p) || !vfs.isFile(p)) continue;
      const raw = vfs.read(p);
      const next = normalizeNote(raw, { role, team: name });
      if (next !== raw && put(p, next, 'roles')) report.steps.roles.frontmatter++;
    }
  }

  // --- path rewrite across the vault's .md files -----------------------------------------------
  const skipDir = (rel) => {
    const segs = rel.split('/');
    const last = segs[segs.length - 1];
    if (['.git', 'node_modules', 'legacy', 'tasks'].includes(last)) return true;
    return rel === 'archive' || ARCHIVE_DIRS.includes(rel);
  };
  const noRewrite = new Set([...ROOT_DOCS, 'company/MIGRATION.md']);
  for (const rel of vfs.list('', skipDir)) {
    if (!rel.toLowerCase().endsWith('.md') || noRewrite.has(rel)) continue;
    const raw = vfs.read(rel);
    if (raw === null) continue;
    const { text, count } = rewriteV1Paths(raw, { engine, vaults });
    if (!count || text === raw) continue;
    if (isDirty(rel)) {
      skip(rel, 'paths', `uncommitted changes (${count} v1 refs)`);
      continue;
    }
    vfs.write(rel, text, 'paths');
    report.steps.paths.files++;
    report.steps.paths.refs += count;
  }
  if (put('company/MIGRATION.md', migrationDoc(engine), 'paths')) report.steps.paths.map = true;

  // --- company v2 layout + root docs -----------------------------------------------------------
  const vaultVars = { VAULT: vault, HADES_VAULT: vault, ENGINE: engine, HADES_HOME: engine, DATE: today() };
  const companyTpl = `${tpl}/vault/company`;
  const companyFiles = [];
  if (fs.existsSync(companyTpl)) {
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(`${dir}/${e.name}`, r);
        else companyFiles.push([render(r, vaultVars), render(fs.readFileSync(`${dir}/${e.name}`, 'utf8').replace(/^﻿/, ''), vaultVars)]);
      }
    };
    walk(companyTpl, '');
  } else {
    for (const role of STAFF_ROLES) companyFiles.push([`staff/${role}.md`, builtinStaffNote(role)]);
  }
  for (const [rel, text] of companyFiles.sort((a, b) => a[0].localeCompare(b[0]))) {
    const dst = `company/${rel}`;
    if (vfs.isFile(dst)) continue;
    vfs.write(dst, text, 'company');
    report.steps.company.created++;
  }
  const rootDoc = (name, make) => {
    const cur = vfs.read(name);
    if (cur !== null && cur.includes(V2_MARK)) {
      if (name === 'README.md' && cur.includes(ORGS_BEGIN)) {
        const eol = cur.includes('\r\n') ? '\r\n' : '\n';
        if (put(name, withOrgTable(cur, registryNow, eol), 'docs')) report.steps.company.docs.push(name);
      }
      return;
    }
    if (cur !== null && isDirty(name)) return skip(name, 'docs', 'uncommitted changes');
    if (cur !== null) {
      // The owner's file is replaced only when its text is safe in archive/v1/. An archive from an
      // earlier run that holds other text means this file is the owner's (e.g. the v2 marker was
      // removed): a conflict, never overwritten.
      const archived = vfs.read(`archive/v1/${name}`);
      if (archived === null) vfs.write(`archive/v1/${name}`, cur, 'docs');
      else if (archived !== cur) return skip(name, 'docs', `conflict: archive/v1/${name} exists and differs (no v2 marker; edit or remove the file by hand)`);
    }
    let text = make(cur);
    text = `${V2_MARK}\n${text.replace(/^<!-- hades: v2 -->\r?\n/, '')}`;
    vfs.write(name, text.endsWith('\n') ? text : `${text}\n`, 'docs');
    report.steps.company.docs.push(name);
  };
  rootDoc('HADES.md', () => hadesPointer(engine));
  rootDoc('CLAUDE.md', () => {
    const t = tplFile('vault/CLAUDE.md');
    return t !== null ? render(t, vaultVars) : builtinClaude(engine);
  });
  rootDoc('README.md', (cur) => {
    const t = tplFile('vault/README.md');
    const text = t !== null ? render(t, vaultVars) : builtinReadme(engine);
    const hadTable = cur !== null && /^\|\s*Organi[sz]ations?\s*\|/im.test(cur);
    return hadTable ? withOrgTable(text, registryNow) : text;
  });

  // --- team.json + CONTEXT.md ------------------------------------------------------------------
  for (const [name, t, teamRel] of liveTeams) {
    const tj = `${teamRel}/team.json`;
    if (!vfs.isFile(tj)) {
      const parsed = parseTeamMd(vfs.read(`${teamRel}/TEAM.md`) || '', { projectPath: t.project_path });
      let base = null;
      const tplText = tplFile('team/team.json');
      if (tplText !== null) {
        try {
          base = JSON.parse(render(tplText, teamVars(name, t)));
        } catch {
          base = null;
        }
      }
      const data = { ...(base || {}), team: name, projects: parsed.projects, environments: { test: emptyEnv(), live: emptyEnv() } };
      data.branch_strategy = parsed.branch_strategy;
      if (!data.security) data.security = { ...DEFAULT_SECURITY };
      vfs.write(tj, `${JSON.stringify(data, null, 2)}\n`, 'teams');
      todo(tj, ENV_TODO);
      report.steps.teams.teamJson++;
      report.steps.teams.unplacedCommands += parsed.unplaced;
    }
    const cx = `${teamRel}/CONTEXT.md`;
    if (!vfs.isFile(cx)) {
      const tplText = tplFile('team/CONTEXT.md');
      let text = tplText !== null ? render(tplText, teamVars(name, t)) : builtinContext(name, t);
      const marker = `<!-- ${MARKER} write this digest (<= 120 lines) from TEAM.md, knowledge/ and projects/ -->`;
      const lines = text.split('\n');
      const h = lines.findIndex((l) => /^#\s/.test(l));
      lines.splice(h >= 0 ? h + 1 : 0, 0, marker);
      text = lines.join('\n');
      vfs.write(cx, text.endsWith('\n') ? text : `${text}\n`, 'teams');
      todo(cx, marker);
      report.steps.teams.context++;
    }
  }

  // --- report + apply --------------------------------------------------------------------------
  report.actions = vfs.ops.map(({ step, op, path: p, to }) => (to ? { step, op, path: p, to } : { step, op, path: p }));
  if (configChanges) report.actions.unshift({ step: 'registry', op: 'config', path: slash(configFile) });
  report.changes = report.actions.length;
  // Teams with work left for the LLM pass: kept .v1.md notes or a marker in a team file.
  const todoTeams = liveTeams
    .filter(([, , rel]) =>
      [...vfs.list(`${rel}/agents`), `${rel}/CONTEXT.md`, `${rel}/team.json`].some(
        (f) => f.endsWith('.v1.md') || (vfs.read(f) || '').includes('hades-migrate'),
      ),
    )
    .map(([n]) => n);
  if (report.skipped.some((s) => /uncommitted/.test(s.reason))) report.next.push('commit or stash the skipped files, then run "hades migrate" again');
  if (todoTeams.length) report.next.push(`run the LLM pass: /hades-learn <team> --migrate (teams: ${todoTeams.join(', ')})`);
  report.next.push('hades install', 'hades doctor');

  if (!dryRun) {
    if (configChanges) writeJson(configFile, configChanges);
    apply(vault, vfs.ops, tracked, report);
  }
  return report;
}

// Replays planned ops: writes are atomic file writes; moves use "git mv" for tracked files (batched
// per destination folder) and a plain rename otherwise. Emptied source folders are removed.
function apply(vault, ops, tracked, report) {
  const touched = new Set();
  const gitMv = (froms, dest) => run('git', ['-C', vault, 'mv', '--', ...froms, dest]).code === 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'write') {
      writeText(`${vault}/${op.path}`, op.content);
      continue;
    }
    // Batch consecutive tracked moves into the same folder with unchanged file names.
    const destDir = path.posix.dirname(op.to);
    const sameName = (o) => path.posix.basename(o.path) === path.posix.basename(o.to);
    const batch = [op];
    if (tracked.has(op.path) && sameName(op)) {
      while (i + 1 < ops.length && ops[i + 1].op === 'move' && tracked.has(ops[i + 1].path) && sameName(ops[i + 1]) &&
        path.posix.dirname(ops[i + 1].to) === destDir && batch.length < 50) batch.push(ops[++i]);
    }
    fs.mkdirSync(`${vault}/${destDir}`, { recursive: true });
    let done = false;
    if (tracked.has(op.path)) {
      done = batch.length > 1 ? gitMv(batch.map((o) => o.path), destDir) : gitMv([op.path], op.to);
      if (!done && batch.length > 1) done = batch.every((o) => gitMv([o.path], o.to));
    }
    for (const o of batch) {
      if (!done && fs.existsSync(`${vault}/${o.path}`)) {
        fs.renameSync(`${vault}/${o.path}`, `${vault}/${o.to}`);
        if (tracked.has(o.path)) report.warnings.push(`git mv failed for ${o.path}; renamed without git`);
      }
      if (tracked.delete(o.path)) tracked.add(o.to);
      touched.add(path.posix.dirname(o.path));
    }
  }
  for (const dir of [...touched].sort((a, b) => b.length - a.length)) {
    let d = dir;
    while (d && d !== '.') {
      try {
        fs.rmdirSync(`${vault}/${d}`);
      } catch {
        break;
      }
      d = path.posix.dirname(d);
    }
  }
}
