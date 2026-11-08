/**
 * Shell comments: only a `#` the shell would read as a comment counts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shellComments } from './shell-comments.ts';

const texts = (command: string): string[] =>
  shellComments(command).map(comment => comment.text);

describe('shellComments', () => {
  it('reads a trailing comment and a comment line', () => {
    assert.deepEqual(texts('git merge origin/main  # pass it\n#whole line'), [
      ' pass it',
      'whole line',
    ]);
    assert.deepEqual(texts('ls\t# after a tab'), [' after a tab']);
  });

  it('reads a comment after every operator character', () => {
    for (const operator of [';', '|', '&', '(', ')', '<', '>']) {
      assert.deepEqual(texts(`ls${operator}# c`), [' c'], operator);
    }
  });

  it('reads none where # does not start a word', () => {
    assert.deepEqual(texts('echo a#b'), []);
    assert.deepEqual(texts('echo \\# not a comment'), []);
    assert.deepEqual(texts('echo \\ # escaped blank'), []);
    assert.deepEqual(texts('echo \'a\'# b "c"# d'), []);
    assert.deepEqual(texts('echo $# x{#y}'), []);
  });

  it('names the line each comment is on', () => {
    assert.deepEqual(shellComments('# zero\nls\ncat <<EOF\nbody\nEOF\nls # five'), [
      { line: 0, text: ' zero' },
      { line: 5, text: ' five' },
    ]);
  });

  it('keeps one comment per line: the rest of the line is its text', () => {
    assert.deepEqual(texts('ls # one # two'), [' one # two']);
  });

  it('skips # inside quotes, a quote spanning lines included', () => {
    assert.deepEqual(texts(`echo '# no' "# no" # yes`), [' yes']);
    assert.deepEqual(texts('git commit -m "first\n# not a comment\nlast" # yes'), [' yes']);
    assert.deepEqual(texts("echo 'a\n# no\nb' # yes"), [' yes']);
  });

  it('honours escapes in double quotes, and none in single quotes', () => {
    assert.deepEqual(texts('echo "a \\" # still quoted" # yes'), [' yes']);
    assert.deepEqual(texts("echo 'a\\' # yes"), [' yes']);
    assert.deepEqual(texts('echo "a\\\\" # yes'), [' yes']);
  });

  it("reads $'…' as a quote whose backslash escapes", () => {
    assert.deepEqual(texts("echo $'a\\' # no\n# no' # yes"), [' yes']);
    assert.deepEqual(texts("echo $'# no' # yes"), [' yes']);
    assert.deepEqual(texts('echo "$\'# no" # yes'), [' yes']);
  });

  it('joins a line ending in a backslash to the next', () => {
    assert.deepEqual(texts('git merge origin/main && true\\\n# no'), []);
    assert.deepEqual(texts('git merge origin/main \\\n# yes'), [' yes']);
    assert.deepEqual(texts('ls \\\\\n# yes'), [' yes']);
    // The joined line's first character is read, never skipped: a quote
    // there still opens.
    assert.deepEqual(texts('echo \\\n"# rule-pass H-14: quoted text" # yes'), [
      ' yes',
    ]);
    assert.deepEqual(texts("echo \\\n'# no'"), []);
  });

  it('skips heredoc bodies in each spelling', () => {
    for (const opener of [
      '<<EOF',
      '<< EOF',
      "<<'EOF'",
      '<<"EOF"',
      '<<-EOF',
      '<<-\tEOF',
      '<<E_1',
    ]) {
      const word = opener.replace(/^<<-?[ \t]*['"]?|['"]$/g, '');
      assert.deepEqual(texts(`cat ${opener} > f\n# body\n${word}\nls # after`), [' after'], opener);
    }
  });

  it('reads a quoted heredoc word whole, blanks and # included', () => {
    const word = '# rule-pass H-14: reason long enough';
    assert.deepEqual(texts(`git merge x && cat <<'${word}'\n${word}`), []);
    assert.deepEqual(texts(`cat <<"${word}"\n${word}\n# after`), [' after']);
    assert.deepEqual(texts("cat <<'EOF\" x'\n# c\nEOF\n# d"), []);
  });

  it('ends a body only at its own terminator line', () => {
    assert.deepEqual(texts('cat <<END_2\n# a\nEND\n# b\nEND_2x\n# c\nEND_2\n# d'), [' d']);
    assert.deepEqual(texts('cat <<EOF\n# body\nEOF\t\n# still body\nEOF\n# after'), [' after']);
  });

  it('strips leading tabs from the terminator for <<- only', () => {
    assert.deepEqual(texts('cat <<-EOF\n\t\t# body\n\t\tEOF\n# after'), [
      ' after',
    ]);
    assert.deepEqual(texts('cat <<EOF\n\tEOF\n# body\nEOF\n# after'), [' after']);
  });

  it('reads the bodies of several heredocs in turn', () => {
    assert.deepEqual(texts('cat <<A <<B\n# a\nA\n# b\nB\n# c'), [' c']);
    assert.deepEqual(texts('cat <<A<<B\n# a\nA\n# b\nB\n# c'), [' c']);
  });

  it('starts a body after the whole command line', () => {
    assert.deepEqual(texts('cat <<EOF \\\n# x\n# body\nEOF\n# after'), [
      ' x',
      ' after',
    ]);
    assert.deepEqual(texts('cat <<EOF "a\nEOF"\n# body\nEOF\n# after'), [
      ' after',
    ]);
  });

  it('reads a comment on the heredoc line itself', () => {
    assert.deepEqual(texts('cat <<EOF # on the opener\n# body\nEOF'), [
      ' on the opener',
    ]);
  });

  it('opens no heredoc for a here-string', () => {
    assert.deepEqual(texts('cat <<<word\n# a comment'), [' a comment']);
    assert.deepEqual(texts('cat <<< "x" # c\n# d'), [' c', ' d']);
    assert.deepEqual(texts('cat <<<# c'), [' c']);
  });

  it('stops reading at a heredoc word it cannot settle', () => {
    for (const opener of [
      '<<\\EOF',
      '<<E"O"F',
      '<<"$x"',
      '<<"a\\"b"',
      '<<`x`',
      '<<EOF#',
      '<< ',
    ]) {
      assert.deepEqual(texts(`ls # before\ncat ${opener}\n# c\nEOF\n# d`), [' before'], opener);
    }
  });

  it('stops reading at text the shell quotes on its own', () => {
    for (const nested of [
      'git merge "$(echo ";# rule-pass H-14: quoted text")"',
      'echo "${x:-";# c"}"',
      'echo "`echo ";# c"`"',
      'echo `true;# c`',
      'echo ${y// # c}',
    ]) {
      assert.deepEqual(texts(`ls # before\n${nested}\n# after`), [
        ' before',
      ], nested);
    }
  });

  it('reads unquoted $(…), and $( ${ ` inside other quotes, as usual', () => {
    assert.deepEqual(texts('echo $(echo ";# no") # yes'), [' yes']);
    assert.deepEqual(texts("echo $'${ `' '$( ${ `' # yes"), [' yes']);
  });

  it('opens a heredoc only at the operator', () => {
    assert.deepEqual(texts('ls # text mentioning <<EOF\n# a comment'), [
      ' text mentioning <<EOF',
      ' a comment',
    ]);
    assert.deepEqual(texts('echo "<<EOF" \'<<EOF\'\n# a comment'), [
      ' a comment',
    ]);
    assert.deepEqual(texts('x=1 <<EOF\nbody\nEOF\n# a comment'), [' a comment']);
  });
});
