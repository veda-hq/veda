import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIG_ENV, CONFIG_FILE, configLocation, entryObject, entryText, loadProjectConfig, NO_CONFIG, parseProjectConfig } from './project-config.ts';

const KNOWN = ['absolute-paths', 'doc-budgets'];
const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const dir = (): string => {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-config-')));
  temps.push(made);
  return made;
};
after(() => {
  for (const made of temps) rmSync(made, { recursive: true, force: true });
});

describe('parseProjectConfig', () => {
  it('reads file and inline entries, a file entry resolved from the config file', () => {
    const config = parseProjectConfig(JSON.stringify({ $schema: 'x', checks: { 'absolute-paths': 'cfg/a.json', 'doc-budgets': { table: 't.md' } } }), '/repo/.pariksha.json', KNOWN, '9.9.9');
    assert.deepEqual(config.checks.get('absolute-paths'), { kind: 'file', path: '/repo/cfg/a.json', shown: 'cfg/a.json' });
    assert.deepEqual(config.checks.get('doc-budgets'), { kind: 'inline', value: { table: 't.md' } });
  });

  it('takes a file with no "checks" as no entries', () => {
    assert.equal(parseProjectConfig('{}', '/r/.pariksha.json', KNOWN, '1.0.0').checks.size, 0);
  });

  const refuses = (text: string, message: RegExp) => assert.throws(() => parseProjectConfig(text, '/r/.pariksha.json', KNOWN, '1.2.3'), message);

  it('refuses what it cannot read, naming the key and the version', () => {
    refuses('{', /\/r\/\.pariksha\.json \(pariksha 1\.2\.3\): not JSON/);
    refuses('[]', /must be a JSON object/);
    refuses('{"check": {}}', /unknown key "check"; this version reads "checks"/);
    refuses('{"checks": []}', /"checks" must be an object/);
    refuses('{"checks": {"boundary": {}}}', /pariksha 1\.2\.3\): unknown check "boundary" in "checks"; this version reads settings for absolute-paths, doc-budgets/);
    refuses('{"checks": {"absolute-paths": ""}}', /checks\.absolute-paths is an empty path/);
    refuses('{"checks": {"absolute-paths": 3}}', /checks\.absolute-paths must be a path/);
    refuses('{"checks": {"absolute-paths": null}}', /checks\.absolute-paths must be a path/);
  });
});

describe('configLocation', () => {
  it('is .pariksha.json at the git top level, from any folder under it', () => {
    const root = dir();
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'a/b'), { recursive: true });
    assert.deepEqual(configLocation(join(root, 'a/b'), {}), { path: join(root, CONFIG_FILE), named: false });
  });

  it('is the folder itself outside git, and the named file when PARIKSHA_CONFIG is set', () => {
    const outside = dir();
    assert.deepEqual(configLocation(outside, {}), { path: join(outside, CONFIG_FILE), named: false });
    assert.deepEqual(configLocation(outside, { [CONFIG_ENV]: 'x/p.json' }), { path: join(outside, 'x/p.json'), named: true });
    assert.deepEqual(configLocation(outside, { [CONFIG_ENV]: '' }), { path: join(outside, CONFIG_FILE), named: false });
  });
});

describe('loadProjectConfig', () => {
  it('is no settings when there is no file', () => {
    assert.equal(loadProjectConfig(dir(), {}, KNOWN, '1.0.0'), NO_CONFIG);
  });

  it('reads the file it finds', () => {
    const root = dir();
    writeFileSync(join(root, CONFIG_FILE), '{"checks": {"doc-budgets": {"table": "t.md"}}}');
    assert.equal(loadProjectConfig(root, {}, KNOWN, '1.0.0').file, join(root, CONFIG_FILE));
  });

  it('refuses a named file that is missing, and a file it cannot read', () => {
    const root = dir();
    assert.throws(() => loadProjectConfig(root, { [CONFIG_ENV]: 'gone.json' }, KNOWN, '1.0.0'), /cannot read .*gone\.json \(PARIKSHA_CONFIG\) \(pariksha 1\.0\.0\)/);
    mkdirSync(join(root, CONFIG_FILE));
    assert.throws(() => loadProjectConfig(root, {}, KNOWN, '1.0.0'), /cannot read .*\.pariksha\.json \(pariksha 1\.0\.0\)/);
  });
});

describe('entryText and entryObject', () => {
  it('give an inline entry as JSON text and as itself', () => {
    const entry = { kind: 'inline', value: { table: 't.md' } } as const;
    assert.equal(entryText(entry), '{"table":"t.md"}');
    assert.equal(entryObject(entry, 'doc-budgets', '1.0.0'), entry.value);
  });

  it('read a file entry, and refuse one that is not a JSON object', () => {
    const root = dir();
    writeFileSync(join(root, 'ok.json'), '{"table": "t.md"}');
    writeFileSync(join(root, 'list.json'), '[]');
    writeFileSync(join(root, 'bad.json'), '{');
    const at = (name: string) => ({ kind: 'file', path: join(root, name), shown: name }) as const;
    assert.equal(entryText(at('ok.json')), '{"table": "t.md"}');
    assert.deepEqual(entryObject(at('ok.json'), 'doc-budgets', '1.0.0'), { table: 't.md' });
    assert.throws(() => entryObject(at('list.json'), 'doc-budgets', '1.0.0'), /checks\.doc-budgets \(list\.json, pariksha 1\.0\.0\): must be a JSON object/);
    assert.throws(() => entryObject(at('bad.json'), 'doc-budgets', '1.0.0'), /checks\.doc-budgets \(bad\.json, pariksha 1\.0\.0\): /);
  });
});
