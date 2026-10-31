// Fake semgrep: "scan --config <c> ... --json --output <report> <target>".
import { after, record, canned, write, forcedExit } from './fake-common.mjs';

const argv = process.argv.slice(2);
record('semgrep', argv, {
  SEMGREP_SEND_METRICS: process.env.SEMGREP_SEND_METRICS,
  SEMGREP_ENABLE_VERSION_CHECK: process.env.SEMGREP_ENABLE_VERSION_CHECK,
  hasAppToken: 'SEMGREP_APP_TOKEN' in process.env,
});
const target = argv[argv.length - 1];
const report = after(argv, '--output');
const forced = forcedExit('FAKE_SEMGREP_EXIT');
if (forced !== null && forced >= 2) {
  process.stderr.write('[ERROR] invalid configuration\n');
  process.exit(forced);
}
const data = canned(target, 'semgrep', { version: '1.181.0', results: [], errors: [] });
data.results = (data.results || []).map((r) => ({ ...r, path: `${target.replace(/\\/g, '/')}/${r.path}` }));
write(report, data);
process.exitCode = forced !== null ? forced : 0;
