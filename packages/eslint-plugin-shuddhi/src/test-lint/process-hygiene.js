/**
 * SHELL-09 with TEST-STRUCT-11 (script and self-test process hygiene) and
 * test process hygiene: process exits, CLI entry checks, git spawn and
 * fixture environments, global patches, git masks, env stubs, spawn
 * timeouts, group kills and detached teardown. One module because the two
 * read the same spawn, env and teardown helpers; `process-hygiene.test.ts`
 * owns it.
 *
 * OPTIONS. The rules name the repository's own helpers in their messages
 * (and some recognise them by name): the hermetic git env builder, the
 * process git mask, the CLI entry check and the process group helpers. Each
 * name is an option with a neutral default; each helper's module path is an
 * option that defaults to none, in which case the message names no module.
 */
import {
  calledMethod,
  constInit,
  enclosingFunctions,
  isFunction,
  isTeardownCallback,
  propertyName,
  registeringBlock,
  TEARDOWN_CALLS,
  unwrap,
  variableOf,
  within,
  WRAPPERS,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Options shared by several rules
// ---------------------------------------------------------------------------

/** JSON schema of one string option. */
const STRING = { type: 'string' };

/** One options object of string properties, nothing else. */
const optionsSchema = properties => [
  { type: 'object', properties, additionalProperties: false },
];

/** The rule's options: its defaults with what the config passes over them. */
const optionsOf = (context, defaults) => ({
  ...defaults,
  ...context.options[0],
});

/** ` (module)` after a helper's name, or nothing when no module is named. */
const inParens = module => (module ? ` (${module})` : '');

/** ` from module` after a helper's name, or nothing when no module is named. */
const fromModule = module => (module ? ` from ${module}` : '');

const GIT_ENV_DEFAULTS = {
  /** The function that builds a hermetic git env for a child. */
  envHelper: 'hermeticGitEnv',
  /** Where that function lives, named in the message. */
  envHelperModule: '',
};
const GIT_MASK_DEFAULTS = {
  /** The function that masks this process's own git env. */
  maskHelper: 'maskProcessGitEnv',
};
const GROUP_DEFAULTS = {
  /** The function that records a child's process group at spawn. */
  trackHelper: 'trackGroup',
  /** The function that signals a tracked group. */
  killHelper: 'killGroup',
  /** Where those functions live, named in the message. */
  groupHelperModule: '',
};

// ---------------------------------------------------------------------------
// SHELL-09 (+ TEST-STRUCT-11) — script and self-test process hygiene
// ---------------------------------------------------------------------------

const isProcessMember = (node, name) =>
  node.type === 'MemberExpression' &&
  node.object.type === 'Identifier' &&
  node.object.name === 'process' &&
  propertyName(node) === name;

const noProcessExit = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Scripts and self-tests set process.exitCode instead of exiting (SHELL-09)',
    },
    schema: [],
    messages: {
      exit: '`process.exit()` ends the process before piped stdout/stderr drains, so the PASS/FAIL report or error that explains the exit can be cut off. Set `process.exitCode = n` and return.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isProcessMember(unwrap(node.callee), 'exit')) {
          context.report({ node, messageId: 'exit' });
        }
      },
    };
  },
};

/**
 * `process.argv[1]` / `process.argv.at(1)`. `node` is never null; a Literal
 * property is always computed (`a[1]`).
 */
function isArgvEntry(node) {
  const value = unwrap(node);
  if (
    value.type === 'MemberExpression' &&
    value.property.type === 'Literal' &&
    value.property.value === 1
  ) {
    return isProcessMember(unwrap(value.object), 'argv');
  }
  if (value.type === 'CallExpression' && calledMethod(value) === 'at') {
    const [index] = value.arguments;
    return (
      index?.type === 'Literal' &&
      index.value === 1 &&
      isProcessMember(unwrap(unwrap(value.callee).object), 'argv')
    );
  }
  return false;
}

const PATH_FUNCTIONS = new Set([
  'resolve',
  'realpathSync',
  'normalize',
  'basename',
  'pathToFileURL',
  'fileURLToPath',
  'String',
]);
const PATH_TESTS = new Set([
  'endsWith',
  'startsWith',
  'includes',
  'match',
  'localeCompare',
]);
const EQUALITY = new Set(['===', '!==', '==', '!=']);

