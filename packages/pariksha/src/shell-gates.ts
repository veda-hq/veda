// shell-gates: ShellCheck, the git hook preamble and the shell pitfalls, over
// the shell files a change writes.
//
// ShellCheck runs first, one pass per configured flag set, over the files as
// the change records them: staged mode judges the index and base mode the
// HEAD commit, each written to a temporary directory so ShellCheck's report
// names repository paths; all mode reads the working tree. Its targets are
// `*.sh`/`*.bash`, direct children of the hooks directory, and extensionless
// files whose first line is a sh/bash/dash/ksh shebang. Then the hook
// preamble (hook-preamble.ts) and the pitfalls (shell-pitfalls.ts) run over
// the shell targets shell-sources.ts selects. Fails closed: a selection
// error is a failure, never a skip.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHookPreamble, DEFAULT_RUNTIMES, type PreambleConfig } from './hook-preamble.ts';
import { checkPitfalls, type PitfallsConfig } from './shell-pitfalls.ts';
import { DEFAULT_SOURCES, selectAll, selectChangedSince, selectStaged, type ShellFinding, type ShellSource, type SourcesConfig, workingTreeSources } from './shell-sources.ts';

export type CheckName = 'preamble' | 'pitfalls';
export const ALL_CHECKS: readonly CheckName[] = ['preamble', 'pitfalls'];

export interface ShellcheckConfig {
  /** One ShellCheck run per entry, each its flags after `--norc`; none runs no ShellCheck. */
  readonly passes: readonly (readonly string[])[];
  /** Paths whose staged change re-judges every tracked target with ShellCheck (how it runs changed). */
  readonly inputs: readonly string[];
  /** What a missing ShellCheck message tells the reader to do. */
  readonly install: string;
}

export interface GatesConfig {
  readonly sources: SourcesConfig;
  /** Absent: the preamble check cannot run, and asking for it is an error. */
  readonly preamble: PreambleConfig | undefined;
  readonly pitfalls: PitfallsConfig;
  readonly shellcheck: ShellcheckConfig;
  /** Lines printed after the findings: where the rules are described. */
  readonly guidance: readonly string[];
}

export const DEFAULT_PASSES: readonly (readonly string[])[] = [['--severity=warning'], ['--severity=info', '--include=SC2086,SC2013,SC2015']];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (raw: Record<string, unknown>, keys: readonly string[], where: string): void => {
  const unknown = Object.keys(raw).find((k) => !keys.includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${where}${unknown}"`);
};

const text = (raw: Record<string, unknown>, key: string, fallback: string | undefined, where: string): string => {
  const value = raw[key] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${where}${key}" must be a non-empty string`);
  return value;
};

const strings = (raw: Record<string, unknown>, key: string, fallback: readonly string[], where: string, allowEmpty = true): readonly string[] => {
  const value = raw[key] ?? fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '') || (!allowEmpty && value.length === 0)) throw new Error(`"${where}${key}" must be a list of non-empty strings`);
  return value as string[];
};

const regexes = (raw: Record<string, unknown>, key: string, where: string): readonly RegExp[] =>
  strings(raw, key, [], where).map((source) => {
    try {
      return new RegExp(source);
    } catch (e) {
      throw new Error(`"${where}${key}" holds a bad regex: ${(e as Error).message}`);
    }
  });

const section = (raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`"${key}" must be an object`);
  return value;
};

/**
 * `{ "hooksDir"?, "exclude"?, "gateInputs"?, "preamble"?: { "id"?,
 * "selectScript", "selectFunction", "runtimes"? }, "pitfalls"?: { "id"?,
 * "validatorPaths"? }, "shellcheck"?: { "passes"?, "inputs"?, "install"? },
 * "guidance"? }`; absent keys take the defaults (README, "shell-gates").
 * Throws on anything else, so a mistyped key never passes as the default.
 */
