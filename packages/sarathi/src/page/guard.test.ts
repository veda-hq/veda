import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after as afterAll, afterEach, describe } from 'node:test';

import { expect, it, vi } from '../test/expect.test.ts';
import {
  confirmedVersion,
  readVersion,
  toolCalls,
} from './protocol.ts';
import {
  claimOnce,
  decide,
  detail,
  envFrom,
  hook,
  isEntry,
  main,
  readInput,
  readText,
  transcriptEvents,
  writeErr,
  type GuardEnv,
} from './guard.ts';

const PAGE = 'https://claude.ai/artifact/Hb96Ljr3ABjFgVp4TWdUQQ';
const OTHER = 'https://claude.ai/artifact/Other';

/** Scratch directories for claim markers, all removed after the file runs. */
const scratchDirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-once-'));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A transcript line holding `blocks` as one message's content. */
const line = (blocks: unknown[]) =>
  JSON.stringify({ message: { content: blocks } });

const read = (id: string, url: string) =>
  line([
    { type: 'tool_use', id, name: 'Artifact', input: { action: 'read', url } },
  ]);

const result = (id: string, content: unknown, isError = false) =>
  line([{ type: 'tool_result', tool_use_id: id, is_error: isError, content }]);

const header = (version: string) =>
  `[Artifact x (version ${version}) — raw HTML follows]`;

/** The version a transcript's latest read of PAGE confirmed. */
const confirmed = (...lines: string[]) =>
  confirmedVersion(toolCalls(transcriptEvents(lines.join('\n'))), PAGE);

describe('the shared artifact protocol', () => {
  it('takes the latest read of the page, text or blocks', () => {
    expect(
      confirmed(
        read('a', PAGE),
        result('a', header('1')),
        'not json',
        '',
        JSON.stringify({ message: { content: 'plain text' } }),
        JSON.stringify({ message: null }),
        JSON.stringify({ other: true }),
        'null',
        read('b', PAGE),
        result('b', [
          { type: 'text', text: header('2') },
          { type: 'image' },
          'x',
        ]),
      ),
    ).toBe('2');
  });

  it('ignores other pages; a later failed or versionless read confirms nothing', () => {
    expect(
      confirmed(read('a', PAGE), result('a', header('1')), read('b', OTHER)),
    ).toBe('1');
    expect(
      confirmed(
        read('a', PAGE),
        result('a', header('1')),
        read('b', PAGE),
        result('b', header('1'), true),
      ),
    ).toBeUndefined();
    expect(
      confirmed(
        read('a', PAGE),
        result('a', header('1')),
        read('b', PAGE),
        result('b', 42),
      ),
    ).toBeUndefined();
    expect(
      confirmed(
        line([{ type: 'tool_use', id: 'e', name: 'Artifact', input: null }]),
        result('e', header('7')),
        result('unpaired', header('6')),
      ),
    ).toBeUndefined();
    expect(
      confirmed(
        read('a', PAGE),
        result('a', header('1')),
        line([
          {
            type: 'tool_use',
            id: 'p',
            name: 'Artifact',
            input: { action: 'publish', url: PAGE },
          },
        ]),
        result('p', `Updated ${PAGE}`),
      ),
    ).toBeUndefined();
    expect(readVersion('no header')).toBeUndefined();
    // Only the tool's opening header counts, never the page's own words.
    expect(readVersion('<p>see (version 9)</p>')).toBeUndefined();
    expect(readVersion(`note\n${header('9')}`)).toBeUndefined();
  });
});

