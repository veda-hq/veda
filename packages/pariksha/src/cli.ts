#!/usr/bin/env node
// pariksha: repository checks. One subcommand per check.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAbsolutePaths, DEFAULT_GUIDANCE as ABSOLUTE_PATHS_GUIDANCE } from './absolute-paths.ts';
import { checkGates, DEFAULT_GATE_CONFIG, parseGateConfig as parseAggregateConfig } from './aggregate-gate-needs.ts';
import { parseDocConfig, readDoc, selectDocs } from './doc-files.ts';
import { DEFAULT_MASKED_CONFIG, findMaskedExits, formatMasked, parseMaskedConfig, readerFor as maskedReaderFor, shellFiles } from './masked-exit-codes.ts';
import { checkNonSyncedResources, DEFAULT_GUIDANCE as NON_SYNCED_GUIDANCE } from './non-synced-resources.ts';
import { ALL_CHECKS as SHELL_CHECKS, type CheckName as ShellCheckName, parseGatesConfig, runShellGates, shellcheckRunner, type Mode as ShellMode, type ShellcheckRunner } from './shell-gates.ts';
import { checkPnpmSettings, DEFAULT_PNPM_CONFIG, formatParity, parsePnpmConfig } from './pnpm-settings.ts';
import { adrDirOf, DEFAULTS, findUncited, formatClaims, listAdrs, readOrUndefined, stagedSource, treeSource, type Options } from './authority-citations.ts';
import { findDenied, hash, isText, parseDenyList, type TrackedFile } from './boundary.ts';
import { DEFAULT_CONFIG, entries, findGaps, formatGaps, listedPaths, parseConfig, treePaths, type Config } from './coverage-by-type.ts';
import { checkBuild, checkPackage, checkVitest, formatViolations, loaderFailure, loadVitestExclude, missingConfigs, ownedBy, parseConfig as parseExemptions } from './coverage-exemptions.ts';
import { checkBudgets } from './doc-budgets.ts';
import { lycheeRunner, type LinkRunner } from './doc-links.ts';
import { parseConfig as parseDocReferencesConfig, type Config as DocReferencesConfig } from './doc-references-config.ts';
import { formatReport as formatDocReferences, runGate, type GateMode, type GateReport } from './doc-references-gate.ts';
import { CHECK_IDS, type CheckId } from './doc-references.ts';
import { diskReads, formatReads, listFiles, needsTypescript, parseConfig as parseGateConfig, readerFor, readGate, type Reads } from './env-gate-switches.ts';
import { loadTypescript, typescriptLoaders, type Ts } from './typescript.ts';
import { checkExportDeletions, formatReport } from './export-deletions.ts';
import { findMissing, formatFindings, parseRequirements } from './required-settings.ts';
import { BASE_CANDIDATES, gitAt, gitAtTop, must, resolveBase, topOf, trackedUnder } from './git.ts';
import { discover as discoverCodecs, fileOf as codecFileOf, findings as codecFindings, formatFindings as formatCodecFindings, parseBaseline as parseCodecBaseline, parseConfig as parseCodecConfig, type Config as CodecConfig, type Discovery, type Format } from './codec-registry.ts';
import { discoverGroup, findings as faultFindings, formatFindings as formatFaultFindings, parseBaseline as parseFaultBaseline, parseConfig as parseFaultConfig, type Config as FaultConfig } from './fault-injection-registry.ts';
import { emptyRoots, growthSince, readBaseline, wholeId, type Baseline } from './registry-ratchet.ts';
import { checkClaims, formatOutcome, loadEslint, parseConfig as parseClaimsConfig, type LinterClass } from './enforcement-claims.ts';
import { parseConfig as parseDuplicateConfig, runDuplicateTests } from './duplicate-tests.ts';
import { DEFAULT_RUNS, npxVitest, parseConfig as parseFlakyConfig, parseRuns, runFlakyTests, type VitestRunner } from './flaky-tests.ts';
import { inheritRunner, runPythonFloor, type Options as PythonFloorOptions, type PythonRunner } from './python-floor.ts';

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Standard input, read whole; only `--files-from -` reads it. */
  readonly stdin?: () => string;
  /** How a check that needs TypeScript gets it; the product's own install by default. */
  readonly typescript?: () => Ts | string;
  /** How env-gate-switches reads the repository at a root; git and the disk by default. */
  readonly gateReads?: (root: string) => Reads;
  /** How doc-references checks links; lychee on PATH by default. */
  readonly links?: LinkRunner;
  /** How enforcement-claims gets ESLint's class; the `eslint` peer beside pariksha by default. */
  readonly eslint?: () => Promise<LinterClass | string>;
  /** The time pnpm-settings holds an expiry to; the clock by default. */
  readonly now?: () => number;
  /** How shell-gates runs ShellCheck; `shellcheck` on PATH by default. */
  readonly shellcheck?: ShellcheckRunner;
  /** How flaky-tests runs Vitest; `npx vitest` by default. */
  readonly vitest?: VitestRunner;
  /** How python-floor runs the named interpreter; a child sharing this process's stdio by default. */
  readonly python?: PythonRunner;
}

export const DENY_FILE = '.veda/deny.sha256';

