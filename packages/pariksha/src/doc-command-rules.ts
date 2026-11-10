// DOC-DRIFT-02, the command as written runs: `--filter` before the script,
// every flag known to the script it reaches, required flags present,
// enum-valued flags given a value the script accepts, and (when the config
// names a runner) a `.ts` file started through one.
//
// doc-commands.ts reads the commands, doc-command-targets.ts finds the script
// each runs, and doc-flag-spec.ts reads what that script declares.
import { posix } from 'node:path';
import { interpreterTarget, INTERPRETERS, nestedCommands, ownArgs, parsePnpm, scriptIndex, scriptTarget, type Target } from './doc-command-targets.ts';
import { documentedCommands } from './doc-commands.ts';
import type { Config } from './doc-references-config.ts';
import { flagSpec, type FlagSpec } from './doc-flag-spec.ts';
import type { ScriptBodies, ScriptProblem } from './doc-scripts.ts';

export interface CommandContext extends ScriptBodies {
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

/** Text of a script plus the relative modules it imports directly. */
const sourceWithImports = (context: CommandContext, path: string): string => {
  const own = context.read(path) ?? '';
  const parts = [own];
  // Only a JS/TS module's imports are its own code.
  if (!/\.[cm]?[jt]sx?$/.test(path)) return own;
  for (const match of own.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = posix.join(posix.dirname(path), String(match[1]));
    const imported = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, base.replace(/\.js$/, '.ts')].map((candidate) => context.read(candidate)).find((text) => text !== undefined);
    if (imported !== undefined) parts.push(imported);
  }
  return parts.join('\n');
};

const LOADER_OPTIONS: ReadonlySet<string> = new Set(['--import', '--loader', '--experimental-loader', '--require', '-r']);
const STRIP_OPTIONS: ReadonlySet<string> = new Set(['--experimental-strip-types', '--experimental-transform-types']);

/**
 * The `.ts` script an interpreter starts without a TypeScript loader, if it
 * starts one. The script is the first word after the interpreter's options.
 * Only node takes a loader, and only a tsx one (`--import tsx`,
 * `--loader=tsx/esm`, `-r tsx/cjs`) or a type-stripping flag before the
 * script runs TypeScript; bash and python run the file as their own language.
 */
const typeScriptStartedWithout = (words: readonly string[]): string | undefined => {
  if (!['node', 'bash', 'sh', 'python', 'python3'].includes(String(words[0]))) return undefined;
  const at = scriptIndex(words, 0);
  const script = words[at];
  if (script === undefined || !script.endsWith('.ts')) return undefined;
  if (words[0] !== 'node') return script;
  const options = words.slice(1, at);
  const loader = options.some((word, index) => {
    const [name = '', inline] = word.split(/=(.*)/s);
    return STRIP_OPTIONS.has(name) || (LOADER_OPTIONS.has(name) && /^tsx(?:\/|$)/.test(String(inline ?? options[index + 1])));
  });
  return loader ? undefined : script;
};

/**
 * The first positional word of `args`: options skipped, and the values the
 * spec says each takes (`--out result destroy` names `destroy`). Values end
 * at the next option.
 */
const firstPositional = (args: readonly string[], spec: FlagSpec): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const word = String(args[index]);
    if (!word.startsWith('-')) return word;
    for (let count = spec.valueCount(word); count > 0 && args[index + 1]?.startsWith('-') === false; count -= 1) index += 1;
  }
  return undefined;
};

const FLAG = /^--[\w-]+(=|$)/;

