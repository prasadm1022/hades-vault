// Fake trivy: "fs ... --output <report> --exit-code N ... <target>".
import { after, record, canned, write, forcedExit } from './fake-common.mjs';

const argv = process.argv.slice(2);
record('trivy', argv);
const target = argv[argv.length - 1];
const report = after(argv, '--output');
const code = Number(after(argv, '--exit-code') || 0);
const data = canned(target, 'trivy', { SchemaVersion: 2, Results: [] });
write(report, data);
const any = (data.Results || []).some((r) => (r.Vulnerabilities || []).length || (r.Misconfigurations || []).length);
const forced = forcedExit('FAKE_TRIVY_EXIT');
process.exitCode = forced !== null ? forced : any ? code : 0;
