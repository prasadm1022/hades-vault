// Tests for lib/core/registry.mjs: validation, add organization/team, load/save.
// Run: node --test tests/cli/registry.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateRegistry,
  addOrganization,
  addTeam,
  loadRegistry,
  saveRegistry,
  parseAliases,
  findOrg,
  emptyRegistry,
} from '../../lib/core/registry.mjs';
import { tempDir, cleanup } from '../helpers/vault.mjs';

after(cleanup);

function sample() {
  return {
    version: 3,
    organizations: {
      acme: { org_dir: 'organizations/acme', root_path: 'C:/w/acme', description: 'Acme', aliases: ['acme-inc'], created: '2026-10-31' },
      globex: { org_dir: 'organizations/globex', root_path: '/home/me/globex', description: '', aliases: [], created: '2026-10-31' },
    },
    teams: {
      portal: { organization: 'acme', type: 'main', project_path: 'C:/w/acme/portal', team_dir: 'organizations/acme/teams/portal', description: '', aliases: ['acme-portal'], status: 'active', created: '2026-10-31' },
      shop: { organization: 'globex', type: 'sub', project_path: '/home/me/globex/shop', team_dir: 'organizations/globex/teams/shop', description: '', aliases: [], status: 'active', created: '2026-10-31' },
    },
  };
}

