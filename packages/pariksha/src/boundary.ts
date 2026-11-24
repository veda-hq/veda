// The boundary check: no tracked file names a denied name. The deny list holds
// SHA-256 hashes of lowercase words, so a repository can refuse a name without
// writing it down.
import { createHash } from 'node:crypto';

export interface TrackedFile {
  readonly path: string;
  readonly text: string;
}

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly word: string;
}

export const hash = (word: string): string => createHash('sha256').update(word.toLowerCase()).digest('hex');

/** The deny list's hashes: one per line; blank lines and # comments ignored. */
export const parseDenyList = (text: string): Set<string> => {
  const hashes = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (line === '') continue;
    if (!/^[0-9a-f]{64}$/.test(line)) throw new Error(`not a SHA-256 hash: "${line}"`);
    hashes.add(line);
  }
  return hashes;
};

/** A file is text unless it holds a NUL byte. */
export const isText = (bytes: Uint8Array): boolean => !bytes.includes(0);

/** `f`, asked once per distinct word: a repeated word gets the answer `f` gave it the first time. */
export const once = <T>(f: (word: string) => T): ((word: string) => T) => {
  const seen = new Map<string, T>();
  return (word) => {
    if (!seen.has(word)) seen.set(word, f(word));
    return seen.get(word) as T;
  };
};

/** Every word of every file whose hash is denied, by file and line. Each distinct word is hashed once. */
export const findDenied = (files: readonly TrackedFile[], deny: ReadonlySet<string>): Hit[] => {
  const hits: Hit[] = [];
  const denied = once((word) => deny.has(hash(word)));
  for (const file of files) {
    // A path names things too: a file called after a denied name is refused.
    const lines = [file.path, ...file.text.split('\n')];
    lines.forEach((text, i) => {
      text
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.forEach((word) => {
          if (denied(word)) hits.push({ file: file.path, line: i, word });
        });
    });
  }
  return hits;
};
