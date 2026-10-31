// Tests for "hades defect" (add, update, list): IDs, validation, rounds, blocked, history, filters.
// Run: node --test tests/cli/defect.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeVault, cleanup } from '../helpers/vault.mjs';
import { formatDefect, TRANSITIONS } from '../../lib/commands/defect.mjs';

after(cleanup);

function setup() {
  const v = makeVault({ teams: { portal: {} } });
  const { id, dir } = v.fakeTask('portal', 12, { title: 'Reset' });
  const defects = () => v.readJson(`${dir}/defects.json`).defects;
  const add = (extra = []) => v.run(['defect', 'add', id, '--title', 'Reset link accepted after expiry', '--severity', 'high', '--owner', 'backend-engineer', '--source', 'qa', ...extra]);
  return { v, id, dir, defects, add };
}

describe('defect add', () => {
  test('records a defect and prints its ID', () => {
    const { v, id, defects, add } = setup();
    const r = add(['--repro', '1. request 2. wait 31 min', '--refs', 'src/auth/reset.ts:42, src/auth/token.ts', '--evidence', '07-qa-report.md#round-1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'D1\n');
    const [d] = defects();
    assert.deepEqual({ ...d, history: undefined }, {
      id: 'D1',
      title: 'Reset link accepted after expiry',
      severity: 'high',
      source: 'qa',
      owner: 'backend-engineer',
      status: 'open',
      round: 0,
      repro: '1. request 2. wait 31 min',
      evidence: '07-qa-report.md#round-1',
      refs: ['src/auth/reset.ts:42', 'src/auth/token.ts'],
      history: undefined,
    });
    assert.equal(d.history.length, 1);
    assert.deepEqual({ ...d.history[0], at: 'x' }, { at: 'x', status: 'open', by: 'qa-engineer', note: '' });
    const sec = v.run(['defect', 'add', id, '--title', 'CWE-79 XSS', '--severity', 'critical', '--owner', 'frontend-engineer', '--source', 'security', '--json']);
    assert.equal(sec.code, 0, sec.err);
    assert.equal(sec.json().id, 'D2');
    assert.equal(sec.json().history[0].by, 'cybersecurity-engineer');
    assert.equal(add(['--by', 'tech-lead']).out.trim(), 'D3');
    assert.equal(defects()[2].history[0].by, 'tech-lead');
  });

  test('review and deploy sources: the finder defaults to tech-lead and devops-engineer', () => {
    const { v, id, defects } = setup();
    const add = (source, owner) => v.run(['defect', 'add', id, '--title', `${source} finding`, '--severity', 'high', '--owner', owner, '--source', source]);
    assert.equal(add('review', 'backend-engineer').code, 0);
    assert.equal(add('deploy', 'devops-engineer').code, 0);
    assert.deepEqual(defects().map((d) => [d.source, d.history[0].by]), [['review', 'tech-lead'], ['deploy', 'devops-engineer']]);
    const list = v.run(['defect', 'list', id, '--source', 'review']);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /^D1 high open backend-engineer r0 review finding$/m);
    assert.doesNotMatch(list.out, /deploy finding/);
  });

  test('IDs continue after the highest existing ID', () => {
    const { v, id, dir, defects, add } = setup();
    v.write(`${dir}/defects.json`, JSON.stringify({ defects: [{ id: 'D7', title: 'x', severity: 'low', source: 'qa', owner: 'tech-lead', status: 'verified', round: 1, history: [] }] }));
    assert.equal(add().out.trim(), 'D8');
    assert.deepEqual(defects().map((d) => d.id), ['D7', 'D8']);
  });

  test('validates severity, owner, source and title (exit 1, nothing written)', () => {
    const { v, id, defects } = setup();
    const base = { '--title': 'T', '--severity': 'high', '--owner': 'backend-engineer', '--source': 'qa' };
    const run = (over) => {
      const m = { ...base, ...over };
      const args = ['defect', 'add', id];
      for (const [k, val] of Object.entries(m)) if (val !== null) args.push(k, val);
      return v.run(args);
    };
    const cases = [
      [{ '--severity': 'blocker' }, /--severity must be critical\|high\|medium\|low/],
      [{ '--owner': 'qa-engineer' }, /--owner must be backend-engineer\|frontend-engineer\|aiml-data-engineer\|devops-engineer\|tech-lead/],
      [{ '--source': 'ops' }, /--source must be qa\|security\|review\|deploy/],
      [{ '--title': null }, /--title is required/],
      [{ '--severity': null }, /--severity is required/],
      [{ '--owner': null }, /--owner is required/],
      [{ '--source': null }, /--source is required/],
      [{ '--title': ' ' }, /--title is empty/],
      [{ '--colour': 'red' }, /unknown flag --colour/],
    ];
    for (const [over, re] of cases) {
      const r = run(over);
      assert.equal(r.code, 1, JSON.stringify(over));
      assert.match(r.err, re, JSON.stringify(over));
    }
    assert.deepEqual(defects(), []);
    assert.equal(v.run(['defect', 'add']).code, 1);
    assert.equal(v.run(['defect', 'add', 'portal-099', '--title', 'T', '--severity', 'high', '--owner', 'tech-lead', '--source', 'qa']).code, 1);
  });
});

describe('defect update', () => {
  test('fixed increments the round; verified closes it; history records each move', () => {
    const { v, id, defects, add } = setup();
    add();
    const f = v.run(['defect', 'update', id, 'd1', '--status', 'fixed', '--note', 'root cause: no expiry check']);
    assert.equal(f.code, 0, f.err);
    assert.equal(f.out.trim(), 'D1 fixed (round 1/3)');
    let d = defects()[0];
    assert.equal(d.round, 1);
    assert.deepEqual({ ...d.history[1], at: 'x' }, { at: 'x', status: 'fixed', by: 'backend-engineer', note: 'root cause: no expiry check' });
    assert.equal(v.run(['defect', 'update', id, 'D1', '--status', 'verified', '--by', 'qa-engineer']).out.trim(), 'D1 verified');
    d = defects()[0];
    assert.equal(d.status, 'verified');
    assert.equal(d.round, 1);
    assert.deepEqual(d.history.map((h) => h.status), ['open', 'fixed', 'verified']);
    assert.equal(d.history[2].by, 'qa-engineer');
  });

  test('a reopen after round 3 makes the defect blocked', () => {
    const { v, id, defects, add } = setup();
    add();
    const up = (status) => v.run(['defect', 'update', id, 'D1', '--status', status, '--note', status]);
    for (let round = 1; round <= 2; round++) {
      assert.equal(up('fixed').out.trim(), `D1 fixed (round ${round}/3)`);
      assert.equal(up('reopened').out.trim(), 'D1 reopened');
    }
    assert.equal(up('fixed').out.trim(), 'D1 fixed (round 3/3)');
    const r = up('reopened');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^D1 BLOCKED: reopened after round 3 \(limit 3\)/);
    const d = defects()[0];
    assert.equal(d.status, 'blocked');
    assert.equal(d.round, 3);
    assert.deepEqual(d.history.map((h) => h.status), ['open', 'fixed', 'reopened', 'fixed', 'reopened', 'fixed', 'reopened', 'blocked']);
    assert.equal(d.history[6].by, 'qa-engineer');
    assert.equal(d.history[7].by, 'hades');
    // blocked: no more fix rounds without --force; wontfix with a reason is allowed
    const again = up('fixed');
    assert.equal(again.code, 1);
    assert.match(again.err, /D1 is blocked; allowed: wontfix/);
    assert.equal(v.run(['defect', 'update', id, 'D1', '--status', 'wontfix', '--note', 'accepted risk']).code, 0);
    assert.equal(defects()[0].history.at(-1).by, 'project-manager');
  });

  test('json output says when the defect became blocked', () => {
    const { v, id, dir } = setup();
    v.write(`${dir}/defects.json`, JSON.stringify({ defects: [{ id: 'D1', title: 'x', severity: 'high', source: 'security', owner: 'devops-engineer', status: 'fixed', round: 4, history: [] }] }));
    const j = v.run(['defect', 'update', id, 'D1', '--status', 'reopened', '--json']).json();
    assert.equal(j.blocked, true);
    assert.equal(j.status, 'blocked');
    assert.equal(j.history[0].by, 'cybersecurity-engineer');
  });

  test('refuses invalid moves unless --force; wontfix needs a note', () => {
    const { v, id, defects, add } = setup();
    add();
    const cases = [
      [['--status', 'verified'], /D1 is open; allowed: fixed, wontfix/],
      [['--status', 'reopened'], /D1 is open; allowed/],
      [['--status', 'wontfix'], /wontfix needs --note/],
      [['--status', 'open'], /--status must be fixed\|verified\|reopened\|wontfix/],
      [['--status', 'blocked'], /--status must be/],
      [[], /--status is required/],
    ];
    for (const [extra, re] of cases) {
      const r = v.run(['defect', 'update', id, 'D1', ...extra]);
      assert.equal(r.code, 1, extra.join(' '));
      assert.match(r.err, re, extra.join(' '));
    }
    assert.equal(defects()[0].status, 'open');
    assert.equal(v.run(['defect', 'update', id, 'D1', '--status', 'verified', '--force']).code, 0);
    assert.equal(defects()[0].status, 'verified');
    assert.equal(v.run(['defect', 'update', id, 'D1', '--status', 'reopened']).code, 0, 'a regression reopens a verified defect');
    assert.equal(v.run(['defect', 'update', id, 'D9', '--status', 'fixed']).code, 1);
    assert.equal(v.run(['defect', 'update', id, '--status', 'fixed']).code, 1);
  });

  test('transition table covers every stored status', () => {
    for (const s of ['open', 'fixed', 'reopened', 'verified', 'wontfix', 'blocked']) assert.ok(Array.isArray(TRANSITIONS[s]), s);
  });
});

