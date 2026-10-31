// Shared helpers for the fake scanners used by gate tests. They never touch the network.
import fs from 'node:fs';
import path from 'node:path';

export function after(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Appends {tool, argv, cwd, env} as one JSON line to $FAKE_ARGV_LOG so tests can check flags.
export function record(tool, argv, env = {}) {
  if (!process.env.FAKE_ARGV_LOG) return;
  fs.appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify({ tool, argv, cwd: process.cwd().replace(/\\/g, '/'), env })}\n`);
}

// Canned findings live next to the scanned project: <target>/.fake/<tool>.json
export function canned(target, tool, fallback) {
  const file = path.join(target, '.fake', `${tool}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function write(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(data, null, 2));
}

export function forcedExit(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? null : Number(v);
}