export const parseGatesConfig = (source: string): GatesConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  onlyKeys(raw, ['hooksDir', 'exclude', 'gateInputs', 'preamble', 'pitfalls', 'shellcheck', 'guidance'], '');
  const hooksDir = text(raw, 'hooksDir', DEFAULT_SOURCES.hooksDir, '');
  if (!hooksDir.endsWith('/')) throw new Error('"hooksDir" must end in "/"');
  const sources: SourcesConfig = { hooksDir, exclude: strings(raw, 'exclude', DEFAULT_SOURCES.exclude, ''), gateInputs: strings(raw, 'gateInputs', DEFAULT_SOURCES.gateInputs, '') };
  const pre = section(raw, 'preamble');
  if (pre !== undefined) onlyKeys(pre, ['id', 'selectScript', 'selectFunction', 'runtimes'], 'preamble.');
  const preamble: PreambleConfig | undefined =
    pre === undefined
      ? undefined
      : {
          id: text(pre, 'id', 'hook-preamble', 'preamble.'),
          hooksDir,
          selectScript: text(pre, 'selectScript', undefined, 'preamble.'),
          selectFunction: text(pre, 'selectFunction', undefined, 'preamble.'),
          runtimes: strings(pre, 'runtimes', DEFAULT_RUNTIMES, 'preamble.', false),
        };
  const pit = section(raw, 'pitfalls') ?? {};
  onlyKeys(pit, ['id', 'validatorPaths'], 'pitfalls.');
  const pitfalls: PitfallsConfig = { id: text(pit, 'id', 'shell-pitfalls', 'pitfalls.'), validatorPaths: regexes(pit, 'validatorPaths', 'pitfalls.') };
  const sc = section(raw, 'shellcheck') ?? {};
  onlyKeys(sc, ['passes', 'inputs', 'install'], 'shellcheck.');
  const passes = sc['passes'] ?? DEFAULT_PASSES;
  if (!Array.isArray(passes) || passes.some((pass) => !Array.isArray(pass) || pass.some((flag) => typeof flag !== 'string' || flag === ''))) throw new Error('"shellcheck.passes" must be a list of flag lists');
  const shellcheck: ShellcheckConfig = {
    passes: passes as string[][],
    inputs: strings(sc, 'inputs', [], 'shellcheck.'),
    install: text(sc, 'install', 'install it from https://www.shellcheck.net', 'shellcheck.'),
  };
  const guidanceRaw = raw['guidance'] ?? ['', `   ${[preamble?.id ?? 'hook-preamble', pitfalls.id].join(' and ')} are described in pariksha's README, under shell-gates.`];
  if (!Array.isArray(guidanceRaw) || guidanceRaw.some((line) => typeof line !== 'string')) throw new Error('"guidance" must be a list of lines');
  return { sources, preamble, pitfalls, shellcheck, guidance: guidanceRaw as string[] };
};

/** Which files a run judges. */
export type Mode = { readonly kind: 'staged' } | { readonly kind: 'all' } | { readonly kind: 'base'; readonly base: string } | { readonly kind: 'files'; readonly files: readonly string[] };

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the program could not start; `ENOENT` when it is not installed. */
  readonly error?: NodeJS.ErrnoException;
}

/** How ShellCheck runs: its arguments, from a directory. */
export type ShellcheckRunner = (cwd: string, args: readonly string[]) => RunResult;

/** The real runner: `command` (`shellcheck` on PATH by default), as a binary. */
export const shellcheckRunner =
  (command = 'shellcheck'): ShellcheckRunner =>
  (cwd, args) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error === undefined ? {} : { error: result.error as NodeJS.ErrnoException }) };
  };

export interface GatesIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly shellcheck: ShellcheckRunner;
}

