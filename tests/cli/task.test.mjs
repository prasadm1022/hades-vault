// Tests for "hades task" (new, show, stage, size, plan, item, coverage, commit, deploy, close, list, path).
// Run: node --test tests/cli/task.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, cleanup, writeFile, initRepo, commit, defectRecord, tempDir } from '../helpers/vault.mjs';
import { validatePlan, parseTestCases, readAcs, slugOf, v1Records } from '../../lib/commands/task.mjs';

after(cleanup);

const setup = () => makeVault({ teams: { portal: { aliases: ['acme-portal'] }, shop: {} } });

function newTask(v, title = 'Password reset by email', extra = ['--size', 'M']) {
  const r = v.run(['task', 'new', 'portal', '--title', title, ...extra]);
  assert.equal(r.code, 0, r.err);
  const [id, dir] = r.out.trim().split(' ');
  return { id, dir };
}

const state = (v, id) => v.readJson(`${v.taskDir(id)}/state.json`);
const BA = '## Summary\nReset.\n\n## Acceptance criteria\n- AC-1 Given a user, When they ask, Then a mail is sent.\n- AC-2 link expires (see AC-1)\n- AC-3 audit log\n';
// A plan and a test plan that cover every AC of BA (qa done and close done check coverage).
const FULL_PLAN = { items: [{ id: 'W1', wave: 1, status: 'done', acceptance: ['AC-1', 'AC-2', 'AC-3'] }] };
const FULL_TESTS = '| TC-1 | AC-1 | auto |\n| TC-2 | AC-2 | auto |\n| TC-3 | AC-3 | manual |\n';
const COVERED = { '01-business-solution.md': BA, 'work-plan.json': JSON.stringify(FULL_PLAN), '06-test-plan.md': FULL_TESTS };

