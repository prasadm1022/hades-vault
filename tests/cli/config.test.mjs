// Tests for the vault/workspace resolution helpers of lib/core/config.mjs (default <engine>/.vault,
// legacy <engine>/vault fallback, config paths relative to the engine). Temp folders only.
// Run: node --test tests/cli/config.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, cleanup, ENGINE, slash } from '../helpers/vault.mjs';
import { defaultVault, configPath, isInsideDir, VAULT_DIR, LEGACY_VAULT_DIR } from '../../lib/core/config.mjs';

after(cleanup);

describe('default vault', () => {
  test('is <engine>/.vault', () => {
    const e = tempDir('hades-cfg-engine-');
    assert.equal(VAULT_DIR, '.vault');
    assert.equal(defaultVault(e, {}), `${e}/.vault`);
    fs.mkdirSync(`${e}/.vault`);
    assert.equal(defaultVault(e, {}), `${e}/.vault`);
  });

  test('a legacy <engine>/vault with a registry is used while .vault does not exist', () => {
    const e = tempDir('hades-cfg-engine-');
    fs.mkdirSync(`${e}/${LEGACY_VAULT_DIR}`);
    assert.equal(defaultVault(e, {}), `${e}/.vault`, 'an empty legacy folder is not a vault');
    fs.writeFileSync(`${e}/vault/registry.json`, '{}');
    assert.equal(defaultVault(e, {}), `${e}/vault`);
    fs.mkdirSync(`${e}/.vault`);
    assert.equal(defaultVault(e, {}), `${e}/.vault`, '.vault wins once it exists');
  });

  test('HADES_DEFAULT_VAULT replaces the built-in default', () => {
    const e = tempDir('hades-cfg-engine-');
    const other = `${e}/elsewhere`;
    assert.equal(defaultVault(e, { HADES_DEFAULT_VAULT: other }), slash(path.resolve(other)));
  });
});

describe('config paths', () => {
  test('relative paths resolve against the engine, absolute paths stay', () => {
    assert.equal(configPath('.vault'), `${ENGINE}/.vault`);
    assert.equal(configPath('..'), slash(path.dirname(ENGINE)));
    const abs = slash(path.resolve('/x/vault'));
    assert.equal(configPath(abs), abs);
  });

  test('isInsideDir', () => {
    assert.ok(isInsideDir(`${ENGINE}/.vault`, ENGINE));
    assert.ok(isInsideDir(`${ENGINE}/.vault/registry.json`, `${ENGINE}/.vault`));
    assert.ok(isInsideDir(ENGINE, ENGINE));
    assert.ok(!isInsideDir(`${ENGINE}-x/.vault`, ENGINE), 'a sibling with the same prefix is outside');
    assert.ok(!isInsideDir(path.dirname(ENGINE), ENGINE));
  });
});
