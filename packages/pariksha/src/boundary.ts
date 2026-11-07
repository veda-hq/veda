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

/** Every word of every file whose hash is denied, by file and line. */
export const findDenied = (files: readonly TrackedFile[], deny: ReadonlySet<string>): Hit[] => {
  const hits: Hit[] = [];
  const seen = new Map<string, boolean>();
  const denied = (word: string): boolean => {
    let d = seen.get(word);
    if (d === undefined) {
      d = deny.has(hash(word));
      seen.set(word, d);
    }
    return d;
  };
  for (const file of files) {
    // A path names things too: a file called after a denied name is refused.
    const lines = [file.path, ...file.text.split('\n')];
    lines.forEach((text, i) => {
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (denied(word)) hits.push({ file: file.path, line: i, word });
      }
    });
  }
  return hits;
};