describe('decide', () => {
  const update: GuardEnv = {
    mode: 'update',
    url: PAGE,
    version: '2',
    once: join(scratch(), 'published'),
  };
  const transcript = [read('a', PAGE), result('a', header('2'))].join('\n');

  it('lets reads and other tools through in any mode', () => {
    const never = () => {
      throw new Error('not read');
    };
    expect(
      decide({ tool_name: 'Read' }, { mode: 'read' }, never),
    ).toBeUndefined();
    expect(
      decide(
        { tool_name: 'Artifact', tool_input: { action: 'read' } },
        update,
        never,
      ),
    ).toBeUndefined();
  });

  it('refuses every Artifact call in a comments session', () => {
    expect(
      decide(
        { tool_name: 'Artifact', tool_input: { action: 'read' } },
        { mode: 'comments' },
        () => '',
      ),
    ).toBe('this session may only use comments; Artifact read refused');
    expect(
      decide(
        { tool_name: 'ArtifactComments', tool_input: { action: 'read' } },
        { mode: 'comments' },
        () => '',
      ),
    ).toBeUndefined();
  });

  it('refuses anything but a read in a read session', () => {
    expect(
      decide(
        { tool_name: 'Artifact', tool_input: null },
        { mode: 'read' },
        () => '',
      ),
    ).toBe('this session may only read; Artifact undefined refused');
  });

  it('publishes an update only to its own page', () => {
    const never = () => {
      throw new Error('not read');
    };
    expect(
      decide(
        {
          tool_name: 'Artifact',
          tool_input: { action: 'delete', url: PAGE },
          transcript_path: 't',
        },
        update,
        never,
      ),
    ).toBe('this session may only read and publish; Artifact delete refused');
    const to = (url?: string) => ({
      tool_name: 'Artifact',
      tool_input: { action: 'publish', url },
      transcript_path: 't',
    });
    expect(decide(to(OTHER), update, never)).toBe(
      `this session may only change ${PAGE}, not ${OTHER}; publish refused`,
    );
    expect(decide(to(), update, never)).toBe(
      `this session may only change ${PAGE}, not undefined; publish refused`,
    );
  });

  it('publishes an update only after its own read saw the version', () => {
    const publish = {
      tool_name: 'Artifact',
      tool_input: { action: 'publish', url: PAGE },
    };
    expect(
      decide({ ...publish, transcript_path: 't' }, update, () => transcript),
    ).toBeUndefined();
    expect(decide(publish, update, () => transcript)).toBe(
      'no transcript to confirm the live version; publish refused',
    );
    expect(
      decide(
        { ...publish, transcript_path: 't' },
        { ...update, version: '1' },
        () => transcript,
      ),
    ).toBe(`${PAGE} is at 2, not 1; publish refused`);
    expect(decide({ ...publish, transcript_path: 't' }, update, () => '')).toBe(
      `${PAGE} is at an unconfirmed version, not 2; publish refused`,
    );
  });

  it('allows one publish per session, however many reads come between', () => {
    const env: GuardEnv = {
      ...update,
      once: join(scratch(), 'published'),
    };
    const publish = {
      tool_name: 'Artifact',
      tool_input: { action: 'publish', url: PAGE },
      transcript_path: 't',
    };
    expect(decide(publish, env, () => transcript)).toBeUndefined();
    expect(decide(publish, env, () => transcript)).toBe(
      'this session has already published once; publish refused',
    );
    // Refused checks never use up the claim.
    const fresh: GuardEnv = {
      ...update,
      once: join(scratch(), 'published'),
    };
    expect(decide(publish, { ...fresh, version: '1' }, () => transcript)).toBe(
      `${PAGE} is at 2, not 1; publish refused`,
    );
    expect(decide(publish, fresh, () => transcript)).toBeUndefined();
  });
});

describe('detail', () => {
  it('prints errors and other values, and survives a value that throws', () => {
    expect(detail(new Error('boom'))).toBe('boom');
    expect(detail('plain')).toBe('plain');
    const hostile = {
      toString(): string {
        throw new Error('no');
      },
    };
    expect(detail(hostile)).toBe('an error that cannot be printed');
  });
});

describe('claimOnce', () => {
  it('succeeds once per path and refuses a path it cannot create', () => {
    const dir = scratch();
    expect(claimOnce(join(dir, 'p'))).toBe(true);
    expect(claimOnce(join(dir, 'p'))).toBe(false);
    expect(claimOnce(join(dir, 'missing', 'p'))).toBe(false);
  });
});

describe('envFrom', () => {
  it('reads the mode and refuses a partial update setup', () => {
    expect(envFrom({ PUBLISH_GUARD_MODE: 'read' })).toEqual({ mode: 'read' });
    expect(envFrom({ PUBLISH_GUARD_MODE: 'comments' })).toEqual({
      mode: 'comments',
    });
    expect(
      envFrom({
        PUBLISH_GUARD_MODE: 'update',
        PUBLISH_GUARD_URL: PAGE,
        PUBLISH_GUARD_VERSION: '3',
        PUBLISH_GUARD_ONCE: '/s/once',
      }),
    ).toEqual({ mode: 'update', url: PAGE, version: '3', once: '/s/once' });
    expect(() => envFrom({ PUBLISH_GUARD_MODE: 'update' })).toThrow(
      'guard misconfigured (mode update)',
    );
    expect(() => envFrom({})).toThrow('mode undefined');
  });
});

