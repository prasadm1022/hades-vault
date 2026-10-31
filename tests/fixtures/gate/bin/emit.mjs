// Fake project command for gate tests.
// node emit.mjs <mode> [exitCode]
//   ok             prints one line
//   log:<file>     prints tests/fixtures/gate/logs/<file>
//   huge           5,000 noise lines, one compile error, 200 more noise lines
//   sleep:<ms>     waits (timeout tests)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode = 'ok', code = '0'] = process.argv.slice(2);

if (mode === 'ok') {
  console.log('all good');
} else if (mode.startsWith('log:')) {
  process.stdout.write(fs.readFileSync(path.join(here, '..', 'logs', mode.slice(4)), 'utf8'));
} else if (mode === 'huge') {
  const out = [];
  for (let i = 0; i < 5000; i++) out.push(`[INFO] Compiling module part ${i} of the reactor build`);
  out.push('[ERROR] /work/demo/src/main/java/com/acme/Huge.java:[77,3] incompatible types: String cannot be converted to int');
  for (let i = 0; i < 200; i++) out.push(`[INFO] Downloaded artifact ${i}`);
  process.stdout.write(`${out.join('\n')}\n`);
} else if (mode.startsWith('sleep:')) {
  console.log('starting long task');
  await new Promise((r) => setTimeout(r, Number(mode.slice(6))));
}
process.exitCode = Number(code);