const isNullish = node => {
  const value = unwrap(node);
  return (
    (value?.type === 'Literal' && value.value === null) ||
    (value?.type === 'Identifier' && value.name === 'undefined')
  );
};

const CLI_ENTRY_DEFAULTS = {
  /** The function that compares the entry path with a module URL. */
  helper: 'isCliEntry',
  /** Where it lives, named in the message. */
  helperModule: '',
  /** Files that hold the helper itself, where the comparison lives. */
  helperFilePattern: String.raw`(^|[\\/])cli-entry(\.[\w-]+)*\.(ts|mjs)$`,
};

const cliEntryHelper = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'CLI entry checks go through the shared CLI entry helper (SHELL-09)',
    },
    schema: optionsSchema({
      helper: STRING,
      helperModule: STRING,
      helperFilePattern: STRING,
    }),
    defaultOptions: [CLI_ENTRY_DEFAULTS],
    messages: {
      handRolled:
        'A hand-rolled entry check on `process.argv[1]` fails when the script is reached through a symlink (a linked worktree, /tmp on macOS): the script exits 0 without running. Use `{{helper}}(process.argv[1], import.meta.url)`{{from}}.',
    },
  },
  create(context) {
    const options = optionsOf(context, CLI_ENTRY_DEFAULTS);
    if (new RegExp(options.helperFilePattern).test(context.filename))
      return {};
    const data = {
      helper: options.helper,
      from: fromModule(options.helperModule),
    };
    const candidates = [];
    const aliases = [];
    return {
      MemberExpression(node) {
        if (isArgvEntry(node)) candidates.push(node);
      },
      CallExpression(node) {
        if (isArgvEntry(node)) candidates.push(node);
      },
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          node.init &&
          isArgvEntry(node.init)
        ) {
          aliases.push(...context.sourceCode.getDeclaredVariables(node));
        }
        if (
          node.id.type === 'ArrayPattern' &&
          node.init &&
          isProcessMember(unwrap(node.init), 'argv') &&
          node.id.elements[1]?.type === 'Identifier'
        ) {
          const name = node.id.elements[1].name;
          aliases.push(
            ...context.sourceCode
              .getDeclaredVariables(node)
              .filter(v => v.name === name),
          );
        }
      },
      'Program:exit'() {
        // Every reference is walked: a write (the declaration, a
        // reassignment) sits under a declarator, pattern or assignment,
        // where the walk below stops without reporting.
        for (const variable of aliases) {
          for (const reference of variable.references)
            candidates.push(reference.identifier);
        }
        const reported = new Set();
        const report = node => {
          if (reported.has(node)) return;
          reported.add(node);
          context.report({ node, messageId: 'handRolled', data });
        };
        for (const candidate of candidates) {
          let current = candidate;
          for (;;) {
            const parent = current.parent;
            if (!parent) break;
            if (
              parent.type === 'CallExpression' &&
              parent.arguments.includes(current)
            ) {
              const callee = unwrap(parent.callee);
              const name =
                callee.type === 'Identifier'
                  ? callee.name
                  : propertyName(callee);
              if (PATH_TESTS.has(name)) {
                report(parent);
                break;
              }
              if (PATH_FUNCTIONS.has(name)) {
                current = parent;
                continue;
              }
              // The entry helper and any other call end the walk.
              break;
            }
            // `current.x`: of the nodes with an `object`, a `with` statement
            // has no property name, so it ends the walk as before.
            if (parent.object === current) {
              const name = propertyName(parent);
              if (
                PATH_TESTS.has(name) &&
                parent.parent?.type === 'CallExpression'
              ) {
                report(parent.parent);
                break;
              }
              if (name === 'href' || name === 'pathname') {
                current = parent;
                continue;
              }
              break;
            }
            if (
              parent.type === 'BinaryExpression' &&
              EQUALITY.has(parent.operator)
            ) {
              const other =
                parent.left === current ? parent.right : parent.left;
              if (!isNullish(other)) report(parent);
              break;
            }
            if (
              WRAPPERS.has(parent.type) ||
              parent.type === 'TemplateLiteral' ||
              (parent.type === 'LogicalExpression' && parent.operator === '??')
            ) {
              current = parent;
              continue;
            }
            break;
          }
        }
      },
    };
  },
};

const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'execa',
  'execaSync',
]);
const SHELL_SPAWNERS = new Set(['exec', 'execSync']);

