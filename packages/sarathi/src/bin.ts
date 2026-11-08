#!/usr/bin/env node
import { main } from './cli.ts';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
});
