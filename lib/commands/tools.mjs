// hades tools list | setup [<name>...] | run <name> -- <args> | verify | bump <name> <tag> [--force] | patch <name>
import { print, output, HadesError, allowFlags, commandFlags } from '../core/util.mjs';
import {
  lockfile,
  recipe,
  canonicalName,
  resolveTool,
  setupTool,
  verifyTools,
  bumpTool,
  patchTool,
  execInherit,
  mergeEnv,
} from '../core/tools.mjs';

export const needsVault = false;
export const FLAGS = { list: [], setup: ['force', 'fromSource'], run: [], verify: [], bump: ['force', 'dropPatch'], patch: ['note', 'drop'] };
export const BOOLEAN_FLAGS = ['force', 'fromSource', 'dropPatch', 'drop'];

const HELP = `Usage:
  hades tools list                         pinned tools: tag, license, how each runs now
  hades tools setup [<name>...] [--force] [--from-source]
                                           install pinned tools into .tools-bin/ (default: all)
  hades tools run <name> -- <args>         run a pinned tool (stdio inherited, exit code passed through)
  hades tools verify                       submodule HEADs equal tools.lock.json (exit 2 on mismatch)
  hades tools bump <name> <tag> [--force] [--drop-patch]
                                           move a pin (cooldown policy; network)
  hades tools patch <name> [--note <text>] pin the commit in tools/<name> (a branch pushed to your
                                           fork) as a patch over the upstream pin
  hades tools patch <name> --drop          back to the upstream base, forget the patch
Aliases: playwright = playwright-mcp, aws = mcp-proxy-for-aws.`;

function pinLabel(pin) {
  if (pin.patch) return `${pin.patch.base_tag || `commit ${pin.patch.base_commit.slice(0, 7)}`}+patch`;
  return pin.tag || (pin.commit ? `commit ${pin.commit.slice(0, 7)}` : '?');
}

function shortLicense(lic) {
  return String(lic || '?').replace(/\s*\(.*?\)/g, '');
}

function list(args, ctx) {
  const lock = lockfile(ctx);
  const rows = Object.entries(lock.tools || {}).map(([name, pin]) => {
    const r = recipe(name);
    let via;
    let note = '';
    if (!r || !r.runnable) via = 'data';
    else {
      try {
        const res = resolveTool(ctx, name);
        via = res.version ? `${res.via} ${res.version}` : res.via;
        const installed = ['local', 'env', 'path'].includes(res.via) || (res.via === 'docker' && /digest/.test(res.note || ''));
        if (!installed) note = 'on demand, not set up';
      } catch {
        via = 'not set up';
      }
    }
    return { name, pin: pinLabel(pin), license: pin.license || '?', via, note };
  });
  output(args, rows, () => {
    const w = Math.max(...rows.map((r) => r.name.length)) + 2;
    const p = Math.max(...rows.map((r) => r.pin.length)) + 2;
    const l = Math.max(...rows.map((r) => shortLicense(r.license).length)) + 2;
    return rows
      .map((r) => `${r.name.padEnd(w)}${r.pin.padEnd(p)}${shortLicense(r.license).padEnd(l)}${r.via}${r.note && r.via !== 'not set up' ? ` (${r.note})` : ''}`)
      .join('\n');
  });
}