const USAGE = [
  'usage: pariksha authority-citations [--mode staged|tree] [--authority <a,b>] [--issue-prefix <A,B>] [--adr-dir <dir>] [--root <dir>]',
  '       pariksha absolute-paths [--config <file>] [--files-from <file>|-] [--root <dir>]',
  '       pariksha aggregate-gate-needs [--config <file>] [--root <dir>]',
  '       pariksha boundary [--root <dir>] [--deny <file>]',
  '       pariksha codec-registry --config <file> [--base <ref> | --no-base] [--root <dir>]',
  '       pariksha coverage-by-type [--config <file>] [--files-from <file>|-] [--root <dir>]',
  '       pariksha coverage-exemptions --config <file> [--package <dir>] [--root <dir>]',
  '       pariksha doc-budgets --table <file> [--section <name>] [--root <dir>]',
  '       pariksha doc-references --config <file> (--staged | --base <ref> [--head <ref>] | --all [--update-baseline | --write-baseline]) [--checks <ids>] [--root <dir>]',
  '       pariksha duplicate-tests [--config <file>] [--files-from <file>|-] [--root <dir>]',
  '       pariksha enforcement-claims --config <file> [--root <dir>]',
  '       pariksha env-gate-switches --config <file> [--mode staged|tree] [--root <dir>]',
  '       pariksha export-deletions [--base <ref>] [--root <dir>]',
  '       pariksha fault-injection-registry --config <file> [--base <ref> | --no-base] [--root <dir>]',
  '       pariksha flaky-tests [--config <file>] [--files-from <file>|-] [--runs <n>] [--root <dir>]',
  '       pariksha masked-exit-codes [--config <file>] [--staged] [--root <dir>]',
  '       pariksha non-synced-resources [--config <file>] [--files-from <file>|-] [--root <dir>]',
  '       pariksha pnpm-settings [--config <file>] [--root <dir>]',
  '       pariksha python-floor --python <interpreter> --floor-file <path> [--exclude <regex>] [--selector <path>] [--root <dir>]',
  '       pariksha required-settings --require <file> [--settings <file>] [--root <dir>]',
  '       pariksha shell-gates [--config <file>] [--staged | --all | --base <ref> | --files-from <file>|-] [--only <checks>] [--root <dir>]',
  '       pariksha hash <word>',
  '       pariksha --version',
].join('\n');

