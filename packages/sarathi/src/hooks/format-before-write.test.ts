import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPrettier, minimalEdit, respond, sessionRoot, type Edit } from './format-before-write.ts';

const HOOK = fileURLToPath(new URL('./format-before-write.ts', import.meta.url));

// A temporary checkout with a stand-in prettier in its node_modules: the
// handler formats only inside its root, and loads the root's prettier.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'format-before-write-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'format-before-write-out-')));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

/**
 * A stand-in for prettier's API with a few of its rules: single quotes, spaces
 * inside braces and after `:` and `,`, one space between words, a semicolon
 * ending each statement line. `(;` does not parse. `dist/` is ignored.
 */
const FAKE_PRETTIER = `
const formatted = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yml', '.yaml', '.css']);
exports.getFileInfo = async (path, options) => ({
  ignored: path.includes('/dist/') && typeof options.ignorePath === 'string',
  inferredParser: formatted.has(path.slice(path.lastIndexOf('.'))) ? 'typescript' : null,
});
exports.resolveConfig = async () => null;
exports.format = async (text, options) => {
  if (typeof options.filepath !== 'string') throw new Error('no filepath');
  if (text.includes('(;')) throw new SyntaxError("';' expected");
  const lines = text.replace(/\\n+$/, '').split('\\n').map((line) =>
    line
      .trimEnd()
      .replace(/"/g, "'")
      .replace(/\\{(\\S)/g, '{ $1')
      .replace(/(\\S)\\}/g, '$1 }')
      .replace(/:(\\S)/g, ': $1')
      .replace(/,(\\S)/g, ', $1')
      .replace(/(\\S) {2,}/g, '$1 ')
      .replace(/([^;\\s])$/, '$1;'),
  );
  return lines.join('\\n') + '\\n';
};
`;
mkdirSync(join(ROOT, 'node_modules', 'prettier'), { recursive: true });
writeFileSync(join(ROOT, 'node_modules', 'prettier', 'package.json'), '{"name":"prettier","main":"index.js"}\n');
writeFileSync(join(ROOT, 'node_modules', 'prettier', 'index.js'), FAKE_PRETTIER);
writeFileSync(join(ROOT, '.prettierignore'), 'dist\n');

const ENV = { CLAUDE_PROJECT_DIR: ROOT };

function apply(before: string, change: Edit | null): string {
  assert.ok(change);
  assert.equal(before.split(change.old_string).length, 2, 'old_string must be unique');
  return before.replace(change.old_string, () => change.new_string);
}

/** The handler's updated input for an event, or null when it prints nothing. */
async function hook(event: object, env: NodeJS.ProcessEnv = ENV): Promise<Record<string, unknown> | null> {
  const out = await respond(JSON.stringify(event), env);
  if (out === '') return null;
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  return parsed.hookSpecificOutput.updatedInput;
}

