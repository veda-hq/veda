# @veda-hq/eslint-plugin-shuddhi

शुद्धि, purification. ESLint rules for code that coding agents write and
reviewers keep sending back: errors swallowed or stringified unsafely, input
parsed by hand, NestJS and Prisma boundaries left open, and tests that pass
without proving anything.

Each rule closes a defect class that a code reviewer reported repeatedly after
push. Its suite holds those findings, reduced, as invalid cases, with the
corrected code and the near misses as valid ones.

## Install

```sh
pnpm add -D eslint @veda-hq/eslint-plugin-shuddhi
```

ESLint 9 flat config, Node 24. `typescript` is an optional peer: only the rules
that read types (`strict-scalar-parse`, `nest-body-dto`) need it, and only
where the config gives the parser a TypeScript project.

## Use

```js
// eslint.config.js
import shuddhi from '@veda-hq/eslint-plugin-shuddhi';

export default [
  {
    files: ['**/*.ts'],
    plugins: { shuddhi },
    rules: {
      'shuddhi/no-swallowed-catch': 'error',
      'shuddhi/no-vacuous-assertion': 'error',
    },
  },
];
```

The plugin can be bound under any namespace: a repository that had these
rules under its own prefix keeps its rule ids (and its bulk suppressions) by
binding the plugin, or one family's `rules`, under that prefix.

Each family also exports config-block helpers that turn its rules on for a set
of globs, with a `namespace` parameter:

| Family | Rules | Helper |
| --- | --- | --- |
| error handling | `no-swallowed-catch`, `safe-log`, `no-raw-error-string`, `no-direct-child-process` | `errorHandlingBlocks` |
| input parsing | `no-hand-rolled-argv`, `env-through-schema`, `strict-scalar-parse`, `schema-parse-untrusted`, `schema-satisfies-contract`, `prisma-json-through-schema`, `no-regex-structured-parse` | `inputParsingConfigs` |
| server boundary | `nest-body-dto`, `dto-field-constraints`, `no-local-api-contract`, `dto-implements-contract`, `no-capability-literal`, `compare-and-set` | `boundaryBlocks` |
| NestJS and Prisma | `no-raw-sql-interpolation`, `nest-http-exception`, `prisma-transaction-multiwrite`, `nest-param-pipe`, `no-unbound-test-app`, `require-orderby-findfirst`, `no-self-mock-sut` | none |
| test lint | 41 rules on test structure, vacuous assertions, process hygiene, fixtures and fakes | `testLintBlocks` |

Every name of a repository's own helper (the safe-logging module, the child
process runner, the argument parser, the contracts package) is a rule option,
so the messages point at the helper your repository actually has.

## Checks

`pnpm check`: the suites under `node --test` with at least 95% of lines and
functions and 90% of branches covered, and a smoke import of the published
entry point. The rules are plain JavaScript, shipped as written; the suites
are TypeScript that Node runs by stripping types.

## Licence

MIT.
