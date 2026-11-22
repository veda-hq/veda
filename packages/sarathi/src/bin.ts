#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import { main } from './cli.ts';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** One line from the terminal, the prompt on stderr so stdout stays the answer. */
const ask = async (prompt: string): Promise<string> => {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  // Input that ends first (Ctrl-D) closes the interface, and a pending
  // question never settles then: the close answers it with nothing.
  const closed = new Promise<string>(resolve => lines.once('close', () => resolve('')));
  try {
    return await Promise.race([lines.question(prompt), closed]);
  } catch {
    // fail-open: input that ended before a line answers nothing, an invalid selection.
    return '';
  } finally {
    lines.close();
  }
};

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  ask,
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
});
