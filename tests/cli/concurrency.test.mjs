// Parallel CLI writes on one task (cli F1, F2; pipeline F14): the engineers of a wave, DevOps and
// the background security engineer run "hades defect add", "task item", "gate" and "task stage"
// at the same time. Every write is a locked read-modify-write: nothing is lost, defect IDs are
// unique, Windows rename collisions (EPERM) are retried and no .tmp or .lock file is left behind.
// Run: node --test tests/cli/concurrency.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeVault, cleanup, tempDir, writeFile, ENGINE } from '../helpers/vault.mjs';
import { withLock, updateJson, readJson, writeText } from '../../lib/core/util.mjs';

after(cleanup);

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.(tmp|lock|stale)$/.test(n));

// N node processes that each run `body` (an async module body with `m` = util.mjs, `file`, `i`).
function nodeProcs(n, body, file) {
  const util = pathToFileURL(`${ENGINE}/lib/core/util.mjs`).href;
  const gate = pathToFileURL(`${ENGINE}/lib/core/gate.mjs`).href;
  const src = `const m = await import(${JSON.stringify(util)}); const g = await import(${JSON.stringify(gate)}); const file = ${JSON.stringify(file)}; const i = Number(process.argv[1]); ${body}`;
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', src, String(i)], { windowsHide: true });
        let err = '';
        c.stderr.on('data', (d) => (err += d));
        c.on('close', (code) => resolve({ code, err }));
      }),
    ),
  );
}

describe('parallel CLI writes on one task', () => {
  test('8 simultaneous "defect add" calls store 8 defects with 8 distinct IDs (each caller gets its own)', async () => {
    const v = makeVault({ teams: { portal: {} } });
    const { id, dir } = v.fakeTask('portal', 1);
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        v.runAsync(['defect', 'add', id, '--title', `t${i}`, '--severity', i % 2 ? 'critical' : 'high', '--owner', 'backend-engineer', '--source', i % 2 ? 'security' : 'deploy']),
      ),
    );
    for (const r of runs) assert.equal(r.code, 0, r.err);
    const printed = runs.map((r) => r.out.trim());
    assert.equal(new Set(printed).size, 8, `printed IDs: ${printed.join(',')}`);
    const stored = v.readJson(`${dir}/defects.json`).defects;
    assert.equal(stored.length, 8);
    assert.deepEqual(stored.map((d) => d.id).sort(), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']);
    // the ID a caller printed is the defect it added
    for (let i = 0; i < 8; i++) assert.equal(stored.find((d) => d.id === printed[i]).title, `t${i}`);
    assert.deepEqual(leftovers(dir), []);
  });

  test('parallel "task item" and "defect update" calls lose no update', async () => {
    const v = makeVault({ teams: { portal: {} } });
    const plan = { items: Array.from({ length: 6 }, (_, i) => ({ id: `W${i + 1}`, wave: 1, status: 'todo' })) };
    const defects = Array.from({ length: 6 }, (_, i) => ({ id: `D${i + 1}`, title: `d${i}`, severity: 'high', source: 'qa', owner: 'backend-engineer', status: 'open', round: 0, history: [] }));
    const { id, dir } = v.fakeTask('portal', 1, { defects, files: { 'work-plan.json': JSON.stringify(plan) } });
    const runs = await Promise.all([
      ...plan.items.map((it) => v.runAsync(['task', 'item', id, it.id, 'done'])),
      ...defects.map((d) => v.runAsync(['defect', 'update', id, d.id, '--status', 'fixed'])),
    ]);
    for (const r of runs) assert.equal(r.code, 0, r.err);
    assert.deepEqual(v.readJson(`${dir}/work-plan.json`).items.map((i) => i.status), Array(6).fill('done'));
    const after1 = v.readJson(`${dir}/defects.json`).defects;
    assert.deepEqual(after1.map((d) => `${d.status}:${d.round}`), Array(6).fill('fixed:1'));
    assert.deepEqual(leftovers(dir), []);
  });

  test('parallel state.json writers (deploy, commit, stage, size) keep every change', async () => {
    const v = makeVault({ teams: { portal: {} } });
    const { id, dir } = v.fakeTask('portal', 1, { size: 'S', stages: { analysis: 'done', design: 'done', planning: 'done', build: 'done', qa: 'done', release: 'done', deploy: 'running' } });
    const runs = await Promise.all([
      v.runAsync(['task', 'deploy', id, '--env', 'test', '--url', 'https://test.example.com']),
      v.runAsync(['task', 'stage', id, 'security', 'running']),
      v.runAsync(['task', 'size', id, 'L']),
      v.runAsync(['task', 'stage', id, 'deploy', 'running', '--model', 'sonnet']),
    ]);
    for (const r of runs) assert.equal(r.code, 0, r.err);
    const s = v.readJson(`${dir}/state.json`);
    assert.equal(s.deploy.env, 'test');
    assert.equal(s.stages.security.status, 'running');
    assert.equal(s.rounds.security, 1);
    assert.equal(s.size, 'L');
    assert.equal(s.stages.deploy.model, 'sonnet');
    assert.deepEqual(leftovers(dir), []);
  });

  test('gate runs appended by parallel processes are all kept (no EPERM, no .tmp left)', async () => {
    const dir = tempDir('hades-gates-');
    const res = await nodeProcs(4, 'for (let k = 0; k < 15; k++) g.appendRun(file, { preset: "build", by: i, k, ok: true, steps: [] });', dir);
    for (const r of res) assert.equal(r.code, 0, r.err);
    const runs = JSON.parse(fs.readFileSync(`${dir}/gates.json`, 'utf8')).runs;
    assert.equal(runs.length, 60);
    for (let i = 0; i < 4; i++) assert.equal(runs.filter((r) => r.by === i).length, 15);
    assert.deepEqual(leftovers(dir), []);
  });

  test('plain writeText from parallel processes never fails (rename retried) and leaves no temp files', async () => {
    const dir = tempDir('hades-write-');
    const file = `${dir}/state.json`;
    const res = await nodeProcs(4, 'for (let k = 0; k < 40; k++) m.writeText(file, JSON.stringify({ i, k }));', file);
    for (const r of res) assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).k === 39);
    assert.deepEqual(leftovers(dir), []);
  });
});

