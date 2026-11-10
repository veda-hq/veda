// What a script's own source declares about its flags (DOC-DRIFT-02): whether
// it reads its own argv, which flags it knows, the values an enum-valued flag
// takes, its required flags and its first positional's choices.
// doc-command-rules.ts holds a documented command to them.

/** What a script's source declares about its flags. A flag here is always `--name` or `-x` (`[\w-]` only), so it goes into a pattern unescaped. */
export interface FlagSpec {
  /** The source reads its own argv: every flag must appear in it. */
  readonly closed: boolean;
  known(flag: string): boolean;
  /** Allowed values for an enum-valued flag, if the source declares them. */
  values(flag: string): Set<string> | undefined;
  /** Flags the parser declares required (argparse `required=True`). */
  readonly required: string[];
  /**
   * How many words after `flag` are its values (argparse: an `add_argument`
   * of the root parser; `nargs=2` takes two, `*`, `+` or a count the source
   * does not spell out take every word up to the next option). A flag-only
   * action or a flag the parser does not declare takes none.
   */
  valueCount(flag: string): number;
  /** Choices of the first positional argument, if declared. */
  readonly positional: Set<string> | undefined;
}

/** argparse actions that take no value: the flag alone is the input. */
const FLAG_ONLY_ACTIONS: readonly string[] = ['store_true', 'store_false', 'store_const', 'append_const', 'count', 'help', 'version'];

/** The keyword arguments in an `add_argument` call's text, each value unquoted. A string is read whole, so `help="nargs=0"` is one argument. */
const keywordArguments = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/"[^"]*"|'[^']*'|(\w+)\s*=\s*("[^"]*"|'[^']*'|[^,"']*)/g)) {
    if (match[1] !== undefined) out.set(match[1], String(match[2]).trim().replace(/^["']|["']$/g, ''));
  }
  return out;
};

/** Words an argparse option with these keyword arguments takes. */
const argparseValueCount = (kwargs: Map<string, string>): number => {
  const action = kwargs.get('action');
  if (action !== undefined && (FLAG_ONLY_ACTIONS.includes(action) || action.endsWith('BooleanOptionalAction'))) return 0;
  const nargs = kwargs.get('nargs');
  if (nargs === undefined || nargs === '?') return 1;
  return /^\d+$/.test(nargs) ? Number(nargs) : Infinity;
};

const quotedValues = (text: string): Set<string> => new Set([...text.matchAll(/["']([^"']+)["']/g)].map((m) => String(m[1])));

/** What a script's own source declares about its flags. */
export const flagSpec = (source: string, path: string): FlagSpec => {
  const shell = /\.(sh|bash)$/.test(path) || !/\.\w+$/.test(path);
  const python = path.endsWith('.py');
  // A script that hands its arguments on cannot be judged from its own text.
  // Nor can a shell script that sources a file: the file runs with the
  // script's own arguments, so its flags may be read there.
  const forwards = shell
    ? /"\$@"|\$\*|"\$\{@\}"|\$@|^\s*(?:source|\.)\s/m.test(source)
    : python
      ? /parse_known_args|sys\.argv\[1:\]\s*\)/.test(source) && !/add_argument/.test(source)
      : /strict:\s*false/.test(source);

  const values = (flag: string): Set<string> | undefined => {
    const usage = new RegExp(`${flag}[ =]<([\\w.:-]+(?:\\|[\\w.:-]+)+)>`).exec(source);
    if (usage !== null) return new Set(String(usage[1]).split('|'));
    const braces = new RegExp(`${flag}[ =]\\{([\\w.:-]+(?:,[\\w.:-]+)+)\\}`).exec(source);
    if (braces !== null) return new Set(String(braces[1]).split(','));
    const choices = new RegExp(`add_argument\\(\\s*["']${flag}["'][^)]*?choices\\s*=\\s*[[(]([^\\])]*)[\\])]`).exec(source);
    return choices === null ? undefined : quotedValues(String(choices[1]));
  };

  // With subparsers, an argument a subcommand's parser adds (`x =
  // subs.add_parser(…)`, or chained on one) is that subcommand's: not
  // required of every invocation, and not the first word.
  const subcommands = /add_subparsers/.test(source);
  const local = new Set([...source.matchAll(/(\w+)\s*=\s*[\w.]+\.add_parser\(/g)].map((m) => String(m[1])));
  const calls = python
    ? [...source.matchAll(/(?:(\w+)|\))\.add_argument\(\s*["']([\w-]+)["']((?:\s*,\s*["'][\w-]+["'])*)([^)]*)/g)]
        .filter((match) => !subcommands || (match[1] !== undefined && !local.has(match[1])))
        .map((match) => ({
          name: String(match[2]),
          // Every option string: `add_argument("-o", "--out")` is both.
          aliases: [String(match[2]), ...Array.from(String(match[3]).matchAll(/["']([\w-]+)["']/g), (m) => String(m[1]))],
          rest: String(match[4]),
        }))
    : [];
  const required = calls.filter((call) => call.name.startsWith('--') && /required\s*=\s*True/.test(call.rest)).map((call) => call.name);
  // The first positional's own choices. A call's text ends at its first `)`, so a tuple of choices runs to the end of it.
  const first = calls.find((call) => !call.name.startsWith('-'));
  const choices = first === undefined ? null : /choices\s*=\s*[[(]([^\])]*)/.exec(first.rest);

  return {
    closed: !forwards,
    known: (flag) => {
      if (flag === '--help' || flag === '-h') return true;
      if (new RegExp(`${flag}(?![\\w-])`).test(source)) return true;
      // node:util parseArgs declares `name: { type: … }` without dashes.
      const key = flag.replace(/^--/, '');
      return new RegExp(`(?:^|[\\s{,])['"]?${key}['"]?\\s*:\\s*\\{[^}]*\\btype\\s*:`).test(source);
    },
    values,
    required,
    valueCount: (flag) => {
      const call = calls.find((each) => each.aliases.includes(flag));
      return call === undefined ? 0 : argparseValueCount(keywordArguments(call.rest));
    },
    positional: choices === null ? undefined : quotedValues(String(choices[1])),
  };
};