describe('defect list', () => {
  test('one compact line per defect, with filters', () => {
    const { v, id } = setup();
    const add = (title, severity, owner, source) => v.run(['defect', 'add', id, '--title', title, '--severity', severity, '--owner', owner, '--source', source]);
    add('Expiry not enforced', 'high', 'backend-engineer', 'qa');
    add('Button misaligned', 'low', 'frontend-engineer', 'qa');
    add('CWE-89 SQL injection', 'critical', 'backend-engineer', 'security');
    add('Missing CSP header', 'medium', 'devops-engineer', 'security');
    v.run(['defect', 'update', id, 'D1', '--status', 'fixed']);
    v.run(['defect', 'update', id, 'D2', '--status', 'wontfix', '--note', 'cosmetic']);
    v.run(['defect', 'update', id, 'D4', '--status', 'fixed']);
    v.run(['defect', 'update', id, 'D4', '--status', 'verified']);
    const all = v.run(['defect', 'list', id]);
    assert.equal(all.code, 0, all.err);
    assert.deepEqual(all.lines, [
      'D1 high fixed backend-engineer r1 Expiry not enforced',
      'D2 low wontfix frontend-engineer r0 Button misaligned',
      'D3 critical open backend-engineer r0 CWE-89 SQL injection',
      'D4 medium verified devops-engineer r1 Missing CSP header',
    ]);
    const ids = (args) => v.run(['defect', 'list', id, ...args]).lines.map((l) => l.split(' ')[0]);
    assert.deepEqual(ids(['--open']), ['D1', 'D3']);
    assert.deepEqual(ids(['--open', '--owner', 'backend-engineer', '--source', 'security']), ['D3']);
    assert.deepEqual(ids(['--source', 'qa']), ['D1', 'D2']);
    assert.deepEqual(ids(['--severity', 'medium']), ['D4']);
    assert.match(v.run(['defect', 'list', id, '--open', '--owner', 'devops-engineer']).out, /no open defects matching/);
    assert.equal(v.run(['defect', 'list', id, '--owner', 'qa-engineer']).code, 1);
    assert.equal(v.run(['defect', 'list', id, '--source', 'ops']).code, 1);
    const json = v.run(['defect', 'list', id, '--open', '--json']).json();
    assert.deepEqual(json.map((d) => d.id), ['D1', 'D3']);
    assert.equal(formatDefect(json[0]), 'D1 high fixed backend-engineer r1 Expiry not enforced');
  });

  test('an empty list, help and unknown subcommands', () => {
    const { v, id } = setup();
    assert.equal(v.run(['defect', 'list', id]).out.trim(), `no defects in ${id}`);
    const h = v.run(['defect', '--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /a reopen after round 3 makes the defect "blocked"/);
    assert.equal(v.run(['defect', 'close', id]).code, 1);
  });
});