describe('lock files', () => {
  test('updateJson returns the mutator result, writes, and removes its lock; a throw writes nothing', () => {
    const dir = tempDir('hades-lock-');
    const file = `${dir}/x.json`;
    assert.equal(updateJson(file, () => ({ n: 0 }), (d) => ++d.n), 1);
    assert.equal(updateJson(file, () => ({ n: 0 }), (d) => ++d.n), 2);
    assert.throws(() => updateJson(file, null, (d) => {
      d.n = 99;
      throw new Error('refused');
    }), /refused/);
    assert.equal(readJson(file).n, 2);
    assert.deepEqual(leftovers(dir), []);
  });

  test('a stale lock (left by a crash) is broken; a fresh one is waited for, then exit 1', () => {
    const dir = tempDir('hades-lock-');
    const file = `${dir}/state.json`;
    writeText(file, '{"n":0}\n');
    const age = (f, ms) => {
      const t = new Date(Date.now() - ms);
      fs.utimesSync(f, t, t);
    };
    // older than the stale limit
    fs.writeFileSync(`${file}.lock`, `999999 ${os.hostname()} 0 dead`);
    age(`${file}.lock`, 120000);
    assert.equal(withLock(file, () => 'ran'), 'ran');
    assert.deepEqual(leftovers(dir), []);
    // a breaker left by a crashed breaker does not block recovery for long
    fs.writeFileSync(`${file}.lock`, 'x');
    fs.writeFileSync(`${file}.lock.break`, 'x');
    age(`${file}.lock`, 120000);
    age(`${file}.lock.break`, 120000);
    assert.equal(withLock(file, () => 'ran again'), 'ran again');
    assert.ok(!fs.existsSync(`${file}.lock`) && !fs.existsSync(`${file}.lock.break`));
    // fresh (even if its owner is gone: a normal exit looks the same): wait, then give up
    fs.writeFileSync(`${file}.lock`, `999999 ${os.hostname()} ${Date.now()} other`);
    assert.throws(() => withLock(file, () => 'never', { waitMs: 300 }), (err) => err.exitCode === 1 && /timed out after 0s waiting for .*state\.json\.lock/.test(err.message));
    assert.ok(fs.existsSync(`${file}.lock`), 'a fresh lock is never removed by a waiter');
    // ... unless it gets older than the stale limit while waiting
    assert.equal(withLock(file, () => 'after stale', { staleMs: 200, waitMs: 5000 }), 'after stale');
  });

  test('the CLI waits for a held lock and proceeds once it is released', async () => {
    const v = makeVault({ teams: { portal: {} } });
    const { id, dir } = v.fakeTask('portal', 1);
    const lock = `${dir}/defects.json.lock`;
    writeFile(lock, `${process.pid} ${os.hostname()} ${Date.now()} held`);
    const pending = v.runAsync(['defect', 'add', id, '--title', 'x', '--severity', 'low', '--owner', 'tech-lead', '--source', 'review']);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(v.readJson(`${dir}/defects.json`).defects.length, 0, 'waits while the lock is held');
    fs.rmSync(lock);
    const r = await pending;
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'D1');
    assert.equal(path.basename(lock), 'defects.json.lock');
  });
});