describe('as the hook runs it', () => {
  it('runs under plain node and blocks with exit 2', () => {
    const guard = fileURLToPath(
      new URL('./guard.ts', import.meta.url),
    );
    const run = (action: string) =>
      spawnSync(process.execPath, [guard], {
        input: JSON.stringify({
          tool_name: 'Artifact',
          tool_input: { action },
        }),
        env: { ...process.env, PUBLISH_GUARD_MODE: 'read' },
        encoding: 'utf8',
      });
    // The reason, if any, shows in the failure rather than a bare exit code.
    const allowed = run('read');
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(readText(guard)).toContain('PreToolUse');
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeErr('x');
    expect(write).toHaveBeenCalledWith('x');
    write.mockRestore();
    const refused = run('publish');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('may only read');
  });

  it('still blocks when started through a symlink, as from a pnpm install', () => {
    const guard = fileURLToPath(new URL('./guard.ts', import.meta.url));
    const link = join(scratch(), 'guard.ts');
    symlinkSync(guard, link);
    const refused = spawnSync(process.execPath, [link], {
      input: JSON.stringify({ tool_name: 'Artifact', tool_input: { action: 'publish' } }),
      env: { ...process.env, PUBLISH_GUARD_MODE: 'read' },
      encoding: 'utf8',
    });
    expect(refused.status, refused.stderr).toBe(2);
    expect(isEntry(link, new URL('./guard.ts', import.meta.url).href)).toBe(true);
    expect(isEntry(undefined, import.meta.url)).toBe(false);
    expect(isEntry('', import.meta.url)).toBe(false);
    expect(isEntry(guard, import.meta.url)).toBe(false);
  });
});

describe('readInput', () => {
  it('hands on the whole input at its end, and empty input on an error', async () => {
    const whole = await new Promise<string>(settle => {
      readInput(Readable.from(['{"a":', '1}']), settle);
    });
    expect(whole).toBe('{"a":1}');
    const failed = new PassThrough();
    const seen: string[] = [];
    readInput(failed, text => seen.push(text));
    failed.write('partial');
    failed.destroy(new Error('closed'));
    await new Promise(settle => setImmediate(settle));
    failed.emit('end');
    expect(seen).toEqual(['']);
  });

  it('sets the exit code from the verdict', () => {
    const before = process.exitCode;
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      hook('not json');
      expect(process.exitCode).toBe(2);
    } finally {
      write.mockRestore();
      process.exitCode = before;
    }
  });
});

describe('main', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 to allow, 2 with the reason to refuse, and 2 on any fault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
    dirs.push(dir);
    const log = join(dir, 'guard.log');
    const err = vi.fn<(text: string) => void>();
    const vars = { PUBLISH_GUARD_MODE: 'read', PUBLISH_GUARD_LOG: log };
    const call = (action: string) =>
      JSON.stringify({ tool_name: 'Artifact', tool_input: { action } });
    expect(main(call('read'), vars, () => '', err)).toBe(0);
    expect(main(call('publish'), vars, () => '', err)).toBe(2);
    expect(err).toHaveBeenLastCalledWith(
      'this session may only read; Artifact publish refused\n',
    );
    expect(main('{', vars, () => '', err)).toBe(2);
    expect(err.mock.lastCall?.[0]).toMatch(/^publish guard: /);
    expect(
      main(
        JSON.stringify({ tool_input: { action: 'publish' } }),
        vars,
        () => '',
        err,
      ),
    ).toBe(2);
    expect(err).toHaveBeenLastCalledWith(
      'publish guard: hook input names no tool\n',
    );
    expect(main(call('read'), {}, () => '', err)).toBe(2);
    const notAnError = (): string => {
      const thrown: unknown = 'plain';
      throw thrown;
    };
    const update = {
      PUBLISH_GUARD_MODE: 'update',
      PUBLISH_GUARD_URL: PAGE,
      PUBLISH_GUARD_VERSION: '1',
      PUBLISH_GUARD_ONCE: join(dir, 'once'),
    };
    expect(
      main(
        JSON.stringify({
          tool_name: 'Artifact',
          tool_input: { url: PAGE },
          transcript_path: 't',
        }),
        update,
        notAnError,
        err,
      ),
    ).toBe(2);
    expect(err).toHaveBeenLastCalledWith('publish guard: plain\n');
    expect(readFileSync(log, 'utf8').split('\n').slice(0, 2)).toEqual([
      'read: allowed',
      'publish: this session may only read; Artifact publish refused',
    ]);
    // An unwritable log (here a directory) still refuses with exit 2.
    const unwritable = { PUBLISH_GUARD_MODE: 'read', PUBLISH_GUARD_LOG: dir };
    expect(main(call('publish'), unwritable, () => '', err)).toBe(2);
    expect(err.mock.lastCall?.[0]).toMatch(/^publish guard: log not written/);
  });
});
