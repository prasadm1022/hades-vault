// hades mcp <serena|rea|playwright|aws> [--project <dir>]
// Starts a pinned MCP server on stdio for Claude Code (agent frontmatter "mcpServers").
// stdout is the MCP channel: this command never writes to it; errors go to stderr.
// Runtime data stays under <engine>/.hades/: serena-home (config, language servers, logs),
// serena/<project folder> (Serena project data, never inside the project), playwright/<project>.
import fs from 'node:fs';
import { print, allowFlags } from '../core/util.mjs';
import { mcpSpec, ensureSerenaConfig, serenaProjectFolder, playwrightOutputDir, execInherit, mergeEnv, MCP_SERVERS } from '../core/tools.mjs';

export const needsVault = false;
export const FLAGS = ['project'];

const HELP = `Usage: hades mcp <${MCP_SERVERS.join('|')}> [--project <dir>]
Starts the pinned MCP server on stdio; the working directory is --project, else the current one.
serena: no startup project unless --project is given (Claude Code starts MCP servers in the
session folder, usually the whole workspace), so activate_project stays available: call
activate_project with the absolute project path before the first symbol tool. With --project,
Serena is pinned to that project (single-project mode, no activate_project).
aws needs "aws": {"profile": "<name>", "region": "<region>"} in hades.config.json (or AWS_PROFILE).`;

// Side effects before launch (mcpSpec itself only reads). Serena keeps each project's data in
// <engine>/.hades/serena/<folder> only if that folder exists before the project is activated
// (else it may use <project>/.serena): create it for the startup project, or for every team project
// of the vault that activate_project may open.
export function prepareMcp(ctx, server, spec) {
  const name = String(server).toLowerCase();
  if (name === 'serena') {
    ensureSerenaConfig(ctx);
    const dirs = spec.project ? [spec.project] : teamProjectDirs(ctx);
    for (const d of dirs) fs.mkdirSync(serenaProjectFolder(ctx, d), { recursive: true });
  }
  if (name === 'playwright') fs.mkdirSync(playwrightOutputDir(ctx, spec.cwd), { recursive: true });
}

function teamProjectDirs(ctx) {
  const teams = (ctx && ctx.registry && ctx.registry.teams) || {};
  return Object.values(teams)
    .map((t) => t && t.project_path)
    .filter((p) => typeof p === 'string' && p && fs.existsSync(p));
}

export async function run(args, ctx) {
  allowFlags(args, FLAGS);
  const server = args.positional[0];
  if (!server || args.flags.help) {
    print(HELP);
    return;
  }
  const project = typeof args.flags.project === 'string' ? args.flags.project : undefined;
  const spec = mcpSpec(ctx, server, { project });
  prepareMcp(ctx, server, spec);
  const code = await execInherit(spec.cmd, spec.args, { env: mergeEnv(process.env, spec.env), cwd: spec.cwd });
  process.exit(code);
}
