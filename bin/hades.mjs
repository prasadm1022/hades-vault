#!/usr/bin/env node
// HADES command-line interface. Zero dependencies; Node >= 22.
// Usage: node bin/hades.mjs <command> [subcommand] [args] [--flags]
import { parseArgs, fail, print, allowFlags, commandFlags } from '../lib/core/util.mjs';
import { loadContext } from '../lib/core/config.mjs';

const COMMANDS = {
  init: 'Create hades.config.json and scaffold a vault if it does not exist',
  install: 'Install agents, skills, hooks and settings into Claude Code (user or project scope)',
  export: 'Export HADES to another coding agent: agents-md | codex | cursor | gemini | copilot | windsurf | cline | opencode',
  doctor: 'Check prerequisites, tool pins, config, vault and installed files',
  org: 'Organizations: new | list',
  team: 'Teams: new | resolve | list | set',
  task: 'Tasks: new | adopt | show | stage | size | plan | item | coverage | commit | deploy | close | list | path',
  defect: 'Defects of a task: add | update | list',
  gate: 'Run quality gates (build, lint, types, tests, secrets, sast, deps) with compact output',
  detect: 'Fingerprint a project and print its stack and commands',
  tools: 'Vendored tools: list | setup | run | verify | bump',
  mcp: 'Launch a vendored MCP server over stdio: serena | rea | playwright | aws',
  usage: 'Token and cost usage (ccusage) for a task or a period',
  status: 'Organizations, teams, open tasks',
  migrate: 'Migrate a HADES v1 vault to v2',
  run: 'Run a requirement end to end, headless, with no permission prompts',
};

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    print('HADES - autonomous software company for Claude Code\n\nUsage: hades <command> [args] [--flags]\n');
    for (const [k, v] of Object.entries(COMMANDS)) print(`  ${k.padEnd(9)} ${v}`);
    print('\nRun "hades <command> --help" for details.');
    return;
  }
  if (name === '--version' || name === '-v') {
    const { readJson } = await import('../lib/core/util.mjs');
    const { ENGINE } = await import('../lib/core/config.mjs');
    print(readJson(`${ENGINE}/package.json`).version);
    return;
  }
  if (!COMMANDS[name]) fail(`unknown command "${name}". Run "hades help".`);
  const mod = await import(`../lib/commands/${name}.mjs`);
  // Boolean flags never swallow the next word ("--dry-run <requirements>").
  const args = parseArgs(argv.slice(1), { booleans: ['help', 'json', ...(mod.BOOLEAN_FLAGS || [])] });
  // Every command refuses unknown flags before anything else runs (a typo such as --dryrun must
  // never fall through to the real action).
  allowFlags(args, commandFlags(mod, args) || []);
  const ctx = loadContext({ needVault: mod.needsVault !== false && !args.flags.help });
  await mod.run(args, ctx);
}

main().catch((err) => {
  process.stderr.write(`hades: ${err && err.message ? err.message : err}\n`);
  if (process.env.HADES_DEBUG) process.stderr.write(`${err.stack}\n`);
  process.exit(err && Number.isInteger(err.exitCode) ? err.exitCode : 1);
});