/** `process.env`. */
function isProcessEnv(node) {
  const value = unwrap(node);
  return (
    value?.type === 'MemberExpression' &&
    value.object.type === 'Identifier' &&
    value.object.name === 'process' &&
    propertyName(value) === 'env'
  );
}

/**
 * An env value that is `process.env` or an object spreading it, directly or
 * through a `const`, and not passed through a hermetic builder.
 */
function spreadsAmbientEnv(node, context, depth = 0) {
  let value = unwrap(node);
  if (!value || depth > 3) return false;
  if (value.type === 'Identifier') {
    value = constInit(value, context);
    if (!value) return false;
  }
  if (isProcessEnv(value)) return true;
  if (value.type !== 'ObjectExpression') return false;
  return value.properties.some(
    property =>
      property.type === 'SpreadElement' &&
      (isProcessEnv(property.argument) ||
        spreadsAmbientEnv(property.argument, context, depth + 1)),
  );
}

/**
 * Do these spawn options set `env`? A spread counts only when it cannot be
 * read here (a parameter, a call's result: built elsewhere, as for the whole
 * options); a spread of an object this file shows (inline or a `const`, three
 * deep) must itself carry `env`: `{ ...options }` is not an env.
 */
function optionsSetEnv(object, context, depth = 0) {
  return object.properties.some(property => {
    if (property.type === 'Property') {
      return (property.key.name ?? property.key.value) === 'env';
    }
    let spread = unwrap(property.argument);
    if (spread.type === 'Identifier') spread = constInit(spread, context);
    if (spread?.type !== 'ObjectExpression') return true;
    return depth >= 3 || optionsSetEnv(spread, context, depth + 1);
  });
}

/**
 * The `env` these options end up with: the last `env` key, read through
 * spreads this file shows (`{ ...base }`, three deep), as `optionsSetEnv`
 * reads them. A spread it cannot read is passed over.
 */
function envValueOf(object, context, depth = 0) {
  for (const property of [...object.properties].reverse()) {
    if (property.type === 'Property') {
      if ((property.key.name ?? property.key.value) === 'env') {
        return property.value;
      }
      continue;
    }
    const spread = objectOf(property.argument, context);
    const env = spread && depth < 3 && envValueOf(spread, context, depth + 1);
    if (env) return env;
  }
  return null;
}

/**
 * What a call does with git, for `git-spawn-env` (a git child's own env) and
 * `git-fixture-env` (what else in the file reaches git). `kind` is `git` for
 * a git child (`options` = its options), `shell` for a shell child, `wrapper`
 * for a local `git(...)`; `mask` when it calls the process mask helper named
 * `maskHelper`; `init` when it makes a repository (`init` among the literal
 * arguments).
 */
function gitCallOf(node, maskHelper) {
  const callee = unwrap(node.callee);
  const name =
    callee.type === 'Identifier' ? callee.name : propertyName(callee);
  const [command] = node.arguments;
  const args =
    name === 'git'
      ? node.arguments
      : SPAWNERS.has(name) &&
          unwrap(node.arguments[1])?.type === 'ArrayExpression'
        ? unwrap(node.arguments[1]).elements
        : [];
  const call = {
    kind: name === 'git' ? 'wrapper' : null,
    options: null,
    mask: name === maskHelper,
    init:
      (name === 'git' || /(^|\/)git$/.test(command?.value)) &&
      args.some(argument => argument?.value === 'init'),
  };
  if (SPAWNERS.has(name)) {
    call.options =
      node.arguments.length >= 3
        ? node.arguments[2]
        : node.arguments[1]?.type === 'ObjectExpression'
          ? node.arguments[1]
          : null;
    if (/(^|\/)(ba|z|da)?sh$/.test(command?.value)) {
      call.kind = 'shell';
    } else if (
      // `/usr/bin/git` is the same child. Only a string Literal argument has
      // a string `value`.
      typeof command?.value === 'string' &&
      /(^|\/)git$/.test(command.value)
    ) {
      call.kind = 'git';
    }
  } else if (SHELL_SPAWNERS.has(name)) {
    const text =
      command?.type === 'Literal'
        ? command.value
        : command?.type === 'TemplateLiteral'
          ? command.quasis[0].value.cooked
          : null;
    if (typeof text === 'string' && /^git(\s|$)/.test(text)) {
      call.kind = 'git';
      call.options = node.arguments[1] ?? null;
    }
  }
  return call;
}

const gitSpawnEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'git children spawned by tests get an explicit env (SHELL-09)',
    },
    schema: optionsSchema({ envHelper: STRING, envHelperModule: STRING }),
    defaultOptions: [GIT_ENV_DEFAULTS],
    messages: {
      inheritsEnv:
        "This git child inherits the caller's environment, and under a git hook that includes GIT_DIR and GIT_INDEX_FILE, so it reads and writes the hook's repository instead of the fixture. Pass `env: {{envHelper}}()`{{source}}.",
      ambientEnv:
        'This env copies `process.env` into a git child, so GIT_CONFIG_* injection, GIT_DIR and the global config file and hooks still reach the fixture whatever is overridden after the spread. Build it with `{{envHelper}}({ ...process.env, ... })`.',
    },
  },
  create(context) {
    const options = optionsOf(context, GIT_ENV_DEFAULTS);
    const data = {
      envHelper: options.envHelper,
      source: inParens(options.envHelperModule),
    };
    return {
      CallExpression(node) {
        const call = gitCallOf(node, null);
        if (call.kind !== 'git') return;
        let value = unwrap(call.options);
        if (value?.type === 'Identifier') {
          // A `const` we can read is checked; a parameter is built elsewhere.
          value = constInit(value, context);
          if (!value) return;
        }
        if (value && value.type !== 'ObjectExpression') return; // built elsewhere: not provable here
        if (!value || !optionsSetEnv(value, context)) {
          context.report({ node, messageId: 'inheritsEnv', data });
          return;
        }
        const env = envValueOf(value, context);
        if (env && spreadsAmbientEnv(env, context)) {
          context.report({ node, messageId: 'ambientEnv', data });
        }
      },
    };
  },
};

const GIT_FIXTURE_DEFAULTS = {
  envHelper: GIT_ENV_DEFAULTS.envHelper,
  ...GIT_MASK_DEFAULTS,
};

/**
 * What else in a file that makes git fixtures reaches git with the caller's
 * environment. A rule of its own, not `git-spawn-env` messages, so that
 * rule's suppressed counts stay as they were.
 */
const gitFixtureEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'shells and in-process code in git-fixture tests get a hermetic env',
    },
    schema: optionsSchema({ envHelper: STRING, maskHelper: STRING }),
    defaultOptions: [GIT_FIXTURE_DEFAULTS],
    messages: {
      shellInheritsEnv:
        "This shell runs in a file that builds git fixtures, and inherits the caller's environment: every git it runs reads the hook's GIT_DIR and the machine's global config. Pass `env: {{envHelper}}()`.",
      unmaskedProcess:
        "This file builds a git repository, and the code it calls in-process spawns git with this process's environment: under a hook that is the hook's repository, and git-ai's trace daemon writes into the fixture during teardown. Mask the process for the file: `beforeAll(() => {{maskHelper}}())`.",
    },
  },
  create(context) {
    const options = optionsOf(context, GIT_FIXTURE_DEFAULTS);
    const data = {
      envHelper: options.envHelper,
      maskHelper: options.maskHelper,
    };
    const shells = [];
    let sawGit = false;
    const inits = [];
    const masks = [];
    const calls = [];
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier') calls.push(node);
        const call = gitCallOf(node, options.maskHelper);
        if (call.mask) masks.push(node);
        if (call.init) inits.push(node);
        if (call.kind === 'git' || call.kind === 'wrapper') sawGit = true;
        if (call.kind !== 'shell') return;
        // No options, or a readable object without `env`; options built
        // elsewhere are not provable here.
        const object = objectOf(call.options, context);
        if (!call.options || (object && !optionsSetEnv(object, context))) {
          shells.push(node);
        }
      },
      'Program:exit'() {
        if (sawGit) {
          for (const node of shells) {
            context.report({ node, messageId: 'shellInheritsEnv', data });
          }
        }
        const init = inits.find(
          node => !masks.some(mask => maskCovers(mask, node, calls, context)),
        );
        if (init) {
          context.report({ node: init, messageId: 'unmaskedProcess', data });
        }
      },
    };
  },
};

const CONDITIONAL_TYPES = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchCase',
  'CatchClause',
]);

/**
 * The code a plain call `f(...)` runs in this file: a function declaration,
 * or a const's initializer (a helper, or one wrapped as `once(() => …)`).
 */
function calledCode(call, context) {
  const def = variableOf(call.callee, context)?.defs[0];
  return def?.type === 'FunctionName'
    ? def.node
    : constInit(call.callee, context);
}