export const ownVersion = (): string => {
  const pkg = join(import.meta.dirname, '..', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
};

/** The files git tracks under root, text ones only. */
export const trackedFiles = (root: string): TrackedFile[] => {
  const names = must(gitAt(root), ['ls-files', '-z']).split('\0').filter(Boolean);
  const files: TrackedFile[] = [];
  for (const path of names) {
    const full = join(root, path);
    if (!existsSync(full)) continue; // deleted in the working tree, not yet committed
    const bytes = readFileSync(full);
    if (isText(bytes)) files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
};

/**
 * `--name value` pairs, each name allowed once and from `allowed`, and bare
 * `switches` (`--no-base`), each once, held as ''; undefined on anything else.
 * An empty value is refused: `--base ""` names no ref.
 */
export const flags = (rest: readonly string[], allowed: readonly string[], switches: readonly string[] = []): Map<string, string> | undefined => {
  const out = new Map<string, string>();
  for (let i = 0; i < rest.length; ) {
    const name = rest[i];
    if (name === undefined || out.has(name)) return undefined;
    if (switches.includes(name)) {
      out.set(name, '');
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    if (!allowed.includes(name) || !value) return undefined;
    out.set(name, value);
    i += 2;
  }
  return out;
};

type Doc = { readonly file: string; readonly text: () => string };

/**
 * absolute-paths and non-synced-resources: the documents `--files-from`
 * lists (a file, or `-` for stdin), or every tracked one, each path read
 * from `--root`; the report goes to stdout, as the shell checks printed it.
 */
const docCheck =
  (name: string, defaultGuidance: readonly string[], check: (docs: readonly Doc[], base: string, guidance: ReturnType<typeof parseDocConfig>) => { ok: boolean; out: string[] }) =>
  (f: Map<string, string>, io: Io): number => {
    const P = `pariksha ${name}:`;
    const base = resolve(f.get('--root') ?? '.');
    try {
      const configPath = f.get('--config');
      const config = parseDocConfig(configPath === undefined ? undefined : readFileSync(resolve(base, configPath), 'utf8'), defaultGuidance);
      const from = f.get('--files-from');
      const listed = from === undefined ? undefined : from === '-' ? (io.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(resolve(from), 'utf8');
      const docs = selectDocs(base, listed, config.include).map((file) => ({ file, text: () => readDoc(base, file) }));
      const result = check(docs, base, config);
      result.out.forEach(io.out);
      return result.ok ? 0 : 1;
    } catch (e) {
      io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
      return 2;
    }
  };

const absolutePaths = docCheck('absolute-paths', ABSOLUTE_PATHS_GUIDANCE, (docs, _base, config) => checkAbsolutePaths(docs, config));

const nonSyncedResources = docCheck('non-synced-resources', NON_SYNCED_GUIDANCE, (docs, base, config) =>
  checkNonSyncedResources(
    docs,
    () => {
      const top = topOf(base);
      if (top === undefined) throw new Error(`${base} is not in a git repository`);
      return top;
    },
    config,
  ),
);

/** Standard input, or the file `from` names, read whole. */
const listFrom = (from: string, io: Io): string => (from === '-' ? (io.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(resolve(from), 'utf8'));

/**
 * masked-exit-codes: the shell files git tracks under `--root`, read from
 * the working tree, or the index with `--staged`. The report goes to stdout
 * when clean and stderr when not, as the original printed it.
 */
const maskedExitCodes = (f: Map<string, string>, io: Io): number => {
  const root = resolve(f.get('--root') ?? '.');
  try {
    const configPath = f.get('--config');
    const config = configPath === undefined ? DEFAULT_MASKED_CONFIG : parseMaskedConfig(readFileSync(resolve(root, configPath), 'utf8'));
    const files = shellFiles(root, config);
    const problems = files.length === 0 ? [] : findMaskedExits(root, files, maskedReaderFor(f.has('--staged')), config);
    const result = formatMasked(problems, files.length, config.id);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`pariksha masked-exit-codes: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

/**
 * shell-gates: one of `--staged` (the default), `--all`, `--base <ref>` or
 * `--files-from <file>|-`; `--only` names the checks to run, and then
 * ShellCheck sits the run out, as the original did.
 */
const shellGates = (f: Map<string, string>, io: Io): number => {
  const P = '❌ Shell gates could not run:';
  const root = resolve(f.get('--root') ?? '.');
  const modes = ['--staged', '--all', '--base', '--files-from'].filter((name) => f.has(name));
  if (modes.length > 1) {
    io.err(`${P} choose one of --staged, --all, --base, --files-from (got ${modes.join(', ')})`);
    return 2;
  }
  let config: ReturnType<typeof parseGatesConfig>;
  let mode: ShellMode;
  try {
    const configPath = f.get('--config');
    config = parseGatesConfig(configPath === undefined ? '{}' : readFileSync(resolve(root, configPath), 'utf8'));
    const base = f.get('--base');
    const from = f.get('--files-from');
    if (from !== undefined) {
      const files = entries(listFrom(from, io));
      if (files.length === 0) throw new Error('the --files-from list names no file, and a check of nothing is no pass');
      mode = { kind: 'files', files };
    } else mode = base !== undefined ? { kind: 'base', base } : f.has('--all') ? { kind: 'all' } : { kind: 'staged' };
  } catch (e) {
    io.err(`${P} ${(e as Error).message}`);
    return 2;
  }
  const only = f.get('--only');
  let checks: ShellCheckName[] = SHELL_CHECKS.filter((name) => name !== 'preamble' || config.preamble !== undefined);
  if (only !== undefined) {
    const names = only.split(',').filter(Boolean);
    const unknown = names.filter((name) => !SHELL_CHECKS.some((check) => check === name));
    if (names.length === 0 || unknown.length > 0) {
      io.err(`${P} --only takes ${SHELL_CHECKS.join(',')}; got ${names.join(',') || 'nothing'}`);
      return 2;
    }
    checks = SHELL_CHECKS.filter((name) => names.includes(name));
  }
  return runShellGates({ root, mode, checks, only: only !== undefined }, config, { out: io.out, err: io.err, shellcheck: io.shellcheck ?? shellcheckRunner() });
};

const aggregateGateNeeds = (f: Map<string, string>, io: Io): number => {
  const root = resolve(f.get('--root') ?? '.');
  const configPath = f.get('--config');
  let config = DEFAULT_GATE_CONFIG;
  try {
    if (configPath !== undefined) config = parseAggregateConfig(readFileSync(resolve(root, configPath), 'utf8'));
  } catch (e) {
    io.err(`pariksha aggregate-gate-needs: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const result = checkGates(root, config);
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

const pnpmSettings = (f: Map<string, string>, io: Io): number => {
  const root = resolve(f.get('--root') ?? '.');
  const configPath = f.get('--config');
  try {
    const config = configPath === undefined ? DEFAULT_PNPM_CONFIG : parsePnpmConfig(readFileSync(resolve(root, configPath), 'utf8'));
    const result = formatParity(checkPnpmSettings(root, config, (io.now ?? Date.now)()), config.id);
    result.err.forEach(io.err);
    result.out.forEach(io.out);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`pariksha pnpm-settings: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const boundary = (f: Map<string, string>, io: Io): number => {
  const root = resolve(f.get('--root') ?? '.');
  const denyPath = resolve(root, f.get('--deny') ?? DENY_FILE);
  if (!existsSync(denyPath)) {
    io.err(`pariksha boundary: no deny list at ${denyPath}`);
    return 2;
  }
  let deny: Set<string>;
  try {
    deny = parseDenyList(readFileSync(denyPath, 'utf8'));
  } catch (e) {
    io.err(`pariksha boundary: ${denyPath}: ${(e as Error).message}`);
    return 2;
  }
  const files = trackedFiles(root);
  const hits = findDenied(files, deny);
  if (hits.length > 0) {
    for (const h of hits) {
      const at = h.line === 0 ? `${h.file} (its path)` : `${h.file}:${h.line}`;
      io.err(`pariksha boundary: ${at}: "${h.word}" is on the deny list`);
    }
    return 1;
  }
  io.out(`pariksha boundary: ${files.length} files, none names a denied word (${deny.size} on the list)`);
  return 0;
};

const fileSize = (path: string): number | undefined => {
  try {
    const s = statSync(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
};

const docBudgets = (f: Map<string, string>, io: Io): number => {
  const table = f.get('--table');
  if (table === undefined) {
    io.err(USAGE);
    return 2;
  }
  const root = resolve(f.get('--root') ?? '.');
  const tablePath = resolve(root, table);
  if (fileSize(tablePath) === undefined) {
    io.err(`pariksha doc-budgets: no budget table at ${tablePath}`);
    return 2;
  }
  const outcome = checkBudgets(readFileSync(tablePath, 'utf8'), f.get('--section') ?? 'Budgets', relative(root, tablePath), (p) => fileSize(resolve(root, p)));
  outcome.out.forEach(io.out);
  outcome.err.forEach(io.err);
  return outcome.ok ? 0 : 1;
};

/** `--checks 01,DOC-DRIFT-04` as check ids, or every id that is not one. */
const checkList = (value: string): CheckId[] | { unknown: string } => {
  const ids = value.split(',').map((id) => (id.startsWith('DOC-DRIFT-') ? id : `DOC-DRIFT-${id}`));
  const unknown = ids.filter((id) => !(CHECK_IDS as readonly string[]).includes(id));
  if (unknown.length === 0) return ids as CheckId[];
  return { unknown: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not one' : 'are not'} of` };
};

const docReferences = (f: Map<string, string>, io: Io): number => {
  const P = 'pariksha doc-references:';
  const configPath = f.get('--config');
  const base = f.get('--base');
  const all = f.has('--all');
  const baseline = f.has('--update-baseline') ? 'update' : f.has('--write-baseline') ? 'write' : undefined;
  const modes = [f.has('--staged'), all, base !== undefined].filter(Boolean).length;
  if (configPath === undefined || modes !== 1 || (f.has('--update-baseline') && f.has('--write-baseline')) || (baseline !== undefined && !all) || (f.has('--head') && base === undefined)) {
    io.err(USAGE);
    return 2;
  }
  const asked = f.get('--checks');
  const listed = asked === undefined ? undefined : checkList(asked);
  if (listed !== undefined && !Array.isArray(listed)) {
    io.err(`${P} --checks: ${listed.unknown} ${CHECK_IDS.join(', ')}`);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`${P} ${dir} is not in a git repository`);
    return 2;
  }
  const mode: GateMode = base !== undefined ? { kind: 'range', base, head: f.get('--head') ?? 'HEAD' } : all ? { kind: 'all' } : { kind: 'staged' };
  // The identifier search reads the whole tree: a push and CI, not a commit.
  const checks: readonly CheckId[] = listed ?? (mode.kind === 'staged' ? ['DOC-DRIFT-01', 'DOC-DRIFT-02'] : [...CHECK_IDS]);
  let config: DocReferencesConfig;
  let report: GateReport;
  try {
    config = parseDocReferencesConfig(readFileSync(resolve(root, configPath), 'utf8'));
    report = runGate({ root, config, mode, checks, baseline, links: io.links ?? lycheeRunner() });
  } catch (e) {
    io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const result = formatDocReferences(report, { config, mode, checks }, configPath);
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

const enforcementClaims = async (f: Map<string, string>, io: Io): Promise<number> => {
  const configPath = f.get('--config');
  if (configPath === undefined) {
    io.err(USAGE);
    return 2;
  }
  const root = resolve(f.get('--root') ?? '.');
  let P = 'pariksha enforcement-claims:';
  try {
    const config = parseClaimsConfig(readFileSync(resolve(root, configPath), 'utf8'));
    if (config.id !== undefined) P = `pariksha enforcement-claims (${config.id}):`;
    const ESLint = await (io.eslint ?? loadEslint)();
    if (typeof ESLint === 'string') {
      io.err(`${P} ${ESLint}`);
      return 2;
    }
    const result = formatOutcome(P, await checkClaims(root, config, ESLint));
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const exportDeletions = (f: Map<string, string>, io: Io): number => {
  const dir = resolve(f.get('--root') ?? '.');
  const git = gitAtTop(dir);
  if (git === undefined) {
    io.err(`pariksha export-deletions: ${dir} is not in a git repository`);
    return 2;
  }
  const asked = f.get('--base');
  const base = asked === undefined ? resolveBase(git) : resolveBase(git, [asked]);
  if (base === undefined) {
    // A shallow single-branch checkout lands here; passing it would pass unread work.
    io.err(
      asked === undefined
        ? `pariksha export-deletions: none of ${BASE_CANDIDATES.join(', ')} names a commit; fetch one or pass --base`
        : `pariksha export-deletions: --base ${asked} names no commit`,
    );
    return 2;
  }
  let report: ReturnType<typeof checkExportDeletions>;
  try {
    report = checkExportDeletions(git, base);
  } catch (e) {
    io.err(`pariksha export-deletions: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const result = formatReport(report);
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

/** A comma-separated flag value as a list; empty entries dropped. */
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const authorityCitations = (f: Map<string, string>, io: Io, env: NodeJS.ProcessEnv): number => {
  const mode = f.get('--mode') ?? 'staged';
  if (mode !== 'staged' && mode !== 'tree') {
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`pariksha authority-citations: ${dir} is not in a git repository`);
    return 2;
  }
  const git = gitAt(root);
  const opts: Options = {
    authorities: list(f.get('--authority')),
    issuePrefixes: list(f.get('--issue-prefix')),
    adrDir: adrDirOf(f.get('--adr-dir') ?? DEFAULTS.adrDir),
  };
  let result: ReturnType<typeof formatClaims>;
  try {
    const source = mode === 'tree' ? treeSource(git, root, readOrUndefined) : stagedSource(git, env, readOrUndefined);
    result = formatClaims(findUncited(source, opts, git, listAdrs(root, opts.adrDir)), opts);
  } catch (e) {
    io.err(`pariksha authority-citations: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

const coverageByType = (f: Map<string, string>, io: Io): number => {
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`pariksha coverage-by-type: ${dir} is not in a git repository`);
    return 2;
  }
  const ts = (io.typescript ?? (() => loadTypescript(typescriptLoaders(root))))();
  if (typeof ts === 'string') {
    io.err(`pariksha coverage-by-type: ${ts}`);
    return 2;
  }
  try {
    const configPath = f.get('--config');
    const config: Config = configPath === undefined ? DEFAULT_CONFIG : parseConfig(readFileSync(resolve(root, configPath), 'utf8'));
    const from = f.get('--files-from');
    const paths =
      from === undefined
        ? treePaths(root, must(gitAt(root), ['ls-files', '-z']))
        : listedPaths(root, from === '-' ? (io.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(resolve(from), 'utf8'));
    const findings = findGaps(ts, config, root, paths);
    if (from === undefined && findings.judged === 0) {
      // The whole tree in no category is a config that checks nothing.
      io.err(`pariksha coverage-by-type: none of ${findings.listed} tracked file(s) is in a category; nothing was checked, so this is not a pass`);
      return 2;
    }
    const result = formatGaps(config, findings);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`pariksha coverage-by-type: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const coverageExemptions = (f: Map<string, string>, io: Io): number => {
  const configPath = f.get('--config');
  if (configPath === undefined) {
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`pariksha coverage-exemptions: ${dir} is not in a git repository`);
    return 2;
  }
  try {
    const config = parseExemptions(readFileSync(resolve(root, configPath), 'utf8'));
    const pkg = f.get('--package');
    const refused = pkg === undefined ? undefined : checkPackage(root, pkg);
    if (refused !== undefined) {
      io.err(`pariksha coverage-exemptions: --package ${refused}`);
      return 2;
    }
    const vitest = ownedBy(config.vitest.configs, pkg);
    const build = ownedBy(config.build.configs, pkg);
    const missing = missingConfigs(root, [...vitest, ...build]);
    if (missing.length > 0) {
      io.err(`pariksha coverage-exemptions: ${missing.join(', ')} named in ${configPath} but not a file; nothing was checked, so this is not a pass`);
      return 2;
    }
    const noLoader = vitest.length > 0 ? loaderFailure(root, config.loader) : undefined;
    if (noLoader !== undefined) {
      io.err(`pariksha coverage-exemptions: ${noLoader}; nothing was checked, so this is not a pass`);
      return 2;
    }
    let violations = checkVitest(config, vitest, (c) => loadVitestExclude(root, c, config.loader));
    if (build.length > 0) {
      const ts = (io.typescript ?? (() => loadTypescript(typescriptLoaders(root))))();
      if (typeof ts === 'string') {
        io.err(`pariksha coverage-exemptions: ${ts}`);
        return 2;
      }
      violations = [...violations, ...checkBuild(ts, config, root, build)];
    }
    const result = formatViolations(violations, vitest.length, build.length, pkg);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(`pariksha coverage-exemptions: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const envGateSwitches = (f: Map<string, string>, io: Io): number => {
  const P = 'pariksha env-gate-switches:';
  const configPath = f.get('--config');
  const mode = f.get('--mode') ?? 'tree';
  if (configPath === undefined || (mode !== 'staged' && mode !== 'tree')) {
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`${P} ${dir} is not in a git repository`);
    return 2;
  }
  let reader: ReturnType<typeof readerFor>;
  let words: readonly string[];
  try {
    const config = parseGateConfig(readFileSync(resolve(root, configPath), 'utf8'));
    reader = readerFor(config);
    words = config.words;
  } catch (e) {
    io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const reads = (io.gateReads ?? diskReads)(root);
  let result: ReturnType<typeof formatReads>;
  try {
    const listed = listFiles(reads, mode).filter((l) => reader.isGateCode(l.file));
    // A tree with no gate code is a config whose gatePaths match nothing (a
    // typo): staged mode would pass every commit under it, so both refuse.
    if (!(mode === 'tree' ? listed.length > 0 : listFiles(reads, 'tree').some((l) => reader.isGateCode(l.file)))) {
      io.err(`${P} no tracked file is gate code under the config's gatePaths; nothing was checked, so this is not a pass`);
      return 2;
    }
    const sources = listed.flatMap((entry) => {
      const text = readGate(reads, mode, entry);
      return text === undefined ? [] : [{ file: entry.file, text }];
    });
    if (mode === 'tree' && sources.length === 0) {
      // Staged mode reads the index, which holds every file it lists.
      io.err(`${P} every tracked gate file (${listed.length}) is gone from the working tree; nothing was checked, so this is not a pass`);
      return 2;
    }
    const ts = sources.some((s) => needsTypescript(s.file)) ? (io.typescript ?? (() => loadTypescript(typescriptLoaders(root))))() : undefined;
    if (typeof ts === 'string') {
      io.err(`${P} ${ts}`);
      return 2;
    }
    result = formatReads(
      sources.flatMap((s) => reader.findSwitchReads(s.file, s.text, ts)),
      words,
      sources.length,
      configPath,
    );
  } catch (e) {
    // An unread gate, or one the reader failed on, is unchecked, never clean.
    io.err(`${P} could not read gate code, so it is unchecked: ${(e as Error).message}`);
    return 2;
  }
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

/** What a registry ratchet plugs into the shared run: its config, discovery, findings and verdict. */
interface Ratchet<C extends { readonly baseline: string; readonly skipped: readonly string[] }> {
  readonly name: string;
  readonly parse: (source: string) => C;
  /** The baseline a text holds; `atBase` reads the merge base's copy against today's lists. */
  readonly parseBaseline: (source: string, where: string, config: C, atBase: boolean) => Baseline;
  /** The roots discovery reads, all of them. */
  readonly roots: (config: C) => readonly string[];
  /** What discovery finds among the tracked files under the roots, as baseline-shaped lists. */
  readonly discover: (root: string, files: readonly string[], config: C, ts: () => Ts) => Baseline;
  /** What one discovered list is, for a vacuity message: its noun and the roots it was read under. */
  readonly kind: (list: string, config: C) => { readonly noun: string; readonly roots: readonly string[] };
  /** The file an id names, for rename detection: the whole id, or its path before a suffix. */
  readonly fileOf: (id: string) => string;
  readonly findings: (root: string, config: C, found: Baseline, baseline: Baseline, grown: readonly string[], ts: () => Ts) => string[];
  readonly format: (list: readonly string[], found: Baseline, baseline: Baseline, notChecked: readonly string[], compared: boolean) => { ok: boolean; out: string[]; err: string[] };
}

/** Thrown when TypeScript cannot be loaded; carries the loader's message. */
class NoTypescript extends Error {}

const runRatchet = <C extends { readonly baseline: string; readonly skipped: readonly string[] }>(spec: Ratchet<C>, f: Map<string, string>, io: Io): number => {
  const P = `pariksha ${spec.name}:`;
  const configPath = f.get('--config');
  const noBase = f.has('--no-base');
  if (configPath === undefined || (noBase && f.has('--base'))) {
    io.err(USAGE);
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`${P} ${dir} is not in a git repository`);
    return 2;
  }
  const git = gitAt(root);
  try {
    const config = spec.parse(readFileSync(resolve(root, configPath), 'utf8'));
    const baseline = readBaseline(root, config.baseline, (source, where) => spec.parseBaseline(source, where, config, false));
    const roots = spec.roots(config);
    const files = trackedUnder(git, root, roots);
    const empty = emptyRoots(files, roots);
    if (empty.length > 0) throw new Error(`no tracked file lies under ${empty.join(', ')}, so discovery there would read nothing`);
    const ts = (): Ts => {
      const loaded = (io.typescript ?? (() => loadTypescript(typescriptLoaders(root))))();
      if (typeof loaded === 'string') throw new NoTypescript(loaded);
      return loaded;
    };
    const found = spec.discover(root, files, config, ts);
    // Each kind discovery reads must find something: one finding nothing is a
    // config (or a discovery) that checks nothing of that kind, never a pass.
    const none = Object.entries(found).find(([, ids]) => ids.length === 0)?.[0];
    if (none !== undefined) {
      const { noun, roots: under } = spec.kind(none, config);
      throw new Error(`discovery finds no ${noun} under ${under.join(', ')}, so nothing of that kind would be checked`);
    }
    let grown: string[] = [];
    if (!noBase) {
      const asked = f.get('--base');
      const base = asked === undefined ? resolveBase(git) : resolveBase(git, [asked]);
      if (base === undefined) {
        throw new Error(asked === undefined ? `none of ${BASE_CANDIDATES.join(', ')} names a commit, so the baseline cannot be held to its merge base; fetch one, pass --base, or pass --no-base` : `--base ${asked} names no commit`);
      }
      grown = growthSince(git, base, config.baseline, baseline, (source, where) => spec.parseBaseline(source, where, config, true), spec.fileOf);
    }
    const notChecked = [...config.skipped, ...(noBase ? ['baseline growth (--no-base)'] : [])];
    const result = spec.format(spec.findings(root, config, found, baseline, grown, ts), found, baseline, notChecked, !noBase);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.ok ? 0 : 1;
  } catch (e) {
    io.err(e instanceof NoTypescript ? `${P} ${e.message}` : `${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

const CODEC_REGISTRY: Ratchet<CodecConfig> = {
  name: 'codec-registry',
  parse: parseCodecConfig,
  parseBaseline: (source, where, _config, atBase) => parseCodecBaseline(source, where, atBase),
  roots: (config) => config.roots,
  discover: (root, files, config, ts) => discoverCodecs(ts(), root, files, new Set(Object.keys(config.oracles) as Format[])),
  kind: (list, config) => ({ noun: list === 'handParsers' ? 'hand parser' : 'producer/consumer pair', roots: config.roots }),
  fileOf: codecFileOf,
  findings: (root, config, found, baseline, grown, ts) => codecFindings(ts(), root, config, found as Discovery, baseline, grown),
  format: (list, found, baseline, notChecked, compared) => formatCodecFindings(list, found as Discovery, baseline, notChecked, compared),
};

const FAULT_INJECTION_REGISTRY: Ratchet<FaultConfig> = {
  name: 'fault-injection-registry',
  parse: parseFaultConfig,
  parseBaseline: parseFaultBaseline,
  roots: (config) => [...new Set(Object.values(config.discover).flatMap((g) => g.roots))],
  discover: (root, files, config) =>
    Object.fromEntries(Object.entries(config.discover).map(([name, group]) => [name, discoverGroup(root, files.filter((file) => group.roots.some((r) => file === r || file.startsWith(`${r}/`))), group)])),
  kind: (list, config) => ({ noun: `${list} source`, roots: config.discover[list]?.roots ?? [] }),
  fileOf: wholeId,
  findings: (root, config, found, baseline, grown, ts) => faultFindings(ts(), root, config, found, baseline, grown),
  format: formatFaultFindings,
};

const codecRegistry = (f: Map<string, string>, io: Io): number => runRatchet(CODEC_REGISTRY, f, io);
const faultInjectionRegistry = (f: Map<string, string>, io: Io): number => runRatchet(FAULT_INJECTION_REGISTRY, f, io);

export const DEFAULT_SETTINGS = '.claude/settings.json';

const requiredSettings = (f: Map<string, string>, io: Io): number => {
  const P = 'pariksha required-settings:';
  const requirePath = f.get('--require');
  if (requirePath === undefined) {
    io.err(USAGE);
    return 2;
  }
  const root = resolve(f.get('--root') ?? '.');
  const settingsPath = f.get('--settings') ?? DEFAULT_SETTINGS;
  const read = (path: string, what: string): string | undefined => {
    try {
      return readFileSync(resolve(root, path), 'utf8');
    } catch {
      io.err(`${P} cannot read the ${what} ${resolve(root, path)}; nothing was checked, so this is not a pass`);
      return undefined;
    }
  };
  const requireText = read(requirePath, 'requirements');
  if (requireText === undefined) return 2;
  let requirements: ReturnType<typeof parseRequirements>;
  try {
    requirements = parseRequirements(requireText);
  } catch (e) {
    io.err(`${P} ${requirePath}: ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  const settingsText = read(settingsPath, 'settings');
  // A missing settings file lacks every required key: a refusal, not a usage error.
  if (settingsText === undefined) return 1;
  let findings: ReturnType<typeof findMissing>;
  try {
    findings = findMissing(settingsText, requirements);
  } catch (e) {
    io.err(`${P} ${settingsPath}: ${(e as Error).message}`);
    return 1;
  }
  const result = formatFindings(findings, requirements.length, settingsPath, requirePath);
  result.out.forEach(io.out);
  result.err.forEach(io.err);
  return result.ok ? 0 : 1;
};

/**
 * The test files duplicate-tests and flaky-tests judge, relative to the root:
 * those `--files-from` lists (mode `files`; a relative entry is read from the
 * root), or every tracked file on disk (mode `all`), kept when `include`
 * matches the root-relative path.
 */
const testFiles = (f: Map<string, string>, io: Io, root: string, include: RegExp): { mode: string; files: string[] } => {
  const from = f.get('--files-from');
  const listed =
    from === undefined
      ? must(gitAt(root), ['ls-files', '-z'])
          .split('\0')
          .filter((p) => p && existsSync(join(root, p)))
      : entries(from === '-' ? (io.stdin ?? (() => readFileSync(0, 'utf8')))() : readFileSync(resolve(from), 'utf8')).map((e) => relative(root, resolve(root, e)));
  return { mode: from === undefined ? 'all' : 'files', files: listed.filter((p) => include.test(p)) };
};

/** duplicate-tests: the report on stdout, warnings and parse errors on stderr, as the original printed them. */
const duplicateTests = (f: Map<string, string>, io: Io): number => {
  const P = 'pariksha duplicate-tests:';
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`${P} ${dir} is not in a git repository`);
    return 2;
  }
  const ts = (io.typescript ?? (() => loadTypescript(typescriptLoaders(root))))();
  if (typeof ts === 'string') {
    io.err(`${P} ${ts}`);
    return 2;
  }
  try {
    const configPath = f.get('--config');
    const config = parseDuplicateConfig(configPath === undefined ? undefined : readFileSync(resolve(root, configPath), 'utf8'));
    const { mode, files } = testFiles(f, io, root, config.include);
    const listed = files.map((file) => ({ file, path: resolve(root, file), read: () => readFileSync(resolve(root, file), 'utf8') }));
    const result = runDuplicateTests(ts, config, mode, listed);
    result.out.forEach(io.out);
    result.err.forEach(io.err);
    return result.code;
  } catch (e) {
    io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
};

/** flaky-tests: `--runs` passes (default 5) of Vitest over the test files, from each package root. */
const flakyTests = (f: Map<string, string>, io: Io): number => {
  const P = 'pariksha flaky-tests:';
  const runsText = f.get('--runs');
  const runs = runsText === undefined ? DEFAULT_RUNS : parseRuns(runsText);
  if (runs === null) {
    io.err('--runs must be an integer from 1 to 1000');
    return 2;
  }
  const dir = resolve(f.get('--root') ?? '.');
  const root = topOf(dir);
  if (root === undefined) {
    io.err(`${P} ${dir} is not in a git repository`);
    return 2;
  }
  let selected: { config: ReturnType<typeof parseFlakyConfig>; mode: string; files: string[] };
  try {
    const configPath = f.get('--config');
    const config = parseFlakyConfig(configPath === undefined ? undefined : readFileSync(resolve(root, configPath), 'utf8'));
    selected = { config, ...testFiles(f, io, root, config.include) };
  } catch (e) {
    io.err(`${P} ${(e as Error).message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  return runFlakyTests(selected.config, runs, selected.mode, root, selected.files, io.vitest ?? npxVitest, io.out);
};

/** python-floor: the packaged script under the `--python` the caller names, its output and exit code passed through. */
const pythonFloor = (f: Map<string, string>, io: Io): number => {
  const python = f.get('--python');
  const floorFile = f.get('--floor-file');
  if (python === undefined || floorFile === undefined) {
    io.err(USAGE);
    return 2;
  }
  const root = f.get('--root');
  const exclude = f.get('--exclude');
  const selector = f.get('--selector');
  const options: PythonFloorOptions = {
    python,
    floorFile,
    ...(root === undefined ? {} : { root }),
    ...(exclude === undefined ? {} : { exclude }),
    ...(selector === undefined ? {} : { selector }),
  };
  return runPythonFloor(options, io.python ?? inheritRunner, io.err);
};

const COMMANDS: Record<string, { allowed: readonly string[]; switches?: readonly string[]; run: (f: Map<string, string>, io: Io, env: NodeJS.ProcessEnv) => number | Promise<number> }> = {
  'codec-registry': { allowed: ['--config', '--base', '--root'], switches: ['--no-base'], run: codecRegistry },
  'coverage-exemptions': { allowed: ['--config', '--package', '--root'], run: coverageExemptions },
  'fault-injection-registry': { allowed: ['--config', '--base', '--root'], switches: ['--no-base'], run: faultInjectionRegistry },
  'absolute-paths': { allowed: ['--config', '--files-from', '--root'], run: absolutePaths },
  'aggregate-gate-needs': { allowed: ['--config', '--root'], run: aggregateGateNeeds },
  'non-synced-resources': { allowed: ['--config', '--files-from', '--root'], run: nonSyncedResources },
  'pnpm-settings': { allowed: ['--config', '--root'], run: pnpmSettings },
  'python-floor': { allowed: ['--python', '--floor-file', '--exclude', '--selector', '--root'], run: pythonFloor },
  'authority-citations': { allowed: ['--mode', '--authority', '--issue-prefix', '--adr-dir', '--root'], run: authorityCitations },
  boundary: { allowed: ['--root', '--deny'], run: boundary },
  'coverage-by-type': { allowed: ['--config', '--files-from', '--root'], run: coverageByType },
  'doc-budgets': { allowed: ['--table', '--section', '--root'], run: docBudgets },
  'doc-references': { allowed: ['--config', '--base', '--head', '--checks', '--root'], switches: ['--staged', '--all', '--update-baseline', '--write-baseline'], run: docReferences },
  'duplicate-tests': { allowed: ['--config', '--files-from', '--root'], run: duplicateTests },
  'enforcement-claims': { allowed: ['--config', '--root'], run: enforcementClaims },
  'flaky-tests': { allowed: ['--config', '--files-from', '--runs', '--root'], run: flakyTests },
  'env-gate-switches': { allowed: ['--config', '--mode', '--root'], run: envGateSwitches },
  'export-deletions': { allowed: ['--base', '--root'], run: exportDeletions },
  'masked-exit-codes': { allowed: ['--config', '--root'], switches: ['--staged'], run: maskedExitCodes },
  'required-settings': { allowed: ['--require', '--settings', '--root'], run: requiredSettings },
  'shell-gates': { allowed: ['--config', '--base', '--files-from', '--only', '--root'], switches: ['--staged', '--all'], run: shellGates },
};

/** The exit code; a Promise of it for the one check that is asynchronous (enforcement-claims, which loads ESLint). */
export const run = (args: readonly string[], io: Io, version: string = ownVersion(), env: NodeJS.ProcessEnv = process.env): number | Promise<number> => {
  const [command, ...rest] = args;
  if (command === '--version' && rest.length === 0) {
    io.out(version);
    return 0;
  }
  if (command === 'hash' && rest.length === 1 && rest[0]) {
    io.out(hash(rest[0]));
    return 0;
  }
  const spec = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  const f = spec && flags(rest, spec.allowed, spec.switches);
  if (!spec || !f) {
    io.err(USAGE);
    return 2;
  }
  return spec.run(f, io, env);
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
};

if (isMain()) {
  process.exitCode = await run(process.argv.slice(2), {
    out: (line) => console.info(line),
    err: (line) => console.error(line),
  });
}
