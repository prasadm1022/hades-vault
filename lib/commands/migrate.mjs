// hades migrate [--dry-run] [--json] [--include-dirty]
// Upgrades a HADES v1 vault (registry version 2) to v2. Deterministic work only; judgement work is
// left to the LLM pass (/hades-learn <team> --migrate) behind "hades-migrate: TODO" markers.
import { output, print, fail, allowFlags } from '../core/util.mjs';
import { migrateVault } from '../core/migrate.mjs';

export const needsVault = true;
export const FLAGS = ['dryRun', 'includeDirty'];
export const BOOLEAN_FLAGS = ['dryRun', 'includeDirty'];

const HELP = `hades migrate [--dry-run] [--json] [--include-dirty]

Upgrades a HADES v1 vault (registry version 2) to v2: registry v3 (vault/git_root moved to
hades.config.json), role notes renamed to the ten-role roster, missing notes, team.json and
CONTEXT.md scaffolded, v1 company/ paths rewritten to engine paths, v1 framework files moved to
archive/v1/. Leaves "hades-migrate: TODO" markers for /hades-learn <team> --migrate.
Running it again changes nothing.

  --dry-run        print the plan; change nothing
  --include-dirty  also touch files with uncommitted changes (skipped and listed by default)
  --json           machine output (full plan in "actions")`;

const MAX_LIST = 10;
const list = (items) => (items.length > MAX_LIST ? `${items.slice(0, MAX_LIST).join(', ')} (+${items.length - MAX_LIST} more)` : items.join(', '));

export function formatReport(r) {
  const s = r.steps;
  const out = [`hades migrate${r.dryRun ? ' (dry run, nothing written)' : ''}: ${r.vault}`];
  const reg = r.alreadyMigrated ? 'already v3' : s.registry.changed ? 'v2 -> v3' : 'v2 (not written)';
  out.push(`registry  ${reg}${s.registry.config.length ? `; hades.config.json: ${s.registry.config.join(', ')}` : ''}`);
  out.push(`roles     ${s.roles.renamed} renamed, ${s.roles.kept} kept as .v1.md, ${s.roles.created} created, ${s.roles.frontmatter} frontmatter`);
  out.push(`archive   ${s.archive.moved} v1 framework files -> archive/v1/`);
  out.push(`paths     ${s.paths.refs} refs in ${s.paths.files} files${s.paths.map ? '; map: company/MIGRATION.md' : ''}`);
  out.push(`company   ${s.company.created} created${s.company.docs.length ? `; rewritten: ${s.company.docs.join(', ')}` : ''}`);
  out.push(`teams     ${s.teams.teamJson} team.json, ${s.teams.context} CONTEXT.md${s.teams.unplacedCommands ? `; ${s.teams.unplacedCommands} command rows not placed` : ''}`);
  const dirtySkips = [...new Set(r.skipped.filter((x) => /uncommitted/.test(x.reason)).map((x) => x.path))];
  const conflicts = r.skipped.filter((x) => !/uncommitted/.test(x.reason));
  if (r.dirty.length) {
    const tail = r.includeDirty ? ' (included)' : dirtySkips.length ? `; skipped: ${list(dirtySkips)}` : '; none needed changes';
    out.push(`dirty     ${r.dirty.length} files with uncommitted changes${tail}`);
  }
  if (conflicts.length) out.push(`conflicts ${list(conflicts.map((x) => `${x.path} (${x.reason})`))}`);
  if (r.todos.length) out.push(`todos     ${r.todos.length} hades-migrate TODO markers in ${new Set(r.todos.map((t) => t.path)).size} files`);
  for (const w of r.warnings) out.push(`warning   ${w}`);
  if (!r.changes) out.push('nothing to change');
  if (r.dryRun && r.actions.length) {
    out.push(`plan (${r.actions.length} actions${r.actions.length > 25 ? ', first 25; --json for all' : ''}):`);
    for (const a of r.actions.slice(0, 25)) out.push(`  ${a.step.padEnd(8)} ${a.op.padEnd(6)} ${a.path}${a.to ? ` -> ${a.to}` : ''}`);
  }
  out.push(`next      ${r.next.join('\n          ')}`);
  return out.join('\n');
}

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  if (args.flags.help) {
    print(HELP);
    return;
  }
  if (args.positional.length) fail(`unexpected argument "${args.positional[0]}". Usage: hades migrate [--dry-run] [--json] [--include-dirty]`);
  const report = migrateVault(ctx, { dryRun: Boolean(args.flags.dryRun), includeDirty: Boolean(args.flags.includeDirty) });
  output(args, report, formatReport);
}