const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}; got:\n${problems.join('\n')}`);

describe('validateRegistry', () => {
  test('a valid registry has no problems', () => {
    assert.deepEqual(validateRegistry(sample()), []);
    assert.deepEqual(validateRegistry(emptyRegistry()), []);
  });

  test('version must be 3', () => {
    const r = sample();
    r.version = 2;
    has(validateRegistry(r), /version must be 3/);
    has(validateRegistry({ ...sample(), version: undefined }), /version/);
  });

  test('not an object', () => {
    has(validateRegistry(null), /object/);
    has(validateRegistry([]), /object/);
  });

  test('names must be kebab-case', () => {
    const r = sample();
    r.teams.Portal_X = { ...r.teams.portal, aliases: [] };
    r.organizations['Acme Co'] = { ...r.organizations.globex };
    const p = validateRegistry(r);
    has(p, /teams\.Portal_X: name must be kebab-case/);
    has(p, /organizations\.Acme Co: name must be kebab-case/);
  });

  test('team organization must exist', () => {
    const r = sample();
    r.teams.shop.organization = 'nope';
    has(validateRegistry(r), /teams\.shop\.organization: unknown organization "nope"/);
    delete r.teams.shop.organization;
    has(validateRegistry(r), /teams\.shop\.organization: missing/);
  });

  test('team type must be main or sub', () => {
    const r = sample();
    r.teams.shop.type = 'core';
    has(validateRegistry(r), /teams\.shop\.type/);
  });

  test('dirs are relative, inside the vault, with forward slashes', () => {
    const r = sample();
    r.teams.portal.team_dir = 'C:/vault/organizations/acme/teams/portal';
    r.teams.shop.team_dir = 'organizations\\globex\\teams\\shop';
    r.organizations.globex.org_dir = '../outside';
    r.organizations.acme.org_dir = '/abs/acme';
    const p = validateRegistry(r);
    has(p, /teams\.portal\.team_dir: must be relative/);
    has(p, /teams\.shop\.team_dir: use forward slashes/);
    has(p, /organizations\.globex\.org_dir: must stay inside the vault/);
    has(p, /organizations\.acme\.org_dir: must be relative/);
    delete r.teams.portal.team_dir;
    has(validateRegistry(r), /teams\.portal\.team_dir: missing/);
  });

  test('paths use forward slashes', () => {
    const r = sample();
    r.teams.portal.project_path = 'C:\\w\\acme\\portal';
    r.organizations.acme.root_path = 'C:\\w\\acme';
    const p = validateRegistry(r);
    has(p, /teams\.portal\.project_path: use forward slashes/);
    has(p, /organizations\.acme\.root_path: use forward slashes/);
  });

  test('aliases are unique across teams and organizations (case-insensitive)', () => {
    const r = sample();
    r.teams.shop.aliases = ['ACME-INC'];
    has(validateRegistry(r), /alias "acme-inc" is ambiguous: organization acme \(alias\), team shop \(alias\)/);
    const r2 = sample();
    r2.teams.shop.aliases = ['acme-portal'];
    has(validateRegistry(r2), /alias "acme-portal" is ambiguous/);
    const r3 = sample();
    r3.teams.shop.aliases = ['portal'];
    has(validateRegistry(r3), /alias "portal" is ambiguous: team portal, team shop \(alias\)/);
    const r4 = sample();
    r4.teams.portal.aliases = ['globex'];
    has(validateRegistry(r4), /alias "globex" is ambiguous/);
  });

  test("a team alias may equal its own organization's name, not another organization's", () => {
    const r = sample();
    const org = r.teams.portal.organization;
    r.teams.portal.aliases = [org.toUpperCase()];
    assert.ok(!validateRegistry(r).some((p) => /ambiguous/.test(p)), 'own organization name is allowed');
    const other = Object.keys(r.organizations).find((o) => o !== org);
    if (other) {
      const r2 = sample();
      r2.teams.portal.aliases = [other];
      has(validateRegistry(r2), new RegExp(`alias "${other}" is ambiguous`));
    }
  });

  test('a team may share its name with an organization; an alias may repeat its own name', () => {
    const r = sample();
    r.teams.acme = { ...r.teams.portal, aliases: ['acme', 'Acme'] };
    assert.deepEqual(validateRegistry(r), []);
  });

  test('aliases must be strings without spaces or commas', () => {
    const r = sample();
    r.teams.portal.aliases = ['gx,globex-inc'];
    has(validateRegistry(r), /invalid alias "gx,globex-inc"/);
    r.teams.portal.aliases = 'acme-portal';
    has(validateRegistry(r), /aliases: must be an array/);
  });
});

describe('addOrganization', () => {
  test('adds with defaults and normalised paths', () => {
    const r = emptyRegistry();
    const e = addOrganization(r, 'acme', { root_path: 'C:\\w\\acme\\', description: 'Acme', aliases: 'acme-inc, ACME-INC ,a2' });
    assert.equal(r.organizations.acme, e);
    assert.equal(e.org_dir, 'organizations/acme');
    assert.equal(e.root_path, 'C:/w/acme');
    assert.deepEqual(e.aliases, ['acme-inc', 'a2']);
    assert.match(e.created, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(validateRegistry(r), []);
  });

  test('refuses bad names, duplicates and alias collisions', () => {
    const r = sample();
    assert.throws(() => addOrganization(r, 'Bad Name', { root_path: '/x' }), /kebab-case/);
    assert.throws(() => addOrganization(r, 'acme', { root_path: '/x' }), /already exists/);
    assert.throws(() => addOrganization(r, 'initech', {}), /root path/);
    assert.throws(() => addOrganization(r, 'initech', { root_path: '/x', aliases: ['acme-portal'] }), /alias "acme-portal" is already used: alias of team portal/);
    assert.throws(() => addOrganization(r, 'initech', { root_path: '/x', aliases: ['portal'] }), /already used: team portal/);
    assert.throws(() => addOrganization(r, 'acme-inc', { root_path: '/x' }), /organization name "acme-inc" is already used: alias of organization acme/);
    assert.throws(() => addOrganization(r, 'initech', { root_path: '/x', aliases: ['has space'] }), /invalid alias/);
    assert.deepEqual(Object.keys(r.organizations), ['acme', 'globex'], 'nothing added on failure');
  });

  test('an organization may be named like an existing team', () => {
    const r = sample();
    addOrganization(r, 'portal', { root_path: '/x' });
    assert.ok(r.organizations.portal);
  });

  test('failure exit code is 1', () => {
    try {
      addOrganization(sample(), 'acme', { root_path: '/x' });
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.exitCode, 1);
    }
  });
});

describe('addTeam', () => {
  test('adds with team_dir under the org dir', () => {
    const r = sample();
    const e = addTeam(r, 'billing', { organization: 'acme', project_path: 'C:\\w\\acme\\billing', aliases: ['bill'] });
    assert.deepEqual(e, {
      organization: 'acme',
      type: 'main',
      project_path: 'C:/w/acme/billing',
      team_dir: 'organizations/acme/teams/billing',
      description: '',
      aliases: ['bill'],
      status: 'active',
      created: e.created,
    });
    assert.deepEqual(validateRegistry(r), []);
  });

  test('refuses duplicates by name or alias, unknown orgs and bad input', () => {
    const r = sample();
    assert.throws(() => addTeam(r, 'portal', { organization: 'acme', project_path: '/p' }), /team "portal" already exists/);
    assert.throws(() => addTeam(r, 'acme-portal', { organization: 'acme', project_path: '/p' }), /team name "acme-portal" is already used: alias of team portal/);
    assert.throws(() => addTeam(r, 'web', { organization: 'acme', project_path: '/p', aliases: ['acme-inc'] }), /alias "acme-inc" is already used: alias of organization acme/);
    assert.throws(() => addTeam(r, 'web', { organization: 'acme', project_path: '/p', aliases: ['shop'] }), /already used: team shop/);
    assert.throws(() => addTeam(r, 'web', { organization: 'nope', project_path: '/p' }), /unknown organization "nope"/);
    assert.throws(() => addTeam(r, 'web', { organization: 'acme', project_path: '/p', type: 'core' }), /main or sub/);
    assert.throws(() => addTeam(r, 'web', { organization: 'acme' }), /project path/);
    assert.throws(() => addTeam(r, 'Web', { organization: 'acme', project_path: '/p' }), /kebab-case/);
    assert.deepEqual(Object.keys(r.teams), ['portal', 'shop'], 'nothing added on failure');
  });

  test('a team may be named like its organization', () => {
    const r = sample();
    addTeam(r, 'acme', { organization: 'acme', project_path: '/p', type: 'sub' });
    assert.equal(r.teams.acme.type, 'sub');
    assert.deepEqual(validateRegistry(r), []);
  });
});

describe('helpers', () => {
  test('parseAliases', () => {
    assert.deepEqual(parseAliases(undefined), []);
    assert.deepEqual(parseAliases(true), []);
    assert.deepEqual(parseAliases('a, b,,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseAliases(['a,b', 'B', ' c ']), ['a', 'b', 'c']);
  });

  test('findOrg by name or alias, case-insensitive', () => {
    const r = sample();
    assert.equal(findOrg(r, 'ACME').name, 'acme');
    assert.equal(findOrg(r, 'Acme-Inc').name, 'acme');
    assert.equal(findOrg(r, 'portal'), null);
    assert.equal(findOrg(r, ''), null);
  });
});

describe('loadRegistry / saveRegistry', () => {
  test('round trip keeps version 3 first, writes atomically and updates ctx', () => {
    const vault = tempDir('hades-reg-');
    const ctx = { vault };
    fs.writeFileSync(`${vault}/registry.json`, JSON.stringify({ organizations: {}, teams: {}, version: 3, extra: 1 }));
    const reg = loadRegistry(ctx);
    addOrganization(reg, 'acme', { root_path: '/w/acme' });
    reg.version = 2; // ignored: always written as 3
    saveRegistry(ctx, reg);
    const text = fs.readFileSync(`${vault}/registry.json`, 'utf8');
    assert.match(text, /^\{\n {2}"version": 3,/);
    assert.ok(text.endsWith('}\n'));
    const back = JSON.parse(text);
    assert.equal(back.extra, 1, 'unknown keys kept');
    assert.ok(back.organizations.acme);
    assert.equal(ctx.registry.organizations.acme.root_path, '/w/acme');
    assert.deepEqual(fs.readdirSync(vault), ['registry.json'], 'no temp file left');
  });

  test('loadRegistry fills missing maps and fails without a registry', () => {
    const vault = tempDir('hades-reg-');
    fs.writeFileSync(`${vault}/registry.json`, '{"version":3}');
    const reg = loadRegistry({ vault });
    assert.deepEqual(reg.organizations, {});
    assert.deepEqual(reg.teams, {});
    assert.throws(() => loadRegistry({ vault: `${vault}/missing` }), /hades init/);
    assert.throws(() => loadRegistry({ vault, registryFile: `${vault}/nope.json` }), /no registry/);
  });
});
