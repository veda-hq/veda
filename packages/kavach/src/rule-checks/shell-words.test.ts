/**
 * The simple commands of a command line: quoting, separators, comments,
 * heredocs and substitutions; the words past wrappers; a tool's subcommand.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  everyCommand,
  gitSubcommand,
  invoked,
  program,
  programOf,
  resolvePath,
  roughCommands,
  shellScript,
  simpleCommands,
  steps,
  subcommand,
} from './shell-words.ts';

/** A table of cases, each row typed as its own tuple. */
const rows = <const T extends readonly (readonly unknown[])[]>(table: T): T => table;

describe('simpleCommands', () => {
  for (const [text, expected] of rows([
    ['', []],
    ['git merge origin/main', [['git', 'merge', 'origin/main']]],
    ['  git   merge\tmain  ', [['git', 'merge', 'main']]],
    ['a; b', [['a'], ['b']]],
    ['a && b || c', [['a'], ['b'], ['c']]],
    ['a | b |& c', [['a'], ['b'], ['c']]],
    ['a & b', [['a'], ['b']]],
    ['(a) ; { b; }', [['a'], ['{', 'b'], ['}']]],
    ['a\nb', [['a'], ['b']]],
    ['a;;\n\nb', [['a'], ['b']]],
  ])) {
  it(`splits ${JSON.stringify(text)} into commands`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    [`echo 'git merge main'`, [['echo', 'git merge main']]],
    [`echo "git merge main"`, [['echo', 'git merge main']]],
    [`echo $'a\\'b'`, [['echo', "a'b"]]],
    [`echo $'a\\nb'`, [['echo', 'anb']]],
    [`a'b'"c"d`, [['abcd']]],
    [`echo '' ""`, [['echo', '', '']]],
    [`echo "a;b" 'c|d'`, [['echo', 'a;b', 'c|d']]],
    [`echo "a\\"b\\\\c\\$d\\\`e"`, [['echo', 'a"b\\c$d`e']]],
    [`echo "a\\xb"`, [['echo', 'a\\xb']]],
    [`echo "a\\\nb"`, [['echo', 'ab']]],
    [`echo "a\nb"`, [['echo', 'a\nb']]],
  ])) {
  it(`reads quotes in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    ['echo a\\ b', [['echo', 'a b']]],
    ['echo a\\;b', [['echo', 'a;b']]],
    ['git \\\nmerge main', [['git', 'merge', 'main']]],
    ['git mer\\\nge main', [['git', 'merge', 'main']]],
    ['echo a\\', [['echo', 'a']]],
    ['echo \\$x \\', [['echo', '$x']]],
    ['echo \\\n', [['echo']]],
  ])) {
  it(`reads backslashes in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    ['git merge main # rule-pass H-14: why', [['git', 'merge', 'main']]],
    ['# git merge main\nls', [['ls']]],
    ['a#b', [['a#b']]],
    ['a;#b\nc', [['a'], ['c']]],
    ['echo # last', [['echo']]],
  ])) {
  it(`drops comments in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    ['git merge main 2>&1', [['git', 'merge', 'main']]],
    ['git merge main >out.txt', [['git', 'merge', 'main']]],
    ['git merge main > out.txt x', [['git', 'merge', 'main', 'x']]],
    ['git merge main &>log', [['git', 'merge', 'main']]],
    ['git merge main >>log; ls', [['git', 'merge', 'main'], ['ls']]],
    ['git merge main >|log', [['git', 'merge', 'main']]],
    ['cat <in a', [['cat', 'a']]],
    ['a 2>/dev/null b', [['a', 'b']]],
    ['a x2>y b', [['a', 'x2', 'b']]],
    ['grep -q x <<<"$v"', [['grep', '-q', 'x']]],
  ])) {
  it(`drops redirections in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    ['cat <<EOF\ngit merge main\nEOF\nls', [['cat'], ['ls']]],
    ["cat <<'EOF' >f\ngit merge main\nEOF\nls", [['cat'], ['ls']]],
    ['cat <<"EOF"\ngit merge main\nEOF', [['cat']]],
    ['cat <<-EOF\n\tgit merge main\n\tEOF\nls', [['cat'], ['ls']]],
    ['cat <<EOF\n\tEOF\ngit merge main\nEOF\nls', [['cat'], ['ls']]],
    ['cat <<A <<B\nx\nA\ny\nB\nls', [['cat'], ['ls']]],
    ['cat <<EOF\nnever closed', [['cat']]],
    ['cat <<EOF\nEOF\nls', [['cat'], ['ls']]],
    ['cat <<A\nA\ncat <<B\nB\nls', [['cat'], ['cat'], ['ls']]],
    ['cat <<EOF', []],
  ])) {
  it(`skips heredoc bodies in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text).commands, expected);
  });
}

  for (const [text, expected] of rows([
    [
      'echo $(git merge main); ls',
      [['git', 'merge', 'main'], ['echo', '$'], ['ls']],
    ],
    [
      'echo `git merge main`',
      [
        ['git', 'merge', 'main'],
        ['echo', '$'],
      ],
    ],
    ['echo a$(b)c d', [['b'], ['echo', 'a$c', 'd']]],
    [
      'echo "x $(git merge main) y"',
      [
        ['git', 'merge', 'main'],
        ['echo', 'x $ y'],
      ],
    ],
    [
      'echo "x `git merge main` y"',
      [
        ['git', 'merge', 'main'],
        ['echo', 'x $ y'],
      ],
    ],
    ['echo $(a $(b) c)', [['b'], ['a', '$', 'c'], ['echo', '$']]],
    ['echo $(a `b` c)', [['b'], ['a', '$', 'c'], ['echo', '$']]],
    ['x=$(git merge main)', [['git', 'merge', 'main'], ['x=$']]],
    ['$(git merge main)', [['git', 'merge', 'main'], ['$']]],
    ['echo $(a; b)', [['a'], ['b'], ['echo', '$']]],
    ['(git merge main)', [['git', 'merge', 'main']]],
    [
      'cat <<EOF\n$(git merge main)\nEOF\nls',
      [['cat'], ['git', 'merge', 'main'], ['ls']],
    ],
    ['cat <<EOF\n`git merge main`\nEOF', [['cat'], ['git', 'merge', 'main']]],
    ['cat <<EOF\na $(b) EOF\nEOF\nls', [['cat'], ['b'], ['ls']]],
    ["cat <<'EOF'\n$(git merge main)\nEOF", [['cat']]],
    [
      `git commit -m "$(cat <<'EOF'\nfix: git merge main\nEOF\n)"`,
      [['cat'], ['git', 'commit', '-m', '$']],
    ],
    [
      'echo "$( (a) )"; git merge main',
      [['a'], ['echo', '$'], ['git', 'merge', 'main']],
    ],
    ['echo $((1+2)) x', [['echo', '$', 'x']]],
    ['echo a$(( (1+2) * $x ))b; ls', [['echo', 'a$b'], ['ls']]],
    ['echo "a$((1))b"', [['echo', 'a$b']]],
    ['cat <<EOF\n$((1+2))\nEOF\nls', [['cat'], ['ls']]],
    ['cat <<EOF\nEOF$((1))\nEOF', [['cat']]],
    ["cat <<'$((1))'\nx\n$((1))\nls", [['cat'], ['ls']]],
    ["cat <<'EOF'\n$((\nEOF\ngit push\n))", [['cat'], ['git', 'push']]],
    ['echo $((1\n+2))', [['1'], ['+2'], ['echo', '$']]],
    [
      'echo $(( $(git merge main) ))',
      [['git', 'merge', 'main'], ['$'], ['echo', '$']],
    ],
    [
      'echo $(( `git merge main` ))',
      [['git', 'merge', 'main'], ['$'], ['echo', '$']],
    ],
    ['echo $((a) ); ls', [['a'], ['echo', '$'], ['ls']]],
    ['(echo $(ab))', [['ab'], ['echo', '$']]],
    ['x=$( (a); b ) y', [['a'], ['b'], ['x=$', 'y']]],
    [
      'echo $(echo case) x',
      [
        ['echo', 'case'],
        ['echo', '$', 'x'],
      ],
    ],
    ['case x in a) b;; esac', [['case', 'x', 'in', 'a'], ['b'], ['esac']]],
  ])) {
  it(`reads substitutions as commands in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text), { commands: expected, unread: '' });
  });
}

  for (const [text, expected] of rows([
    [
      'echo ${HOME}; git merge main',
      [
        ['echo', '$'],
        ['git', 'merge', 'main'],
      ],
    ],
    ['echo "${HOME}/x"; ls', [['echo', '$/x'], ['ls']]],
    ['a${x}b', [['a$b']]],
    ['echo $HOME a$b', [['echo', '$HOME', 'a$b']]],
  ])) {
  it(`reads expansions as word parts in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text), { commands: expected, unread: '' });
  });
}

  for (const [text, expected] of rows([
    ["$'\\x67it' merge main", [['git', 'merge', 'main']]],
    ["$'\\u0067it' merge main", [['git', 'merge', 'main']]],
    ["$'\\U00000067it' merge main", [['git', 'merge', 'main']]],
    ["$'\\147it' merge main", [['git', 'merge', 'main']]],
    ["echo $'a\\'b' $'c\\\\d'", [['echo', "a'b", 'c\\d']]],
    ["echo $'a\\nb'", [['echo', 'anb']]],
    ["echo $'\\xZZ'", [['echo', 'xZZ']]],
  ])) {
  it(`decodes $'…' escapes in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text), { commands: expected, unread: '' });
  });
}

  for (const [text, commands, unread] of rows([
    ["ls; echo 'open", [['ls']], " echo 'open"],
    ['ls; echo "open', [['ls']], ' echo "open'],
    ["ls; echo $'open", [['ls']], " echo $'open"],
    ["ls; echo $'open\\", [['ls']], " echo $'open\\"],
    ['ls; echo "open\\', [['ls']], ' echo "open\\'],
    ['ls; echo ${open', [['ls']], ' echo ${open'],
    ['ls; echo "${open', [['ls']], ' echo "${open'],
    ['ls; echo $(open', [['ls']], ' echo $(open'],
    ['ls; echo `open', [['ls']], ' echo `open'],
    ['ls; echo "$(a); b', [['ls'], ['a']], ' echo "$(a); b'],
    ['ls\ncat <<\\EOF\nx\nEOF', [['ls']], 'cat <<\\EOF\nx\nEOF'],
    ['ls; cat <<EOF"x"\nx\nEOF', [['ls']], ' cat <<EOF"x"\nx\nEOF'],
    ['ls; cat <<EOF', [['ls']], ' cat <<EOF'],
    ['ls\ncat <<EOF\nnever closed', [['ls'], ['cat']], 'never closed'],
    ['cat <<EOF\nx\nEOF\necho "open', [['cat']], 'echo "open'],
    [
      'ls; git merge ${x:-$(git merge main)}',
      [['ls']],
      ' git merge ${x:-$(git merge main)}',
    ],
    ['ls; echo ${x:-`b`}', [['ls']], ' echo ${x:-`b`}'],
    ['ls; echo ${x:-"}"}', [['ls']], ' echo ${x:-"}"}'],
    ["ls; echo ${x:-'a'}", [['ls']], " echo ${x:-'a'}"],
    ['ls; echo ${x:-${y}}', [['ls']], ' echo ${x:-${y}}'],
    ['ls; echo ${x:-\\}}', [['ls']], ' echo ${x:-\\}}'],
    ['ls; echo "${x:-$y}"', [['ls']], ' echo "${x:-$y}"'],
    [
      'ls; echo $(case x in a) git merge main;; esac)',
      [['ls']],
      ' echo $(case x in a) git merge main;; esac)',
    ],
    ['ls; (a', [['ls']], 'a'],
    ['ls; echo $((1+2', [['ls']], ' echo $((1+2'],
    ['cat <<EOF\n$(open\nEOF', [['cat'], ['open']], '$(open\nEOF'],
  ])) {
  it(`stops at what it cannot follow in ${JSON.stringify(text)}, keeping the rest`, () => {
      assert.deepEqual(simpleCommands(text), { commands, unread });
    });
}

  it('reads everything it can follow', () => {
    assert.equal(simpleCommands('a; b # c').unread, '');
  });

  for (const [text, expected] of rows([
    ["$'\\U0010FFFF'", [['\u{10ffff}']]],
    [
      "echo $'\\U00110000'; git merge main",
      [
        ['echo', ''],
        ['git', 'merge', 'main'],
      ],
    ],
    ["echo $'\\UFFFFFFFF'x", [['echo', 'x']]],
  ])) {
  it(`reads a code point past Unicode as nothing in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(simpleCommands(text), { commands: expected, unread: '' });
  });
}
});

/** The readings the commit and heavy-work checks were written against. */
describe('simpleCommands for the commit and heavy-work checks', () => {
  for (const [command, expected] of rows([
    ['   ', []],
    ['git  status\t-s', [['git', 'status', '-s']]],
    ['a | b & c', [['a'], ['b'], ['c']]],
    ['(a) ; `b`', [['a'], ['b'], ['$']]],
    [`echo 'git commit; x'`, [['echo', 'git commit; x']]],
    [`echo "git commit | x"`, [['echo', 'git commit | x']]],
    [`echo "a'b"`, [['echo', "a'b"]]],
    [`echo 'a"b'`, [['echo', 'a"b']]],
    [`echo a"b c"d`, [['echo', 'ab cd']]],
    [`echo $'a;b'`, [['echo', 'a;b']]],
    [`echo $'a' b`, [['echo', 'a', 'b']]],
    [`echo 'a\\'`, [['echo', 'a\\']]],
  ])) {
  it(`reads ${JSON.stringify(command)}`, () => {
    assert.deepEqual(simpleCommands(command).commands, expected);
  });
}

  it('keeps a quote that spans lines as one word', () => {
    assert.deepEqual(simpleCommands(`git commit -m "a\nb; c"\nd`).commands, [
      ['git', 'commit', '-m', 'a\nb; c'],
      ['d'],
    ]);
    assert.deepEqual(simpleCommands(`echo 'a\nb'`).commands, [['echo', 'a\nb']]);
  });

  it('joins a backslash-newline into one command', () => {
    assert.deepEqual(simpleCommands('git \\\ncommit\nx').commands, [
      ['git', 'commit'],
      ['x'],
    ]);
    assert.deepEqual(simpleCommands('gi\\\nt commit').commands, [
      ['git', 'commit'],
    ]);
    assert.deepEqual(simpleCommands('echo "a\\\nb" c').commands, [
      ['echo', 'ab', 'c'],
    ]);
    assert.deepEqual(simpleCommands("echo 'a\\\nb'").commands, [
      ['echo', 'a\\\nb'],
    ]);
  });

  it('drops comments, but not a # inside a word', () => {
    assert.deepEqual(simpleCommands('a # git commit\nb').commands, [
      ['a'],
      ['b'],
    ]);
    assert.deepEqual(simpleCommands('#git commit').commands, []);
    assert.deepEqual(simpleCommands("echo '#' b").commands, [['echo', '#', 'b']]);
  });

  it('skips heredoc bodies up to their word', () => {
    assert.deepEqual(simpleCommands('cat <<EOF >f\ngit commit\nEOF\ngit status').commands, [['cat'], ['git', 'status']]);
    assert.deepEqual(simpleCommands('cat << X\n\tX\ngit commit\nX\nb').commands, [
      ['cat'],
      ['b'],
    ]);
    assert.deepEqual(simpleCommands('a <<A <<B\nB\ngit x\nA\ngit y\nB\ngit commit').commands, [['a'], ['git', 'commit']]);
  });

  it('opens a heredoc only after a line ends outside quotes', () => {
    assert.deepEqual(simpleCommands('a <<X "b\nc"\nX\nd').commands, [
      ['a', 'b\nc'],
      ['d'],
    ]);
  });

  it('drops a here-string as a redirection', () => {
    assert.deepEqual(simpleCommands('cat <<<x\ngit commit').commands, [
      ['cat'],
      ['git', 'commit'],
    ]);
  });

  it('stops at a heredoc word it cannot settle', () => {
    assert.deepEqual(simpleCommands('a <<\\EOF\ngit commit\nEOF'), {
      commands: [],
      unread: 'a <<\\EOF\ngit commit\nEOF',
    });
    assert.deepEqual(simpleCommands('b; a <<"$x"\ngit commit'), {
      commands: [['b']],
      unread: ' a <<"$x"\ngit commit',
    });
  });
});

describe('program', () => {
  for (const [word, expected] of rows([
    ['git', 'git'],
    ['/usr/bin/git', 'git'],
    ['./node_modules/.bin/pnpm', 'pnpm'],
  ])) {
  it(`reads ${String(word)} as ${String(expected)}`, () => {
    assert.equal(program(word), expected);
  });
}
});

describe('invoked', () => {
  for (const [words, expected] of rows([
    [[], []],
    [
      ['git', 'commit'],
      ['git', 'commit'],
    ],
    [
      ['A=1', 'B=x=y', 'git', 'commit'],
      ['git', 'commit'],
    ],
    [['A=1'], []],
    [
      ['command', 'git', 'commit'],
      ['git', 'commit'],
    ],
    [['exec', 'git'], ['git']],
    [['time', 'git'], ['git']],
    [['time', '-p', 'git'], ['git']],
    [['nohup', 'git'], ['git']],
    [['env', 'A=1', 'git'], ['git']],
    [['env', '-i', 'A=1', 'git'], ['git']],
    [['env', '-u', 'HOME', 'git'], ['git']],
    [['env', '-C', '/x', 'git'], ['git']],
    [['env', '-S', 'x', 'git'], ['git']],
    [['env', '-i'], []],
    [['nice', '-n', '5', 'git'], ['git']],
    [['nice', 'git'], ['git']],
    [['nice'], []],
    [['nice', '-n'], []],
    [['/usr/bin/nice', 'git'], ['git']],
    [['sudo', '-u', 'me', 'git'], ['git']],
    [['sudo', '-g', 'g', 'git'], ['git']],
    [['sudo', '-C', '3', 'git'], ['git']],
    [['sudo', '-D', '/', 'git'], ['git']],
    [['sudo', '-E', 'git'], ['git']],
    [['env', '--unset', 'A', 'git'], ['git']],
    [['env', '--chdir', '/x', 'git'], ['git']],
    [['env', '--split-string', 'x', 'git'], ['git']],
    [['exec', '-a', 'name', 'git'], ['git']],
    [['time', '-o', 'f', 'git'], ['git']],
    [['time', '-f', '%e', 'git'], ['git']],
    [['fi'], ['fi']],
    [
      ['nice', 'env', 'A=1', 'time', 'git', 'x'],
      ['git', 'x'],
    ],
    [['if', 'git'], ['git']],
    [['then', 'git'], ['git']],
    [['elif', 'git'], ['git']],
    [['else', 'git'], ['git']],
    [['do', 'git'], ['git']],
    [['while', '!', 'git'], ['git']],
    [['until', 'git'], ['git']],
    [['{', 'git'], ['git']],
    [['if', 'command', 'git'], ['git']],
    [
      ['echo', 'if'],
      ['echo', 'if'],
    ],
    [
      ['-p', 'git'],
      ['-p', 'git'],
    ],
    [
      ['echo', 'A=1'],
      ['echo', 'A=1'],
    ],
    [
      ['1A=x', 'git'],
      ['1A=x', 'git'],
    ],
    [
      ['-A=x', 'git'],
      ['-A=x', 'git'],
    ],
  ])) {
  it(`runs ${JSON.stringify(words)} as ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(invoked(words), expected);
  });
}
});