/** The statements of `block` after the one that holds `node`. */
function statementsAfter(node, block) {
  const body = block.type === 'Program' ? block.body : (block.body.body ?? []);
  return body.slice(body.findIndex(statement => within(node, statement)) + 1);
}

/**
 * Does the process mask call `mask` run, always, before `init`?
 * In a `beforeAll`/`beforeEach`, it covers the block that registers the hook;
 * anywhere else, it covers what follows it in its own function (or the file,
 * at top level). Either way it also covers a helper of this file called in
 * what it covers. A mask under a condition covers nothing.
 */
function maskCovers(mask, init, calls, context) {
  const chain = enclosingFunctions(mask, context);
  const own = chain[0]?.fn ?? context.sourceCode.ast;
  for (let up = mask.parent; up !== own; up = up.parent) {
    if (CONDITIONAL_TYPES.has(up.type)) return false;
  }
  // A top-level mask runs at import, before every function the file calls.
  if (chain.length === 0 && enclosingFunctions(init, context).length > 0) {
    return true;
  }
  const hook = chain[0]?.owner;
  const after = statementsAfter(mask, own);
  const covered =
    hook?.kind === 'hook' && /^before(All|Each)$/.test(hook.name)
      ? node => within(node, registeringBlock(own))
      : node => after.some(statement => within(node, statement));
  if (covered(init)) return true;
  return calls.some(
    call => covered(call) && within(init, calledCode(call, context)),
  );
}

const noGlobalPatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tests spy on console/stdout instead of reassigning them (TEST-STRUCT-11)',
    },
    schema: [],
    messages: {
      patched:
        'Reassigning `{{target}}` patches a process-wide global that a thrown assertion leaves patched for every later test. Use `vi.spyOn(...)` (restored by `restoreMocks`/`vi.restoreAllMocks()`).',
    },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        const left = unwrap(node.left);
        if (left.type !== 'MemberExpression') return;
        const object = unwrap(left.object);
        const isConsole =
          object.type === 'Identifier' && object.name === 'console';
        const isStream =
          propertyName(left) === 'write' &&
          (isProcessMember(object, 'stdout') ||
            isProcessMember(object, 'stderr'));
        if (isConsole || isStream) {
          context.report({
            node,
            messageId: 'patched',
            data: { target: context.sourceCode.getText(left) },
          });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Test process hygiene: git masks, env stubs, timeouts, group kills, teardown
// ---------------------------------------------------------------------------

/** The `const` object an options or env value resolves to, or null. */
function objectOf(node, context) {
  let value = unwrap(node);
  if (value?.type === 'Identifier') value = constInit(value, context);
  return value?.type === 'ObjectExpression' ? value : null;
}

/** The key a non-computed property names, or null. */
function keyOf(property) {
  if (property.type !== 'Property' || property.computed) return null;
  return property.key.name ?? property.key.value;
}

/**
 * Does this options object set `key`? A spread this file cannot read (a
 * parameter, a call's result) counts, as `optionsSetEnv` does; a readable one
 * must set it itself, three deep.
 */
function optionsSet(object, key, context, depth = 0) {
  return object.properties.some(property => {
    if (property.type === 'Property') return keyOf(property) === key;
    const spread = objectOf(property.argument, context);
    return !spread || depth >= 3 || optionsSet(spread, key, context, depth + 1);
  });
}

/** The mask constant `NAME` or `x.NAME`. */
function isGitMaskConstant(node, name) {
  const value = unwrap(node);
  return (
    (value?.type === 'Identifier' && value.name === name) ||
    propertyName(value) === name
  );
}

/** `Object.assign(...)`. */
function isObjectAssign(call) {
  const callee = unwrap(call.callee);
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    propertyName(callee) === 'assign'
  );
}

const PARTIAL_MASK_DEFAULTS = {
  /** The constant that holds only the git mask variables. */
  maskConstant: 'HERMETIC_GIT_VARIABLES',
  envHelper: GIT_ENV_DEFAULTS.envHelper,
  ...GIT_MASK_DEFAULTS,
};

