import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MARKERS, PUBLISH_TOOL, decide, hook, main, markersRemoved, occurrences, readText, servedPath, start } from './action-box.ts';

const HOOK = fileURLToPath(new URL('./action-box.ts', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'action-box-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A page whose action box is whole. */
const WHOLE =
  '<title>T</title><div data-action-box><a data-action-link href="https://github.com/x/y/issues/1">Open #1</a><p data-if-silent>Nothing ships.</p></div><h2>Detail</h2>';
/** A page with no action box at all. */
const BARE = '<title>T</title><h2>Detail</h2><p>Text.</p>';
const BARE_GAPS =
  'has no complete action box before its first <h2>; add an element marked data-action-box; inside it, a link marked data-action-link, with an https href to where the reader acts; inside it, an element marked data-if-silent saying what happens if the reader does nothing. A page with nothing to do still says so in its box.';

const SERVER = 'mcp__claude-artifacts__';
const noRead = (path: string): string => assert.fail(`read ${path}`);

function page(name: string, html: string): string {
  const path = join(DIR, name);
  writeFileSync(path, html);
  return path;
}

describe('PUBLISH_TOOL', () => {
  test('matches the three publishing tools of any server, by suffix', () => {
    for (const tool of ['publish_version', 'publish_files', 'edit_version']) {
      assert.equal(PUBLISH_TOOL.exec(`mcp__claude-artifacts__${tool}`)?.[1], tool);
      assert.equal(PUBLISH_TOOL.exec(`mcp__0f3a-b2__${tool}`)?.[1], tool);
    }
  });

  test('matches nothing else', () => {
    for (const name of [
      'publish_version',
      'mcp____publish_version',
      'mcp__claude-artifacts__publish_versions',
      'mcp__claude-artifacts__read_artifact',
      'xmcp__claude-artifacts__edit_version',
      'Artifact',
    ]) {
      assert.equal(PUBLISH_TOOL.test(name), false, name);
    }
  });
});

describe('servedPath', () => {
  test('drops a leading ./ or /, however repeated', () => {
    assert.equal(servedPath('index.html'), 'index.html');
    assert.equal(servedPath('./index.html'), 'index.html');
    assert.equal(servedPath('/index.html'), 'index.html');
    assert.equal(servedPath('.//./index.html'), 'index.html');
  });

  test('keeps a folder, and a dot inside the path', () => {
    assert.equal(servedPath('css/index.html'), 'css/index.html');
    assert.equal(servedPath('a/./index.html'), 'a/./index.html');
    assert.equal(servedPath('..index.html'), '..index.html');
  });
});

test('occurrences counts each place a marker stands', () => {
  assert.equal(occurrences('', 'data-if-silent'), 0);
  assert.equal(occurrences('<p data-if-silent>', 'data-if-silent'), 1);
  assert.equal(occurrences('data-if-silent data-if-silent', 'data-if-silent'), 2);
});

test('MARKERS are the three attributes an action box is made of', () => {
  assert.deepEqual(MARKERS, ['data-action-box', 'data-action-link', 'data-if-silent']);
});

describe('markersRemoved', () => {
  test('names each marker that occurs fewer times in all the new texts than in all the old', () => {
    const edits = [
      { old_text: '<div data-action-box>', new_text: '<div>' },
      { old_text: '<p data-if-silent>x</p>', new_text: '<p>x</p>' },
    ];
    assert.deepEqual(markersRemoved({ edits }), ['data-action-box', 'data-if-silent']);
  });

  test('passes a marker moved from one edit to another, or one kept or added', () => {
    const edits = [
      { old_text: '<a data-action-link href="https://a">', new_text: '<a href="https://a">' },
      { old_text: '<b>', new_text: '<a data-action-link href="https://b">' },
      { old_text: '<p data-if-silent>x</p>', new_text: '<p data-if-silent>y</p>' },
      { old_text: '<h1>', new_text: '<div data-action-box>' },
    ];
    assert.deepEqual(markersRemoved({ edits }), []);
  });

  test('counts across edits, not per edit: two taken out and one put back is one gone', () => {
    const edits = [
      { old_text: 'data-if-silent data-if-silent', new_text: '' },
      { old_text: '', new_text: 'data-if-silent' },
    ];
    assert.deepEqual(markersRemoved({ edits }), ['data-if-silent']);
  });

  test('does not join two edits into a marker neither holds', () => {
    const edits = [
      { old_text: 'data-if-', new_text: 'data-if-' },
      { old_text: 'silent', new_text: 'silent' },
      { old_text: 'data-if-silent', new_text: 'data-if-' },
      { old_text: 'x', new_text: 'silent' },
    ];
    assert.deepEqual(markersRemoved({ edits }), ['data-if-silent']);
  });

  test('refuses edits it cannot read', () => {
    assert.throws(() => markersRemoved({}), { message: 'edit_version names no edits' });
    assert.throws(() => markersRemoved({ edits: 'x' }), { message: 'edit_version names no edits' });
    for (const edit of [null, 'x', [], { old_text: 'a' }, { new_text: 'a' }, { old_text: 1, new_text: 'a' }, { old_text: 'a', new_text: 1 }]) {
      assert.throws(() => markersRemoved({ edits: [edit] }), { message: 'edit_version has an edit without old_text and new_text' }, JSON.stringify(edit));
    }
  });
});

describe('decide', () => {
  test('lets every other tool through, unread', () => {
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, noRead), undefined);
    assert.equal(decide({ tool_name: `${SERVER}read_artifact` }, noRead), undefined);
  });

  test('refuses input that names no tool, or a publish with no input', () => {
    assert.throws(() => decide({}, noRead), { message: 'hook input names no tool' });
    assert.throws(() => decide({ tool_name: 7 }, noRead), { message: 'hook input names no tool' });
    for (const tool_input of [undefined, null, 'x', []]) {
      assert.throws(() => decide({ tool_name: `${SERVER}publish_version`, tool_input }, noRead), { message: 'publish_version has no input' });
    }
  });

  describe('publish_version', () => {
    const tool_name = `${SERVER}publish_version`;

    test('passes a page whose action box is whole', () => {
      assert.equal(decide({ tool_name, tool_input: { content: WHOLE } }, noRead), undefined);
    });

    test('refuses a page without one, saying what is missing', () => {
      assert.equal(decide({ tool_name, tool_input: { content: BARE } }, noRead), `the page publish_version sends ${BARE_GAPS}`);
    });

    test('refuses a call that sends no content', () => {
      assert.equal(decide({ tool_name, tool_input: { slug: 's' } }, noRead), 'publish_version sends no content');
      assert.equal(decide({ tool_name, tool_input: { content: 1 } }, noRead), 'publish_version sends no content');
    });
  });

  describe('publish_files', () => {
    const tool_name = `${SERVER}publish_files`;

    test('judges each file served as index.html, read from its path', () => {
      const good = page('good.html', WHOLE);
      assert.equal(decide({ tool_name, tool_input: { files: [{ as: 'index.html', path: good }] } }, readText), undefined);
      const bad = page('bad.html', BARE);
      assert.equal(decide({ tool_name, tool_input: { files: [{ as: './index.html', path: bad }] } }, readText), `${bad} ${BARE_GAPS}`);
      assert.equal(
        decide({ tool_name, tool_input: { files: [{ as: 'index.html', path: good }, { as: '/index.html', path: bad }] } }, readText),
        `${bad} ${BARE_GAPS}`,
      );
    });

    test('passes a republish that sends no index.html, reading nothing', () => {
      const files = [{ as: 'css/site.css', path: '/x/site.css' }, { as: 'docs/index.html', path: '/x/i.html' }, { path: '/x/y' }, null, 'index.html'];
      assert.equal(decide({ tool_name, tool_input: { files } }, noRead), undefined);
      assert.equal(decide({ tool_name, tool_input: { files: [] } }, noRead), undefined);
    });

    test('refuses an index.html it cannot read', () => {
      for (const file of [{ as: 'index.html' }, { as: 'index.html', path: '' }, { as: 'index.html', path: 3 }, { as: 'index.html', uri: 'file:///x' }]) {
        assert.equal(decide({ tool_name, tool_input: { files: [file] } }, noRead), 'publish_files serves index.html with no path to read it from', JSON.stringify(file));
      }
      const missing = join(DIR, 'missing.html');
      assert.match(String(decide({ tool_name, tool_input: { files: [{ as: 'index.html', path: missing }] } }, readText)), /^ENOENT: no such file or directory/);
    });

    test('refuses a call with no files list', () => {
      assert.equal(decide({ tool_name, tool_input: {} }, noRead), 'publish_files names no files list');
      assert.equal(decide({ tool_name, tool_input: { files: {} } }, noRead), 'publish_files names no files list');
    });
  });

  describe('edit_version', () => {
    const tool_name = `${SERVER}edit_version`;
    const removing = [{ old_text: '<p data-if-silent>x</p>', new_text: '<p>x</p>' }];

    test('refuses an edit to the page that takes a marker out', () => {
      const why =
        'this edit_version takes data-if-silent out of the page; an action box keeps all of data-action-box, data-action-link, data-if-silent before the page\'s first <h2>';
      assert.equal(decide({ tool_name, tool_input: { edits: removing } }, noRead), why);
      assert.equal(decide({ tool_name, tool_input: { edits: removing, path: 'index.html' } }, noRead), why);
      assert.equal(decide({ tool_name, tool_input: { edits: removing, path: './index.html' } }, noRead), why);
    });

    test('passes an edit that keeps every marker', () => {
      const edits = [{ old_text: '<p data-if-silent>x</p>', new_text: '<p data-if-silent>y</p>' }];
      assert.equal(decide({ tool_name, tool_input: { edits } }, noRead), undefined);
    });

    test('passes an edit to another file of the artifact', () => {
      assert.equal(decide({ tool_name, tool_input: { edits: removing, path: 'notes.html' } }, noRead), undefined);
      assert.equal(decide({ tool_name, tool_input: { edits: 'not judged', path: 'css/site.css' } }, noRead), undefined);
    });

    test('refuses edits it cannot read', () => {
      assert.equal(decide({ tool_name, tool_input: { edits: [{}] } }, noRead), 'edit_version has an edit without old_text and new_text');
      assert.equal(decide({ tool_name, tool_input: { path: 1 } }, noRead), 'edit_version names no edits');
    });
  });
});