describe('subcommand', () => {
  const valued = new Set(['-C', '--dir']);
  for (const [args, expected] of rows([
    [[], null],
    [['-v'], null],
    [['commit'], { name: 'commit', rest: [] }],
    [['commit', '-m', 'x'], { name: 'commit', rest: ['-m', 'x'] }],
    [['-C', 'path', 'commit'], { name: 'commit', rest: [] }],
    [['--dir', 'p', '-v', 'add', 'x'], { name: 'add', rest: ['x'] }],
    [['--dir=p', 'add'], { name: 'add', rest: [] }],
    [['-C'], null],
  ])) {
  it(`reads ${JSON.stringify(args)} as ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(subcommand(args, valued), expected);
  });
}
});

describe('gitSubcommand for the merge check', () => {
  for (const [words, expected] of rows([
    [['git', 'merge', 'x'], { name: 'merge', rest: ['x'] }],
    [['/usr/bin/git', 'merge'], { name: 'merge', rest: [] }],
    [['A=1', 'B_2=x', 'git', 'pull'], { name: 'pull', rest: [] }],
    [['git', '-C', 'dir', 'merge', 'x'], { name: 'merge', rest: ['x'] }],
    [['git', '-c', 'a=b', '--no-pager', 'merge'], { name: 'merge', rest: [] }],
    [
      ['git', '--git-dir', 'd', '--work-tree', 'w', 'merge'],
      { name: 'merge', rest: [] },
    ],
    [
      ['git', '--namespace', 'n', '--config-env', 'k=V', 'pull'],
      { name: 'pull', rest: [] },
    ],
    [['git', '--git-dir=d', 'merge'], { name: 'merge', rest: [] }],
  ])) {
  it(`reads ${JSON.stringify(words)}`, () => {
    assert.deepEqual(gitSubcommand(words), expected);
  });
}

  for (const [words] of rows([
    [[]],
    [['A=1']],
    [['echo', 'git', 'merge']],
    [['legit', 'merge']],
    [['gitx', 'merge']],
    [['1A=x', 'git', 'merge']],
    [['if', 'echo', 'git']],
    [['ls', '-a', 'git']],
    [['-a', 'git', 'merge']],
    [['env', '-i']],
    [['git']],
    [['git', '-C', 'dir']],
    [['git', '--no-pager']],
  ])) {
  it(`finds no git subcommand in ${JSON.stringify(words)}`, () => {
    assert.equal(gitSubcommand(words), null);
  });
}
});

/** The readings the git and pull-request checks were written against. */
describe('simpleCommands for the git and pull-request checks', () => {
  it('drops redirections and their files', () => {
    assert.deepEqual(simpleCommands('git add a >log 2>>err b <in c &>all d 1>|e f <>g h')
        .commands, [['git', 'add', 'a', 'b', 'c', 'd', 'f', 'h']]);
    assert.deepEqual(simpleCommands('a b 2>&1 c >&- d <&0 e 10>&12 f').commands, [
      ['a', 'b', 'c', 'd', 'e', 'f'],
    ]);
    assert.deepEqual(simpleCommands('a 2>&1|b x &>>f y').commands, [
      ['a'],
      ['b', 'x', 'y'],
    ]);
    assert.deepEqual(simpleCommands('a >&1b c').commands, [['a', 'c']]);
    assert.deepEqual(simpleCommands('grep -q x <<< "$y" z\nls').commands, [
      ['grep', '-q', 'x', 'z'],
      ['ls'],
    ]);
  });

  it('keeps a redirection-like word inside quotes', () => {
    assert.deepEqual(simpleCommands(`git commit -m ">x" '<y'`).commands, [
      ['git', 'commit', '-m', '>x', '<y'],
    ]);
  });

  it('keeps a backslash inside double quotes unless it escapes', () => {
    assert.deepEqual(simpleCommands('a "q\\"t\\\\b\\$c\\`d\\n"').commands, [
      ['a', 'q"t\\b$c`d\\n'],
    ]);
    assert.deepEqual(simpleCommands('"gi\\\nt" push').commands, [
      ['git', 'push'],
    ]);
  });

  it('reads the script of a shell run with -c as commands too', () => {
    assert.deepEqual(simpleCommands("bash -c 'git push && git add -A'; ls"), {
      commands: [
        ['bash', '-c', 'git push && git add -A'],
        ['git', 'push'],
        ['git', 'add', '-A'],
        ['ls'],
      ],
      unread: '',
    });
    assert.deepEqual(simpleCommands("env A=1 sh -ec 'git commit'").commands, [
      ['env', 'A=1', 'sh', '-ec', 'git commit'],
      ['git', 'commit'],
    ]);
  });

  it('keeps what a -c script left unread, so a check can fail closed', () => {
    assert.deepEqual(simpleCommands(`bash -c 'echo "x'; sh -c 'echo "y'; git merge main`), {
      commands: [
        ['bash', '-c', 'echo "x'],
        ['sh', '-c', 'echo "y'],
        ['git', 'merge', 'main'],
      ],
      unread: 'echo "x',
    });
    assert.deepEqual(simpleCommands(`bash -c 'echo "x'; echo "open`), {
      commands: [['bash', '-c', 'echo "x']],
      unread: 'echo "x\n echo "open',
    });
  });
});

