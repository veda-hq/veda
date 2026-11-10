// Which files the record rules read. Paths are repository-relative and use
// `/`, exactly as `git diff --name-only` prints them.
import type { FrozenPaths, RecordsConfig } from "../config.ts";

/**
 * A frozen path: under one of `frozen.paths` and not one of the exact
 * `frozen.except` paths, which stay editable.
 */
export const isFrozenPath = (path: string, frozen: FrozenPaths): boolean =>
  frozen.paths.some((prefix) => path.startsWith(prefix)) &&
  !frozen.except.includes(path);

/**
 * Files never scanned as text: binaries, lockfiles and generated bundles.
 * Everything else a repository tracks is text a reader may follow.
 */
const NOT_TEXT =
  /(\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|br|woff2?|ttf|otf|eot|mp4|mov|mp3|wav|jar|keystore|jks|p12|der|so|dylib|a|bin|db|sqlite|tflite|onnx|pbxproj|xcworkspacedata|lock)|pnpm-lock\.yaml|package-lock\.json)$/i;

export const isTextPath = (path: string): boolean => !NOT_TEXT.test(path);

/**
 * Source files, by extension in either case (`main.C`): the path denylist
 * does not read code.
 */
export const isCodePath = (path: string): boolean =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sh|bash|zsh|rb|swift|kt|java|m|mm|h|c|cc|cpp|go|rs|sql|prisma|css|scss)$/i.test(
    path,
  );

/**
 * Whether any rule reads `path`: not a binary, not a frozen path, not under a
 * skipped prefix, and none of `own`, the gate's own files (its baseline and
 * the config, which quote the very shapes the rules refuse).
 */
export const isReadPath = (
  path: string,
  records: RecordsConfig,
  own: readonly string[],
): boolean =>
  isTextPath(path) &&
  !own.includes(path) &&
  !records.skip.some((prefix) => path.startsWith(prefix)) &&
  !isFrozenPath(path, records.frozen);
