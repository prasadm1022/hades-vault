// Fake "docker run" for gate tests: maps container paths back to host paths through the
// --mount / -v options and runs the fake scanner for the image, so the Docker code path of the
// gate can be tested without Docker. Records its own argv (tool "docker") via FAKE_ARGV_LOG.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './fake-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
record('docker', argv);
if (argv[0] !== 'run') process.exit(125);

const VALUE_FLAGS = new Set(['--mount', '-v', '--volume', '-w', '--workdir', '--name', '-e', '--env', '--network', '--user', '-u', '--add-host', '--entrypoint']);
const mounts = [];
let workdir = '/';
let i = 1;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('-')) break;
  if (!VALUE_FLAGS.has(a)) continue;
  const v = argv[++i];
  if (a === '--mount') {
    const kv = {};
    for (const part of v.split(',')) {
      const eq = part.indexOf('=');
      kv[eq < 0 ? part : part.slice(0, eq)] = eq < 0 ? true : part.slice(eq + 1);
    }
    mounts.push({ host: kv.source, container: kv.target });
  } else if (a === '-v' || a === '--volume') {
    const m = /^(.+?):(\/[^:]*)/.exec(v);
    mounts.push({ host: m[1], container: m[2] });
  } else if (a === '-w' || a === '--workdir') {
    workdir = v;
  }
}
const image = argv[i] || '';
let cmd = argv.slice(i + 1);
const toHost = (p) => {
  let best = null;
  for (const m of mounts) {
    if ((p === m.container || p.startsWith(`${m.container}/`)) && (!best || m.container.length > best.container.length)) best = m;
  }
  return best ? `${best.host}${p.slice(best.container.length)}` : p;
};
const tool = /gitleaks/.test(image) ? 'gitleaks' : /trivy/.test(image) ? 'trivy' : /semgrep/.test(image) ? 'semgrep' : /zap/.test(image) ? 'zap' : null;
if (!tool) process.exit(125);
if (cmd[0] === 'semgrep') cmd = cmd.slice(1);
const hostArgs = cmd.map((a) => (a.startsWith('/') ? toHost(a) : a));
const r = spawnSync(process.execPath, [path.join(here, `fake-${tool}.mjs`), ...hostArgs], { cwd: toHost(workdir), stdio: 'inherit', env: process.env });
process.exit(r.status === null ? 1 : r.status);