function fixture(name: string, text: string): string {
  const path = join(ROOT, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test('minimalEdit: the smallest unique replacement', () => {
  const before = 'const a = 1;\nconst b = {x:1};\nconst c = 3;\n';
  const after = 'const a = 1;\nconst b = { x: 1 };\nconst c = 3;\n';
  const change = minimalEdit(before, after);
  assert.deepEqual(change, { old_string: 'x:1', new_string: ' x: 1 ' });
  assert.equal(apply(before, change), after);
});

test('minimalEdit: grows by whole lines until old_string is unique', () => {
  const before = 'x\nfoo(1)\nx\nfoo(1)\n';
  const after = 'x\nfoo(1)\nx\nfoo(2)\n';
  const change = minimalEdit(before, after);
  assert.ok(change && change.old_string.length > 1);
  assert.equal(apply(before, change), after);
});

test('minimalEdit: a pure insertion gets an anchor', () => {
  const before = 'a\nb\n';
  const after = 'a\nnew\nb\n';
  assert.equal(apply(before, minimalEdit(before, after)), after);
});

test('minimalEdit: changes at the very start and the very end', () => {
  for (const [before, after] of [
    ['\nx\n', 'x\n'],
    ['x', 'x\n'],
    ['"a"', "'a'"],
  ] as const) {
    assert.equal(apply(before, minimalEdit(before, after)), after);
  }
});

test('minimalEdit: nothing to anchor on gives null', () => {
  assert.equal(minimalEdit('', 'x'), null);
});

test('Write: content is handed over formatted', async () => {
  const path = join(ROOT, 'new.ts');
  const out = await hook({ tool_name: 'Write', tool_input: { file_path: path, content: 'const a = "x"\nexport {a}\n' } });
  assert.deepEqual(out, { file_path: path, content: "const a = 'x';\nexport { a };\n" });
});

test('Write: already formatted content passes untouched', async () => {
  const path = join(ROOT, 'clean.ts');
  assert.equal(await hook({ tool_name: 'Write', tool_input: { file_path: path, content: "export const a = 'x';\n" } }), null);
});

test('Edit: rewritten so the file comes out formatted', async () => {
  const before = "const greeting = 'hello';\nexport { greeting };\n";
  const path = fixture('edit.ts', before);
  const out = await hook({
    tool_name: 'Edit',
    tool_input: {
      file_path: path,
      old_string: "const greeting = 'hello';",
      new_string: 'const greeting = \'hello\';\nconst v = {a:1,b:"1"}',
    },
  });
  assert.ok(out);
  assert.equal(out['file_path'], path);
  assert.equal(out['replace_all'], false);
  assert.equal(
    apply(before, out as unknown as Edit),
    "const greeting = 'hello';\nconst v = { a: 1, b: '1' };\nexport { greeting };\n",
  );
  assert.equal(readFileSync(path, 'utf8'), before, 'the handler never writes');
});

test('Edit: replace_all is applied before formatting', async () => {
  const before = 'export const a = [1, 2];\nexport const b = [1, 2];\n';
  const path = fixture('all.ts', before);
  const out = await hook({
    tool_name: 'Edit',
    tool_input: { file_path: path, old_string: '[1, 2]', new_string: '[1,2,3]', replace_all: true },
  });
  assert.equal(apply(before, out as unknown as Edit), 'export const a = [1, 2, 3];\nexport const b = [1, 2, 3];\n');
});

test('Edit: left alone when the tool itself would refuse it', async () => {
  const path = fixture('dup.ts', 'export const a = 1;\nexport const b = 1;\n');
  for (const tool_input of [
    { file_path: path, old_string: '= 1', new_string: '=  2' },
    { file_path: path, old_string: 'missing', new_string: 'x' },
    { file_path: path, old_string: '', new_string: 'x' },
    { file_path: path, new_string: 'x' },
  ]) {
    assert.equal(await hook({ tool_name: 'Edit', tool_input }), null);
  }
});

test('Edit: a formatted result, a no-op, or code that does not parse passes untouched', async () => {
  const path = fixture('parse.ts', 'export const a = 1;\n');
  for (const new_string of ['export const a = 2;', 'export const a =  1;', 'export const a = (;']) {
    const tool_input = { file_path: path, old_string: 'export const a = 1;', new_string };
    assert.equal(await hook({ tool_name: 'Edit', tool_input }), null, new_string);
  }
});

test('out of scope: scratch, outside the root, links, other types, other tools', async () => {
  const link = join(ROOT, 'link.ts');
  symlinkSync(fixture('target.ts', 'export const a = 1;\n'), link);
  const content = 'const a = "x"\n';
  for (const file_path of [
    join(ROOT, '.tmp', 'x.ts'),
    join(ROOT, '.local', 'x.ts'),
    join(OUTSIDE, 'x.ts'),
    join(ROOT, 'x.py'),
    join(ROOT, 'missing-dir', 'x.ts'),
    link,
    '',
  ]) {
    assert.equal(await hook({ tool_name: 'Write', tool_input: { file_path, content } }), null, file_path);
  }
  const missing = { file_path: join(ROOT, 'nope.ts'), old_string: 'a', new_string: 'b' };
  assert.equal(await hook({ tool_name: 'Edit', tool_input: missing }), null);
  assert.equal(await hook({ tool_name: 'Edit', tool_input: { file_path: link, old_string: 'a', new_string: 'b' } }), null);
  assert.equal(await hook({ tool_name: 'Write', tool_input: { file_path: join(ROOT, 'y.ts') } }), null);
  assert.equal(await hook({ tool_name: 'NotebookEdit', tool_input: { file_path: join(ROOT, 'x.ts') } }), null);
  assert.equal(await hook({ tool_name: 'Write' }), null);
});

test('prettier-ignored files pass untouched', async () => {
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const file_path = join(ROOT, 'dist', 'x.ts');
  assert.equal(await hook({ tool_name: 'Write', tool_input: { file_path, content: 'a = "x"\n' } }), null);
});

test('the session checkout is the input cwd, not the project directory', async () => {
  const wt = join(ROOT, '.claude', 'worktrees', 'wt');
  mkdirSync(join(wt, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', wt]);
  assert.equal(sessionRoot({ cwd: join(wt, 'src') }, ENV), wt);
  assert.equal(sessionRoot({ cwd: join(ROOT, 'no-such-dir') }, ENV), ROOT);
  assert.equal(sessionRoot({ cwd: 42 }, ENV), ROOT);
  // A fresh worktree has no node_modules: the project checkout's prettier formats it.
  const file_path = join(wt, 'src', 'a.ts');
  const out = await hook({ cwd: wt, tool_name: 'Write', tool_input: { file_path, content: 'const a = "x"\n' } });
  assert.deepEqual(out, { file_path, content: "const a = 'x';\n" });
  // The project checkout's own files are outside a worktree session.
  assert.equal(await hook({ cwd: wt, tool_name: 'Write', tool_input: { file_path: join(ROOT, 'm.ts'), content: 'a\n' } }), null);
});

test('without prettier anywhere, nothing is printed', async () => {
  assert.equal(loadPrettier(OUTSIDE, {}), null);
  assert.equal(await hook({ tool_name: 'Write', tool_input: { file_path: join(OUTSIDE, 'x.ts'), content: 'a\n' } }, { CLAUDE_PROJECT_DIR: OUTSIDE }), null);
  assert.ok(loadPrettier(OUTSIDE, ENV), 'falls back to the project checkout');
});

test('the handler over stdin: formats, and never blocks on malformed input', () => {
  const env = { ...process.env, ...ENV };
  const run = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(ROOT, 'stdin.ts'), content: 'const a = "x"\n' } }),
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    (JSON.parse(run.stdout) as { hookSpecificOutput: { updatedInput: { content: string } } }).hookSpecificOutput.updatedInput.content,
    "const a = 'x';\n",
  );
  const bad = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8', env });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});
