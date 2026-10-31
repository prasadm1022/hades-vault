// Fake ZAP packaged scan: "<zap-*.py> -t <url> ... -J <report.json> ...". The JSON report is
// written relative to the working directory (the real image writes under /zap/wrk).
// FAKE_ZAP_REPORT = canned traditional-json report; FAKE_ZAP_EXIT = forced exit code.
import fs from 'node:fs';
import { after, record, write, forcedExit } from './fake-common.mjs';

const argv = process.argv.slice(2);
record('zaproxy', argv);
const json = after(argv, '-J');
const forced = forcedExit('FAKE_ZAP_EXIT');
if (forced === 3) {
  console.log('No URLs found - is the target URL accessible? Local services may not be accessible from the Docker container');
  process.exit(3);
}
const data = process.env.FAKE_ZAP_REPORT
  ? JSON.parse(fs.readFileSync(process.env.FAKE_ZAP_REPORT, 'utf8'))
  : { '@version': '2.17.0', site: [] };
write(json, data);
console.log('FAIL-NEW: 0 FAIL-INPROG: 0 WARN-NEW: 2 WARN-INPROG: 0 INFO: 0 IGNORE: 0 PASS: 40');
process.exitCode = forced !== null ? forced : 2;