describe('main', () => {
  function run(stdin: string, read: (path: string) => string = noRead): { code: number; err: string } {
    let err = '';
    const code = main(stdin, read, text => (err += text));
    return { code, err };
  }

  test('exit 0, silent, for a call it lets through', () => {
    assert.deepEqual(run(JSON.stringify({ tool_name: 'Read', tool_input: {} })), { code: 0, err: '' });
    assert.deepEqual(run(JSON.stringify({ tool_name: `${SERVER}publish_version`, tool_input: { content: WHOLE } })), { code: 0, err: '' });
  });

  test('exit 2 with the reason for a refusal', () => {
    assert.deepEqual(run(JSON.stringify({ tool_name: `${SERVER}publish_version`, tool_input: { content: BARE } })), {
      code: 2,
      err: `sarathi action box: the page publish_version sends ${BARE_GAPS}\n`,
    });
  });

  test('exit 2 for a fault, saying the call is refused', () => {
    assert.deepEqual(run(JSON.stringify({})), { code: 2, err: 'sarathi action box: hook input names no tool; the call is refused\n' });
    const { code, err } = run('not json');
    assert.equal(code, 2);
    assert.match(err, /^sarathi action box: .*JSON.*; the call is refused\n$/);
  });
});

describe('the hook as Claude Code runs it', () => {
  function runHook(input: unknown): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }

  test('refuses a page without an action box, exit 2', () => {
    const result = runHook({ tool_name: `${SERVER}publish_version`, tool_input: { content: BARE } });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, `sarathi action box: the page publish_version sends ${BARE_GAPS}\n`);
  });

  test('passes a whole one, exit 0', () => {
    assert.deepEqual(runHook({ tool_name: `${SERVER}publish_version`, tool_input: { content: WHOLE } }), { status: 0, stderr: '' });
  });

  test('the shell wrapper runs the built handler', () => {
    const script = fileURLToPath(new URL('../../hooks/action-box.sh', import.meta.url));
    const text = readText(script);
    assert.match(text, /exec node "\$\{BASH_SOURCE\[0\]%\/\*\}\/\.\.\/dist\/hooks\/action-box\.js"\n$/);
  });
});

describe('start and hook', () => {
  test('imported, start reads nothing', () => {
    let ran = false;
    start(fileURLToPath(import.meta.url), pathToFileURL(HOOK).href, new PassThrough(), () => (ran = true));
    start(undefined, pathToFileURL(HOOK).href, new PassThrough(), () => (ran = true));
    assert.equal(ran, false);
  });

  test('as the entry, start hands the whole input to run', async () => {
    const stdin = new PassThrough();
    const got = new Promise<string>(done => start(HOOK, pathToFileURL(HOOK).href, stdin, done));
    stdin.end('{"a":1}');
    assert.equal(await got, '{"a":1}');
  });

  test('hook sets the exit code from the verdict', () => {
    const before = process.exitCode;
    try {
      hook(JSON.stringify({ tool_name: 'Read' }));
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = before;
    }
  });
});
