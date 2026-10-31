// Tests for "hades task adopt": a HADES v1 single-file task record (with an <id>-artifacts/ folder)
// becomes a v2 task folder <id>-<slug>-v2/; the v1 files are never touched.
// Run: node --test tests/cli/task-adopt.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeVault, cleanup, writeFile } from '../helpers/vault.mjs';
import { v1Request, adoptedState } from '../../lib/commands/task.mjs';
import { STAGES } from '../../lib/core/task.mjs';

after(cleanup);

// A v1 record as HADES v1 wrote it: frontmatter, a "## Request (verbatim)" blockquote, PM sections.
const V1 = [
  '---',
  'id: portal-004',
  'organization: acme',
  'team: portal',
  'title: Password reset by email',
  'status: IN PROGRESS',
  'size: m',
  'opened: 2026-10-11',
  '---',
  '',
  '# portal-004 - Password reset by email',
  '',
  '## Request (verbatim)',
  '',
  '> Users must reset their password by email.',
  '> Links expire after 30 minutes.',
  '',
  '## Understanding & assumptions (PM)',
  'Scope is the web app only.',
  '',
  '## Decisions (PM)',
  '- mail via the existing SMTP relay',
  '',
].join('\n');

function v1Vault() {
  const v = makeVault({ teams: { portal: {} } });
  const tasks = v.tasksDir('portal');
  const record = writeFile(`${tasks}/portal-004-password-reset-by-email.md`, V1);
  const artifact = writeFile(`${tasks}/portal-004-artifacts/01-business-brief.md`, '# Brief\nAC-1 a mail is sent\n');
  // v1 sibling notes files have no id in their frontmatter and are not the record
  const notes = writeFile(`${tasks}/portal-004-notes-B1.md`, '# notes\n');
  return { v, tasks, record, artifact, notes };
}

const bytes = (f) => fs.readFileSync(f);

