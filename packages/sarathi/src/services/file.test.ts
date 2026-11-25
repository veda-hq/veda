import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { expect } from '../test/expect.test.ts';
import { expand, loadServicesFile, parseServicesFile, placeholders, servicesPath, ServicesError } from './file.ts';
import { sample, sampleRaw } from './sample.test.ts';

const parse = (change: (raw: Record<string, unknown>) => void): unknown => {
  const raw = sampleRaw();
  change(raw);
  return () => parseServicesFile(raw, 'services.json');
};

describe('the services file', () => {
  test('a whole file reads as written, with defaults for what it leaves out', () => {
    const file = sample();
    expect(file).toMatchObject({
      path: '/project/services.json',
      compose: 'compose.yaml',
      project: 'acme-wt',
      apiPorts: [20000, 29999],
      webPort: 5173,
      published: { postgres: { service: 'postgres', port: 5432 }, redis: { service: 'redis', port: 6379 } },
      web: { environment: ['API_URL'] },
    });
    expect(file.server?.before).toHaveLength(2);
    expect(file.actions['database-init']).toEqual({ mainCheckoutOnly: false, run: expect.any(Array) });
    expect(file.actions['database-snapshot']?.mainCheckoutOnly).toBe(true);
    const bare = parseServicesFile({ compose: 'c.yaml', project: 'p', rootLabel: 'l', apiPorts: [1000, 1000], webPort: 999 }, 'f');
    expect(bare).toEqual({ path: 'f', compose: 'c.yaml', project: 'p', rootLabel: 'l', apiPorts: [1000, 1000], webPort: 999, published: {}, environment: {}, actions: {} });
    const plain = parseServicesFile({ ...sampleRaw(), server: { command: ['serve'] }, web: { command: ['web'] } }, 'f');
    expect(plain.server).toEqual({ before: [], command: ['serve'] });
    expect(plain.web).toEqual({ command: ['web'], environment: [] });
  });

  test('every key is checked and an unknown one refused', () => {
    const cases: Array<[(raw: Record<string, unknown>) => void, string]> = [
      [raw => (raw.extra = 1), 'unknown key "extra"'],
      [raw => (raw.compose = '/abs/compose.yaml'), '"compose" must be a path'],
      [raw => (raw.compose = ''), '"compose" must be a path'],
      [raw => (raw.compose = '../other/compose.yaml'), '"compose" must be a path'],
      [raw => (raw.compose = 'infra/../../compose.yaml'), '"compose" must be a path'],
      [raw => (raw.project = 'Acme'), '"project" must be lowercase'],
      [raw => (raw.rootLabel = '-x'), '"rootLabel" must be a Docker label key'],
      [raw => (raw.apiPorts = [2, 1]), '"apiPorts" must be [first, last]'],
      [raw => (raw.apiPorts = [1]), '"apiPorts" must be [first, last]'],
      [raw => (raw.apiPorts = [0, 1]), '"apiPorts" must be [first, last]'],
      [raw => (raw.apiPorts = 'x'), '"apiPorts" must be [first, last]'],
      [raw => (raw.webPort = 70000), '"webPort" must be a port'],
      [raw => (raw.webPort = 20001), '"webPort" must lie outside "apiPorts"'],
      [raw => (raw.published = []), '"published" must be an object'],
      [raw => (raw.published = { password: ['postgres', 5432] }), '"password" must be letters'],
      [raw => (raw.published = { 'a-b': ['postgres', 5432] }), '"a-b" must be letters'],
      [raw => (raw.published = { db: ['postgres'] }), '"published.db" must be [service, container port]'],
      [raw => (raw.published = { db: ['-x', 5432] }), '"published.db" must be [service, container port]'],
      [raw => (raw.published = { db: ['postgres', 0] }), '"published.db" must be [service, container port]'],
      [raw => (raw.environment = []), '"environment" must be an object'],
      [raw => (raw.environment = { 'A-B': 'x' }), '"environment.A-B" must be a variable name'],
      [raw => (raw.environment = { A: 1 }), '"environment.A" must be a variable name'],
      [raw => (raw.environment = { A: '{nope}' }), '"environment.A": unknown placeholder {nope}'],
      [raw => (raw.environment = { A: '{container:}' }), 'unknown placeholder {container:}'],
      [raw => (raw.web = 'vite'), '"web" must be an object'],
      [raw => (raw.web = { command: ['vite'], port: 1 }), 'web: unknown key "port"'],
      [raw => (raw.web = { command: [] }), '"web.command" must be a command'],
      [raw => (raw.web = { command: [''] }), '"web.command" must be a command'],
      [raw => (raw.web = { command: ['vite', 3] }), '"web.command" must be a command'],
      [raw => (raw.web = { command: ['vite', '{postgres}'] }), '"web.command"[1]: unknown placeholder {postgres}'],
      [raw => (raw.web = { command: ['vite'], environment: 'API_URL' }), '"web.environment" must be an array'],
      [raw => (raw.web = { command: ['vite'], environment: ['MISSING'] }), '"MISSING" is not in "environment"'],
      // Object built-ins are not environment keys the file defined.
      [raw => (raw.web = { command: ['vite'], environment: ['toString'] }), '"toString" is not in "environment"'],
      [raw => { delete raw.environment; raw.web = { command: ['vite'], environment: ['constructor'] }; }, '"constructor" is not in "environment"'],
      [raw => (raw.web = { command: ['vite'], environment: ['DATABASE_URL'] }), '"DATABASE_URL" needs the published port postgres'],
      [raw => (raw.server = []), '"server" must be an object'],
      [raw => (raw.server = { command: ['x'], after: [] }), 'server: unknown key "after"'],
      [raw => (raw.server = { command: ['x'], before: 'x' }), '"server.before" must be an array of commands'],
      [raw => (raw.server = { before: [] }), '"server.command" must be a command'],
      // A command reads a published port from `environment`, never as a placeholder.
      [raw => (raw.server = { before: [['wait-for', '{postgres}']], command: ['x'] }), '"server.before"[0][1]: unknown placeholder {postgres}'],
      [raw => (raw.server = { command: ['x', '{redis}'] }), '"server.command"[1]: unknown placeholder {redis}'],
      [raw => (raw.actions = { init: [['x', '{postgres}']] }), '"actions.init"[0][1]: unknown placeholder {postgres}'],
      [raw => (raw.actions = []), '"actions" must be an object'],
      [raw => (raw.actions = { up: [['x']] }), '"up" must be lowercase letters'],
      [raw => (raw.actions = { Init: [['x']] }), '"Init" must be lowercase letters'],
      [raw => (raw.actions = { init: 'x' }), '"actions.init" must be an array of commands or'],
      [raw => (raw.actions = { init: { run: [['x']], when: 1 } }), 'actions.init: unknown key "when"'],
      [raw => (raw.actions = { init: { run: [['x']], mainCheckoutOnly: 'yes' } }), '"actions.init.mainCheckoutOnly" must be true or false'],
      [raw => (raw.actions = { init: { run: [['{x}']] } }), '"actions.init.run"[0][0]: unknown placeholder {x}'],
      [raw => (raw.actions = { init: [['x', '{y}']] }), '"actions.init"[0][1]: unknown placeholder {y}'],
      // Shapes that only look right: a number, a missing key, an array-like object, one item too many.
      [raw => (raw.compose = 5), '"compose" must be a path'],
      [raw => delete raw.project, '"project" must be lowercase'],
      [raw => delete raw.rootLabel, '"rootLabel" must be a Docker label key'],
      [raw => (raw.apiPorts = { 0: 20000, 1: 29999, length: 2 }), '"apiPorts" must be [first, last]'],
      [raw => (raw.apiPorts = [20000, 29999, 30000]), '"apiPorts" must be [first, last]'],
      [raw => (raw.published = { db: { 0: 'postgres', 1: 5432, length: 2 } }), '"published.db" must be [service, container port]'],
      [raw => (raw.published = { db: ['postgres', 5432, 5433] }), '"published.db" must be [service, container port]'],
      [raw => (raw.published = { db: [5, 5432] }), '"published.db" must be [service, container port]'],
      [raw => (raw.web = { command: ['vite'], environment: ['API_URL', 1] }), '"web.environment" must be an array of environment keys'],
      [raw => (raw.environment = { A: '{container-postgres}' }), '"environment.A": unknown placeholder {container-postgres}'],
      // A name is refused for anything after what its pattern allows.
      [raw => (raw.project = 'acme-wt!'), '"project" must be lowercase'],
      [raw => (raw.rootLabel = 'acme.root!'), '"rootLabel" must be a Docker label key'],
      [raw => (raw.published = { db: ['postgres!', 5432] }), '"published.db" must be [service, container port]'],
      [raw => (raw.environment = { A: '{container:postgres!}' }), '"environment.A": unknown placeholder {container:postgres!}'],
      [raw => (raw.actions = { 'init!': [['x']] }), '"init!" must be lowercase letters'],
      // A port is a whole number from 1 to 65535, and the web port lies outside both ends of the band.
      [raw => (raw.webPort = 65536), '"webPort" must be a port'],
      [raw => (raw.webPort = 5173.5), '"webPort" must be a port'],
      [raw => (raw.webPort = '5173'), '"webPort" must be a port'],
      [raw => (raw.published = { db: ['postgres', '5432'] }), '"published.db" must be [service, container port]'],
      [raw => (raw.webPort = 20000), '"webPort" must lie outside "apiPorts"'],
      [raw => (raw.webPort = 29999), '"webPort" must lie outside "apiPorts"'],
    ];
    for (const [change, message] of cases) {
      expect(parse(change)).toThrow(message);
      expect(parse(change)).toThrow(ServicesError);
    }
    expect(() => parseServicesFile([], 'f')).toThrow('f must hold a JSON object');
    expect(() => parseServicesFile(null, 'f')).toThrow('f must hold a JSON object');
  });

  test('a refusal names every key, name or port it is about', () => {
    const refusal = (change: (raw: Record<string, unknown>) => void): string => {
      const raw = sampleRaw();
      change(raw);
      try {
        parseServicesFile(raw, 'services.json');
      } catch (error) {
        expect(String(error)).toBe(`ServicesError: ${(error as Error).message}`);
        return (error as Error).message;
      }
      throw new Error('the file was accepted');
    };
    expect(refusal(raw => Object.assign(raw, { extra: 1, more: 2 }))).toBe('services.json: unknown key "extra", "more"');
    expect(refusal(raw => (raw.published = { project: ['postgres', 5432] }))).toBe(
      'services.json "published": "project" must be letters, digits and _, and not password, serverPort, webPort, project',
    );
    expect(
      refusal(raw => {
        raw.environment = { BOTH: '{postgres}/{redis}' };
        raw.web = { command: ['vite'], environment: ['BOTH'] };
      }),
    ).toBe('services.json "web.environment": "BOTH" needs the published port postgres, redis, and web starts no containers');
    expect(refusal(raw => (raw.actions = { up: [['x']] }))).toBe(
      'services.json "actions": "up" must be lowercase letters, digits and dashes, and not up, down, status, run, web, server, reap, prune',
    );
  });

  test('ports and names at the edge of what is allowed are accepted', () => {
    for (const webPort of [19999, 30000, 65535]) expect(parseServicesFile({ ...sampleRaw(), webPort }, 'f').webPort).toBe(webPort);
    const file = parseServicesFile(
      {
        ...sampleRaw(),
        published: { db: ['postgres', 65535] },
        environment: { PROJECT: '{project}' },
        web: { command: ['vite', '{project}'] },
        actions: { init: { run: [['x']] } },
      },
      'f',
    );
    expect(file.published).toEqual({ db: { service: 'postgres', port: 65535 } });
    expect(file.environment).toEqual({ PROJECT: '{project}' });
    expect(file.actions.init).toEqual({ mainCheckoutOnly: false, run: [['x']] });
    // A file without web or server has no such key, not one set to undefined.
    const bare = parseServicesFile({ compose: 'c.yaml', project: 'p', rootLabel: 'l', apiPorts: [1000, 1000], webPort: 999 }, 'f');
    expect(bare).not.toHaveProperty('web');
    expect(bare).not.toHaveProperty('server');
  });

  test('placeholders are filled, the password URL-encoded only where asked', () => {
    expect(placeholders('a{b}c{container:d}')).toEqual(['b', 'container:d']);
    const values = { password: 'p@ss', serverPort: 21000, webPort: 5173, project: 'acme-wt-0123456789abcdef', published: { postgres: 41001 } };
    expect(expand('{password}|{serverPort}|{webPort}|{project}|{postgres}|{container:postgres}', values, true)).toBe(
      'p%40ss|21000|5173|acme-wt-0123456789abcdef|41001|acme-wt-0123456789abcdef-postgres-1',
    );
    expect(expand('{password}', values, false)).toBe('p@ss');
    expect(() => expand('{redis}', values, true)).toThrow('{redis} has no value before the services run');
  });

  test('a package path is found under SARATHI_PACKAGES, else the root node_modules', () => {
    expect(servicesPath('@acme/rules/services.json', '/root', {})).toBe('/root/node_modules/@acme/rules/services.json');
    expect(servicesPath('@acme/rules/services.json', '/root', { SARATHI_PACKAGES: '' })).toBe('/root/node_modules/@acme/rules/services.json');
    expect(servicesPath('@acme/rules/services.json', '/root', { SARATHI_PACKAGES: '/pkgs' })).toBe('/pkgs/@acme/rules/services.json');
    expect(servicesPath('tools/services.json', '/root', { SARATHI_PACKAGES: '/pkgs' })).toBe('/root/tools/services.json');
    expect(servicesPath('/etc/services.json', '/root', {})).toBe('/etc/services.json');
  });

  test('a file that cannot be read or is not JSON is named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sarathi-services-file-'));
    try {
      expect(() => loadServicesFile(join(dir, 'missing.json'))).toThrow(`cannot read the services file ${join(dir, 'missing.json')}`);
      writeFileSync(join(dir, 'bad.json'), '{');
      expect(() => loadServicesFile(join(dir, 'bad.json'))).toThrow('bad.json is not JSON');
      writeFileSync(join(dir, 'good.json'), JSON.stringify(sampleRaw()));
      expect(loadServicesFile(join(dir, 'good.json')).project).toBe('acme-wt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