describe('task new', () => {
  test('numbering continues after v1 records and v2 folders', () => {
    const v = setup();
    v.v1Task('portal', 7, { slug: 'old-login' });
    v.v1Task('shop', 30);
    const a = newTask(v);
    assert.equal(a.id, 'portal-008');
    v.fakeTask('portal', 12);
    assert.equal(newTask(v, 'Second').id, 'portal-013');
    assert.equal(newTask(v, 'Third', ['--size', 'S']).id, 'portal-014');
    const shop = v.run(['task', 'new', 'shop', '--title', 'Cart']);
    assert.equal(shop.out.split(' ')[0], 'shop-031');
  });

  test('creates README with the verbatim request, state.json and defects.json; prints "<id> <folder>"', () => {
    const v = setup();
    const reqFile = writeFile(`${v.root}/req.md`, 'Build a password reset.\n\n## Details\n- expire after 30 min: {{NOT_A_VAR}}\n- `code`  with  spaces\n\n\n');
    const r = v.run(['task', 'new', 'acme-portal', '--title', 'Password  reset\nby email', '--size', 'm', '--request-file', reqFile]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1);
    const [id, dir] = r.out.trim().split(' ');
    assert.equal(id, 'portal-001');
    assert.equal(dir, `${v.tasksDir('portal')}/portal-001-password-reset-by-email`);
    const readme = fs.readFileSync(`${dir}/README.md`, 'utf8');
    assert.match(readme, /^---\nid: portal-001\nteam: portal\norganization: acme\ntitle: Password reset by email\nsize: M\nopened: \d{4}-\d{2}-\d{2}\n---\n/);
    assert.ok(readme.includes('## Request (verbatim)\n\nBuild a password reset.\n\n## Details\n- expire after 30 min: {{NOT_A_VAR}}\n- `code`  with  spaces\n\n## Decisions'), readme);
    assert.match(readme, /^## Lessons$/m);
    assert.doesNotMatch(readme, /Assumptions & decisions/);
    assert.doesNotMatch(readme.replace('{{NOT_A_VAR}}', ''), /\{\{[A-Z0-9_]+\}\}/, 'template fully rendered');
    const s = v.readJson(`${dir}/state.json`);
    assert.equal(s.id, 'portal-001');
    assert.equal(s.team, 'portal');
    assert.equal(s.organization, 'acme');
    assert.equal(s.title, 'Password reset by email');
    assert.equal(s.size, 'M');
    assert.equal(s.status, 'open');
    assert.equal(s.stage, 'analysis');
    assert.equal(s.stages.intake.status, 'done');
    assert.equal(s.stages.close.status, 'pending');
    assert.deepEqual(s.rounds, { qa: 0, security: 0 });
    assert.deepEqual(s.commits, []);
    assert.equal(s.deploy, null);
    assert.deepEqual(v.readJson(`${dir}/defects.json`), { defects: [] });
  });

  test('without --request-file the title is the request; long titles give a <= 50 char slug', () => {
    const v = setup();
    const title = 'Make the checkout page faster on slow mobile networks and old phones please';
    const { dir } = newTask(v, title, []);
    const name = dir.split('/').pop();
    const slug = name.slice('portal-001-'.length);
    assert.ok(slug.length <= 50, slug);
    assert.ok(!slug.endsWith('-'));
    assert.equal(slug, slugOf(title));
    assert.ok(fs.readFileSync(`${dir}/README.md`, 'utf8').includes(`## Request (verbatim)\n\n${title}\n`));
    assert.equal(v.readJson(`${dir}/state.json`).size, null);
    assert.equal(slugOf('!!!'), 'task');
  });

  test('validation failures exit 1 and create nothing', () => {
    const v = setup();
    const cases = [
      [['task', 'new', 'portal', '--title', 'x', '--size', 'XL'], /--size must be S\|M\|L/],
      [['task', 'new', 'portal'], /--title is required/],
      [['task', 'new', 'portal', '--title'], /--title needs a value/],
      [['task', 'new', 'nope', '--title', 'x'], /unknown team/],
      [['task', 'new', 'portal', '--title', 'x', '--request-file', `${v.root}/missing.md`], /request file not found/],
      [['task', 'new', '--title', 'x'], /missing <team>/],
      [['task', 'new', 'portal', '--title', 'x', '--sise', 'M'], /unknown flag --sise/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(v.tasksDir('portal')), []);
  });
});

describe('task stage', () => {
  test('moves the machine, records at/note/model and prints the next stage', () => {
    const v = setup();
    const { id } = newTask(v);
    const r = v.run(['task', 'stage', id, 'analysis', 'running', '--model', 'opus']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `${id} analysis running; next: analysis`);
    const d = v.run(['task', 'stage', id, 'analysis', 'done', '--note', 'AC-1..3']);
    assert.equal(d.out.trim(), `${id} analysis done; next: design`);
    const s = state(v, id);
    assert.equal(s.stage, 'design');
    assert.equal(s.stages.analysis.status, 'done');
    assert.equal(s.stages.analysis.model, 'opus', 'model kept from the running move');
    assert.equal(s.stages.analysis.note, 'AC-1..3');
    assert.match(s.stages.analysis.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const j = v.run(['task', 'stage', id, 'design', 'skipped', '--note', 'S task', '--json']).json();
    assert.equal(j.next, 'planning');
    assert.equal(j.status, 'skipped');
  });

  test('refuses running/done while an earlier stage is pending, unless --force', () => {
    const v = setup();
    const { id } = newTask(v);
    const before = fs.readFileSync(`${v.taskDir(id)}/state.json`, 'utf8');
    for (const st of ['running', 'done']) {
      const r = v.run(['task', 'stage', id, 'build', st]);
      assert.equal(r.code, 1);
      assert.match(r.err, /earlier stage\(s\) are pending: analysis, design, planning/);
    }
    assert.equal(fs.readFileSync(`${v.taskDir(id)}/state.json`, 'utf8'), before, 'state unchanged');
    // blocked/failed/skipped/pending are allowed out of order
    assert.equal(v.run(['task', 'stage', id, 'qa', 'skipped', '--note', 'build blocked']).code, 0);
    assert.equal(v.run(['task', 'stage', id, 'deploy', 'blocked', '--note', 'no env']).code, 0);
    const f = v.run(['task', 'stage', id, 'build', 'done', '--force']);
    assert.equal(f.code, 0, f.err);
    assert.equal(state(v, id).stages.build.status, 'done');
    assert.equal(state(v, id).stage, 'analysis', 'current stage = first not done/skipped');
  });

  test('skipped needs a note; unknown stage or status exit 1', () => {
    const v = setup();
    const { id } = newTask(v);
    const cases = [
      [['task', 'stage', id, 'analysis', 'skipped'], /needs --note/],
      [['task', 'stage', id, 'analysis', 'skipped', '--note', ' '], /needs --note/],
      [['task', 'stage', id, 'testing', 'done'], /unknown stage "testing"/],
      [['task', 'stage', id, 'analysis', 'finished'], /unknown stage status "finished"/],
      [['task', 'stage', id, 'analysis'], /missing <status>/],
      [['task', 'stage', 'portal-099', 'analysis', 'done'], /task folder not found/],
      [['task', 'stage', 'nope', 'analysis', 'done'], /not a task ID/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
  });

  test('qa/security rounds increment when the stage moves to running', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { analysis: 'done', design: 'done', planning: 'done', build: 'done' } });
    assert.match(v.run(['task', 'stage', id, 'qa', 'running']).out, /qa running \(round 1\)/);
    v.run(['task', 'stage', id, 'qa', 'running']);
    assert.equal(state(v, id).rounds.qa, 1, 'running -> running is not a new round');
    v.run(['task', 'stage', id, 'qa', 'failed', '--note', 'D1']);
    v.run(['task', 'stage', id, 'qa', 'running']);
    v.run(['task', 'stage', id, 'qa', 'failed', '--note', 'D1']);
    v.run(['task', 'stage', id, 'qa', 'running']);
    v.run(['task', 'stage', id, 'qa', 'failed', '--note', 'D1']);
    const fourth = v.run(['task', 'stage', id, 'qa', 'running']);
    assert.equal(fourth.code, 0);
    assert.match(fourth.out, /warning: qa round 4 exceeds the limit of 3/);
    assert.equal(state(v, id).rounds.qa, 4);
    assert.equal(state(v, id).rounds.security, 0);
  });

  test('qa/security cannot be done while blocking defects of that source exist (exit 2), unless --force', () => {
    const v = setup();
    const defects = [
      defectRecord('D1', { severity: 'high', source: 'qa', status: 'fixed' }),
      defectRecord('D2', { severity: 'critical', source: 'security', status: 'open' }),
      defectRecord('D3', { severity: 'medium', source: 'qa', status: 'open' }),
    ];
    const done = { status: 'done' };
    const { id, dir } = v.fakeTask('portal', 1, { stages: { analysis: done, design: done, planning: done, build: done, qa: 'running' }, defects, files: COVERED });
    const r = v.run(['task', 'stage', id, 'qa', 'done']);
    assert.equal(r.code, 2);
    assert.match(r.err, /qa cannot pass while critical\/high qa\/review defects are not verified: D1 high fixed/);
    assert.equal(state(v, id).stages.qa.status, 'running');
    // verify D1 -> qa may pass; the open medium and the security critical do not block qa
    const data = v.readJson(`${dir}/defects.json`);
    data.defects[0].status = 'verified';
    // integration-review findings run through the qa loop; a failed deploy blocks deploy
    data.defects.push(defectRecord('D4', { severity: 'high', source: 'review', status: 'reopened' }), defectRecord('D5', { severity: 'critical', source: 'deploy', owner: 'devops-engineer' }));
    writeFile(`${dir}/defects.json`, JSON.stringify(data));
    assert.match(v.run(['task', 'stage', id, 'qa', 'done']).err, /qa\/review defects are not verified: D4 high reopened \(or --force\)$/m);
    data.defects[3].status = 'verified';
    writeFile(`${dir}/defects.json`, JSON.stringify(data));
    assert.equal(v.run(['task', 'stage', id, 'qa', 'done']).code, 0);
    assert.equal(v.run(['task', 'stage', id, 'release', 'done']).code, 0);
    const dep = v.run(['task', 'stage', id, 'deploy', 'done']);
    assert.equal(dep.code, 2);
    assert.match(dep.err, /deploy cannot pass while critical\/high deploy defects are not verified: D5 critical open/);
    data.defects[4].status = 'verified';
    writeFile(`${dir}/defects.json`, JSON.stringify(data));
    assert.equal(v.run(['task', 'stage', id, 'deploy', 'done']).code, 0);
    const sec = v.run(['task', 'stage', id, 'security', 'done']);
    assert.equal(sec.code, 2);
    assert.match(sec.err, /D2 critical open/);
    const forced = v.run(['task', 'stage', id, 'security', 'done', '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.match(forced.out, /next: close/);
  });
});

describe('task show', () => {
  test('compact status with stages, next, defects, gate, deploy and commits', () => {
    const v = setup();
    const defects = [
      defectRecord('D1', { severity: 'high', status: 'open' }),
      defectRecord('D2', { severity: 'medium', status: 'reopened' }),
      defectRecord('D3', { severity: 'critical', status: 'verified' }),
      defectRecord('D4', { severity: 'low', status: 'blocked', source: 'security' }),
    ];
    const gates = {
      runs: [
        { preset: 'build', at: '2026-10-31T09:00:00Z', ok: true, steps: [{ project: '.', step: 'build', status: 'pass' }] },
        {
          preset: 'build',
          at: '2026-10-31T09:40:00Z',
          ok: false,
          steps: [
            { project: '.', step: 'build', status: 'pass' },
            { project: '.', step: 'test', status: 'fail' },
            { project: 'api', step: 'lint', status: 'error' },
            { project: '.', step: 'types', status: 'n/a' },
          ],
        },
      ],
    };
    const plan = { items: [{ id: 'W1', wave: 1, status: 'done' }, { id: 'W2', wave: 2, status: 'doing' }, { id: 'W3', wave: 2 }] };
    const { id } = v.fakeTask('portal', 4, {
      title: 'Reset',
      stages: { analysis: 'done', design: { status: 'skipped', note: 'S' }, planning: 'done', build: { status: 'running', model: 'sonnet' }, deploy: { status: 'blocked', note: 'no credentials' } },
      defects,
      files: { 'gates.json': JSON.stringify(gates), 'work-plan.json': JSON.stringify(plan) },
    });
    v.run(['task', 'deploy', id, '--env', 'test', '--url', 'https://test.example.com']);
    const repo = `${v.work}/acme/portal`;
    initRepo(repo, { message: 'feat: reset' });
    v.run(['task', 'commit', id, '--repo', repo]);
    const r = v.run(['task', 'show', id]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.lines.length <= 20, r.out);
    assert.equal(r.lines[0], `${id} Reset`);
    assert.match(r.out, /size M \| status open/);
    assert.ok(r.out.includes('stages intake[x] analysis[x] design[-] planning[x] build[>] qa[ ] release[ ] deploy[!] security[ ] close[ ]'), r.out);
    assert.match(r.out, /^next build \(running, sonnet\) \| rounds qa 0\/3 security 0\/3$/m);
    assert.match(r.out, /^blocked deploy: no credentials$/m);
    assert.match(r.out, /^plan 3 item\(s\) in 2 wave\(s\): 1 done, 1 doing, 1 todo$/m);
    assert.match(r.out, /^defects 3 open \(high 1, medium 1, low 1\) \| blocking D1\(high,open,qa\) \| blocked D4$/m);
    assert.match(r.out, /^gate build FAIL 2026-10-31T09:40:00Z: test, api:lint\(error\)$/m);
    assert.match(r.out, /^deploy test https:\/\/test\.example\.com /m);
    assert.match(r.out, /^commits 1: [0-9a-f]{7,} \(portal\)$/m);
    assert.match(r.out, /^folder .*portal-004-reset$/m);
    assert.doesNotMatch(r.out, /[^\x20-\x7E\n]/, 'ASCII only');
    const j = v.run(['task', 'show', id, '--json']).json();
    assert.equal(j.next, 'build');
    assert.deepEqual(j.defects.blocking, ['D1']);
    assert.deepEqual(j.gate.failing, ['test', 'api:lint(error)']);
    assert.equal(j.plan.items, 3);
  });

  test('a fresh task shows nothing recorded yet', () => {
    const v = setup();
    const { id } = newTask(v);
    const r = v.run(['task', 'show', id]);
    assert.match(r.out, /^plan none$/m);
    assert.match(r.out, /^defects none open \(0 total\)$/m);
    assert.match(r.out, /^gate none$/m);
    assert.match(r.out, /^deploy none$/m);
    assert.match(r.out, /^commits 0$/m);
    assert.match(r.out, /^next analysis \(pending\)/m);
  });
});

describe('task size', () => {
  test('raises freely, lowers only with --force, keeps README frontmatter in sync', () => {
    const v = setup();
    const { id, dir } = newTask(v, 'Sized', ['--size', 'S']);
    const up = v.run(['task', 'size', id, 'l']);
    assert.equal(up.code, 0, up.err);
    assert.equal(up.out.trim(), `${id} size S -> L`);
    assert.equal(state(v, id).size, 'L');
    assert.match(fs.readFileSync(`${dir}/README.md`, 'utf8'), /^size: L$/m);
    const down = v.run(['task', 'size', id, 'M']);
    assert.equal(down.code, 1);
    assert.match(down.err, /lowering the size L -> M needs --force/);
    assert.equal(v.run(['task', 'size', id, 'M', '--force']).code, 0);
    assert.equal(state(v, id).size, 'M');
    assert.match(v.run(['task', 'size', id, 'M']).out, /unchanged/);
    assert.equal(v.run(['task', 'size', id, 'XL']).code, 1);
  });
});

describe('task plan', () => {
  const item = (id, extra = {}) => ({ id, title: `Item ${id}`, owner: 'backend-engineer', wave: 1, depends_on: [], project: '.', files: [`src/${id}.ts`], acceptance: [], done_when: 'tests pass', ...extra });

  test('stores a valid plan and prints a wave summary', () => {
    const v = setup();
    const { id, dir } = newTask(v);
    writeFile(`${dir}/01-business-solution.md`, BA);
    const plan = {
      items: [
        item('W1', { acceptance: ['AC-1'], files: ['./src/db/schema.sql'] }),
        item('W2', { owner: 'frontend-engineer', acceptance: ['AC-2'], files: ['web/form.tsx'] }),
        item('W3', { wave: 2, depends_on: ['W1', 'W2'], owner: 'tech-lead', acceptance: ['AC-3', 'AC-1'], files: ['src/db/schema.sql'] }),
        item('W4', { wave: 3, owner: 'devops-engineer', depends_on: ['W3'], files: ['Dockerfile'] }),
      ],
    };
    const file = writeFile(`${dir}/work-plan.draft.json`, JSON.stringify(plan));
    const r = v.run(['task', 'plan', id, '--from', file]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.lines[0], 'work plan stored: 4 item(s), 3 wave(s), 3/3 AC covered');
    assert.equal(r.lines[1], 'wave 1: W1 backend-engineer, W2 frontend-engineer');
    assert.equal(r.lines[2], 'wave 2: W3 tech-lead (after W1,W2)');
    const stored = v.readJson(`${dir}/work-plan.json`);
    assert.equal(stored.items.length, 4);
    assert.equal(stored.items[0].status, 'todo');
    assert.equal(stored.items[0].files[0], 'src/db/schema.sql', 'paths normalised');
    // re-plan keeps item status unless the draft sets one
    v.run(['task', 'item', id, 'W1', 'done']);
    assert.equal(v.run(['task', 'plan', id, '--from', file]).code, 0);
    assert.equal(v.readJson(`${dir}/work-plan.json`).items[0].status, 'done');
  });

  test('rejects with exit 2 and lists the problems', () => {
    const v = setup();
    const { id, dir } = newTask(v);
    writeFile(`${dir}/01-business-solution.md`, BA);
    const plan = {
      items: [
        item('W1', { acceptance: ['AC-1'], files: ['src/a.ts', 'src/shared/'] }),
        item('W2', { owner: 'qa-engineer', acceptance: ['AC-9'], files: ['src/shared/x.ts'] }),
        item('W3', { wave: 2, depends_on: ['W4'], files: ['b.ts'] }),
        item('W4', { wave: 2, files: ['c.ts'] }),
        item('W5', { wave: 1, depends_on: ['W9', 'W5'], files: ['SRC/A.ts'] }),
        item('W1', { wave: 3, files: ['d.ts'] }),
        { id: 'X7', title: '', owner: 'backend-engineer', wave: 0, files: [], acceptance: 'AC-1', done_when: '' },
      ],
    };
    const file = writeFile(`${v.root}/plan.json`, JSON.stringify(plan));
    const r = v.run(['task', 'plan', id, '--from', file]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.lines[0], /^work plan rejected \(\d+ problem\(s\)\):$/);
    const expect = [
      /W2: owner "qa-engineer" is not a team engineer role/,
      /W2: AC-9 is not in 01-business-solution\.md/,
      /W1: duplicate id/,
      /W3 \(wave 2\) depends on W4 \(wave 2\): dependencies must be in an earlier wave/,
      /W5: depends on unknown item W9/,
      /W5: depends on itself/,
      /wave 1: W1 and W2 share src\/shared\/ \(same-wave items run in parallel\)/,
      /wave 1: W1 and W5 share src\/a\.ts/,
      /X7: id must be W<n>/,
      /X7: title missing/,
      /X7: wave must be a whole number >= 1/,
      /X7: files must list at least one path/,
      /X7: acceptance must be a list of AC-n ids/,
      /X7: done_when missing/,
      /AC-2 is not covered by any work item/,
      /AC-3 is not covered by any work item/,
    ];
    for (const re of expect) assert.match(r.out, re);
    assert.ok(!fs.existsSync(`${dir}/work-plan.json`), 'nothing stored');
  });

  test('missing 01, invalid JSON and a bad shape are rejected; missing --from is an error', () => {
    const v = setup();
    const { id, dir } = newTask(v);
    const ok = writeFile(`${v.root}/ok.json`, JSON.stringify({ items: [item('W1', { acceptance: ['AC-1'] })] }));
    const no01 = v.run(['task', 'plan', id, '--from', ok]);
    assert.equal(no01.code, 2);
    assert.match(no01.out, /01-business-solution\.md not found/);
    writeFile(`${dir}/01-business-solution.md`, '## Summary\nno criteria here\n');
    assert.match(v.run(['task', 'plan', id, '--from', ok]).out, /no AC-n ids in 01/);
    const bad = writeFile(`${v.root}/bad.json`, '{ items: [');
    const j = v.run(['task', 'plan', id, '--from', bad]);
    assert.equal(j.code, 2);
    assert.match(j.out, /invalid JSON/);
    const shape = writeFile(`${v.root}/shape.json`, '{"plan": []}');
    assert.match(v.run(['task', 'plan', id, '--from', shape]).out, /must be \{"items": \[\.\.\.\]\}/);
    assert.equal(v.run(['task', 'plan', id]).code, 1);
    assert.equal(v.run(['task', 'plan', id, '--from', `${v.root}/none.json`]).code, 1);
    const json = v.run(['task', 'plan', id, '--from', ok, '--json']);
    assert.equal(json.code, 2);
    assert.equal(json.json().ok, false);
  });

  test('validatePlan: projects not in team.json are warnings; a bare array is accepted', () => {
    const res = validatePlan([item('W1', { acceptance: ['AC-1'], project: 'api/' })], { acs: ['AC-1'], projects: ['.'] });
    assert.deepEqual(res.problems, []);
    assert.match(res.warnings[0], /project "api" is not in team\.json/);
    assert.equal(res.items[0].project, 'api');
    const nested = validatePlan({ items: [item('W1', { acceptance: ['AC-1'], files: ['src/'] }), item('W2', { files: ['src/deep/x.ts'], project: 'web' })] }, { acs: ['AC-1'] });
    assert.deepEqual(nested.problems, [], 'different projects never overlap');
  });
});

describe('task item', () => {
  test('updates an item and reports wave progress', () => {
    const v = setup();
    const plan = { items: [{ id: 'W1', wave: 1, status: 'todo' }, { id: 'W2', wave: 1, status: 'todo' }, { id: 'W3', wave: 2, depends_on: ['W1'], status: 'todo' }] };
    const { id, dir } = v.fakeTask('portal', 1, { files: { 'work-plan.json': JSON.stringify(plan) } });
    const r = v.run(['task', 'item', id, 'w1', 'done']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'W1 done; wave 1: 1/2 done; plan: 1/3 done');
    assert.equal(v.readJson(`${dir}/work-plan.json`).items[0].status, 'done');
    assert.equal(v.run(['task', 'item', id, 'W3', 'doing']).out.trim(), 'W3 doing; wave 2: 0/1 done; plan: 1/3 done');
    v.run(['task', 'item', id, 'W1', 'todo']);
    assert.match(v.run(['task', 'item', id, 'W3', 'done']).out, /warning: W3 depends on W1 \(not done\)/);
    assert.equal(v.run(['task', 'item', id, 'W9', 'done']).code, 1);
    assert.equal(v.run(['task', 'item', id, 'W1', 'finished']).code, 1);
    const none = v.fakeTask('portal', 2);
    const r2 = v.run(['task', 'item', none.id, 'W1', 'done']);
    assert.equal(r2.code, 1);
    assert.match(r2.err, /no work plan/);
  });
});

describe('task coverage', () => {
  const TP = [
    '## Summary',
    'Plan.',
    '| TC | AC | Type |',
    '|---|---|---|',
    '| TC-1 | AC-1 | auto |',
    '| TC-2 | AC-1, AC-2 | manual |',
    '### TC-3 Expiry check',
    '- covers AC-2',
    '- TC-4 regression: no AC',
    '## Other',
    'AC-3 mentioned outside any TC',
  ].join('\n');

  test('parseTestCases and readAcs', () => {
    const tcs = parseTestCases(TP);
    assert.deepEqual([...tcs.entries()], [['TC-1', ['AC-1']], ['TC-2', ['AC-1', 'AC-2']], ['TC-3', ['AC-2']], ['TC-4', []]]);
    assert.deepEqual(readAcs('AC-10 AC-2, AC-1 and AC-2 again; MAC-3 no'), ['AC-1', 'AC-2', 'AC-10']);
  });

  test('gaps exit 2; full coverage exits 0', () => {
    const v = setup();
    const plan = { items: [{ id: 'W1', acceptance: ['AC-1', 'AC-2'] }, { id: 'W2', acceptance: ['AC-7'] }] };
    const { id, dir } = v.fakeTask('portal', 1, { files: { '01-business-solution.md': BA, 'work-plan.json': JSON.stringify(plan), '06-test-plan.md': TP } });
    const r = v.run(['task', 'coverage', id]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.out, /^AC +work items +test cases$/m);
    assert.match(r.out, /^AC-1 +W1 +TC-1,TC-2$/m);
    assert.match(r.out, /^AC-2 +W1 +TC-2,TC-3$/m);
    assert.match(r.out, /^AC-3 +- +-$/m);
    assert.match(r.out, /^unknown AC refs: W2 -> AC-7$/m);
    assert.match(r.out, /^test cases without AC: TC-4$/m);
    assert.match(r.out, /^gaps: AC-3 no work item; AC-3 no test case$/m);
    const j = v.run(['task', 'coverage', id, '--json']);
    assert.equal(j.code, 2);
    assert.deepEqual(j.json().gaps, { noItem: ['AC-3'], noTest: ['AC-3'] });

    plan.items.push({ id: 'W3', acceptance: ['AC-3'] });
    writeFile(`${dir}/work-plan.json`, JSON.stringify(plan));
    writeFile(`${dir}/06-test-plan.md`, `${TP}\n| TC-5 | AC-3 | auto |\n`);
    const ok = v.run(['task', 'coverage', id]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /coverage ok: 3 AC, each with a work item and a test case/);
  });

  test('missing files are reported as gaps', () => {
    const v = setup();
    const { id, dir } = v.fakeTask('portal', 1);
    const none = v.run(['task', 'coverage', id]);
    assert.equal(none.code, 2);
    assert.match(none.out, /no 01-business-solution\.md/);
    writeFile(`${dir}/01-business-solution.md`, BA);
    const r = v.run(['task', 'coverage', id]);
    assert.equal(r.code, 2);
    assert.match(r.out, /missing: work-plan\.json, 06-test-plan\.md/);
    assert.match(r.out, /gaps: AC-1 no work item; AC-2 no work item; AC-3 no work item; AC-1 no test case/);
  });
});

describe('task commit, deploy, close', () => {
  test('commit records HEAD once per hash; default repo is the project path', () => {
    const v = setup();
    const { id } = newTask(v);
    const repo = `${v.work}/acme/portal`;
    const h1 = initRepo(repo, { message: 'feat(auth): reset by email' });
    const r = v.run(['task', 'commit', id, '--repo', repo]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `recorded ${h1} feat(auth): reset by email (portal); commits: 1`);
    assert.match(v.run(['task', 'commit', id]).out, /^already recorded/);
    const h2 = commit(repo, 'fix: expiry');
    v.run(['task', 'commit', id, '--repo', repo]);
    assert.deepEqual(state(v, id).commits, [
      { repo, hash: h1, summary: 'feat(auth): reset by email' },
      { repo, hash: h2, summary: 'fix: expiry' },
    ]);
    const notRepo = v.run(['task', 'commit', id, '--repo', tempDir()]);
    assert.equal(notRepo.code, 1);
    assert.match(notRepo.err, /no commit found/);
    assert.equal(v.run(['task', 'commit', id, '--repo', `${v.root}/missing`]).code, 1);
  });

  test('deploy records env, url and time; validates input', () => {
    const v = setup();
    const { id } = newTask(v);
    const r = v.run(['task', 'deploy', id, '--env', 'pending-push', '--note', 'CI deploys on push']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `${id} deploy pending-push recorded`);
    v.run(['task', 'deploy', id, '--env', 'live', '--url', 'https://app.example.com']);
    const d = state(v, id).deploy;
    assert.equal(d.env, 'live');
    assert.equal(d.url, 'https://app.example.com');
    assert.match(d.at, /Z$/);
    assert.equal(d.note, undefined, 'each deploy replaces the record');
    assert.equal(v.run(['task', 'deploy', id, '--env', 'prod']).code, 1);
    assert.equal(v.run(['task', 'deploy', id, '--env', 'test', '--url', 'ftp://x']).code, 1);
    assert.equal(v.run(['task', 'deploy', id]).code, 1);
  });

  test('close refuses done with blocking defects (exit 2); blocked and --force close', () => {
    const v = setup();
    const defects = [defectRecord('D1', { severity: 'critical', source: 'security', status: 'reopened' }), defectRecord('D2', { severity: 'medium' })];
    const all = Object.fromEntries(['analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security'].map((s) => [s, 'done']));
    const { id } = v.fakeTask('portal', 1, { defects, stages: all, files: COVERED });
    const r = v.run(['task', 'close', id, '--status', 'done']);
    assert.equal(r.code, 2);
    assert.match(r.err, /D1 critical reopened/);
    assert.equal(state(v, id).status, 'open');
    const b = v.run(['task', 'close', id, '--status', 'blocked', '--note', 'D1 needs a licence']);
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, new RegExp(`^${id} closed: blocked`));
    const fresh = v.fakeTask('portal', 2);
    assert.match(v.run(['task', 'close', fresh.id, '--status', 'blocked', '--note', 'x']).out, /warning: stage\(s\) still pending: analysis, design/);
    const s = state(v, id);
    assert.equal(s.status, 'blocked');
    assert.match(s.closed, /Z$/);
    assert.equal(s.stages.close.status, 'done');
    assert.equal(s.stages.close.note, 'D1 needs a licence');
    assert.equal(v.run(['task', 'close', id, '--status', 'done', '--force']).code, 0);
    assert.equal(state(v, id).status, 'done');
    assert.equal(v.run(['task', 'close', id, '--status', 'abandoned']).code, 1);
    assert.equal(v.run(['task', 'close', id]).code, 1);
  });

  test('close done with only verified/medium defects and every stage done', () => {
    const v = setup();
    const all = Object.fromEntries(['analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security'].map((s) => [s, 'done']));
    const { id, dir } = v.fakeTask('portal', 1, { stages: all, files: COVERED, defects: [defectRecord('D1', { status: 'verified' }), defectRecord('D2', { severity: 'low' }), defectRecord('D3', { severity: 'high', status: 'blocked' })] });
    const blocked = v.run(['task', 'close', id, '--status', 'done']);
    assert.equal(blocked.code, 2, 'a blocked high defect is not verified');
    assert.match(blocked.err, /D3 high blocked/);
    writeFile(`${dir}/defects.json`, JSON.stringify({ defects: [defectRecord('D1', { status: 'verified' }), defectRecord('D2', { severity: 'low' }), defectRecord('D3', { severity: 'high', status: 'wontfix' })] }));
    const r = v.run(['task', 'close', id, '--status', 'done', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json().warnings, []);
    assert.equal(state(v, id).stage, null);
  });
});

describe('task list and path', () => {
  test('lists v2 folders and v1 records (marked v1); --open filters', () => {
    const v = setup();
    v.v1Task('portal', 1, { slug: 'login-page' });
    v.v1Task('portal', 2, { slug: 'search', frontmatter: { id: 'portal-002', status: 'IN PROGRESS' }, body: '' });
    v.v1Task('portal', 2, { slug: 'notes-B1', frontmatter: {} });
    v.v1Task('portal', 3, { slug: 'no-status', frontmatter: { id: 'portal-003' } });
    const a = newTask(v, 'Reset');
    const b = newTask(v, 'Closed one');
    v.run(['task', 'close', b.id, '--status', 'done', '--force']);
    const r = v.run(['task', 'list', 'acme-portal']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines.map((l) => l.split(/\s+/)[0]), ['portal-001', 'portal-002', 'portal-003', 'portal-004', 'portal-005']);
    assert.match(r.lines[0], /^portal-001 +done +v1 +- +Old 1$/);
    assert.match(r.lines[1], /^portal-002 +in-progress +v1 +- +search$/);
    assert.match(r.lines[2], /^portal-003 +unknown +v1/);
    assert.match(r.lines[3], /^portal-004 +open +analysis +M +Reset$/);
    assert.match(r.lines[4], /^portal-005 +done +- +M +Closed one$/);
    const open = v.run(['task', 'list', 'portal', '--open']);
    assert.deepEqual(open.lines.map((l) => l.split(/\s+/)[0]), ['portal-002', a.id]);
    const json = v.run(['task', 'list', 'portal', '--json']).json();
    assert.equal(json.length, 5);
    assert.equal(json[0].version, 1);
    assert.equal(json[3].version, 2);
    assert.deepEqual(json[3].defects.blocking, []);
    assert.ok(!('state' in json[3]));
    const cwd = v.run(['task', 'list', '--open'], { cwd: `${v.work}/acme/portal` });
    assert.equal(cwd.lines.length, 2);
    assert.match(v.run(['task', 'list', 'shop']).out, /no tasks for shop/);
    assert.equal(v.run(['task', 'list', 'nope']).code, 1);
  });

  test('v1Records ignores files without an id in their frontmatter', () => {
    const v = setup();
    v.v1Task('portal', 5, { slug: 'x' });
    v.v1Task('portal', 5, { slug: 'notes', frontmatter: {} });
    writeFile(`${v.tasksDir('portal')}/BACKLOG.md`, '# backlog');
    writeFile(`${v.tasksDir('portal')}/portal-006-wrong.md`, '---\nid: portal-007\n---\n');
    const recs = v1Records(v.tasksDir('portal'), 'portal');
    assert.deepEqual(recs.map((r) => r.id), ['portal-005']);
    assert.equal(recs[0].title, 'Old 5');
    writeFile(`${v.tasksDir('portal')}/portal-008-redesign.md`, '﻿---\nid: portal-008\nstatus: In Progress\n---\n\n# portal-008 — Professional redesign\n');
    const r8 = v1Records(v.tasksDir('portal'), 'portal').find((r) => r.id === 'portal-008');
    assert.equal(r8.title, 'Professional redesign', 'title from an em-dash heading');
    assert.equal(r8.status, 'in-progress');
    assert.equal(r8.open, true);
  });

  test('path prints the folder; unknown tasks exit 1; help', () => {
    const v = setup();
    const { id, dir } = newTask(v);
    const r = v.run(['task', 'path', id]);
    assert.equal(r.out.trim(), dir);
    assert.equal(v.run(['task', 'path', id, '--json']).json().dir, dir);
    assert.equal(v.run(['task', 'path', 'portal-042']).code, 1);
    assert.equal(v.run(['task', 'show', 'shop-001']).code, 1);
    const h = v.run(['task', '--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /hades task coverage <task>/);
    assert.equal(v.run(['task', 'frob']).code, 1);
  });
});

describe('stage machine rules (D6, D7)', () => {
  const done = 'done';
  const upTo = (last) => Object.fromEntries(['analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security'].slice(0, ['analysis', 'design', 'planning', 'build', 'qa', 'release', 'deploy', 'security'].indexOf(last) + 1).map((s) => [s, done]));
  const PLAN = { items: [{ id: 'W1', wave: 1, acceptance: ['AC-1', 'AC-2', 'AC-3'] }] };
  const TESTS = '| TC-1 | AC-1 | auto |\n| TC-2 | AC-2 | auto |\n';

  test('source-level security may run while deploy runs; security done waits for the deploy', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { ...upTo('release'), deploy: 'running' } });
    const run = v.run(['task', 'stage', id, 'security', 'running']);
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, /security running \(round 1\)/);
    const doneEarly = v.run(['task', 'stage', id, 'security', 'done']);
    assert.equal(doneEarly.code, 1);
    assert.match(doneEarly.err, /security cannot be done while earlier stage\(s\) are running: deploy \(DAST runs after the deploy; /);
    assert.equal(v.run(['task', 'stage', id, 'deploy', 'done']).code, 0);
    assert.equal(v.run(['task', 'stage', id, 'security', 'done']).code, 0);
  });

  test('other stages cannot start or finish while an earlier one runs', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { analysis: done, design: done, planning: 'running' } });
    for (const st of ['running', 'done']) {
      const r = v.run(['task', 'stage', id, 'build', st]);
      assert.equal(r.code, 1, st);
      assert.match(r.err, /build cannot be (running|done) while earlier stage\(s\) are running: planning \(finish them, or --force\)/);
    }
    const { id: id2 } = v.fakeTask('portal', 2, { stages: { ...upTo('qa'), release: done, deploy: 'pending' } });
    assert.match(v.run(['task', 'stage', id2, 'security', 'running']).err, /earlier stage\(s\) are pending: deploy/, 'security waits for the deploy to start');
  });

  test('planning done needs a stored plan that covers every AC (exit 2)', () => {
    const v = setup();
    const { id, dir } = v.fakeTask('portal', 1, { stages: { analysis: done, design: done }, files: { '01-business-solution.md': BA } });
    const none = v.run(['task', 'stage', id, 'planning', 'done']);
    assert.equal(none.code, 2);
    assert.match(none.err, /planning cannot be done: no work-plan\.json \(hades task plan .* --from <task folder>\/work-plan\.draft\.json, or --force\)/);
    writeFile(`${dir}/work-plan.json`, JSON.stringify({ items: [{ id: 'W1', acceptance: ['AC-1'] }] }));
    assert.match(v.run(['task', 'stage', id, 'planning', 'done']).err, /AC-2 no work item; AC-3 no work item/);
    writeFile(`${dir}/work-plan.json`, JSON.stringify(PLAN));
    assert.equal(v.run(['task', 'stage', id, 'planning', 'done']).code, 0);
  });

  test('qa: show hints the coverage check; qa running warns about AC without a test case', () => {
    const v = setup();
    const { id, dir } = v.fakeTask('portal', 1, { stages: upTo('build'), files: { '01-business-solution.md': BA, 'work-plan.json': JSON.stringify(PLAN), '06-test-plan.md': TESTS } });
    const show = v.run(['task', 'show', id]);
    assert.match(show.out, new RegExp(`^hint before qa: hades task coverage ${id} -> AC-3 no test case$`, 'm'));
    assert.match(v.run(['task', 'show', id, '--json']).json().hint, /AC-3 no test case/);
    const r = v.run(['task', 'stage', id, 'qa', 'running']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^warning: coverage gaps before qa: AC-3 no test case \\(hades task coverage ${id}\\)$`, 'm'));
    assert.doesNotMatch(v.run(['task', 'show', id]).out, /^hint/m, 'no hint once qa runs');
    writeFile(`${dir}/06-test-plan.md`, `${TESTS}| TC-3 | AC-3 | manual |\n`);
    v.run(['task', 'stage', id, 'qa', 'failed', '--note', 'D1']);
    assert.match(v.run(['task', 'show', id]).out, /^hint coverage ok \(3 AC, each with a work item and a test case\): qa may start$/m);
    assert.doesNotMatch(v.run(['task', 'stage', id, 'qa', 'running']).out, /coverage gaps/);
    const fresh = v.fakeTask('portal', 2, { stages: upTo('build') });
    assert.match(v.run(['task', 'show', fresh.id]).out, /^hint before qa: .* -> no 01-business-solution\.md; no work-plan\.json; no 06-test-plan\.md$/m);
  });

  test('close done refuses while a stage runs; close blocked warns about it', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { ...upTo('deploy'), security: 'running' } });
    const r = v.run(['task', 'close', id, '--status', 'done']);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot close done while stage\(s\) are not done or skipped: security running/);
    assert.equal(state(v, id).status, 'open');
    const b = v.run(['task', 'close', id, '--status', 'blocked', '--note', 'DAST target down']);
    assert.equal(b.code, 0, b.err);
    assert.match(b.out, /^warning: stage\(s\) still running: security$/m);
    assert.equal(v.run(['task', 'close', id, '--status', 'done', '--force']).code, 0);
  });

  // cli F3: a fresh task, or one with a failed build, must not close done.
  test('close done refuses pending, failed and blocked stages (exit 2); blocked closes', () => {
    const v = setup();
    const fresh = v.fakeTask('portal', 1);
    const r = v.run(['task', 'close', fresh.id, '--status', 'done']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /not done or skipped: analysis pending, design pending, planning pending, build pending, qa pending/);
    assert.equal(state(v, fresh.id).status, 'open');
    const failedBuild = v.fakeTask('portal', 2, { stages: { ...upTo('planning'), build: { status: 'failed', note: 'red x3' }, qa: 'skipped', release: 'skipped', deploy: 'skipped', security: 'skipped' }, files: COVERED });
    const f = v.run(['task', 'close', failedBuild.id, '--status', 'done']);
    assert.equal(f.code, 2);
    assert.match(f.err, /: build failed \(finish them, close --status blocked, or --force\)/);
    const blocked = v.fakeTask('portal', 3, { stages: { ...upTo('security'), qa: { status: 'blocked', note: 'D1' } }, files: COVERED });
    assert.match(v.run(['task', 'close', blocked.id, '--status', 'done']).err, /qa blocked/);
    assert.equal(v.run(['task', 'close', blocked.id, '--status', 'blocked', '--note', 'D1 blocked']).code, 0);
    assert.equal(state(v, blocked.id).status, 'blocked');
  });

  // cli F3: later stages cannot run or pass after a failed stage; documented exceptions stay.
  test('a failed stage is not finished: later stages refused until it is re-run or blocked', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { ...upTo('planning'), build: 'failed' }, files: COVERED });
    for (const [stage, st] of [['qa', 'running'], ['qa', 'done'], ['qa', 'skipped', 'x'], ['release', 'done']]) {
      const r = v.run(['task', 'stage', id, stage, st, '--note', 'x']);
      if (st === 'skipped') {
        assert.equal(r.code, 0, r.err);
        continue;
      }
      assert.equal(r.code, 1, `${stage} ${st}`);
      assert.match(r.err, /earlier stage\(s\) failed: build \(re-run them, mark them blocked, or --force\)/);
    }
    assert.equal(state(v, id).stages.release.status, 'pending');
    // blocked = given up: the documented "build blocked -> later stages skipped -> close blocked" path
    assert.equal(v.run(['task', 'stage', id, 'build', 'blocked', '--note', 'red after 3']).code, 0);
    assert.equal(v.run(['task', 'stage', id, 'qa', 'skipped', '--note', 'build blocked']).code, 0);
    // a blocked qa (critical defect blocked) still allows the release commit and the deploy
    const k = v.fakeTask('portal', 2, { stages: { ...upTo('build'), qa: { status: 'blocked', note: 'D1' } } });
    assert.equal(v.run(['task', 'stage', k.id, 'release', 'done']).code, 0);
    // source-level security still runs after a failed deploy
    const d = v.fakeTask('portal', 3, { stages: { ...upTo('release'), deploy: { status: 'failed', note: 'health red' } } });
    const sec = v.run(['task', 'stage', d.id, 'security', 'running']);
    assert.equal(sec.code, 0, sec.err);
    assert.equal(v.run(['task', 'stage', d.id, 'security', 'running', '--force']).code, 0);
  });

  // pipeline F6: "next" never sends the PM back to a blocked stage; failed is retried.
  test('next skips blocked stages and keeps failed ones', () => {
    const v = setup();
    const { id } = v.fakeTask('portal', 1, { stages: { ...upTo('release'), deploy: 'running' } });
    const r = v.run(['task', 'stage', id, 'deploy', 'blocked', '--note', 'no environment']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /deploy blocked; next: security$/m);
    assert.match(v.run(['task', 'show', id]).out, /^next security \(pending\)/m);
    const f = v.fakeTask('portal', 2, { stages: { ...upTo('release'), deploy: 'running' } });
    assert.match(v.run(['task', 'stage', f.id, 'deploy', 'failed', '--note', 'health red']).out, /next: deploy$/m);
    const p = v.fakeTask('portal', 3, { stages: { analysis: done, design: done, planning: { status: 'blocked', note: 'no plan' } } });
    assert.match(v.run(['task', 'show', p.id]).out, /^next build \(pending\)/m);
  });

  // cli F4: the close stage completes only through "task close".
  test('task stage close done|skipped is refused; close running is allowed', () => {
    const v = setup();
    const all = upTo('security');
    const { id } = v.fakeTask('portal', 1, { stages: all, defects: [defectRecord('D1', { severity: 'critical', source: 'security' })] });
    for (const st of ['done', 'skipped']) {
      const r = v.run(['task', 'stage', id, 'close', st, '--note', 'x']);
      assert.equal(r.code, 1, st);
      assert.match(r.err, /the close stage completes only through "hades task close/);
    }
    assert.equal(state(v, id).stages.close.status, 'pending');
    assert.equal(v.run(['task', 'stage', id, 'close', 'running']).code, 0);
  });

  // cli F5: an AC without a test case blocks qa done and close done.
  test('qa done and close done need a test case for every AC (exit 2), unless --force', () => {
    const v = setup();
    const partial = '| TC-1 | AC-1 | auto |\n| TC-2 | AC-2 | auto |\n';
    const files = { '01-business-solution.md': BA, 'work-plan.json': JSON.stringify(FULL_PLAN), '06-test-plan.md': partial };
    const { id, dir } = v.fakeTask('portal', 1, { stages: { ...upTo('build'), qa: 'running' }, files });
    const r = v.run(['task', 'stage', id, 'qa', 'done']);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, new RegExp(`qa cannot be done: AC-3 no test case \\(hades task coverage ${id}; `));
    assert.equal(state(v, id).stages.qa.status, 'running');
    assert.equal(v.run(['task', 'stage', id, 'qa', 'done', '--force']).code, 0);
    for (const s of ['release', 'deploy', 'security']) assert.equal(v.run(['task', 'stage', id, s, 'done']).code, 0, s);
    const c = v.run(['task', 'close', id, '--status', 'done']);
    assert.equal(c.code, 2);
    assert.match(c.err, /cannot close done while acceptance criteria are untested: AC-3 no test case/);
    writeFile(`${dir}/06-test-plan.md`, FULL_TESTS);
    assert.equal(v.run(['task', 'close', id, '--status', 'done']).code, 0);
    // qa skipped with a note (a recorded override): close done does not check coverage
    const s = v.fakeTask('portal', 2, { stages: { ...upTo('build'), qa: { status: 'skipped', note: 'docs only' }, release: done, deploy: done, security: done } });
    assert.equal(v.run(['task', 'close', s.id, '--status', 'done']).code, 0);
  });

  // cli F12: review defects block build done (G3).
  test('build done is refused while a critical/high review defect is open (exit 2)', () => {
    const v = setup();
    const { id, dir } = v.fakeTask('portal', 1, { stages: { ...upTo('planning'), build: 'running' }, defects: [defectRecord('D1', { severity: 'critical', source: 'review', owner: 'tech-lead' })] });
    const r = v.run(['task', 'stage', id, 'build', 'done']);
    assert.equal(r.code, 2);
    assert.match(r.err, /build cannot pass while critical\/high review defects are not verified: D1 critical open/);
    writeFile(`${dir}/defects.json`, JSON.stringify({ defects: [defectRecord('D1', { severity: 'critical', source: 'review', status: 'verified' })] }));
    assert.equal(v.run(['task', 'stage', id, 'build', 'done']).code, 0);
  });
});

// cli F10: a re-submitted plan keeps the stored status of existing items.
describe('task plan re-submission', () => {
  test('a draft with "status": "todo" does not reset finished items', () => {
    const v = setup();
    const { id, dir } = newTask(v);
    writeFile(`${dir}/01-business-solution.md`, BA);
    const it = (wid, extra) => ({ id: wid, title: wid, owner: 'backend-engineer', wave: 1, files: [`src/${wid}.ts`], acceptance: [], done_when: 'tests pass', status: 'todo', ...extra });
    const draft = writeFile(`${dir}/work-plan.draft.json`, JSON.stringify({ items: [it('W1', { acceptance: ['AC-1', 'AC-2', 'AC-3'] }), it('W2')] }));
    assert.equal(v.run(['task', 'plan', id, '--from', draft]).code, 0);
    v.run(['task', 'item', id, 'W1', 'done']);
    v.run(['task', 'item', id, 'W2', 'doing']);
    const again = writeFile(`${dir}/work-plan.draft.json`, JSON.stringify({ items: [it('W1', { acceptance: ['AC-1', 'AC-2', 'AC-3'] }), it('W2'), it('W3', { wave: 2, depends_on: ['W1'] })] }));
    assert.equal(v.run(['task', 'plan', id, '--from', again]).code, 0);
    const items = v.readJson(`${dir}/work-plan.json`).items;
    assert.deepEqual(items.map((i) => `${i.id}:${i.status}`), ['W1:done', 'W2:doing', 'W3:todo']);
    assert.match(items[0].at, /Z$/, 'the time of the last move is kept');
  });
});
