/** Command-line options of the rule-check CLIs: `--name value` pairs and bare flags. */

/** The value after `--name`; undefined when the option is absent. Throws when it has no value. */
export function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * Refuse any word that is neither one of `options` (with its value) nor one
 * of `flags`, so a mistyped option fails loudly instead of being ignored.
 */
export function onlyKnown(argv: readonly string[], options: readonly string[], flags: readonly string[] = []): void {
  let value = false;
  for (const word of argv) {
    if (value) value = false;
    else if (options.includes(word)) value = true;
    else if (!flags.includes(word)) throw new Error(`unknown argument ${JSON.stringify(word)}`);
  }
}
