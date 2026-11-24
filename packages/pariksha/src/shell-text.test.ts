// The shell lexing the doc-commands reader and shell-gates' line rules go
// through: a `#` comment cut off, quoted text masked so an operator inside a
// string splits nothing, message views, words, logical lines (quoting that
// spans lines, heredoc bodies, continuations) and command positions. Each edge
// is pinned on the lexer's own output, so a regression shows as the exact text
// that changed rather than as a rule that went quiet.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeLines, commandAt, commandPositions, maskQuoted, messageView, stripComment, words } from './shell-text.ts';

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

  it('opens a quoted $( at its $, so the string is open again after its )', () => {
    assert.equal(stripComment('X="$(f) # c"'), 'X="$(f) # c"');
  });

  it('tracks parens nested two deep inside a quoted $(', () => {
    assert.equal(stripComment('X="$(a (b (c) d) # x'), 'X="$(a (b (c) d)');
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
    // Each escape is judged by the character right after it, not a later one.
    assert.equal(maskQuoted('echo \\. x\\;'), 'echo \\. x  ');
  });

  it('closes a substitution after the subshell inside it, and masks what follows', () => {
    assert.equal(maskQuoted('"$(a (b) c) d"'), '"$(a (b) c)  "');
  });

  it("reads each case arm's ) as a pattern's end, whatever the spacing and the words", () => {
    assert.equal(maskQuoted('"$(case $x in ab) y;;b) z;; esac) w"'), '"$(case $x in ab) y;;b) z;; esac)  "');
    assert.equal(maskQuoted('"$(case $x in a | b) y;; esac) w"'), '"$(case $x in a | b) y;; esac)  "');
    assert.equal(maskQuoted('"$(case $x in a|bc) y;; esac) w"'), '"$(case $x in a|bc) y;; esac)  "');
    assert.equal(maskQuoted('"$(case $x in a ) y;; esac) w"'), '"$(case $x in a ) y;; esac)  "');
    // A command whose name holds the word case is no case: its ) closes the substitution.
    assert.equal(maskQuoted('"$(test-case) y"'), '"$(test-case)  "');
    assert.equal(maskQuoted('"$(case.sh) y"'), '"$(case.sh)  "');
    // A subshell in an arm closes its own (, not a pattern.
    assert.equal(maskQuoted('"$(case $x in a) (b) ;; esac) z"'), '"$(case $x in a) (b) ;; esac)  "');
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

describe('messageView', () => {
  for (const [code, view] of [
    ['echo $HOME is set', 'echo             '],
    ['echo 42 apples', 'echo          '],
    ['echo "x" 5', 'echo      '],
  ] as const) {
    it(`blanks the message words of ${JSON.stringify(code)}`, () => {
      assert.equal(messageView(code), view);
    });
  }

  it('returns code with no echo or printf unchanged', () => {
    assert.equal(messageView('node "a b"'), 'node "a b"');
  });

  it('keeps substitutions, nested parens and backticks included', () => {
    assert.equal(messageView('echo $(a (b) c) msg; node'), 'echo $(a (b) c)    ; node');
    assert.equal(messageView('echo `date` msg; node'), 'echo `date`    ; node');
  });

  it('keeps a redirection and its target, with its fd digit', () => {
    assert.equal(messageView('echo hi 2>/dev/null'), 'echo    2>/dev/null');
    assert.equal(messageView('echo a &> log more'), 'echo   &> log     ');
    assert.equal(messageView('echo a > f;node x'), 'echo   > f;node x');
  });

  it('keeps a duplicated fd and a quoted target with a blank in it, and blanks the words after', () => {
    assert.equal(messageView('echo hi 2>&1 more'), 'echo    2>&1     ');
    assert.equal(messageView('echo x > "a b" c'), 'echo   > "a b"  ');
    assert.equal(messageView("echo x > 'a b' c"), "echo   > 'a b'  ");
  });

  it('takes no later word as the target of a redirection with none of its own', () => {
    assert.equal(messageView('echo a >| f'), 'echo   >| f');
  });

  it('ends a message at & and keeps what follows', () => {
    assert.equal(messageView('echo hi & node x'), 'echo    & node x');
    assert.equal(messageView('printf "%s" a | node'), 'printf        | node');
  });
});

describe('words', () => {
  for (const [code, expected] of [
    ['echo "a b"', ['echo', '"a b"']],
    ["echo 'a b' c", ['echo', "'a b'", 'c']],
    ['echo "a\\" b" c', ['echo', '"a\\" b"', 'c']],
    ["echo 'a\\' b", ['echo', "'a\\'", 'b']],
    ['echo a\\ b', ['echo', 'a\\ b']],
    ['echo a\\', ['echo', 'a\\']],
    ['echo ${a:-x y} z', ['echo', '${a:-x y}', 'z']],
    ['echo ${a} b', ['echo', '${a}', 'b']],
    ['echo {a b}', ['echo', '{a', 'b}']],
    ['echo $(a (b) c) d', ['echo', '$(a (b) c)', 'd']],
    ['echo $(a|b) c', ['echo', '$(a|b)', 'c']],
    ['a b|c', ['a', 'b']],
    ['a b;c', ['a', 'b']],
    ['a b&c', ['a', 'b']],
    ['a b)c', ['a', 'b']],
    ['  a   b  ', ['a', 'b']],
  ] as const) {
    it(`splits ${JSON.stringify(code)}`, () => {
      assert.deepEqual(words(code), expected);
    });
  }
});

describe('codeLines', () => {
  const cases: Array<[string, Array<{ line: number; code: string }>]> = [
    [
      'a\n\nb',
      [
        { line: 1, code: 'a' },
        { line: 3, code: 'b' },
      ],
    ],
    ['a\n\\', [{ line: 1, code: 'a' }]],
    [
      'a\n# c\n  # d\nb # e',
      [
        { line: 1, code: 'a' },
        { line: 4, code: 'b' },
      ],
    ],
    ['echo "a', [{ line: 1, code: 'echo "a' }]],
    ['no\\\nde x.js', [{ line: 1, code: 'node x.js' }]],
  ];
  for (const [text, lines] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => {
      assert.deepEqual(codeLines(text), lines);
    });
  }

  it('keeps a quoted string spanning lines as one logical line', () => {
    assert.deepEqual(codeLines('echo "a\nb" c'), [{ line: 1, code: 'echo "a\nb" c' }]);
    assert.deepEqual(codeLines('echo "a\nb" "c\nd"'), [{ line: 1, code: 'echo "a\nb" "c\nd"' }]);
    assert.deepEqual(codeLines('( echo "a\nb" )\nnode'), [
      { line: 1, code: '( echo "a\nb" )' },
      { line: 3, code: 'node' },
    ]);
  });

  it('removes a backslash-newline in double quotes, keeps it in single', () => {
    assert.deepEqual(codeLines('X="$(no\\\nde x)"'), [{ line: 1, code: 'X="$(node x)"' }]);
    assert.deepEqual(codeLines("echo 'a\\\nb'"), [{ line: 1, code: "echo 'a\\\nb'" }]);
  });

  it('continues code after a closing quote that ends in a backslash', () => {
    assert.deepEqual(codeLines('echo "a\nb" \\\nnode'), [{ line: 1, code: 'echo "a\nb" node' }]);
    assert.deepEqual(codeLines('echo "a\nb" c \\\nnode'), [{ line: 1, code: 'echo "a\nb" c node' }]);
  });

  it('removes a backslash-newline inside a string that opens after a closing quote', () => {
    assert.deepEqual(codeLines('echo "a\nb" "c \\\nd"'), [{ line: 1, code: 'echo "a\nb" "c d"' }]);
  });

  it('holds no line open on a bare (, outside any quote', () => {
    assert.deepEqual(codeLines('f (\nnode'), [
      { line: 1, code: 'f (' },
      { line: 2, code: 'node' },
    ]);
  });

  it('drops a line of blanks, and a continuation that ends in blanks', () => {
    assert.deepEqual(codeLines('a\n   \nb'), [
      { line: 1, code: 'a' },
      { line: 3, code: 'b' },
    ]);
    assert.deepEqual(codeLines('x\n  \\'), [{ line: 1, code: 'x' }]);
  });

  it('strips a comment line inside a continuation, as bash does', () => {
    assert.deepEqual(codeLines('echo a \\\n# c\nnode x'), [
      { line: 1, code: 'echo a ' },
      { line: 3, code: 'node x' },
    ]);
  });

  it('carries the nesting of a quoted $(…) across lines', () => {
    assert.deepEqual(codeLines('X="$(f (a) b\nc)"\nnode'), [
      { line: 1, code: 'X="$(f (a) b\nc)"' },
      { line: 3, code: 'node' },
    ]);
    assert.deepEqual(codeLines('X="$(printf "%s\n" x) node is text"\nnpm'), [
      { line: 1, code: 'X="$(printf "%s\n" x) node is text"' },
      { line: 3, code: 'npm' },
    ]);
  });

  it('ends a physical line at a comment inside a quoted $(…) that stays open', () => {
    assert.deepEqual(codeLines('X="$(a\nb # c\nd)"'), [{ line: 1, code: 'X="$(a\nb\nd)"' }]);
  });

  describe('heredocs', () => {
    for (const [text, opener] of [
      ["cat <<'E O'\nnode\nE O\nnpm", "cat <<'E O'"],
      ['cat <<"END"\nnode\nEND\nnpm', 'cat <<"END"'],
      ['cat <<\\EOF\nnode\nEOF\nnpm', 'cat <<\\EOF'],
      ['cat <<-EOF\n\tnode\n\tEOF\nnpm', 'cat <<-EOF'],
    ] as const) {
      it(`drops the body of ${JSON.stringify(text)} through its delimiter`, () => {
        assert.deepEqual(codeLines(text), [
          { line: 1, code: opener },
          { line: 4, code: 'npm' },
        ]);
      });
    }

    it('ends a body only on an exact delimiter line', () => {
      assert.deepEqual(codeLines('cat <<EOF\nnode\nEOF \nEOF\nnpm'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 5, code: 'npm' },
      ]);
    });

    it('opens none for a here-string or a shift', () => {
      assert.deepEqual(codeLines('cat <<<"$x"\nnode'), [
        { line: 1, code: 'cat <<<"$x"' },
        { line: 2, code: 'node' },
      ]);
      assert.deepEqual(codeLines('x=$(( 1 << 2 ))\nnode'), [
        { line: 1, code: 'x=$(( 1 << 2 ))' },
        { line: 2, code: 'node' },
      ]);
    });

    it('starts the body after a continued command line ends', () => {
      assert.deepEqual(codeLines('cat <<EOF \\\n> out\nbody\nEOF\nnode'), [
        { line: 1, code: 'cat <<EOF > out' },
        { line: 5, code: 'node' },
      ]);
    });

    it('keeps only the substitutions an expanding body runs', () => {
      assert.deepEqual(codeLines('cat <<EOF\necho "$(node x)"\nEOF\n'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '      $(node x) ' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\nplain text\nEOF\nnode'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 4, code: 'node' },
      ]);
    });

    it('judges each closed substitution on its own line', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node x)\n$(npm y)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node x)' },
        { line: 3, code: '$(npm y)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\na $(node x)\n$(npm y)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '  $(node x)' },
        { line: 3, code: '$(npm y)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n`node x`\n`npm y`\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '`node x`' },
        { line: 3, code: '`npm y`' },
      ]);
    });

    it('joins a backslash-newline inside a body substitution, as bash does', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(no\\\nde x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node x)' },
      ]);
    });

    it('judges a substitution spanning body lines whole', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node\nx)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node\nx)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n`node\nx`\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '`node\nx`' },
      ]);
    });

    it('opens no substitution on an escaped $( or a bare (', () => {
      assert.deepEqual(codeLines('cat <<EOF\na \\$( b\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\na (b\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n$((1 + 2)) (\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
    });

    it('still runs the substitutions of an unterminated body', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node\nx'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node\nx' },
      ]);
    });

    it('starts a body after a quote that opens on its opener line', () => {
      assert.deepEqual(codeLines('X="$(cat <<EOF\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF\n)"' },
        { line: 5, code: 'npm' },
      ]);
    });

    it('reads a backslash inside single quotes as literal, not an escape', () => {
      // `'a\'` is the word a\ and closes its quote, so the opener line ends
      // there and the body starts on line 2.
      assert.deepEqual(codeLines('X="$(cat <<EOF; echo \'a\\\'\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF; echo \'a\\\'\n)"' },
        { line: 5, code: 'npm' },
      ]);
    });

    // bash reads each of these with the body after the string closes, and
    // runs the last line (checked against bash 5).
    for (const [quote, text, opener] of [
      ['double', 'cat <<EOF; echo "a\nb"\nnode\nEOF\nnpm', 'cat <<EOF; echo "a\nb"'],
      ['single, ending in a backslash', "cat <<EOF; echo 'a \\\nb'\nnode\nEOF\nnpm", "cat <<EOF; echo 'a \\\nb'"],
    ] as const) {
      it(`starts no body inside a ${quote}-quoted string the opener line leaves open`, () => {
        assert.deepEqual(codeLines(text), [
          { line: 1, code: opener },
          { line: 5, code: 'npm' },
        ]);
      });
    }

    it('starts no body inside a string nested in a quoted substitution', () => {
      assert.deepEqual(codeLines('X="$(cat <<EOF; echo \'a \\\nb\'\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF; echo \'a \\\nb\'\n)"' },
        { line: 6, code: 'npm' },
      ]);
    });

    it('opens none when an operator follows <<, so the lines after are still judged', () => {
      assert.deepEqual(codeLines('cat << >out\nnode'), [
        { line: 1, code: 'cat << >out' },
        { line: 2, code: 'node' },
      ]);
    });

    it('ends a double-quoted delimiter with a blank in it on that text', () => {
      assert.deepEqual(codeLines('cat <<"E O"\nnode\nE O\nnpm'), [
        { line: 1, code: 'cat <<"E O"' },
        { line: 4, code: 'npm' },
      ]);
    });

    it('strips every leading tab for <<-, and only leading ones', () => {
      assert.deepEqual(codeLines('cat <<-EOF\n\t\tEOF\nnode'), [
        { line: 1, code: 'cat <<-EOF' },
        { line: 3, code: 'node' },
      ]);
      assert.deepEqual(codeLines('cat <<-EOF\nE\tOF\nnode\nEOF\nnpm'), [
        { line: 1, code: 'cat <<-EOF' },
        { line: 5, code: 'npm' },
      ]);
    });

    it('judges a substitution still open at the delimiter where the body ends', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node\nEOF\nnpm'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node' },
        { line: 4, code: 'npm' },
      ]);
    });

    it('runs no substitution in a quoted heredoc body', () => {
      assert.deepEqual(codeLines("cat <<'EOF'\n$(node x)\nEOF\nnpm"), [
        { line: 1, code: "cat <<'EOF'" },
        { line: 4, code: 'npm' },
      ]);
    });

    it('strips leading tabs only for <<-', () => {
      assert.deepEqual(codeLines('cat <<EOF\n\tEOF\nEOF\nnode'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 4, code: 'node' },
      ]);
    });

    it('keeps a body substitution whole past the quotes and escapes inside it', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(echo "a\\"b" \')\' \\) x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(echo "a\\"b" \')\' \\) x)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n`echo "a b" \'c\' \\` x`\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '`echo "a b" \'c\' \\` x`' },
      ]);
    });

    it('opens a heredoc in the code after a string closes', () => {
      assert.deepEqual(codeLines("printf '%s' 'help\n'; cat <<'EOF'\nnode\nEOF\nnpm"), [
        { line: 1, code: "printf '%s' 'help\n'; cat <<'EOF'" },
        { line: 5, code: 'npm' },
      ]);
    });
  });
});

describe('commandPositions', () => {
  const cases: Array<[string, string, number[]]> = [
    ['"node" x', 'node', [6]],
    ['a |& node x', 'node', [9]],
    ['a | node x', 'node', [8]],
    ['case $x in node) npm ;; esac', 'node', []],
    ['case $x in a|node) npm ;; esac', 'node', []],
    ['case $x in a) node ;; esac', 'node', [18]],
    ['lint) node x ;;', 'node', [10]],
    ['echo if node', 'node', []],
    ['if node; then :; fi', 'node', [7]],
    ['env -u X node a', 'node', [13]],
    ['/usr/bin/node a', 'node', [13]],
    ['echo "node x"', 'node', []],
    ['X="$(node x)"', 'node', [9]],
    ['nodejs x', 'node', []],
    ['node.js x', 'node.js', [7]],
    ['nodexjs x', 'node.js', []],
    ['echo $(a) node', 'node', []],
    ['X=1 node a', 'node', [8]],
    ['>/dev/null node a', 'node', [15]],
    ['x=`node a`', 'node', [7]],
    // A ) that closes no paren starts a command; one that closes a subshell does not.
    ['(a) b) node', 'node', [11]],
    ['x=$(case $y in a) node;; esac)', 'node', [22]],
    // The first word of an arm's pattern list, whatever the spacing, is a label.
    ['node | npm) a ;;', 'node', []],
    ['node|npm) a ;;', 'node', []],
    ['node ) a ;;', 'node', []],
    ['a) b;; node | npm) c', 'node', []],
    // Only a label right after the word makes it one.
    ['node; a) |b)', 'node', [4]],
    // A quoted command word after a separator, at the end, or before an operator.
    ['a; "node" x', 'node', [9]],
    ['a; "node"', 'node', [9]],
    ['"node"; x', 'node', [6]],
  ];
  for (const [code, command, ends] of cases) {
    it(`finds ${JSON.stringify(code)} running ${command} at ${JSON.stringify(ends)}`, () => {
      assert.deepEqual(commandPositions(code, command), ends);
    });
  }

  it('returns the first position, or -1', () => {
    assert.equal(commandAt('a; node x; node y', 'node'), 7);
    assert.equal(commandAt('echo node', 'node'), -1);
  });
});
