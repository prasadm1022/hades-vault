// Fake gitleaks: "dir <target> ... -r <report> --exit-code N". Writes canned findings with
// absolute File paths (as the real tool does for an absolute target) and redacted secrets.
import { after, record, canned, write, forcedExit } from './fake-common.mjs';

const argv = process.argv.slice(2);
record('gitleaks', argv);
const target = after(argv, 'dir');
const report = after(argv, '-r');
const leakCode = Number(after(argv, '--exit-code') || 1);
const findings = canned(target, 'gitleaks', []).map((f) => {
  const file = `${target.replace(/\\/g, '/')}/${f.File}`;
  return { ...f, File: file, Secret: 'REDACTED', Match: 'REDACTED', Fingerprint: `${file}:${f.RuleID}:${f.StartLine}` };
});
const forced = forcedExit('FAKE_GITLEAKS_EXIT');
if (forced === null || forced !== 1) write(report, findings);
process.stderr.write('INF scan completed\n');
process.exitCode = forced !== null ? forced : findings.length ? leakCode : 0;
