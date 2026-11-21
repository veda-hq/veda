/**
 * `sarathi worktree pick`: an interactive worktree picker. A subprocess cannot
 * change its parent shell's directory, so this lists the worktrees on stderr
 * (visible even when stdout is captured), asks for a number, and prints only
 * the chosen path on stdout. A shell function does the `cd`; `--shell` prints
 * it.
 *
 * One `git worktree list --porcelain -z` call feeds both the menu and the
 * paths, so a worktree added or removed meanwhile cannot shift a choice onto
 * another path. Each field ends in NUL, so a path with spaces or a newline
 * stays whole. A worktree whose folder is gone (`prunable`) is not offered:
 * there is nowhere to `cd`.
 */
import { execFileSync } from 'node:child_process';

export interface PickIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Shows `prompt` on stderr and resolves the line typed; replaced in tests. */
  readonly ask: (prompt: string) => Promise<string>;
}

export interface Listed {
  readonly path: string;
  readonly row: string;
}

export const SHELL_FUNCTION = `wt() { local d; d=$(pnpm --silent exec sarathi worktree pick) && cd "$d"; }`;

export const SHELL_HELP = `\`sarathi worktree pick\` lists worktrees and prints the path you pick, but it
cannot \`cd\` your shell itself (no subprocess can). Add this function once to
your shell rc file (~/.zshrc), then \`wt\` takes you there:

    ${SHELL_FUNCTION}

Reload your shell (\`source ~/.zshrc\` or a new tab), then run:

    wt
`;

export const PICK_USAGE = 'usage: sarathi worktree pick [--shell]\n';

/**
 * The worktrees `git worktree list --porcelain -z` prints, each with its menu
 * row: fields end in NUL and an empty field ends a record. Gone ones are left
 * out.
 */
export function parsePorcelain(porcelain: string): Listed[] {
  const listed: Listed[] = [];
  let fields: string[] = [];
  const record = (): void => {
    let path: string | undefined;
    let head = '';
    let branch = '';
    let gone = false;
    for (const field of fields) {
      if (field.startsWith('worktree ')) path = field.slice('worktree '.length);
      else if (field.startsWith('HEAD ')) head = field.slice('HEAD '.length);
      else if (field.startsWith('branch ')) branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (field === 'detached') branch = 'detached';
      else if (field === 'prunable' || field.startsWith('prunable ')) gone = true;
    }
    if (path !== undefined && !gone) listed.push({ path, row: `${path}  ${head.slice(0, 7)} [${branch}]` });
    fields = [];
  };
  for (const field of porcelain.split('\0')) {
    if (field === '') record();
    else fields.push(field);
  }
  record();
  return listed;
}

/** The chosen worktree for a typed answer, 1-based; undefined when it names none. */
export function chosen(listed: readonly Listed[], answer: string): Listed | undefined {
  const text = answer.trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  // Base 10 always: a leading zero (`08`) is a number here, never octal.
  return listed[Number.parseInt(text, 10) - 1];
}

function porcelain(io: PickIo): string | undefined {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: io.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...io.env } });
  } catch {
    // fail-open: no listing reads as no worktrees, which the caller reports and exits 1.
    return undefined;
  }
}

/** Runs the picker; resolves the exit code. */
export async function pickMain(args: readonly string[], io: PickIo): Promise<number> {
  if (args.length === 1 && args[0] === '--shell') {
    io.out(SHELL_HELP);
    return 0;
  }
  if (args.length > 0) {
    io.err(PICK_USAGE);
    return 1;
  }
  const listed = parsePorcelain(porcelain(io) ?? '');
  if (listed.length === 0) {
    io.err("No worktrees found (not a git repository, or 'git worktree list' failed).\n");
    return 1;
  }
  io.err(`Worktrees:\n${listed.map((item, index) => `  ${index + 1}) ${item.row}\n`).join('')}`);
  const pick = chosen(listed, await io.ask('Pick a number: '));
  if (pick === undefined) {
    io.err('Invalid selection.\n');
    return 1;
  }
  io.out(`${pick.path}\n`);
  return 0;
}