const noPartialGitMask = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A git env is built by the hermetic env helper, never from its masks alone',
    },
    schema: optionsSchema({
      maskConstant: STRING,
      envHelper: STRING,
      maskHelper: STRING,
    }),
    defaultOptions: [PARTIAL_MASK_DEFAULTS],
    messages: {
      partial:
        "`{{maskConstant}}` is only the masks: it keeps every inherited `GIT_*` (a hook's GIT_DIR, GIT_NAMESPACE, …) and names no author, so a fixture commit fails on a runner with no identity. Use `{{envHelper}}(...)` for a child's env and `{{maskHelper}}()` for this process.",
    },
  },
  create(context) {
    const options = optionsOf(context, PARTIAL_MASK_DEFAULTS);
    const data = {
      maskConstant: options.maskConstant,
      envHelper: options.envHelper,
      maskHelper: options.maskHelper,
    };
    const isMask = node => isGitMaskConstant(node, options.maskConstant);
    return {
      CallExpression(node) {
        if (!isObjectAssign(node)) return;
        if (node.arguments.slice(1).some(isMask)) {
          context.report({ node, messageId: 'partial', data });
        }
      },
      Property(node) {
        if (keyOf(node) !== 'env') return;
        const env = objectOf(node.value, context);
        if (
          env?.properties.some(
            property =>
              property.type === 'SpreadElement' && isMask(property.argument),
          )
        ) {
          context.report({ node, messageId: 'partial', data });
        }
      },
    };
  },
};

/** `process.env` itself, or one of its variables. */
function isProcessEnvTarget(node) {
  const value = unwrap(node);
  return (
    isProcessEnv(value) ||
    (value?.type === 'MemberExpression' && isProcessEnv(value.object))
  );
}

/**
 * Does `fn`'s body register, before `node`, an `onTestFinished` whose
 * callback is one of `restorers` (it writes `process.exitCode`)? An empty or
 * unrelated callback restores nothing.
 */
function registersTeardownBefore(fn, node, restorers) {
  if (fn.body.type !== 'BlockStatement') return false;
  return fn.body.body.some(
    statement =>
      statement.range[1] <= node.range[0] &&
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'CallExpression' &&
      statement.expression.callee.type === 'Identifier' &&
      TEARDOWN_CALLS.has(statement.expression.callee.name) &&
      statement.expression.arguments.some(argument => restorers.has(argument)),
  );
}

const envViaStub = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tests change env vars through vi.stubEnv and restore process.exitCode',
    },
    schema: optionsSchema({ maskHelper: STRING }),
    defaultOptions: [GIT_MASK_DEFAULTS],
    messages: {
      envWrite:
        'Writing `process.env` directly outlives a failed assertion and leaks into every later test in this worker. Use `vi.stubEnv(name, value)` (`undefined` unsets): `unstubEnvs: true` undoes it before the next test. For git masks, `{{maskHelper}}()`.',
      exitCode:
        'This sets `process.exitCode` for the whole worker: a value another test set is lost, or a failure is masked. Save it first and put it back, `const prior = process.exitCode; onTestFinished(() => { process.exitCode = prior; })`.',
    },
  },
  create(context) {
    const data = {
      maskHelper: optionsOf(context, GIT_MASK_DEFAULTS).maskHelper,
    };
    const exitCodes = [];
    // The blocks an afterEach/afterAll restore covers: the describe callback
    // that registers the hook, or the whole file for a top-level one. A
    // restore in one describe says nothing about a test in another.
    const restoredBlocks = [];
    // Teardown callbacks that write `process.exitCode`, seen before any
    // write they guard: source order is visit order.
    const restorers = new Set();
    return {
      AssignmentExpression(node) {
        const left = unwrap(node.left);
        if (isProcessEnvTarget(left)) {
          context.report({ node, messageId: 'envWrite', data });
          return;
        }
        if (left.type !== 'MemberExpression') return;
        if (!isProcessMember(left, 'exitCode')) return;
        const chain = enclosingFunctions(node, context);
        const teardown = chain.find(isTeardownCallback);
        if (teardown) {
          restorers.add(teardown.fn);
          const hook = chain.find(
            entry =>
              entry.owner?.kind === 'hook' &&
              (entry.owner.name === 'afterEach' ||
                entry.owner.name === 'afterAll'),
          );
          if (hook) restoredBlocks.push(registeringBlock(hook.fn));
          return;
        }
        // A restore: the value read back from a const that saved it.
        const right = unwrap(node.right);
        const saved =
          right.type === 'Identifier' ? constInit(right, context) : null;
        if (saved && isProcessMember(saved, 'exitCode')) return;
        if (
          chain.some(({ fn }) => registersTeardownBefore(fn, node, restorers))
        ) {
          return;
        }
        exitCodes.push(node);
      },
      UnaryExpression(node) {
        if (node.operator === 'delete' && isProcessEnvTarget(node.argument)) {
          context.report({ node, messageId: 'envWrite', data });
        }
      },
      CallExpression(node) {
        if (isObjectAssign(node) && isProcessEnv(node.arguments[0])) {
          context.report({ node, messageId: 'envWrite', data });
        }
      },
      'Program:exit'() {
        for (const node of exitCodes) {
          if (restoredBlocks.some(block => within(node, block))) continue;
          context.report({ node, messageId: 'exitCode' });
        }
      },
    };
  },
};