describe('roughCommands', () => {
  it('splits at every operator, parenthesis and backquote', () => {
    assert.deepEqual(roughCommands('a;b&c|d(e)f\ng`h'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(word => [word]));
  });

  it('drops quotes, backslashes and empty words', () => {
    assert.deepEqual(roughCommands(` "git"  'com\\mit'\t-m ;; ' '`), [
      ['git', 'commit', '-m'],
    ]);
  });

  it('reads nothing from nothing', () => {
    assert.deepEqual(roughCommands(''), []);
  });
});

describe('everyCommand', () => {
  it('reads the commands past where the reader stopped', () => {
    const text = 'ls; echo "$(case x in x) echo ok;; esac)"; git commit -m x';
    assert.deepEqual(simpleCommands(text).commands, [['ls']]);
    assert.deepEqual(everyCommand(text), [
      ['ls'],
      ['echo', '$'],
      ['case', 'x', 'in', 'x'],
      ['echo', 'ok'],
      ['esac'],
      ['git', 'commit', '-m', 'x'],
    ]);
  });

  it('is the commands read when the reader follows everything', () => {
    assert.deepEqual(everyCommand('a "b;c"; d'), [['a', 'b;c'], ['d']]);
  });
});

describe('shellScript', () => {
  for (const [words, script] of rows([
    [['bash', '-c', 'git push'], 'git push'],
    [['sh', '-ec', 'x'], 'x'],
    [['/bin/zsh', '-lc', 'x'], 'x'],
    [['dash', '-c', 'x', 'name'], 'x'],
    [['bash', '--norc', '-c', 'x'], 'x'],
  ])) {
  it(`reads the script of ${JSON.stringify(words)}`, () => {
    assert.equal(shellScript(words), script);
  });
}

  for (const [words] of rows([
    [['bash', 'run.sh']],
    [['bash', '-x', 'run.sh']],
    [['bash', '-c']],
    [['bash', '-c1', 'x']],
    [['bash', 'x-c', 'y']],
    [['ssh', '-c', 'x']],
    [['fish', '-c', 'x']],
    [['bashful', '-c', 'x']],
    [[]],
  ])) {
  it(`reads no script from ${JSON.stringify(words)}`, () => {
    assert.equal(shellScript(words), null);
  });
}
});

describe('gitSubcommand', () => {
  for (const [words, expected] of rows([
    [['git', 'push', '-u', 'origin'], { name: 'push', rest: ['-u', 'origin'] }],
    [['A=1', 'env', 'git', 'add', '.'], { name: 'add', rest: ['.'] }],
    [['git', '-C', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '-c', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '--config-env', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '--git-dir', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '--namespace', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '--work-tree', 'push', 'add'], { name: 'add', rest: [] }],
    [['git', '--no-pager', '--git-dir=x', 'add'], { name: 'add', rest: [] }],
  ])) {
  it(`reads ${JSON.stringify(words)} as ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(gitSubcommand(words), expected);
  });
}

  for (const [words] of rows([[['gh', 'push']], [['legit', 'push']]])) {
  it(`reads no git subcommand in ${JSON.stringify(words)}`, () => {
      assert.equal(gitSubcommand(words), null);
    });
}
});

describe('programOf', () => {
  it('reads past assignments, keeping their values, and wrappers', () => {
    assert.deepEqual(programOf(['A=1', 'B=x=y', 'env', '-i', 'C=2', 'nohup', 'git', 'push']), {
      env: new Map([
        ['A', '1'],
        ['B', 'x=y'],
        ['C', '2'],
      ]),
      args: ['git', 'push'],
    });
    assert.deepEqual(programOf(['/usr/bin/env', 'rg', 'x'])?.args, ['rg', 'x']);
  });

  for (const [words] of rows([
    [['nice', '-n', '5', 'rg', 'x']],
    [['sudo', '-u', 'alice', 'rg', 'x']],
    [['env', '-u', 'X', 'rg', 'x']],
    [['time', '-p', 'rg', 'x']],
    [['exec', '-a', 'name', 'rg', 'x']],
    [['command', '-p', 'rg', 'x']],
    [['if', 'rg', 'x']],
    [['then', '!', 'rg', 'x']],
    [['timeout', '30', 'rg', 'x']],
    [['timeout', '-s', '9', '30', 'rg', 'x']],
    [['timeout', '--signal', 'KILL', '30', 'rg', 'x']],
    [['timeout', '-k', '5', '30', 'rg', 'x']],
    [['timeout', '--kill-after', '5', '--foreground', '30', 'rg', 'x']],
    [['npx', '-y', 'rg', 'x']],
    [['npx', '-p', 'pkg', 'rg', 'x']],
    [['npx', '--package', 'pkg', 'rg', 'x']],
    [['npx', '-c', 'cmd', 'rg', 'x']],
    [['npx', '--call', 'cmd', 'rg', 'x']],
    [['pnpm', 'exec', 'rg', 'x']],
    [['pnpm', 'dev:exec', 'rg', 'x']],
    [['sudo', '-u', 'alice', 'timeout', '9', 'pnpm', 'exec', 'rg', 'x']],
  ])) {
  it(`reads rg past the runners in ${JSON.stringify(words)}`, () => {
    assert.deepEqual(programOf(words)?.args, ['rg', 'x']);
  });
}

  it('stops at any other program', () => {
    assert.deepEqual(programOf(['pnpm', 'test'])?.args, ['pnpm', 'test']);
    assert.deepEqual(programOf(['pnpm'])?.args, ['pnpm']);
    assert.deepEqual(programOf(['git', 'A=1'])?.args, ['git', 'A=1']);
    assert.deepEqual(programOf(['1A=x', 'b'])?.args, ['1A=x', 'b']);
  });

  for (const [words] of rows([
    [[]],
    [['A=1']],
    [['env', '-i']],
    [['timeout', '30']],
    [['pnpm', 'exec']],
  ])) {
  it(`names no program in ${JSON.stringify(words)}`, () => {
    assert.equal(programOf(words), null);
  });
}
});

describe('resolvePath', () => {
  it('resolves from the folder', () => {
    assert.equal(resolvePath('src/a', '/w', '/h/me'), '/w/src/a');
    assert.equal(resolvePath('../b', '/w/x', '/h/me'), '/w/b');
    assert.equal(resolvePath('/abs/../c', '/w', '/h/me'), '/c');
    assert.equal(resolvePath('', '/w', '/h/me'), '/w');
  });

  it('expands ~ and ~user at the start, $HOME anywhere', () => {
    assert.equal(resolvePath('~', '/w', '/h/me'), '/h/me');
    assert.equal(resolvePath('~/c', '/w', '/h/me'), '/h/me/c');
    assert.equal(resolvePath('~root', '/w', '/h/me'), '/h/root');
    assert.equal(resolvePath('~bob/x', '/w', '/h/me'), '/h/bob/x');
    assert.equal(resolvePath('a/~', '/w', '/h/me'), '/w/a/~');
    assert.equal(resolvePath('$HOME/c', '/w', '/h/me'), '/h/me/c');
    assert.equal(resolvePath('${HOME}', '/w', '/h/me'), '/h/me');
    assert.equal(resolvePath('../../$HOME/p', '/w/x/y', '/h/me'), '/w/h/me/p');
    assert.equal(resolvePath('/x${HOME}$HOME', '/w', '/h'), '/x/h/h');
  });

  it('leaves other expansions unknown', () => {
    assert.equal(resolvePath('$X/c', '/w', '/h'), null);
    assert.equal(resolvePath('a$', '/w', '/h'), null);
    assert.equal(resolvePath('$HOMEX/c', '/w', '/h'), null);
  });

  it('judges only absolute paths from an unknown folder', () => {
    assert.equal(resolvePath('rel', null, '/h'), null);
    assert.equal(resolvePath('/abs', null, '/h'), '/abs');
    assert.equal(resolvePath('~/c', null, '/h'), '/h/c');
  });
});

describe('steps', () => {
  it('gives each command the folder it runs in', () => {
    assert.deepEqual(steps('cd src && grep -r x; cd ../lib; rg y', '/w', '/h'), [
      { env: new Map(), args: ['grep', '-r', 'x'], dir: '/w/src' },
      { env: new Map(), args: ['rg', 'y'], dir: '/w/lib' },
    ]);
    assert.deepEqual(steps('A=1; rg y', '/w', '/h'), [
      { env: new Map(), args: ['rg', 'y'], dir: '/w' },
    ]);
    assert.deepEqual(steps('pushd /x; cd; rg y', '/w', '/h'), [
      { env: new Map(), args: ['rg', 'y'], dir: '/h' },
    ]);
  });

  for (const cd of ['cd -- /', 'cd -P /', 'cd -L -P /', 'cd -e /', 'cd -@ /']) {
  it(`reads past the options of ${String(cd)} to its folder`, () => {
      assert.deepEqual(steps(`${cd}; rg secret .`, '/w', '/h'), [
        { env: new Map(), args: ['rg', 'secret', '.'], dir: '/' },
      ]);
    });
}

  it('runs later commands in an unknown folder after an unknown cd', () => {
    assert.deepEqual(steps('rg a; cd $X; rg -r b /etc', '/w', '/h'), [
      { env: new Map(), args: ['rg', 'a'], dir: '/w' },
      { env: new Map(), args: ['rg', '-r', 'b', '/etc'], dir: null },
    ]);
    assert.deepEqual(steps('cd -; rg b', '/w', '/h'), [
      { env: new Map(), args: ['rg', 'b'], dir: null },
    ]);
    assert.deepEqual(steps('cd $X; cd /y; rg b', '/w', '/h'), [
      { env: new Map(), args: ['rg', 'b'], dir: '/y' },
    ]);
  });

  it('keeps a number set apart from a redirection as an argument', () => {
    assert.deepEqual(steps('rg -L secret 2 >out', '/w', '/h'), [
      { env: new Map(), args: ['rg', '-L', 'secret', '2'], dir: '/w' },
    ]);
  });

  it('finds a search inside shell control words', () => {
    const found = steps('if true; then rg -r secret /etc; fi', '/w', '/h').map((step) => step.args);
    assert.ok(found.some((args) => JSON.stringify(args) === JSON.stringify(['rg', '-r', 'secret', '/etc'])));
  });
});
