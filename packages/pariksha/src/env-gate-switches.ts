// env-gate-switches: no gate code reads an environment variable that switches
// it off.
//
// A hook that reads `FOO_SKIP` or `FOO_PROBE` from the environment has a
// bypass anyone can type: `FOO_SKIP=1 git push`. This check refuses READING an
// environment variable whose name has a switch word (by default SKIP or PROBE:
// `X_SKIP`, `SKIP_X`, `X_PROBE_Y`) in gate code: the paths the product's config
// names (git hooks, agent hooks, the scripts they run, CI workflows), as shell,
// TypeScript and JavaScript (read by the TypeScript checker), Python and
// workflow YAML.
//
// What is not a read: a shell variable the file itself initialises at the top
// level before reading it (`DOCKER_SKIP=""` … `$DOCKER_SKIP`) holds the
// script's own decision, not the caller's. A self-defaulting assignment
// (`X_SKIP="${X_SKIP:-0}"`) is a read, and so is an assignment inside a branch,
// loop, function or group (indented or not), which a run may never reach, and
// `X_SKIP=1 cmd`, which sets cmd's environment only.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type * as TS from 'typescript';
import { gitAt, must, PLAIN_DIFF, type Git } from './git.ts';
import type { Ts } from './typescript.ts';

export interface Config {
  /** Where gate code lives: path regexes, any one matching. */
  readonly gatePaths: readonly RegExp[];
  /** Paths under a gate path that are not gate code (tests, fixtures, docs). */
  readonly notGateCode: readonly RegExp[];
  /** Switches that turn off something other than a gate, each in its own files, with the reason. */
  readonly notAGate: Readonly<Record<string, { readonly files: readonly string[]; readonly reason: string }>>;
  /** The words that make a name a switch. */
  readonly words: readonly string[];
}

export const DEFAULT_WORDS: readonly string[] = ['SKIP', 'PROBE'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');
/** A normalized relative POSIX path, as git prints one. */
const isRepoPath = (p: string): boolean => !isAbsolute(p) && posix.normalize(p) === p && p !== '.' && p !== '..' && !p.startsWith('../') && !p.endsWith('/');

const patterns = (raw: Record<string, unknown>, key: string): RegExp[] => {
  const v = raw[key] ?? [];
  if (!isStrings(v)) throw new Error(`"${key}" must be a list of non-empty regular expressions`);
  return v.map((source) => {
    try {
      return new RegExp(source);
    } catch (e) {
      throw new Error(`${key}: "${source}" is not a regular expression: ${(e as Error).message}`);
    }
  });
};

/** A name made of words, one of them a switch word. */
const switchName = (words: readonly string[]): string => String.raw`(?:[A-Z][A-Z0-9]*_)*(?:${words.join('|')})(?:_[A-Z0-9]+)*`;

/** The config a JSON text names; throws naming the first bad key. */
export const parseConfig = (text: string): Config => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !['gatePaths', 'notGateCode', 'notAGate', 'words'].includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const gatePaths = patterns(raw, 'gatePaths');
  if (gatePaths.length === 0) throw new Error('"gatePaths" is empty, so nothing would be checked');
  const notGateCode = patterns(raw, 'notGateCode');
  const words = raw['words'] ?? DEFAULT_WORDS;
  if (!Array.isArray(words) || words.length === 0) throw new Error('"words" must be a non-empty list');
  const badWord = words.find((w) => typeof w !== 'string' || !/^[A-Z0-9]+$/.test(w));
  if (badWord !== undefined) throw new Error(`words: ${JSON.stringify(badWord)} is not an upper-case word ([A-Z0-9]+)`);
  const isSwitch = new RegExp(`^${switchName(words as string[])}$`);
  const allowed = raw['notAGate'] ?? {};
  if (!isRecord(allowed)) throw new Error('"notAGate" must be an object');
  const notAGate: Record<string, { files: string[]; reason: string }> = {};
  for (const [name, entry] of Object.entries(allowed)) {
    if (!isSwitch.test(name)) throw new Error(`notAGate: "${name}" is not a switch name, so it allows nothing`);
    if (!isRecord(entry)) throw new Error(`notAGate.${name} must be an object`);
    const extra = Object.keys(entry).find((k) => k !== 'files' && k !== 'reason');
    if (extra !== undefined) throw new Error(`notAGate.${name}: unknown key "${extra}"`);
    const { files, reason } = entry;
    if (!isStrings(files) || files.length === 0) throw new Error(`notAGate.${name}.files must be a non-empty list of paths`);
    const bad = files.find((f) => !isRepoPath(f));
    if (bad !== undefined) throw new Error(`notAGate.${name}.files: "${bad}" is not a normalized root-relative path`);
    // Allowing a switch is a decision a reviewer can see, not a baseline.
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`notAGate.${name} needs a reason`);
    notAGate[name] = { files, reason };
  }
  return { gatePaths, notGateCode, notAGate, words: words as string[] };
};

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

type Kind = 'shell' | 'script' | 'python' | 'workflow';

const kindOf = (file: string): Kind | null => {
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'script';
  if (file.endsWith('.py')) return 'python';
  if (/\.ya?ml$/.test(file)) return 'workflow';
  if (file.endsWith('.sh') || file.startsWith('.husky/')) return 'shell';
  return null;
};