const CHILD_PROCESS_SOURCES = new Set(['node:child_process', 'child_process']);
const BLOCKING_SPAWNS = new Set(['spawnSync', 'execFileSync', 'execSync']);

/**
 * The `child_process` function a call invokes, or null: a named import (under
 * any local name) or a member of a namespace or default import. A local that
 * merely shares the name, such as an injected fake, is not one.
 */
function childProcessFunction(call, context) {
  const callee = unwrap(call.callee);
  const identifier =
    callee.type === 'Identifier'
      ? callee
      : callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier'
        ? callee.object
        : null;
  if (!identifier) return null;
  const def = variableOf(identifier, context)?.defs[0];
  if (
    def?.type !== 'ImportBinding' ||
    !CHILD_PROCESS_SOURCES.has(def.parent.source.value)
  ) {
    return null;
  }
  if (callee.type === 'Identifier') {
    return def.node.type === 'ImportSpecifier'
      ? (def.node.imported.name ?? def.node.imported.value)
      : null;
  }
  return def.node.type === 'ImportSpecifier' ? null : propertyName(callee);
}

const SPAWN_TIMEOUT_DEFAULTS = {
  /** The test budget, named in brackets after "the test budget". */
  testBudget: '',
};

const spawnTimeout = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A blocking child process in a test has a timeout',
    },
    schema: optionsSchema({ testBudget: STRING }),
    defaultOptions: [SPAWN_TIMEOUT_DEFAULTS],
    messages: {
      noTimeout:
        '`{{name}}` with no `timeout` blocks the worker until the test budget{{budget}}, or with no budget at all at module load, when the child hangs. Pass `timeout` in ms: the killed child then fails the test.',
    },
  },
  create(context) {
    const budget = inParens(
      optionsOf(context, SPAWN_TIMEOUT_DEFAULTS).testBudget,
    );
    return {
      CallExpression(node) {
        const name = childProcessFunction(node, context);
        if (!BLOCKING_SPAWNS.has(name)) return;
        // Options follow the arguments array, or the command (`execSync`).
        const options =
          node.arguments.length >= 3 ? node.arguments[2] : node.arguments[1];
        let value = unwrap(options);
        if (value?.type === 'Identifier') {
          // A `const` we can read is checked; a parameter is built elsewhere.
          value = constInit(value, context);
          if (!value) return;
        }
        if (value && value.type !== 'ArrayExpression') {
          if (value.type !== 'ObjectExpression') return; // built elsewhere
          if (optionsSet(value, 'timeout', context)) return;
        }
        context.report({
          node,
          messageId: 'noTimeout',
          data: { name, budget },
        });
      },
    };
  },
};

/** The message data the group helper options give. */
const groupData = options => ({
  trackHelper: options.trackHelper,
  killHelper: options.killHelper,
  source: inParens(options.groupHelperModule),
});

const GROUP_SCHEMA = optionsSchema({
  trackHelper: STRING,
  killHelper: STRING,
  groupHelperModule: STRING,
});

const noRawGroupKill = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tests signal a process group only through the guarded helper',
    },
    schema: GROUP_SCHEMA,
    defaultOptions: [GROUP_DEFAULTS],
    messages: {
      raw: "`process.kill(-pid)` signals whatever group that number names now: `-(pid ?? 0)` after a failed spawn is the runner's own group, and a pid reused after the child exited is someone else's. Track the group at spawn, `const group = {{trackHelper}}(child)`, and end it with `{{killHelper}}(group)`{{source}}.",
    },
  },
  create(context) {
    const data = groupData(optionsOf(context, GROUP_DEFAULTS));
    return {
      CallExpression(node) {
        if (!isProcessMember(unwrap(node.callee), 'kill')) return;
        // `-1` parses as a unary minus too: there is no negative Literal.
        const target = unwrap(node.arguments[0]);
        if (target?.type === 'UnaryExpression' && target.operator === '-') {
          context.report({ node, messageId: 'raw', data });
        }
      },
    };
  },
};

