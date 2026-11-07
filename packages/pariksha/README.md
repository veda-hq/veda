# @veda-hq/pariksha

परीक्षा, examination. Repository checks: doc drift, rule enforcement,
test-quality ratchets. Part of [Veda](https://github.com/veda-hq/veda).

## v0.1: `pariksha boundary`

Refuses any file git tracks, by its path or its text, that names a word on
the repository's deny list.

```sh
npx @veda-hq/pariksha@0.1.0 boundary [--root <dir>] [--deny <file>]
npx @veda-hq/pariksha@0.1.0 hash <word>
npx @veda-hq/pariksha@0.1.0 --version
```

- The deny list (default `.veda/deny.sha256`, relative to the root) holds one
  SHA-256 hash of a lowercase word per line; blank lines and `#` comments are
  ignored. `pariksha hash <word>` prints the line for a word.
- Words are runs of ASCII letters and digits, compared case-insensitively:
  `foo-bar`, `foo_bar` and `@Foo/bar` all contain the word `foo`.
- Binary files (any NUL byte) are skipped. Untracked files are not read.
- Exit codes: 0 clean, 1 a denied word was found (each is listed with its file
  and line; line 0 is the file's path), 2 a usage or deny-list error.

Node 24 or later. MIT.