/** Whether reading `file` needs the TypeScript compiler. */
export const needsTypescript = (file: string): boolean => kindOf(file) === 'script';

/** A match's group, as a string: an unmatched optional group is empty. */
const group = (match: RegExpMatchArray, index: number): string => match[index] ?? '';

/**
 * A type checker over this one file and nothing else (no lib, no imports, no
 * `@types`): enough to resolve which declaration each identifier names. The
 * host serves the parsed tree itself; the program asks it for nothing else,
 * and emits nothing.
 */
const checkerOf = (ts: Ts, tree: TS.SourceFile): TS.TypeChecker => {
  const options: TS.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === tree.fileName ? tree : undefined);
  return ts.createProgram({ rootNames: [tree.fileName], options, host }).getTypeChecker();
};

/**
 * JavaScript and TypeScript are read as a syntax tree, not as text, so a
 * comment or string that merely mentions `process.env.X_SKIP` is not a read,
 * and every spelling of an access is: dotted, bracketed, optional-chained
 * (`process?.['env']?.['X_SKIP']`), destructured, `'X_SKIP' in env`, and
 * each through any local bound to the environment.
 */
const scriptSwitchReads = (ts: Ts, file: string, source: string, report: (out: Violation[], file: string, line: number, name: string | null) => void): Violation[] => {
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(`/gate/${file}`, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: TS.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  const strip = (node: TS.Expression): TS.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  /**
   * The string a key expression always evaluates to, or null: a literal, a
   * template or `+` of such parts, or a `const` bound to one, so
   * `env['GATE_' + 'SKIP']` and `const KEY = 'GATE_SKIP'; env[KEY]` name
   * their switch as surely as `env.GATE_SKIP` does.
   */
  const constants = new Set<TS.Node>();
  const constantString = (node: TS.Expression): string | null => {
    const target = strip(node);
    if (ts.isStringLiteralLike(target)) return target.text;
    if (ts.isTemplateExpression(target)) {
      let text = target.head.text;
      for (const span of target.templateSpans) {
        const part = constantString(span.expression);
        if (part === null) return null;
        text += part + span.literal.text;
      }
      return text;
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      // One unknown operand leaves the sum unknown.
      const parts = [constantString(target.left), constantString(target.right)];
      return parts.includes(null) ? null : parts.join('');
    }
    if (!ts.isIdentifier(target)) return null;
    const declaration = symbolOf(target)?.declarations?.at(0);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
      constants.has(declaration)
    ) {
      return null;
    }
    constants.add(declaration);
    try {
      return constantString(declaration.initializer);
    } finally {
      constants.delete(declaration);
    }
  };
  /** The name an access or binding key names, or null. */
  const literalKey = (node: TS.Node | undefined): string | null => {
    if (node === undefined) return null;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return constantString(node.expression);
    return null;
  };
  const accessed = (node: TS.PropertyAccessExpression | TS.ElementAccessExpression): string | null => (ts.isPropertyAccessExpression(node) ? node.name.text : constantString(node.argumentExpression));
  /** Locals bound to the `process` module (`import proc from 'node:process'`). */
  const processAliases = new Set<TS.Symbol>();
  /** The file declares something named `process`, which may shadow Node's. */
  let declaresProcess = false;
  /**
   * A `process` destructured in a variable declaration is the global only
   * when it takes the `process` member of `globalThis` or `global`; from any
   * other initialiser it is that object's. Where the source is not in view
   * (a parameter, a nested or array pattern) it is taken as the global.
   */
  const destructuredGlobal = (element: TS.BindingElement): boolean => {
    const pattern = element.parent;
    const holder = pattern.parent;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(holder) || holder.initializer === undefined) {
      return true;
    }
    const from = strip(holder.initializer);
    if (!ts.isIdentifier(from) || !['globalThis', 'global'].includes(from.text)) return false;
    // A computed key that is not a constant may name `process` at run time.
    const key = literalKey(element.propertyName ?? element.name);
    return key === null || key === 'process';
  };
  /**
   * `process`, or `globalThis.process`: not any object's `process` member,
   * nor a local `process` that holds an ordinary object.
   */
  const isProcess = (node: TS.Expression): boolean => {
    const target = strip(node);
    if (requiresProcess(target)) return true;
    if (ts.isIdentifier(target)) {
      if (target.text === 'process') {
        if (!declaresProcess) return true;
        const declaration = symbolOf(target)?.declarations?.at(0);
        if (declaration !== undefined && ts.isBindingElement(declaration)) return destructuredGlobal(declaration);
        // Typed `NodeJS.Process` or `typeof globalThis.process`.
        return namedIsGlobal(target, /\bprocess\b/i, isProcess);
      }
      if (processAliases.size === 0) return false;
      const symbol = symbolOf(target);
      return symbol !== undefined && processAliases.has(symbol);
    }
    if (!(ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) || accessed(target) !== 'process') {
      return false;
    }
    const owner = strip(target.expression);
    return ts.isIdentifier(owner) && ['globalThis', 'global'].includes(owner.text);
  };

  // Locals bound to the environment, by BINDING (the checker's symbol), so an
  // alias in one function says nothing about a same-named local in another.
  // A name `env` is always one (a parameter or a destructured `{ env }`).
  // The checker is built only for a file that aliases the environment.
  const receivers = new Set<TS.Symbol>();
  let checker: TS.TypeChecker | null = null;
  const symbolOf = (identifier: TS.Identifier): TS.Symbol | undefined => {
    checker ??= checkerOf(ts, tree);
    // A shorthand `{ env }` names the variable it assigns, not a property.
    return ts.isShorthandPropertyAssignment(identifier.parent) ? checker.getShorthandAssignmentValueSymbol(identifier.parent) : checker.getSymbolAtLocation(identifier);
  };
  const bind = (identifier: TS.Identifier): void => {
    const symbol = symbolOf(identifier);
    if (symbol !== undefined) receivers.add(symbol);
  };
  /**
   * A local named `env` is taken as the environment (`function gate(env)`
   * called with `process.env`, `import { env } from 'node:process'`) unless
   * its declaration gives it a type that is not `ProcessEnv`: then it is an
   * ordinary object (`check(env: { PUSH_SKIP: boolean })`). A local named
   * `process` is Node's `process` on the same terms, its type `Process`;
   * where nothing in the file declares it, it is the global itself.
   */
  const resolving = new Set<TS.Node>();
  const namedIsGlobal = (identifier: TS.Identifier, type: RegExp, holds: (node: TS.Expression) => boolean): boolean => {
    const declaration = symbolOf(identifier)?.declarations?.at(0);
    if (declaration === undefined || !(ts.isParameter(declaration) || ts.isVariableDeclaration(declaration))) return true;
    // Initialised (or defaulted) with the global, it is the global, whatever
    // its annotation.
    const init = declaration.initializer;
    if (init !== undefined && !resolving.has(declaration)) {
      resolving.add(declaration);
      try {
        if (holds(init)) return true;
      } finally {
        resolving.delete(declaration);
      }
    }
    if (declaration.type !== undefined) return type.test(declaration.type.getText(tree));
    // An untyped variable is what it is initialised with (`const env =
    // { PUSH_SKIP: false }` is an object); an untyped parameter is taken as
    // the global, which callers pass under its own name.
    return ts.isParameter(declaration);
  };
  const isEnv = (node: TS.Expression): boolean => {
    const target = strip(node);
    if (ts.isIdentifier(target)) {
      // A binding already shown to hold the environment is one, whatever
      // its name or annotation (`const env: Record<…> = process.env`).
      if (receivers.size > 0) {
        const symbol = symbolOf(target);
        if (symbol !== undefined && receivers.has(symbol)) return true;
      }
      return target.text === 'env' && namedIsGlobal(target, /\bProcessEnv\b/, isEnv);
    }
    if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && accessed(target) === 'env') {
      return isProcess(target.expression);
    }
    return false;
  };

  const declarations: TS.VariableDeclaration[] = [];
  // `settings = process.env` after `let settings;` aliases it as surely as an
  // initialiser does (`||=`, `??=` and `&&=` too).
  const assignments: { name: TS.Identifier; value: TS.Expression }[] = [];
  // `({ PUSH_SKIP } = process.env)` reads as a destructuring declaration
  // does, and `({ env: settings } = process)` aliases the environment.
  const assigned: { pattern: TS.ObjectLiteralExpression; value: TS.Expression }[] = [];
  const ASSIGNING = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
  /** Each `key: target` of an assignment pattern, shorthand included. */
  const patternEntries = (pattern: TS.ObjectLiteralExpression): { key: string | null; target: TS.Expression }[] =>
    pattern.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [{ key: property.name.text, target: property.name }];
      if (ts.isPropertyAssignment(property)) return [{ key: literalKey(property.name), target: property.initializer }];
      return [];
    });
  const PROCESS_MODULES = new Set(['process', 'node:process']);
  /** `require('node:process')`. */
  const requiresProcess = (node: TS.Expression): boolean => {
    const target = strip(node);
    if (!ts.isCallExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== 'require') return false;
    const [only, ...more] = target.arguments;
    return only !== undefined && more.length === 0 && ts.isStringLiteralLike(only) && PROCESS_MODULES.has(only.text);
  };
  // The process module under another name is `process`; its `env` export
  // under another name is the environment.
  const aliasProcessModule = (clause: TS.ImportClause | undefined): void => {
    if (clause === undefined) return;
    const addProcess = (identifier: TS.Identifier): void => {
      const symbol = symbolOf(identifier);
      if (symbol !== undefined) processAliases.add(symbol);
    };
    if (clause.name !== undefined) addProcess(clause.name);
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      addProcess(bindings.name);
      return;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'env') bind(element.name);
      if (imported === 'default') addProcess(element.name);
    }
  };
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      aliasProcessModule(node.importClause);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && requiresProcess(node.initializer)) {
      const symbol = symbolOf(node.name);
      if (symbol !== undefined) processAliases.add(symbol);
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    // Any name `process` (a parameter, a variable, a function, a member):
    // only then can a bare `process` be something other than Node's.
    const { parent } = node;
    if (ts.isIdentifier(node) && node.text === 'process' && 'name' in parent && parent.name === node) declaresProcess = true;
    if (ts.isBinaryExpression(node) && ASSIGNING.has(node.operatorToken.kind)) {
      const left = strip(node.left);
      if (ts.isIdentifier(left)) assignments.push({ name: left, value: node.right });
      if (ts.isObjectLiteralExpression(left)) assigned.push({ pattern: left, value: node.right });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);

  // An alias of an alias is still the environment: grow to a fixed point.
  let size = -1;
  while (size !== receivers.size) {
    size = receivers.size;
    for (const { name, value } of assignments) {
      if (isEnv(value)) bind(name);
    }
    for (const { pattern, value } of assigned) {
      if (!isProcess(value)) continue;
      for (const { key, target } of patternEntries(pattern)) {
        const bound = strip(target);
        if (key === 'env' && ts.isIdentifier(bound)) bind(bound);
      }
    }
    for (const declaration of declarations) {
      const init = declaration.initializer;
      if (init === undefined) continue;
      if (ts.isIdentifier(declaration.name) && isEnv(init)) bind(declaration.name);
      if (ts.isObjectBindingPattern(declaration.name) && isProcess(init)) {
        for (const element of declaration.name.elements) {
          const key = literalKey(element.propertyName ?? element.name);
          if (key === 'env' && ts.isIdentifier(element.name)) bind(element.name);
        }
      }
    }
  }

  const out: Violation[] = [];
  const found = (node: TS.Node, name: string | null): void => report(out, file, lineOf(node), name);
  /** `env.X = v` and `delete env.X` write the variable; they never read it. */
  const writesOnly = (node: TS.Node): boolean => {
    let child = node;
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    return (ts.isBinaryExpression(parent) && parent.left === child && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ts.isDeleteExpression(parent);
  };
  const reads = (node: TS.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isEnv(node.expression) && !writesOnly(node)) {
      found(node, accessed(node));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && isEnv(node.right)) {
      found(node, constantString(node.left));
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isEnv(node.initializer)) {
      for (const element of node.name.elements) found(element, literalKey(element.propertyName ?? element.name));
    }
    ts.forEachChild(node, reads);
  };
  reads(tree);
  for (const { pattern, value } of assigned) {
    if (!isEnv(value)) continue;
    for (const { key } of patternEntries(pattern)) found(pattern, key);
  }
  return out;
};

