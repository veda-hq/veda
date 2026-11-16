// repo-rules over Turborepo task inputs: a task that declares `inputs` hashes
// only those files, so a source that reads any other file can cache-hit on a
// change to it and replay an old pass.
import { dirname, join, normalize, relative } from 'node:path';
import { type Finding, type Repo, type Rule } from './repo-rules.ts';
import { parseJsonc, withoutJsComments } from './repo-rules-configs.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A glob as Turborepo writes them (`**`, `*`, `?`, `{a,b}`, `[ab]`), as an anchored regex over a `/` path. */
export const globToRegExp = (glob: string): RegExp => {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) out += '\\{';
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((alt) => globToRegExp(alt).source.slice(1, -1))
          .join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) out += '\\[';
      else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

/** The paths, relative to the repository root, a task's `inputs` hash for a package at `dir` ('' for the root). */
export const inputMatcher = (inputs: readonly string[], dir: string): ((path: string) => boolean) => {
  const rules = inputs.map((raw) => {
    const negated = raw.startsWith('!');
    const glob = negated ? raw.slice(1) : raw;
    const rooted = glob.startsWith('$TURBO_ROOT$/');
    const relativeGlob = rooted ? glob.slice('$TURBO_ROOT$/'.length) : glob;
    const full = rooted || dir === '' ? relativeGlob : `${dir}/${relativeGlob.replace(/^\.\//, '')}`;
    return { negated, pattern: globToRegExp(normalize(full).replace(/^\.\//, '')) };
  });
  return (path) => {
    let hit = false;
    for (const rule of rules) if (rule.pattern.test(path)) hit = !rule.negated;
    return hit;
  };
};

interface Task {
  readonly name: string;
  readonly inputs: readonly string[];
}

/** A file's string literals that look like paths: a name with an extension, or a path with a `/`. */
const PATH_LITERAL = /(['"`])((?:\.{1,2}\/)*[\w@-][\w@.-]*(?:\/[\w@.-]+)*\.[A-Za-z0-9]+)\1/g;

/** The tracked files a source names in its string literals, read from its folder, its package or the root. */
export const namedFiles = (code: string, file: string, dir: string, tracked: ReadonlySet<string>): Array<{ path: string; index: number }> => {
  const out: Array<{ path: string; index: number }> = [];
  for (const match of code.matchAll(PATH_LITERAL)) {
    const literal = match[2] as string;
    const bases = literal.startsWith('.') ? [dirname(file)] : [dirname(file), dir, ''];
    for (const base of bases) {
      const path = normalize(join(base, literal)).replace(/^\.\//, '');
      if (!path.startsWith('..') && tracked.has(path)) {
        out.push({ path, index: match.index });
        break;
      }
    }
  }
  return out;
};

/** The tasks with `inputs` that run in the package at `dir`, from the root turbo.json and the package's own. */
export const tasksWithInputs = (root: unknown, own: unknown, dir: string, name: string | undefined, scripts: readonly string[]): Task[] => {
  const tasksOf = (doc: unknown): Record<string, unknown> => {
    const tasks = isRecord(doc) ? (doc['tasks'] ?? doc['pipeline']) : undefined;
    return isRecord(tasks) ? tasks : {};
  };
  const rootTasks = tasksOf(root);
  const ownTasks = tasksOf(own);
  const out: Task[] = [];
  for (const script of scripts) {
    const candidates = dir === '' ? [rootTasks[`//#${script}`]] : [ownTasks[script], name === undefined ? undefined : rootTasks[`${name}#${script}`], rootTasks[script]];
    const task = candidates.find(isRecord);
    const inputs = task?.['inputs'];
    if (!Array.isArray(inputs) || !inputs.every((i) => typeof i === 'string') || inputs.includes('$TURBO_DEFAULT$')) continue;
    out.push({ name: dir === '' ? `//#${script}` : script, inputs });
  }
  return out;
};

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The tasks judged by default: those that run their sources (tests), not the ones that only read them (typecheck, lint, build). */
export const DEFAULT_TASKS = ['test'] as const;

/** A settings check: a non-empty list of regular expressions; throws on one that does not compile. */
const regexList = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v !== '')) return 'must be a non-empty list of regular expressions';
  for (const source of value as string[]) {
    try {
      new RegExp(source);
    } catch (e) {
      throw new Error(`holds "${source}", which is not a regular expression: ${(e as Error).message}`);
    }
  }
  return undefined;
};

export const turboInputsCoverReads: Rule = {
  id: 'turbo-inputs-cover-reads',
  lesson:
    "A Turborepo task with `inputs` hashes only those files. When a source it runs reads another file (a test that checks the README, a script that reads a config), a change to that file alone cache-hits and replays the old pass, so a dead link or a broken config ships green. Add the file to the task's `inputs`, or mark the task `cache: false`.",
  settings: { tasks: regexList },
  run: (repo, settings) => {
    const judged = ((settings['tasks'] as readonly string[] | undefined) ?? DEFAULT_TASKS).map((s) => new RegExp(s));
    const rootText = repo.read('turbo.json');
    if (rootText === undefined) return [];
    const rootTurbo = parseJsonc(rootText);
    const tracked = repo.tracked();
    const all = new Set(tracked);
    const packages = tracked.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p)).map((p) => (p === 'package.json' ? '' : dirname(p)));
    const owner = (path: string): string => packages.filter((d) => d === '' || path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
    const touched = new Set(repo.files.map(owner));
    const everything = repo.files.includes('turbo.json');
    const findings: Finding[] = [];
    for (const dir of packages) {
      if (!everything && !touched.has(dir)) continue;
      const pkg = parseJsonc(repo.read(join(dir, 'package.json')) ?? '');
      const scripts = isRecord(pkg) && isRecord(pkg['scripts']) ? Object.keys(pkg['scripts']) : [];
      const name = isRecord(pkg) && typeof pkg['name'] === 'string' ? pkg['name'] : undefined;
      const ownText = dir === '' ? undefined : repo.read(join(dir, 'turbo.json'));
      const tasks = tasksWithInputs(rootTurbo, ownText === undefined ? undefined : parseJsonc(ownText), dir, name, scripts).filter((t) => judged.some((r) => r.test(t.name.replace(/^\/\/#/, ''))));
      // package.json and turbo.json are always part of a task's hash.
      const always = new Set([join(dir, 'package.json'), join(dir, 'turbo.json'), 'turbo.json'].map((p) => normalize(p)));
      for (const task of tasks) {
        const hashed = inputMatcher(task.inputs, dir);
        const mine = (path: string): boolean => owner(path) === dir;
        for (const file of tracked.filter((p) => mine(p) && SOURCE.test(p) && hashed(p))) {
          const text = repo.read(file);
          if (text === undefined) continue;
          const code = withoutJsComments(text);
          for (const { path, index } of namedFiles(code, file, dir, all)) {
            if (hashed(path) || always.has(path)) continue;
            const line = code.slice(0, index).split('\n').length;
            const shown = relative(dir === '' ? '.' : dir, path) || path;
            findings.push({ file, line, detail: `task ${task.name} runs this file, which names ${shown}; the task's inputs do not hash it` });
          }
        }
      }
    }
    return findings;
  },
};