describe('task adopt', () => {
  test('creates <id>-<slug>-v2 with state, README (request + Legacy line) and empty defects; v1 files untouched', () => {
    const { v, tasks, record, artifact, notes } = v1Vault();
    const before = [bytes(record), bytes(artifact), bytes(notes)];
    const r = v.run(['task', 'adopt', 'portal-004']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1);
    const [id, dir] = r.out.trim().split(' ');
    assert.equal(id, 'portal-004');
    assert.equal(dir, `${tasks}/portal-004-password-reset-by-email-v2`);
    // v1 files are neither moved nor changed
    assert.deepEqual([bytes(record), bytes(artifact), bytes(notes)], before);
    assert.ok(fs.existsSync(`${tasks}/portal-004-artifacts/01-business-brief.md`));

    const s = v.readJson(`${dir}/state.json`);
    assert.equal(s.id, 'portal-004');
    assert.equal(s.title, 'Password reset by email');
    assert.equal(s.size, 'M', 'size from the v1 frontmatter');
    assert.equal(s.status, 'open');
    assert.equal(s.stage, 'analysis');
    assert.deepEqual(s.stages.intake, { status: 'skipped', at: s.opened, note: 'v1 record: portal-004-password-reset-by-email.md' });
    assert.equal(s.stages.analysis.status, 'pending');
    assert.deepEqual(v.readJson(`${dir}/defects.json`), { defects: [] });

    const readme = fs.readFileSync(`${dir}/README.md`, 'utf8');
    assert.match(readme, /^---\nid: portal-004\nteam: portal\norganization: acme\ntitle: Password reset by email\nsize: M\n/);
    assert.ok(
      readme.includes('Legacy: HADES v1 record [portal-004-password-reset-by-email.md](../portal-004-password-reset-by-email.md), artifacts [portal-004-artifacts/](../portal-004-artifacts/) (kept as they are; v1 status in-progress).\n\n## Request (verbatim)\n\nUsers must reset their password by email.\nLinks expire after 30 minutes.\n'),
      readme,
    );
    assert.doesNotMatch(readme, /Understanding & assumptions/, 'only the Request section is taken');
    assert.doesNotMatch(readme, /\{\{[A-Z0-9_]+\}\}/);
  });

  test('the adopted task is the v2 task of that ID: show, list, stage, next ID', () => {
    const { v, tasks } = v1Vault();
    const dir = v.run(['task', 'adopt', 'portal-004', '--stage', 'build', '--size', 'l']).out.trim().split(' ')[1];
    const s = v.readJson(`${dir}/state.json`);
    assert.equal(s.size, 'L', '--size wins over the v1 frontmatter');
    for (const st of ['intake', 'analysis', 'design', 'planning']) {
      assert.equal(s.stages[st].status, 'skipped', st);
      assert.equal(s.stages[st].note, 'v1 record: portal-004-password-reset-by-email.md');
    }
    assert.equal(s.stages.build.status, 'pending');
    assert.equal(s.stage, 'build');
    const show = v.run(['task', 'show', 'portal-004']);
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /^next build \(pending\)/m);
    assert.match(show.out, new RegExp(`^folder ${dir}$`, 'm'));
    assert.equal(v.run(['task', 'path', 'portal-004']).out.trim(), dir);
    // listed once, as v2 (the artifacts folder is not a task)
    const list = v.run(['task', 'list', 'portal', '--json']).json();
    assert.deepEqual(list.map((t) => `${t.id}:v${t.version}`), ['portal-004:v2']);
    assert.equal(v.run(['task', 'stage', 'portal-004', 'build', 'running']).code, 0);
    const next = v.run(['task', 'new', 'portal', '--title', 'Next one']);
    assert.equal(next.out.split(' ')[0], 'portal-005');
    assert.ok(fs.existsSync(`${tasks}/portal-004-password-reset-by-email.md`));
  });

  test('a record without a Request section gets a pointer; no artifacts folder, no artifacts link', () => {
    const v = makeVault({ teams: { portal: {} } });
    v.v1Task('portal', 2, { slug: 'login-page', frontmatter: { id: 'portal-002', status: 'DONE' }, body: '\nSome history.\n' });
    const r = v.run(['task', 'adopt', 'portal-002', '--json']);
    assert.equal(r.code, 0, r.err);
    const j = r.json();
    assert.equal(j.dir, `${v.tasksDir('portal')}/portal-002-login-page-v2`);
    assert.equal(j.v1.artifacts, null);
    assert.equal(j.size, null);
    assert.match(r.err, /warning: the v1 record of portal-002 has status "done"/);
    const readme = fs.readFileSync(`${j.dir}/README.md`, 'utf8');
    assert.ok(readme.includes('Legacy: HADES v1 record [portal-002-login-page.md](../portal-002-login-page.md) (kept as they are; v1 status done).'), readme);
    assert.ok(readme.includes('## Request (verbatim)\n\nSee the v1 record: [portal-002-login-page.md](../portal-002-login-page.md) (no "## Request" section found).'), readme);
  });

  test('refusals exit 1 and create nothing', () => {
    const { v, tasks } = v1Vault();
    const cases = [
      [['task', 'adopt', 'portal-009'], /no HADES v1 record for portal-009/],
      [['task', 'adopt', 'nope-001'], /unknown team/],
      [['task', 'adopt', 'portal'], /not a task ID/],
      [['task', 'adopt', 'portal-004', '--stage', 'close'], /--stage must be one of intake analysis/],
      [['task', 'adopt', 'portal-004', '--stage', 'testing'], /--stage must be one of/],
      [['task', 'adopt', 'portal-004', '--size', 'XL'], /--size must be S\|M\|L/],
      [['task', 'adopt', 'portal-004', '--stgae', 'build'], /unknown flag --stgae/],
      [['task', 'adopt'], /missing <v1-task-id>/],
    ];
    for (const [args, re] of cases) {
      const r = v.run(args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re, args.join(' '));
    }
    assert.deepEqual(fs.readdirSync(tasks).filter((n) => n.endsWith('-v2')), []);
    assert.equal(v.run(['task', 'adopt', 'portal-004']).code, 0);
    const again = v.run(['task', 'adopt', 'portal-004']);
    assert.equal(again.code, 1);
    assert.match(again.err, /portal-004 already has a v2 task folder/);
  });

  test('v1Request and adoptedState', () => {
    assert.equal(v1Request('# x\n\n## Request\n\n> a\n>\n> b\n\n## Next\nc\n'), 'a\n\nb');
    assert.equal(v1Request('## Request (verbatim)\nplain text\n### detail\nmore\n## Other'), 'plain text\n### detail\nmore');
    assert.equal(v1Request('# none here\n'), null);
    assert.equal(v1Request('## Request\n\n## Next\n'), null);
    const s = adoptedState({ id: 't-001', team: 't', organization: 'o', title: 'T', size: null, first: 'qa', record: 'r.md' });
    assert.deepEqual(STAGES.filter((x) => s.stages[x].status === 'skipped'), ['intake', 'analysis', 'design', 'planning', 'build']);
    assert.equal(s.stage, 'qa');
    const i = adoptedState({ id: 't-001', team: 't', organization: 'o', title: 'T', size: null, first: 'intake', record: 'r.md' });
    assert.equal(i.stages.intake.status, 'pending');
    assert.equal(i.stage, 'intake');
  });
});