const ARITHMETIC_PARTS = [
  // `(( X ))` and `$(( X ))`, up to the closing `))`.
  /\(\(((?:[^)]|\)(?!\)))*)\)\)/g,
  // `let X+1`, to the end of its command.
  /\blet\s+([^;&|#]*)/g,
  // An integer comparison's operands (`[[ X -eq 1 ]]`).
  /(\b[A-Za-z_]\w*\s+)-(?:eq|ne|lt|le|gt|ge)\b/g,
  /-(?:eq|ne|lt|le|gt|ge)(\s+[A-Za-z_]\w*)\b/g,
  // An indexed array's subscript (`${list[X]}`).
  /\$\{\w+\[([^\]]*)\]/g,
];

/**
 * Shell code with each bare switch name in an arithmetic context written as
 * the read it is: bash evaluates `(( PUSH_SKIP ))`, `let`, `[[ X -eq 1 ]]`
 * and array subscripts by reading the variable, no `$` needed.
 */
const arithmeticAsReads = (code: string, bareSwitch: RegExp): string => {
  let out = code;
  for (const part of ARITHMETIC_PARTS) {
    out = out.replace(part, (whole, inner: string) => whole.replace(inner, inner.replace(bareSwitch, '$$$1')));
  }
  return out;
};

const OPENS = /(?:^\s*|[;&|(]\s*|\b(?:then|do|else)\s+)(?:if|case|while|until|for|select)\b/g;
const CLOSES = /(?:^|[;&|\s])(?:fi|esac|done)(?=\s*(?:$|[;&|)#]))/g;

/**
 * How deep in shell control flow each line starts: 0 is code every run
 * reaches. An `if`, `case` or loop body, and a function or `{ … }` group, is
 * deeper: an assignment there may never run (`if false; then X_SKIP=0; fi`).
 */
const shellDepths = (lines: readonly (string | null)[]): number[] => {
  let depth = 0;
  return lines.map((line) => {
    // A heredoc line is data: it opens and closes nothing.
    if (line === null) return depth;
    // `shellLines` has already dropped every comment.
    const code = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
    const start = depth;
    const opens = (code.match(OPENS) ?? []).length;
    const closes = (code.match(CLOSES) ?? []).length;
    const braceOpens = (code.match(/(?:^|\s|\))\{(?=\s|$)/g) ?? []).length;
    const braceCloses = (code.match(/(?:^|[;\s])\}(?=\s*(?:$|[;&|)#]))/g) ?? []).length;
    // A `( … )` subshell: its assignments never reach the parent shell.
    // Indented or after `then`/`do`/`else` too, as OPENS reads, and as a
    // function's body (`gate() (`), as a `{` group can be.
    const subshellOpens = (code.match(/(?:^\s*|[;&|)]\s*|\b(?:then|do|else)\s+)\((?!\()/g) ?? []).length;
    const subshellCloses = (code.match(/(?:^|[;\s])\)(?=\s*(?:$|[;&|)#]))/g) ?? []).length;
    depth = Math.max(0, depth + opens + braceOpens + subshellOpens - closes - braceCloses - subshellCloses);
    return start;
  });
};

/**
 * A value that is one shell word, so `X=v` sets a variable, not `X=v cmd`'s
 * env. Unquoted operators are refused: `X=0&` or `X=0 | cat` assigns in a
 * background or pipeline subshell and leaves the caller's value in place.
 * A `$( … )` substitution and one trailing `;` are allowed.
 */
const ONE_WORD = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^()]*\)|[^\s'"&|;<>()`])*\s*;?\s*(?:#.*)?$/;

/**
 * The line a shell file first initialises `name` where every run reaches it
 * (top level, outside any branch, loop, function or group), or null. A
 * heredoc body is data, so `X_SKIP=0` printed by `cat <<'EOF'` is none.
 */
const initialisedAt = (lines: readonly string[], shell: readonly ShellLine[], depths: readonly number[], name: string): number | null => {
  const assignment = new RegExp(`^(?:export\\s+|readonly\\s+)?${name}=(.*)$`);
  // The command on the line above, and the last non-blank command before this line.
  let above: string | null = null;
  let prior: string | undefined;
  for (const [index, line] of shell.entries()) {
    const lineAbove = above;
    const priorCommand = prior;
    above = line.command;
    if (line.command !== null && line.command.trim() !== '') prior = line.command;
    // Heredoc data, and text inside a string an earlier line opened, assign
    // nothing.
    if (line.command === null || line.quoted) continue;
    const match = assignment.exec(lines[index] ?? '');
    if (match === null) continue;
    // `false && \` or `false &&` on the line above makes this line the end of
    // a conditional list: the assignment may never run.
    // After `&&`, `||` or `|` bash reads on past blank and comment lines
    // (`false &&`, a blank line, `X_SKIP=0`) and past a heredoc's lines
    // (`cat <<EOF &&`, its body, `EOF`); a `\` joins only the next one.
    if (lineAbove !== null && /\\\s*$/.test(lineAbove)) continue;
    if (priorCommand !== undefined && /(?:&&|\|\|?)\s*$/.test(priorCommand)) continue;
    const value = group(match, 1);
    // `X_SKIP="${X_SKIP:-0}"` takes the caller's value: a read, not a decision.
    if (new RegExp(`\\$\\{?${name}\\b`).test(value)) return null;
    if (depths[index] !== 0 || !ONE_WORD.test(value)) continue;
    return index;
  }
  return null;
};

interface Heredoc {
  readonly delimiter: string;
  /** `<<'EOF'`, `<<"EOF"`, `<<\EOF`: the body is not expanded. */
  readonly quoted: boolean;
  /** `<<-`: leading tabs are stripped from the body and the delimiter. */
  readonly tabs: boolean;
}

/**
 * One shell line as bash reads it. `expands` is the text bash expands on it
 * (null where it expands nothing); `command` is its command text, or null on
 * a heredoc's body and delimiter lines, which are data.
 */
type ShellLine =
  | { readonly expands: string | null; readonly command: null }
  | {
      readonly expands: string;
      readonly command: string;
      /** The line starts inside a quoted string an earlier line opened. */
      readonly quoted: boolean;
    };

/** The quote a line leaves open: `$'` keeps taking `\` escapes on the next. */
type OpenQuote = "'" | "$'" | '"' | null;

/**
 * A heredoc operator and its delimiter word, matched where `lastIndex` points.
 * `<<<` is a here-string, not a heredoc: in `cat <<<'EOF'` no `<` opens one.
 */
const HEREDOC_WORD = /(?<!<)<<(?!<)(-?)[ \t]*((?:\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s;&|<>()'"\\])+)/y;

/**
 * A double-quoted stretch up to its closing `"`, the first no `\` escapes;
 * matched where `lastIndex` points.
 */
const CLOSING_DOUBLE_QUOTE = /(?:[^"\\]|\\[\s\S])*"/y;
/** A `$'…'` quote's text up to its closing `'`: it takes `\` escapes too. */
const CLOSING_ANSI_C_QUOTE = /(?:[^'\\]|\\[\s\S])*'/y;

/**
 * The index in `line` of the quote `closing` reaches from `from` on, or -1
 * when the line ends inside the quote.
 */
const closingAt = (line: string, from: number, closing: RegExp): number => {
  closing.lastIndex = from;
  return closing.exec(line) === null ? -1 : closing.lastIndex - 1;
};

/**
 * The end of a double-quoted stretch starting at `from` (the index of its
 * closing `"`, or -1 when the line ends inside it), and the stretch with
 * each escaped character neutralised: `"\$X_SKIP"` is the text `$X_SKIP`.
 */
const doubleQuoted = (line: string, from: number): { end: number; text: string } => {
  const end = closingAt(line, from, CLOSING_DOUBLE_QUOTE);
  return { end, text: line.slice(from, end === -1 ? line.length : end).replace(/\\[\s\S]/g, '\\_') };
};

/**
 * One physical line with what bash does not expand dropped (single-quoted
 * text, escaped characters and the comment), the heredocs it opens, and the
 * quote still open at its end. `open` is the quote an earlier line left
 * open: a string may span lines. `<<` inside quotes, a comment or `$(( … ))`
 * arithmetic opens no heredoc. Double-quoted text is kept in its quotes, so
 * `"$"'x'` is a `$` and a plain quote, not `$'x'`.
 */
const scanLine = (line: string, open: OpenQuote): { code: string; heredocs: Heredoc[]; open: OpenQuote } => {
  let code = '';
  const heredocs: Heredoc[] = [];
  let index = 0;
  if (open === "'" || open === "$'") {
    const end = open === "$'" ? closingAt(line, 0, CLOSING_ANSI_C_QUOTE) : line.indexOf("'");
    if (end === -1) return { code, heredocs, open };
    index = end + 1;
  } else if (open === '"') {
    const stretch = doubleQuoted(line, 0);
    code += `"${stretch.text}"`;
    if (stretch.end === -1) return { code, heredocs, open };
    index = stretch.end + 1;
  }
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '\\') {
      // An escaped character is literal; a trailing `\` continues the line.
      code += index + 1 < line.length ? '\\_' : '\\';
      index += 2;
    } else if (char === "'") {
      // `$'…'` takes backslash escapes, so `\'` does not close it, on this
      // line or the next. An unescaped `$` opens one: `\$'` is a plain quote.
      const quote: OpenQuote = code.endsWith('$') ? "$'" : "'";
      const end = quote === "$'" ? closingAt(line, index + 1, CLOSING_ANSI_C_QUOTE) : line.indexOf("'", index + 1);
      code += "''";
      if (end === -1) return { code, heredocs, open: quote };
      index = end + 1;
    } else if (char === '"') {
      const stretch = doubleQuoted(line, index + 1);
      code += `"${stretch.text}"`;
      if (stretch.end === -1) return { code, heredocs, open: '"' };
      index = stretch.end + 1;
    } else if (char === '#' && (index === 0 || /\s/.test(line.charAt(index - 1)))) {
      break;
    } else {
      HEREDOC_WORD.lastIndex = index;
      const match = HEREDOC_WORD.exec(line);
      const arithmetic = (code.match(/\(\(/g) ?? []).length > (code.match(/\)\)/g) ?? []).length;
      if (match === null || arithmetic) {
        code += char;
        index += 1;
        continue;
      }
      const word = group(match, 2);
      heredocs.push({
        // `<<$'EOF'` ends at `EOF`: the `$` is quoting, not a character.
        delimiter: word.replace(
          /\$'((?:[^'\\]|\\.)*)'|'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g,
          // One alternative matched: when none of the first three did, the
          // fourth, an escaped character, did.
          (_all: string, ansi: string | undefined, single: string | undefined, double: string | undefined, escaped: string) => ansi?.replace(/\\(.)/g, '$1') ?? single ?? double ?? escaped,
        ),
        quoted: /['"\\]/.test(word),
        tabs: match[1] === '-',
      });
      // The operator and its word are redirection syntax: nothing to expand.
      index += match[0].length;
    }
  }
  return { code, heredocs, open: null };
};

/**
 * Each shell line as bash reads it. Outside heredocs, the code with
 * single-quoted text, escaped characters and comments dropped, following a
 * quoted string across lines; a quoted heredoc's body expands nothing; an
 * unquoted heredoc's body expands, since nothing in it is a quote or a
 * comment (only `\$` stays literal). What is left is where `$X_SKIP` really
 * is a read; `printf '%s' 'no $X_SKIP'`, `echo \$X_SKIP` and a comment
 * explaining the old switch are not.
 */
const shellLines = (lines: readonly string[]): ShellLine[] => {
  const pending: Heredoc[] = [];
  let open: OpenQuote = null;
  return lines.map((line): ShellLine => {
    const heredoc = pending.at(0);
    if (heredoc !== undefined) {
      if ((heredoc.tabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
        pending.shift();
        return { expands: null, command: null };
      }
      return { expands: heredoc.quoted ? null : line.replace(/\\[\\$`]/g, '\\_'), command: null };
    }
    const quoted = open !== null;
    const scanned = scanLine(line, open);
    open = scanned.open;
    pending.push(...scanned.heredocs);
    return { expands: scanned.code, command: scanned.code, quoted };
  });
};

/**
 * A workflow line up to its comment: a `#` at the start or after whitespace,
 * outside quotes, as in YAML and in the shell of a `run:` block. A double
 * quote takes `\` escapes; a quote left open runs to the end of the line.
 * `# Removed: ${{ env.CI_SKIP }}` documents a switch; it reads nothing.
 */
const BEFORE_WORKFLOW_COMMENT = /^(?:"(?:[^"\\]|\\(?:[\s\S]|$))*(?:"|$)|'[^']*(?:'|$)|(?<=\S)#|[^"'#])*/;

const withoutComment = (line: string): string => BEFORE_WORKFLOW_COMMENT.exec(line)?.[0] ?? line;

/**
 * A Python comment, or a string literal not glued to a word before it: its
 * prefix (`r`, `b`, `f`, …), its quote, its text and its closing quote, if
 * any. A `'''` or `"""` string spans lines; a `'` or `"` one ends at a
 * newline it does not escape.
 */
const PYTHON_TOKEN =
  /#[^\n]*|(?<!\w)([rRbBuUfF]{0,2}(?:'''(?:\\[\s\S]|(?!''')[^\\])*(?:'''|)|"""(?:\\[\s\S]|(?!""")[^\\])*(?:"""|)|'(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?))/g;
/** An f-string: its braces hold code. */
const F_STRING = /^[rRbB]?[fF]/;

/**
 * Where the replacement field opened before `from` closes: the index of its
 * `}`, past quoted text and nested braces at any depth (`{d['}']}`,
 * `{x:>{width}}`, `{a and {'b': {'c': 1}}}`), or -1 if it never closes.
 */
const fieldEnd = (text: string, from: number): number => {
  let depth = 1;
  let quote: string | null = null;
  // UTF-16 units, the indexing `slice` uses.
  for (const [offset, char] of text.slice(from).split('').entries()) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return from + offset;
    }
  }
  return -1;
};

/** Reads one file's text: the shell, Python and workflow readers, and the script reader's reporting. */
export interface Reader {
  /** Whether `file` is gate code this check owns. */
  readonly isGateCode: (file: string) => boolean;
  /** Every environment read of a switch name in one file's text; a TypeScript or JavaScript file needs `ts`. */
  readonly findSwitchReads: (file: string, source: string, ts: Ts | undefined) => Violation[];
}

/** The reader a config describes: every pattern built from its switch words. */
export const readerFor = (config: Config): Reader => {
  const SWITCH_NAME = switchName(config.words);
  const IS_SWITCH = new RegExp(`^${SWITCH_NAME}$`);
  const allowed = new Map(Object.entries(config.notAGate).map(([name, { files }]) => [name, new Set(files)]));
  /** Is `name` an approved non-gate switch in `file`? */
  const notAGate = (name: string, file: string): boolean => allowed.get(name)?.has(file) ?? false;
  const report = (out: Violation[], file: string, line: number, name: string | null): void => {
    if (name === null || !IS_SWITCH.test(name) || notAGate(name, file)) return;
    out.push({ file, line, name });
  };

  const READS: Readonly<Record<'shell' | 'python' | 'workflow', readonly RegExp[]>> = {
    shell: [new RegExp(String.raw`\$\{?(${SWITCH_NAME})\b`, 'g')],
    python: [new RegExp(String.raw`\benviron(?:\.get)?\s*[[(]\s*['"](${SWITCH_NAME})['"]`, 'g'), new RegExp(String.raw`\bgetenv\s*\(\s*['"](${SWITCH_NAME})['"]`, 'g')],
    workflow: [
      new RegExp(String.raw`\$\{?(${SWITCH_NAME})\b`, 'g'),
      new RegExp(String.raw`\benv\.(${SWITCH_NAME})\b`, 'g'),
      // Actions expressions index contexts too: `env['CI_SKIP']`.
      new RegExp(String.raw`\benv\s*\[\s*(['"])(${SWITCH_NAME})\1\s*\]`, 'g'),
    ],
  };
  const BARE_SWITCH = new RegExp(String.raw`(?<![\w$\{])(${SWITCH_NAME})\b`, 'g');
  /** A literal that is exactly a switch name: the key of a read. */
  const IS_SWITCH_LITERAL = new RegExp(String.raw`^[rRbBuUfF]{0,2}(['"])${SWITCH_NAME}\1$`);

  /**
   * An f-string's code: each `{…}` replacement field, read as Python, and the
   * newlines of its text; an escaped `{{` and every other character of the
   * text read nothing. A `}` outside a field is text whether doubled or not,
   * and a `{` that never closes is text.
   */
  const fStringCode = (literal: string): string => {
    let out = '';
    let at = 0;
    // The empty string past the end stops the scan.
    while (literal.charAt(at) !== '') {
      if (literal.slice(at, at + 2) === '{{') {
        at += 2;
        continue;
      }
      const end = literal.charAt(at) === '{' ? fieldEnd(literal, at + 1) : -1;
      if (end !== -1) {
        out += `{${pythonCode(literal.slice(at + 1, end))}}`;
        at = end + 1;
        continue;
      }
      if (literal.charAt(at) === '\n') out += '\n';
      at += 1;
    }
    return out;
  };

  /**
   * Python source with comments dropped and every string literal emptied,
   * except a literal that is exactly a switch name (the key of a read, as in
   * `os.environ.get('X_SKIP')`), which loses its prefix, and an f-string,
   * which keeps only the code in its braces, read the same way. So
   * `print("use os.environ.get('X_SKIP')")`, `f"os.getenv('X_SKIP') {task}"`
   * and `# os.environ['X_SKIP']` read nothing. An emptied literal keeps its
   * newlines, so lines stay aligned.
   */
  const pythonCode = (source: string): string =>
    source.replace(PYTHON_TOKEN, (token: string, literal: string | undefined) => {
      // A comment keeps only its `#`, which reads nothing.
      if (literal === undefined) return token.slice(0, 1);
      if (IS_SWITCH_LITERAL.test(literal)) return literal.replace(/^[rRbBuUfF]+/, '');
      if (F_STRING.test(literal)) return fStringCode(literal);
      return '\n'.repeat(literal.split('\n').length - 1);
    });

  /**
   * Python reads, matched over the whole file: a call formatted across lines
   * (`os.environ.get(\n    "X_SKIP"\n)`) is still a read. `os.environ["X"] =
   * …` and `del os.environ["X"]` overwrite or drop the caller's value, so they
   * are writes, not reads.
   */
  const pythonSwitchReads = (file: string, source: string): Violation[] => {
    const code = pythonCode(source);
    const out: Violation[] = [];
    for (const pattern of READS.python) {
      pattern.lastIndex = 0;
      for (const match of code.matchAll(pattern)) {
        const start = match.index;
        const after = code.slice(start + match[0].length);
        const before = code.slice(0, start);
        if (/^\s*\]\s*=(?!=)/.test(after) || /\bdel\s+(?:[\w.]+\.)?$/.test(before)) continue;
        report(out, file, before.split('\n').length, group(match, 1));
      }
    }
    return out.sort((a, b) => a.line - b.line);
  };

  const findSwitchReads = (file: string, source: string, ts: Ts | undefined): Violation[] => {
    const kind = kindOf(file);
    if (kind === null) return [];
    if (kind === 'script') {
      if (ts === undefined) throw new Error(`${file}: reading TypeScript or JavaScript needs the typescript package`);
      return scriptSwitchReads(ts, file, source, report);
    }
    if (kind === 'python') return pythonSwitchReads(file, source);
    const lines = source.split('\n');
    const patterns = READS[kind];
    const out: Violation[] = [];
    const shell = kind === 'shell' ? shellLines(lines) : null;
    const expanding = shell === null ? lines.map(withoutComment) : shell.map((line) => line.expands);
    let depths: number[] | null = null;
    for (const [index, expands] of expanding.entries()) {
      if (expands === null) continue;
      const code = arithmeticAsReads(expands, BARE_SWITCH);
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of code.matchAll(pattern)) {
          // The name is each pattern's last group.
          const name = group(match, match.length - 1);
          if (shell !== null && !notAGate(name, file)) {
            // Control-flow depth counts commands only: heredoc bodies are data.
            depths ??= shellDepths(shell.map((item) => item.command));
            const init = initialisedAt(lines, shell, depths, name);
            if (init !== null && init < index) continue;
          }
          report(out, file, index + 1, name);
        }
      }
    }
    return out;
  };

  return {
    isGateCode: (file) => config.gatePaths.some((p) => p.test(file)) && !config.notGateCode.some((p) => p.test(file)) && kindOf(file) !== null,
    findSwitchReads,
  };
};

export type Mode = 'staged' | 'tree';

/** How the check reads the repository: git at its top level, and the working tree by root-relative path. */
export interface Reads {
  readonly git: Git;
  readonly exists: (file: string) => boolean;
  /** A working-tree file's text; throws when it cannot be read. */
  readonly read: (file: string) => string;
}

export const diskReads = (root: string): Reads => ({
  git: gitAt(root),
  exists: (file) => existsSync(join(root, file)),
  read: (file) => readFileSync(join(root, file), 'utf8'),
});

/** A file the check was asked to read and could not: never a clean result. */
export class UnreadableGateFile extends Error {}

/** The files a mode judges: every tracked file, or the ones the index adds, copies, modifies or renames. */
export const listFiles = (reads: Reads, mode: Mode): string[] =>
  must(reads.git, mode === 'staged' ? ['diff', ...PLAIN_DIFF, '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean);

/** A gate file's text: the index's for staged, the working tree's for tree (undefined when deleted there). */
export const readGate = (reads: Reads, mode: Mode, file: string): string | undefined => {
  if (mode === 'staged') {
    // `:0:` names stage 0 explicitly, so a path such as `0:a.sh` is read as itself.
    const text = reads.git.run(['show', `:0:${file}`]);
    if (text === undefined) throw new UnreadableGateFile(`${file}: git show :0:${file} failed`);
    return text;
  }
  if (!reads.exists(file)) return undefined;
  try {
    return reads.read(file);
  } catch (e) {
    throw new UnreadableGateFile(`${file}: ${(e as Error).message}`);
  }
};

const P = 'pariksha env-gate-switches:';

/** `*_SKIP / *_PROBE`, for the words a config names. */
const wordsShown = (words: readonly string[]): string => words.map((w) => `*_${w}`).join(' / ');

export const formatReads = (violations: readonly Violation[], words: readonly string[], files: number, configPath: string): { ok: boolean; out: string[]; err: string[] } => {
  if (violations.length === 0) return { ok: true, out: [`${P} no gate reads a ${wordsShown(words)} environment switch (${files} gate file(s) read)`], err: [] };
  return {
    ok: false,
    out: [],
    err: [
      `${P} gate code reads an environment switch anyone can set to turn it off:`,
      ...violations.map(({ file, line, name }) => `   ${file}:${line} reads ${name}`),
      `${P} ${violations.length} read(s). Decide inside the gate (a flag the gate owns, a file it checks), or, if the switch turns off no check at all, add it to notAGate in ${configPath} with the reason.`,
    ],
  };
};
