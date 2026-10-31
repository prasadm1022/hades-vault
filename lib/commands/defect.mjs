// hades defect add <task> --title "..." --severity <s> --owner <role> --source <qa|security|review|deploy> [--repro] [--refs a,b] [--evidence] [--by <role>] [--note]
// hades defect update <task> <D#> --status <fixed|verified|reopened|wontfix> [--note "..."] [--by <role>] [--force]
// hades defect list <task> [--open] [--owner <role>] [--source <src>] [--severity <s>]
// Defects of a task (defects.json). Rounds: each move to "fixed" is a round; a reopen after round
// MAX_ROUNDS makes the defect "blocked". Format: docs/file-formats.md.
import { print, fail, nowIso, allowFlags } from '../core/util.mjs';
import { resolveTask, loadDefects, updateDefects, SEVERITIES, DEFECT_STATUS, DEFECT_OWNERS, DEFECT_SOURCES, MAX_ROUNDS } from '../core/task.mjs';

// qa = QA testing, security = cybersecurity testing, review = tech-lead integration review,
// deploy = failed deploy or health check.
export const SOURCES = DEFECT_SOURCES;
export const UPDATE_STATUS = ['fixed', 'verified', 'reopened', 'wontfix'];
// Allowed moves (from -> to). "blocked" is set by the CLI only; --force allows any move.
export const TRANSITIONS = {
  open: ['fixed', 'wontfix'],
  fixed: ['verified', 'reopened', 'wontfix'],
  reopened: ['fixed', 'wontfix'],
  verified: ['reopened'],
  wontfix: ['reopened'],
  blocked: ['wontfix'],
};
// Default --by of a new defect and of verify/reopen moves.
const FINDER = { qa: 'qa-engineer', security: 'cybersecurity-engineer', review: 'tech-lead', deploy: 'devops-engineer' };

const HELP = `Usage:
  hades defect add <task> --title "..." --severity <${SEVERITIES.join('|')}> --owner <role> --source <${DEFECT_SOURCES.join('|')}>
                   [--repro "..."] [--refs a,b] [--evidence "..."] [--by <role>] [--note "..."]   prints the ID
  hades defect update <task> <D#> --status <${UPDATE_STATUS.join('|')}> [--note "..."] [--by <role>] [--force]
  hades defect list <task> [--open] [--owner <role>] [--source <${DEFECT_SOURCES.join('|')}>] [--severity <s>]
All accept --json. Owners: ${DEFECT_OWNERS.join(', ')}.
Sources: qa (QA testing), security (security testing), review (tech-lead integration review),
deploy (failed deploy or health check).
Flow: open -> fixed -> verified, or fixed -> reopened -> fixed ...; each move to fixed is a round;
a reopen after round ${MAX_ROUNDS} makes the defect "blocked". wontfix needs --note (the reason).
--open = not verified and not wontfix. Exit: 0 ok, 1 error or refused.`;

const BOOLEANS = ['json', 'help', 'open', 'force'];
// Flags per subcommand (checked by bin/hades.mjs and again here).
export const FLAGS = {
  add: ['title', 'severity', 'owner', 'source', 'repro', 'refs', 'evidence', 'by', 'note'],
  update: ['status', 'note', 'by', 'force'],
  list: ['open', 'owner', 'source', 'severity'],
};
export const BOOLEAN_FLAGS = ['open', 'force'];

function fixBooleans(args) {
  for (const k of BOOLEANS) {
    const v = args.flags[k];
    if (typeof v === 'string' && !['true', 'yes', '1'].includes(v.toLowerCase())) args.positional.unshift(v);
    if (v !== undefined) args.flags[k] = true;
  }
}

function allow(args, allowed, maxPositional) {
  allowFlags(args, allowed);
  if (args.positional.length > maxPositional) fail(`unexpected argument: ${args.positional[maxPositional]}`);
}

function str(flags, key, { required = false } = {}) {
  const v = flags[key];
  if (v === undefined) {
    if (required) fail(`--${key} is required`);
    return undefined;
  }
  if (v === true) fail(`--${key} needs a value`);
  return String(v);
}

function oneOf(value, list, flag) {
  if (value !== undefined && !list.includes(value)) fail(`--${flag} must be ${list.join('|')} (is "${value}")`);
  return value;
}

export async function run(args, ctx) {
  fixBooleans(args);
  const sub = args.positional[0];
  if (args.flags.help || !sub || sub === 'help') {
    print(HELP);
    return;
  }
  args.positional.shift();
  if (!args.positional[0]) fail(`missing <task>\n${HELP}`);
  if (sub === 'add') return defectAdd(args, ctx);
  if (sub === 'update') return defectUpdate(args, ctx);
  if (sub === 'list') return defectList(args, ctx);
  fail(`unknown subcommand "defect ${sub}"\n${HELP}`);
}

const isOpen = (d) => !['verified', 'wontfix'].includes(d.status);

export function formatDefect(d) {
  return `${d.id} ${d.severity} ${d.status} ${d.owner} r${d.round || 0} ${d.title}`;
}