/** Calls that start a child which can outlive the test. */
const DETACHABLE_SPAWNERS = new Set([
  'spawn',
  'fork',
  'execFile',
  'exec',
  'execa',
]);

/**
 * `track(x)`, directly or through a `const` → the variable `x`, or null.
 * `track` is the group tracking helper's name.
 */
function trackedChild(node, context, track) {
  let value = unwrap(node);
  if (value?.type === 'Identifier') value = constInit(value, context);
  if (
    value?.type !== 'CallExpression' ||
    unwrap(value.callee).name !== track
  ) {
    return null;
  }
  const child = unwrap(value.arguments[0]);
  return child?.type === 'Identifier' ? variableOf(child, context) : null;
}

/**
 * `const child = spawn(...)` → the variable `child`, or null. A call is never
 * a declarator's `id`, so a declarator parent holds it as its `init`.
 */
function spawnedChild(node, context) {
  const { parent } = node;
  return parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
    ? context.sourceCode.getDeclaredVariables(parent)[0]
    : null;
}

const detachedTeardown = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A detached child started by a test has teardown that kills its group',
    },
    schema: GROUP_SCHEMA,
    defaultOptions: [GROUP_DEFAULTS],
    messages: {
      noTeardown:
        'A `detached: true` child leads its own process group and outlives this test when an assertion fails before it ends. Kill the group in teardown: `const group = {{trackHelper}}(child); onTestFinished(() => { {{killHelper}}(group); });`{{source}}, or in a `finally` around it.',
    },
  },
  create(context) {
    const options = optionsOf(context, GROUP_DEFAULTS);
    const data = groupData(options);
    const detached = [];
    const kills = [];
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name =
          callee.type === 'Identifier' ? callee.name : propertyName(callee);
        if (name === options.killHelper) {
          kills.push(node);
          return;
        }
        // Spawners only: `toHaveBeenCalledWith(..., { detached: true })`
        // asserts on a fake and starts nothing.
        if (!DETACHABLE_SPAWNERS.has(name)) return;
        const found = node.arguments
          .map(argument => objectOf(argument, context))
          .find(
            object =>
              object?.properties.some(
                property =>
                  keyOf(property) === 'detached' &&
                  unwrap(property.value).type === 'Literal' &&
                  unwrap(property.value).value === true,
              ) ?? false,
          );
        if (found) detached.push(node);
      },
      'Program:exit'() {
        const teardown = kills.filter(kill =>
          enclosingFunctions(kill, context).some(isTeardownCallback),
        );
        for (const node of detached) {
          const scopes = enclosingFunctions(node, context).map(({ fn }) => fn);
          // A kill whose group this file shows was tracked from another
          // child ends that child, not this one. A group it cannot trace (a
          // parameter, a list) still counts.
          const child = spawnedChild(node, context);
          const ownKill = kill => {
            const target = trackedChild(
              kill.arguments[0],
              context,
              options.trackHelper,
            );
            return !child || !target || target === child;
          };
          // A teardown covers the block that registers it: a test or
          // describe callback, or the whole file at top level. A hook in one
          // describe says nothing about a spawn in another.
          const registered = teardown.filter(ownKill).some(kill => {
            const registration = enclosingFunctions(kill, context).find(
              isTeardownCallback,
            ).fn.parent;
            const block = enclosingFunctions(registration, context)[0]?.fn;
            return block === undefined || scopes.includes(block);
          });
          const finallyKills = kills.filter(ownKill).some(kill => {
            for (let up = node.parent; up && !isFunction(up); up = up.parent) {
              // Only a TryStatement has a `finalizer`; null matches no node.
              if (within(kill, up.finalizer)) return true;
            }
            return false;
          });
          if (!registered && !finallyKills) {
            context.report({ node, messageId: 'noTeardown', data });
          }
        }
      },
    };
  },
};

export {
  cliEntryHelper,
  detachedTeardown,
  envViaStub,
  gitFixtureEnv,
  gitSpawnEnv,
  noGlobalPatch,
  noPartialGitMask,
  noProcessExit,
  noRawGroupKill,
  SHELL_SPAWNERS,
  SPAWNERS,
  spawnTimeout,
};
