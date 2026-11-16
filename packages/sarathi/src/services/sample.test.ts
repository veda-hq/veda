// A services file shaped like a real project's, for the services tests. No
// tests of its own: a `.test.ts` name keeps it out of the build and the
// coverage figures.
import { parseServicesFile, type ServicesFile } from './file.ts';

export const PREFIX = 'acme-wt';
export const LABEL = 'acme.worktree-services.root';

/** The raw file: Postgres and Redis published, a web and a server command, two actions. */
export function sampleRaw(webPort = 5173): Record<string, unknown> {
  return {
    compose: 'compose.yaml',
    project: PREFIX,
    rootLabel: LABEL,
    apiPorts: [20000, 29999],
    webPort,
    published: { postgres: ['postgres', 5432], redis: ['redis', 6379] },
    environment: {
      DATABASE_URL: 'postgresql://acme_user:{password}@127.0.0.1:{postgres}/acme_dev?schema=public',
      REDIS_URL: 'redis://:{password}@127.0.0.1:{redis}',
      PORT: '{serverPort}',
      API_URL: 'http://localhost:{serverPort}',
      ALLOWED_ORIGINS: 'http://localhost:{webPort},http://127.0.0.1:{webPort}',
    },
    web: { command: ['pnpm', 'web', 'vite', '--port', '{webPort}', '--strictPort'], environment: ['API_URL'] },
    server: {
      before: [
        ['pnpm', 'init', 'database', '{container:postgres}'],
        ['pnpm', 'migrate', 'deploy'],
      ],
      command: ['pnpm', 'serve', 'start', '--watch'],
    },
    actions: {
      'database-init': [
        ['pnpm', 'init', 'database', '{container:postgres}', '--force'],
        ['pnpm', 'migrate', 'deploy'],
      ],
      'database-snapshot': { mainCheckoutOnly: true, run: [['pnpm', 'snapshot', 'database', '{container:postgres}']] },
    },
  };
}

export function sample(webPort = 5173): ServicesFile {
  return parseServicesFile(sampleRaw(webPort), '/project/services.json');
}