function nextId(data) {
  const max = data.defects.reduce((m, d) => Math.max(m, Number((/^D(\d+)$/.exec(d.id || '') || [0, 0])[1])), 0);
  return `D${max + 1}`;
}

function defectAdd(args, ctx) {
  allow(args, FLAGS.add, 1);
  const task = resolveTask(ctx, args.positional[0]);
  const title = str(args.flags, 'title', { required: true }).replace(/\s+/g, ' ').trim();
  if (!title) fail('--title is empty');
  const severity = oneOf(str(args.flags, 'severity', { required: true }), SEVERITIES, 'severity');
  const owner = oneOf(str(args.flags, 'owner', { required: true }), DEFECT_OWNERS, 'owner');
  const source = oneOf(str(args.flags, 'source', { required: true }), SOURCES, 'source');
  const refsRaw = str(args.flags, 'refs');
  const refs = refsRaw ? refsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const at = nowIso();
  const fields = {
    title,
    severity,
    source,
    owner,
    status: 'open',
    round: 0,
    repro: str(args.flags, 'repro') || '',
    evidence: str(args.flags, 'evidence') || '',
    refs,
    history: [{ at, status: 'open', by: str(args.flags, 'by') || FINDER[source], note: str(args.flags, 'note') || '' }],
  };
  // The ID is allocated inside the lock: parallel adds get distinct IDs and none is lost.
  const d = updateDefects(task, (data) => {
    const rec = { id: nextId(data), ...fields };
    data.defects.push(rec);
    return rec;
  });
  if (args.flags.json) print(JSON.stringify(d, null, 2));
  else print(d.id);
}

function defectUpdate(args, ctx) {
  allow(args, FLAGS.update, 2);
  const task = resolveTask(ctx, args.positional[0]);
  const id = String(args.positional[1] || '').toUpperCase();
  if (!id) fail(`missing <D#>\n${HELP}`);
  const status = oneOf(str(args.flags, 'status', { required: true }), UPDATE_STATUS, 'status');
  const note = str(args.flags, 'note');
  const force = !!args.flags.force;
  if (status === 'wontfix' && !(note && note.trim())) fail('wontfix needs --note "<reason>"');
  const byFlag = str(args.flags, 'by');
  // Find, check the transition and record it inside the lock (no lost or double update).
  const { d, final, blocked } = updateDefects(task, (data) => {
    const d = data.defects.find((x) => String(x.id).toUpperCase() === id);
    if (!d) fail(`no defect ${id} in ${task.id} (defects: ${data.defects.map((x) => x.id).join(', ') || 'none'})`);
    const from = DEFECT_STATUS.includes(d.status) ? d.status : 'open';
    if (!force && !(TRANSITIONS[from] || []).includes(status)) {
      fail(`refused: ${d.id} is ${from}; allowed: ${(TRANSITIONS[from] || []).join(', ') || 'none'} (or --force)`);
    }
    const at = nowIso();
    const by = byFlag || (status === 'fixed' ? d.owner : status === 'wontfix' ? 'project-manager' : FINDER[d.source] || '');
    let final = status;
    let blocked = false;
    if (status === 'fixed') d.round = (d.round || 0) + 1;
    if (status === 'reopened' && (d.round || 0) >= MAX_ROUNDS) {
      final = 'blocked';
      blocked = true;
    }
    d.status = final;
    if (!Array.isArray(d.history)) d.history = [];
    if (blocked) {
      d.history.push({ at, status: 'reopened', by, note: note || '' });
      d.history.push({ at, status: 'blocked', by: 'hades', note: `reopened after round ${d.round} (limit ${MAX_ROUNDS})` });
    } else {
      d.history.push({ at, status: final, by, note: note || '' });
    }
    return { d, final, blocked };
  });
  if (args.flags.json) {
    print(JSON.stringify({ ...d, blocked }, null, 2));
    return;
  }
  if (blocked) {
    print(`${d.id} BLOCKED: reopened after round ${d.round} (limit ${MAX_ROUNDS}); no more fix rounds - continue with what is safe and report it`);
  } else {
    print(`${d.id} ${final}${status === 'fixed' ? ` (round ${d.round}/${MAX_ROUNDS})` : ''}`);
  }
}

function defectList(args, ctx) {
  allow(args, FLAGS.list, 1);
  const task = resolveTask(ctx, args.positional[0]);
  const owner = oneOf(str(args.flags, 'owner'), DEFECT_OWNERS, 'owner');
  const source = oneOf(str(args.flags, 'source'), SOURCES, 'source');
  const severity = oneOf(str(args.flags, 'severity'), SEVERITIES, 'severity');
  const data = loadDefects(task);
  const list = (data.defects || []).filter(
    (d) => (!args.flags.open || isOpen(d)) && (!owner || d.owner === owner) && (!source || d.source === source) && (!severity || d.severity === severity),
  );
  if (args.flags.json) {
    print(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    print(`no ${args.flags.open ? 'open ' : ''}defects${owner || source || severity ? ' matching' : ''} in ${task.id}`);
    return;
  }
  for (const d of list) print(formatDefect(d));
}