async function setup(args, ctx) {
  const lock = lockfile(ctx);
  const names = args.positional.slice(1).map(canonicalName);
  const targets = names.length ? names : Object.keys(lock.tools || {}).filter((n) => recipe(n) && recipe(n).runnable);
  const results = [];
  for (const name of targets) {
    let res;
    try {
      res = await setupTool(ctx, name, { force: !!args.flags.force, fromSource: !!args.flags.fromSource });
    } catch (err) {
      res = { name, ok: false, error: err && err.message ? err.message : String(err) };
    }
    results.push(res);
    if (!args.flags.json) {
      if (res.ok) print(`ok    ${res.name.padEnd(18)} ${res.via}${res.version ? ` ${res.version}` : ''}: ${res.detail}`);
      else print(`FAIL  ${res.name.padEnd(18)} ${String(res.error).split('\n').join('\n      ')}`);
    }
  }
  if (args.flags.json) print(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new HadesError(`${failed.length} of ${results.length} tool(s) failed to set up: ${failed.map((r) => r.name).join(', ')}`);
}

async function runCmd(args, ctx) {
  const name = args.positional[1];
  if (!name) throw new HadesError('usage: hades tools run <name> -- <args>');
  const r = resolveTool(ctx, name, { cwd: process.cwd() });
  const code = await execInherit(r.cmd, r.args.concat(args.rest), { env: mergeEnv(process.env, r.env) });
  process.exitCode = code;
}

function verify(args, ctx) {
  const rows = verifyTools(ctx);
  const bad = rows.filter((r) => !r.ok);
  output(args, rows, () =>
    [
      ...bad.map((r) => `MISMATCH ${r.name}: lock ${r.expected.slice(0, 12)}, ${r.actual ? `HEAD ${r.actual.slice(0, 12)}` : r.status}`),
      ...rows.filter((r) => r.patch).map((r) => `PATCHED  ${r.name}: ${r.patch.commits} commit(s) on ${r.patch.branch} over ${r.patch.base_tag || r.patch.base_commit.slice(0, 12)}`),
      `${rows.length - bad.length}/${rows.length} tool pins match tools.lock.json`,
    ].join('\n'),
  );
  if (bad.length) throw new HadesError(`${bad.length} tool(s) differ from tools.lock.json (fix: git submodule update --init --checkout tools/<name>)`, 2);
}

async function bump(args, ctx) {
  const [, name, ref] = args.positional;
  if (!name || !ref) throw new HadesError('usage: hades tools bump <name> <tag> [--force] [--drop-patch]');
  const res = await bumpTool(ctx, name, ref, { force: !!args.flags.force, dropPatch: !!args.flags.dropPatch });
  output(
    args,
    res,
    `${res.name}: ${res.from} -> ${res.to} (commit ${res.commit.slice(0, 12)}, released ${res.released}, ${res.days} days${res.forced ? ', cooldown overridden' : ''})\n` +
      `next: hades tools setup ${res.name} --force; review and commit tools/${res.name} and tools/tools.lock.json`,
  );
}

function patch(args, ctx) {
  const name = args.positional[1];
  if (!name) throw new HadesError('usage: hades tools patch <name> [--note <text>] | hades tools patch <name> --drop');
  const note = typeof args.flags.note === 'string' ? args.flags.note : null;
  const res = patchTool(ctx, name, { note, drop: !!args.flags.drop });
  const text = res.dropped
    ? `${res.name}: patch dropped, back to ${res.commit.slice(0, 12)} (was ${res.from})`
    : `${res.name}: ${res.from} -> ${res.commit.slice(0, 12)} (${res.commits} commit(s) on ${res.branch} over ${res.base})\ntakes effect: ${res.effect}`;
  output(args, res, `${text}\nnext: hades tools setup ${res.name} --force; review and commit tools/${res.name} and tools/tools.lock.json`);
}

export async function run(args, ctx) {
  allowFlags(args, commandFlags({ FLAGS }, args));
  const sub = args.positional[0];
  if (!sub || args.flags.help || sub === 'help') {
    print(HELP);
    return;
  }
  if (sub === 'list') return list(args, ctx);
  if (sub === 'setup') return setup(args, ctx);
  if (sub === 'run') return runCmd(args, ctx);
  if (sub === 'verify') return verify(args, ctx);
  if (sub === 'bump') return bump(args, ctx);
  if (sub === 'patch') return patch(args, ctx);
  throw new HadesError(`unknown subcommand "tools ${sub}". Run "hades tools --help".`);
}
