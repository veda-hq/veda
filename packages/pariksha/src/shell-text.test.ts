// The shell lexing the doc-commands reader goes through: a `#` comment cut
// off, and quoted text masked so an operator inside a string splits nothing.
// Each edge is pinned on the lexer's own output, so a regression shows as the
// exact text that changed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskQuoted, stripComment } from './shell-text.ts';

describe('stripComment', () => {
  for (const [line, code] of [
    ['echo a # c', 'echo a'],
    ['echo "a" # note', 'echo "a"'],
    ['# whole', ''],
    ['f;# c', 'f;'],
    ['f(# c', 'f('],
    ['echo a #b', 'echo a'],
  ] as const) {
    it(`removes the comment from ${JSON.stringify(line)}`, () => {
      assert.equal(stripComment(line), code);
    });
  }

  for (const line of ['echo a#b', 'echo ${#x}', 'echo {#a,b}', 'echo $#', "echo '# quoted'", 'echo "# quoted"', 'echo \\# escaped']) {
    it(`keeps ${JSON.stringify(line)}: its # starts no word outside quotes`, () => {
      assert.equal(stripComment(line), line);
    });
  }

  it('keeps an escaped blank before a comment: it is no continuation', () => {
    assert.equal(stripComment('echo ok \\ # note'), 'echo ok \\ ');
  });

  it('reads an escaped quote as text, not an opening quote', () => {
    assert.equal(stripComment('echo \\" # x'), 'echo \\"');
  });

  it('ends a quoted $(...) body at its comment, nested parens included', () => {
    assert.equal(stripComment('X="$(echo a # note'), 'X="$(echo a');
    assert.equal(stripComment('X="$(f (a) # c'), 'X="$(f (a)');
    // Past the `)` the outer string is still open: `# c` is its text.
    assert.equal(stripComment('X="$(f "a # b") # c'), 'X="$(f "a # b") # c');
    assert.equal(stripComment('X="$(f "a # b")" # c'), 'X="$(f "a # b")"');
  });

  it('keeps a line with no comment as written, trailing blanks included', () => {
    assert.equal(stripComment('echo a  '), 'echo a  ');
    assert.equal(stripComment(''), '');
  });

  it('reads a single-quoted # and an escaped quote inside double quotes as text', () => {
    assert.equal(stripComment("echo 'a # b' # c"), "echo 'a # b'");
    assert.equal(stripComment('echo "a \\" # b" # c'), 'echo "a \\" # b"');
  });
});

describe('maskQuoted', () => {
  for (const [code, masked] of [
    ["echo 'a b' c", "echo '   ' c"],
    ["echo '' x", "echo '' x"],
    ["echo 'open", "echo '    "],
    ['echo "a\\"b" node', 'echo "    " node'],
    ['"abc\\', '"    '],
  ] as const) {
    it(`blanks quoted text in ${JSON.stringify(code)}, offsets unchanged`, () => {
      assert.equal(maskQuoted(code), masked);
      assert.equal(maskQuoted(code).length, code.length);
    });
  }

  it('blanks an escaped operator or quote with its backslash', () => {
    assert.equal(maskQuoted('echo a\\; node'), 'echo a   node');
    assert.equal(maskQuoted("echo \\' node"), 'echo    node');
    assert.equal(maskQuoted('echo \\. nvm.sh'), 'echo \\. nvm.sh');
    assert.equal(maskQuoted('echo \\'), 'echo \\');
    assert.equal(maskQuoted('a\\\\'), 'a\\\\');
  });

  it('keeps a $(...) inside double quotes as code, masking its strings', () => {
    assert.equal(maskQuoted('"$(echo \\) x)"'), '"$(echo    x)"');
    assert.equal(maskQuoted('"$(echo \'a)\' b)"'), '"$(echo \'  \' b)"');
    assert.equal(maskQuoted('"$(echo "a)" b)"'), '"$(echo "  " b)"');
    assert.equal(maskQuoted('"$(a (b) c)"'), '"$(a (b) c)"');
    assert.equal(maskQuoted('"$(date) x"'), '"$(date)  "');
    // The `)` right after an inner string still closes the substitution.
    assert.equal(maskQuoted('"$(echo \'a\') b"'), '"$(echo \' \')  "');
  });

  it('keeps a backtick substitution inside double quotes as code', () => {
    assert.equal(maskQuoted('X="`echo "a b"`"'), 'X="`echo "   "`"');
    assert.equal(maskQuoted('X="`a \\` b`" c'), 'X="`a    b`" c');
    assert.equal(maskQuoted('X="`a \'b c\'`" d'), 'X="`a \'   \'`" d');
    assert.equal(maskQuoted('"`abc'), '"`abc');
  });

  it('masks $((...)) arithmetic in double quotes as text', () => {
    assert.equal(maskQuoted('"$((1 + 2)) x"'), '"            "');
  });

  it("closes no substitution on a case arm's )", () => {
    assert.equal(maskQuoted('"$(case $x in a) y;; esac) z"'), '"$(case $x in a) y;; esac)  "');
  });

  it('keeps an unclosed substitution in double quotes as code to the end', () => {
    assert.equal(maskQuoted('"$(echo a'), '"$(echo a');
  });

  it('keeps text outside quotes, a backtick outside double quotes included', () => {
    assert.equal(maskQuoted('echo `a "b c"` d'), 'echo `a "   "` d');
    assert.equal(maskQuoted('plain words'), 'plain words');
  });
});
