/** The identity a fixture commits as when its caller names none. */
export declare const FIXTURE_GIT_IDENTITY: Readonly<{
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
  GIT_COMMITTER_NAME: string;
  GIT_COMMITTER_EMAIL: string;
}>;

/** Values every fixture git command runs with, whatever the machine has. */
export declare const HERMETIC_GIT_VARIABLES: Readonly<Record<string, string>>;

/** The environment for a fixture's git commands, built from `base` (copied). */
export declare function hermeticGitEnv(
  base?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

/** The same isolation applied to `env` in place; returns its restore. */
export declare function maskProcessGitEnv(env?: NodeJS.ProcessEnv): () => void;