/** Runs the DOC-DRIFT-02 command rules over the commands in `files`. */
export const findCommandProblems = (config: Config, context: CommandContext, files: readonly string[]): ScriptProblem[] => {
  const problems: ScriptProblem[] = [];
  const runner = config.commands.typescriptRunner;
  const nested = nestedCommands(config.commands.nested);
  const specs = new Map<string, FlagSpec>();
  const specFor = (path: string): FlagSpec => {
    const cached = specs.get(path);
    if (cached !== undefined) return cached;
    const spec = flagSpec(sourceWithImports(context, path), path);
    specs.set(path, spec);
    return spec;
  };
  // join normalizes, and never leaves a leading `./`.
  const resolveFrom = (dir: string, path: string): string | undefined => {
    const candidate = posix.join(dir, path);
    return context.exists(candidate) ? candidate : undefined;
  };

  for (const file of files) {
    const content = context.read(file);
    if (content === undefined) continue;
    for (const command of documentedCommands(file, content, config.exemptMarker)) {
      const { words } = command;
      const head = String(words[0]);
      const report = (script: string, reason: string): void => {
        problems.push({ file, line: command.line, script, reason });
      };
      if (runner !== undefined) {
        // A `.ts` file started by anything but the runner.
        if (head.endsWith('.ts')) {
          report(head, `\`${head}\` is TypeScript run as a program — start it with \`${runner} ${head}\``);
          continue;
        }
        const script = typeScriptStartedWithout(words);
        if (script !== undefined) {
          report(script, `\`${head} ${script}\` does not run TypeScript here — use \`${runner} ${script}\``);
          continue;
        }
      }

      let target: Target | undefined;
      if (head === 'pnpm') {
        const pnpm = parsePnpm(words);
        if (pnpm.exec !== undefined) {
          target = interpreterTarget(['exec', ...pnpm.exec], (path) => resolveFrom(posix.join(command.cwd, pnpm.dir ?? ''), path) ?? resolveFrom('', path));
        } else if (pnpm.script !== undefined) {
          const scope = pnpm.filter ?? (command.cwd === '' ? '.' : command.cwd);
          const body = context.scripts.get(scope)?.get(pnpm.script);
          const dir = context.scopeDirs.get(scope);
          // A package script's own options come first; `--filter` among them
          // reaches the script, not pnpm. After a positional word it belongs
          // to a nested command, and a bin such as turbo has a --filter of its own.
          const misplaced = pnpm.args.findIndex((word) => /^(--filter|-F)(=|$)/.test(word));
          const before = pnpm.args.slice(0, misplaced);
          if (body !== undefined && misplaced !== -1 && before.every((word) => word.startsWith('-')) && !before.includes('--')) {
            report(pnpm.script, `\`${String(pnpm.args[misplaced])}\` after \`${pnpm.script}\` is handed to the script, not to pnpm — write \`pnpm --filter <pkg> ${pnpm.script}\``);
            continue;
          }
          if (body !== undefined && dir !== undefined) {
            const inner = scriptTarget(body, dir, resolveFrom, nested);
            if (inner !== undefined) target = { path: inner.path, args: pnpm.args[0] === '--' ? pnpm.args.slice(1) : pnpm.args };
          } else if (INTERPRETERS.has(pnpm.script)) {
            target = interpreterTarget([pnpm.script, ...pnpm.args], (path) => resolveFrom(command.cwd, path) ?? resolveFrom('', path));
          }
        }
      } else {
        target = interpreterTarget(words, (path) => resolveFrom(command.cwd, path) ?? resolveFrom('', path));
      }
      if (target === undefined) continue;

      const { path } = target;
      const spec = specFor(path);
      const args = ownArgs(target.args, nested);
      const flags = args.filter((word) => FLAG.test(word));
      if (spec.closed) {
        for (const word of flags) {
          const flag = String(word.split('=')[0]);
          if (!spec.known(flag)) report(flag, `\`${flag}\` is not a flag of \`${path}\` — the script never reads it`);
        }
      }
      args.forEach((word, index) => {
        if (!FLAG.test(word)) return;
        const [flag = '', inline] = word.split(/=(.*)/s);
        const allowed = spec.values(flag);
        const value = inline ?? args[index + 1];
        if (allowed !== undefined && value !== undefined && /^[\w.:/-]+$/.test(value) && !value.startsWith('-') && !allowed.has(value)) {
          report(flag, `\`${flag} ${value}\` — \`${path}\` accepts ${[...allowed].join(', ')}`);
        }
      });
      // `python3 x.py collects …` names the program; only a command with arguments, or one in a fence, is an invocation to complete.
      if (!flags.includes('--help') && (command.fenced || args.length > 0)) {
        for (const flag of spec.required) {
          if (!flags.some((word) => word.split('=')[0] === flag)) report(flag, `\`${path}\` requires \`${flag}\`; the documented command omits it`);
        }
      }
      if (spec.positional !== undefined) {
        const first = firstPositional(args, spec);
        if (first !== undefined && /^\w[\w-]*$/.test(first) && !spec.positional.has(first)) report(first, `\`${first}\` is not an action of \`${path}\` (${[...spec.positional].join(', ')})`);
      }
    }
  }
  return problems;
};