const gitText = (root: string, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Text printed by a child, as lines: a last newline ends the last line rather than adding an empty one. */
const linesOf = (output: string): string[] => (output === '' ? [] : output.replace(/\n$/, '').split('\n'));

/** The paths ShellCheck judges by name, under `hooksDir`. */
const shellcheckMatch = (hooksDir: string): RegExp => new RegExp(String.raw`\.(sh|bash)$|^${hooksDir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^/.]+$`);

/** A first line that names a shell ShellCheck reads: POSIX `[[:space:]]` spelt out. */
const SHELLCHECK_SHEBANG = /^#![ \t\n\v\f\r]*(\/usr\/bin\/env[ \t\n\v\f\r]+(-[^ \t\n\v\f\r]+[ \t\n\v\f\r]+)*)?(\/[^ \t\n\v\f\r]*\/)?(sh|bash|dash|ksh)([ \t\n\v\f\r]|$)/;

type Side = 'staged' | 'index' | 'range' | 'all';

/** The first line of `text`, as `head -n 1` writes it (its newline dropped). */
const firstLine = (text: string): string => text.split('\n')[0] as string;

/** The judged side's first line of `path`, or '' when it cannot be read (as `… 2>/dev/null | head -n 1 || true` gives). */
const firstLineOn = (root: string, side: Side, path: string): string => {
  try {
    if (side === 'all') return firstLine(readFileSync(join(root, path), 'utf8'));
    return firstLine(gitText(root, ['show', side === 'range' ? `HEAD:${path}` : `:${path}`]));
  } catch {
    return '';
  }
};

/** The ShellCheck targets on `side`, in the order git lists them. */
const shellcheckTargets = (root: string, side: Side, base: string | undefined, hooksDir: string): string[] => {
  const listed =
    side === 'staged'
      ? gitText(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', '--no-renames'])
      : side === 'index'
        ? gitText(root, ['ls-files', '--cached', '-z'])
        : side === 'range'
          ? gitText(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRT', '--no-renames', gitText(root, ['merge-base', base as string, 'HEAD']).trim(), 'HEAD'])
          : gitText(root, ['ls-files', '-z']);
  const match = shellcheckMatch(hooksDir);
  const files: string[] = [];
  for (const path of listed.split('\0')) {
    if (path === '') continue;
    if (match.test(path)) files.push(path);
    else if (!(path.split('/').at(-1) as string).includes('.') && SHELLCHECK_SHEBANG.test(firstLineOn(root, side, path))) files.push(path);
  }
  return files;
};

/** Writes `files` as `side` records them under a new directory, which the caller removes. */
const snapshot = (root: string, side: Side, files: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-gates-'));
  try {
    if (side === 'range') {
      const tar = join(dir, '.snapshot.tar');
      execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD', '--', ...files], { cwd: root, stdio: 'pipe' });
      execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: 'pipe' });
      rmSync(tar);
    } else {
      execFileSync('git', ['checkout-index', '-f', '-z', `--prefix=${dir}/`, '--stdin'], { cwd: root, input: files.map((f) => `${f}\0`).join(''), stdio: ['pipe', 'pipe', 'pipe'] });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
};

/** ShellCheck over `files` as `side` records them; `report` prints its output and reads its verdict. */
const shellcheckOn = (top: string, side: Side, files: readonly string[], flags: readonly string[], io: GatesIo, report: (result: RunResult) => boolean): boolean => {
  if (files.length === 0) {
    io.out('✅ No files to check.');
    return true;
  }
  if (side === 'all') return report(io.shellcheck(top, ['--norc', ...flags, ...files]));
  const dir = snapshot(top, side, files);
  try {
    return report(io.shellcheck(dir, ['--norc', ...flags, ...files]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The side ShellCheck reads for `mode`: a staged change to how it runs re-judges the whole index. */
const sideOf = (root: string, mode: Mode, inputs: readonly string[]): Side => {
  // Files mode passes the listed paths as they are, and needs no git.
  if (mode.kind === 'all' || mode.kind === 'files') return 'all';
  if (mode.kind === 'base') return 'range';
  if (inputs.length > 0 && gitText(root, ['diff', '--cached', '--name-only', '-z']).split('\0').some((path) => inputs.includes(path))) return 'index';
  return 'staged';
};

export const selectSources = (root: string, mode: Mode, config: SourcesConfig): ShellSource[] => {
  switch (mode.kind) {
    case 'staged':
      return selectStaged(root, config).sources;
    case 'all':
      return selectAll(root, config);
    case 'base':
      return selectChangedSince(root, mode.base, config);
    case 'files':
      return workingTreeSources(root, mode.files, config);
  }
};

export const runChecks = (sources: readonly ShellSource[], checks: readonly CheckName[], config: GatesConfig): ShellFinding[] => {
  const findings: ShellFinding[] = [];
  for (const source of sources) {
    if (checks.includes('preamble') && config.preamble !== undefined) findings.push(...checkHookPreamble(source, config.preamble));
    if (checks.includes('pitfalls')) findings.push(...checkPitfalls(source, config.pitfalls));
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
};

export const report = (findings: readonly ShellFinding[]): string => findings.map((f) => `  ${f.file}:${String(f.line)}  ${f.check} ${f.rule}\n      ${f.message}`).join('\n');

/** An error's message, or its name when it has none. */
export const errorDetail = (error: unknown): string => (error instanceof Error ? error.message || error.name || 'Error' : String(error));

export interface GatesOptions {
  readonly root: string;
  readonly mode: Mode;
  readonly checks: readonly CheckName[];
  /** `--only` was given: the named checks run, ShellCheck does not. */
  readonly only: boolean;
}

/**
 * The gate: 0 when ShellCheck and the checks pass, 1 on any finding or a
 * missing ShellCheck, 2 when it cannot run (a selection or git failure).
 */
export const runShellGates = (options: GatesOptions, config: GatesConfig, io: GatesIo): number => {
  if (options.checks.includes('preamble') && config.preamble === undefined) {
    io.err('❌ Shell gates could not run: the config has no "preamble" section, so the hook preamble cannot be checked; add one, or pass --only pitfalls');
    return 2;
  }
  let rc = 0;
  try {
    const passes = options.only ? [] : config.shellcheck.passes;
    if (passes.length > 0) {
      const probe = io.shellcheck(options.root, ['--version']);
      if (probe.error?.code === 'ENOENT') {
        io.err(`❌ shellcheck is required: ${config.shellcheck.install}`);
        return 1;
      }
      const side = sideOf(options.root, options.mode, config.shellcheck.inputs);
      for (const flags of passes) if (!shellcheckPassFor(options, side, flags, config, io)) rc = 1;
    }
    const sources = selectSources(options.root, options.mode, config.sources);
    if (sources.length === 0) {
      io.out('✅ Shell gates: no shell scripts or hooks to check');
      return rc;
    }
    const findings = runChecks(sources, options.checks, config);
    if (findings.length > 0) {
      io.err(`❌ Shell gates: ${String(findings.length)} finding(s) in ${String(sources.length)} file(s)\n`);
      io.err(report(findings));
      config.guidance.forEach(io.err);
      return 1;
    }
    io.out(`✅ Shell gates: ${String(sources.length)} file(s) pass ${options.checks.join(', ')}`);
    return rc;
  } catch (error: unknown) {
    io.err(`❌ Shell gates could not run: ${errorDetail(error)}`);
    return 2;
  }
};

/** One ShellCheck pass with `flags`; whether it passed. A ShellCheck that cannot start throws. */
const shellcheckPassFor = (options: GatesOptions, side: Side, flags: readonly string[], config: GatesConfig, io: GatesIo): boolean => {
  const report = (result: RunResult): boolean => {
    if (result.error !== undefined) throw result.error;
    linesOf(result.stdout).forEach(io.out);
    linesOf(result.stderr).forEach(io.err);
    return result.status === 0;
  };
  if (options.mode.kind === 'files') return report(io.shellcheck(options.root, ['--norc', ...flags, '--', ...options.mode.files]));
  const top = gitText(options.root, ['rev-parse', '--show-toplevel']).trim();
  const files = shellcheckTargets(top, side, options.mode.kind === 'base' ? options.mode.base : undefined, config.sources.hooksDir);
  return shellcheckOn(top, side, files, flags, io, report);
};
