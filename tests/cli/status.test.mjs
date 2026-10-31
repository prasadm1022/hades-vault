// Tests for "hades status": organizations -> teams -> open tasks, legacy counts, filters, limits.
// Run: node --test tests/cli/status.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, cleanup, defectRecord } from '../helpers/vault.mjs';
import { renderStatus } from '../../lib/commands/status.mjs';

after(cleanup);

function company() {
  const v = makeVault({
    orgs: { acme: { aliases: ['acme-inc'] }, globex: {} },
    teams: { portal: { aliases: ['acme-portal'] }, docs: { type: 'sub', status: 'paused' }, shop: { org: 'globex' } },
  });
  const done = { status: 'done' };
  v.fakeTask('portal', 3, {
    title: 'Password reset',
    stages: { analysis: done, design: done, planning: done, build: done, qa: 'running' },
    defects: [defectRecord('D1', { severity: 'high' }), defectRecord('D2', { severity: 'medium' }), defectRecord('D3', { severity: 'low', status: 'blocked' })],
  });
  v.fakeTask('portal', 4, { title: 'Audit log', size: 'S', defects: [defectRecord('D1', { severity: 'medium' })] });
  v.fakeTask('portal', 5, { title: 'Closed', status: 'done' });
  v.fakeTask('portal', 6, { title: 'Stuck', status: 'blocked' });
  v.v1Task('portal', 1);
  v.v1Task('portal', 2, { frontmatter: { id: 'portal-002', status: 'IN PROGRESS' } });
  v.v1Task('docs', 1);
  return v;
}

describe('hades status', () => {
  test('whole company: orgs, teams with type/status/counts, open tasks with stage and defects', () => {
    const v = company();
    const r = v.run(['status']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length <= 40);
    assert.equal(r.lines[0], `vault ${v.vault}: 2 org(s), 3 team(s), 2 open task(s)`);
    const body = r.lines.slice(1);
    assert.deepEqual(body.map((l) => l.replace(/(\S) {2,}/g, '$1  ')), [
      `acme  ${v.work}/acme`,
      '  portal  main active  open 2, done 1, blocked 1, legacy 2, blocking defects 1',
      '    portal-003  qa  M  Password reset  [blocking D1; blocked D3]',
      '    portal-004  analysis S  Audit log  [defects 1 open]',
      '  docs  sub paused  open 0, done 0, legacy 1',
      `globex  ${v.work}/globex`,
      '  shop  main active  open 0, done 0',
    ]);
  });

  test('filters by team (name, alias, path) and organization (name, alias)', () => {
    const v = company();
    for (const q of ['portal', 'ACME-PORTAL', `${v.work}/acme/portal/src`]) {
      const r = v.run(['status', q]);
      assert.equal(r.code, 0, `${q}: ${r.err}`);
      assert.ok(r.out.includes('  portal  main active'), q);
      assert.ok(!r.out.includes('docs'), q);
      assert.ok(!r.out.includes('globex'), q);
    }
    for (const q of ['globex', 'acme-inc']) {
      const r = v.run(['status', q]);
      assert.equal(r.code, 0);
      assert.equal(r.lines.filter((l) => /^\S/.test(l) && !l.startsWith('vault')).length, 1, q);
    }
    assert.match(v.run(['status', 'acme-inc']).out, /docs +sub paused/);
    const none = v.run(['status', 'nope']);
    assert.equal(none.code, 1);
    assert.match(none.err, /no team or organization matches "nope"/);
  });

  test('--json gives the full structure', () => {
    const v = company();
    const d = v.run(['status', '--json']).json();
    assert.equal(d.vault, v.vault);
    assert.deepEqual(d.problems, []);
    assert.deepEqual(d.organizations.map((o) => o.organization), ['acme', 'globex']);
    const portal = d.organizations[0].teams[0];
    assert.deepEqual(portal.counts, { open: 2, done: 1, blocked: 1, legacy: 2, legacy_open: 1 });
    assert.equal(portal.open[0].id, 'portal-003');
    assert.equal(portal.open[0].stage, 'qa');
    assert.deepEqual(portal.open[0].defects.blocking, ['D1']);
    assert.deepEqual(portal.open[0].defects.bySeverity, { high: 1, medium: 1, low: 1 });
    const f = v.run(['status', 'shop', '--json']).json();
    assert.deepEqual(f.filter, { team: 'shop' });
    assert.equal(f.organizations.length, 1);
  });

  test('stays within 40 lines for a large company', () => {
    const teams = {};
    for (let i = 0; i < 25; i++) teams[`team-${i}`] = {};
    const v = makeVault({ orgs: { big: {} }, teams });
    for (let i = 0; i < 25; i++) for (let n = 1; n <= 3; n++) v.fakeTask(`team-${i}`, n);
    const r = v.run(['status']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length <= 40, `${r.lines.length} lines`);
    assert.match(r.lines[0], /1 org\(s\), 25 team\(s\), 75 open task\(s\)/);
    assert.equal(r.lines.length, 2 + 25, 'team lines only: every team is still listed');
    assert.match(r.out, /^ {2}team-24 +main active +open 3, done 0$/m);
    const json = v.run(['status', '--json']).json();
    assert.equal(json.organizations[0].teams.length, 25, '--json is never truncated');
  });

  test('collapses task lines before truncating', () => {
    const data = {
      vault: '/v',
      problems: [],
      organizations: [
        {
          organization: 'o',
          root_path: '/w',
          teams: Array.from({ length: 6 }, (_, i) => ({
            team: `t${i}`,
            type: 'main',
            status: 'active',
            counts: { open: 6, done: 0, blocked: 0, legacy: 0 },
            open: Array.from({ length: 6 }, (__, n) => ({ id: `t${i}-00${n}`, title: 'x', size: 'M', stage: 'build', defects: { open: 0, blocking: [], blocked: [] } })),
          })),
        },
      ],
    };
    const out = renderStatus(data).split('\n');
    assert.ok(out.length <= 40);
    assert.equal(out.length, 1 + 1 + 6 * 2, 'one summary line per team instead of one per task');
    assert.match(out[3], /^ {4}t0-000\(build\) t0-001\(build\)/);
    // too many teams even for one line each: truncated with a pointer
    const many = { ...data, organizations: [{ ...data.organizations[0], teams: Array.from({ length: 50 }, (_, i) => ({ ...data.organizations[0].teams[0], team: `t${i}` })) }] };
    const cut = renderStatus(many).split('\n');
    assert.equal(cut.length, 40);
    assert.match(cut[39], /^\.\.\. 13 more line\(s\): hades status <org>$/);
  });

  test('reports registry problems and teams of unregistered organizations', () => {
    const v = makeVault({ teams: { portal: {} } });
    const reg = v.registry();
    reg.teams.orphan = { ...reg.teams.portal, organization: 'gone', team_dir: 'organizations/gone/teams/orphan', aliases: [] };
    fs.mkdirSync(`${v.vault}/organizations/gone/teams/orphan/tasks`, { recursive: true });
    v.write('registry.json', JSON.stringify(reg));
    const r = v.run(['status']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^registry: 1 problem\(s\), first: teams\.orphan\.organization: unknown organization "gone"$/m);
    assert.match(r.out, /^\(no organization\)\n {2}orphan +main active/m);
  });

  test('an empty vault and help', () => {
    const v = makeVault({ orgs: {} });
    const r = v.run(['status']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `vault ${v.vault}: 0 org(s), 0 team(s), 0 open task(s)`);
    const h = v.run(['status', '--help']);
    assert.match(h.out, /^Usage: hades status/);
    assert.equal(v.run(['status', '--verbose']).code, 1);
  });
});
