import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { START_IDENTITY_FORMAT, type LivenessSystem } from "./liveness.ts";
import { lockFilename, type SlotChild, type SpawnSlotChild } from "./slot.ts";
import {
  appendLine,
  cleanLabel,
  currentStage,
  DEFAULT_TURNS,
  DEFAULT_WAIT_MINUTES,
  gitIn,
  LOCK_RETRY_MS,
  LOCK_TRIES,
  liveness,
  look,
  HOLDER_INDENT,
  NOTICE_MS,
  ordinal,
  parseReplayArgs,
  parseTicket,
  parseTurnArgs,
  POLL_MS,
  VIRTUAL_POLL_MS,
  QUEUE_LOCK_NAME,
  queuedPids,
  readSettingsFile,
  readTickets,
  REPLAY_USAGE,
  replayable,
  resolveSettings,
  SETTINGS_FILENAME,
  sleepFor,
  TICKET_SCHEMA,
  ticketPath,
  TICKETS_DIRNAME,
  turn,
  TURN_DIR_ENV,
  TURN_HELD_ENV,
  TURN_LOG_FILENAME,
  TURN_MODE_ENV,
  TURN_USAGE,
  TURN_WAIT_ENV,
  turnDirectory,
  turnReplay,
  TURNS_ENV,
  underQueueLock,
  waiterPath,
  WAITERS_DIRNAME,
  waitingLines,
  whoAsks,
  writeTicket,
  type Git,
  type Look,
  type Ticket,
  type TurnSettings,
} from "./turn.ts";

/*
 * The queue runs against a REAL directory, as `dvara slot`'s tests do; only
 * the clock, the process table, the sleep, git and the command are faked.
 * Every test builds its own environment: nothing here reads the process's,
 * so a run inside a held turn, in CI or with the queue enforcing tests the
 * same thing, and nothing writes into the machine's real queue.
 */

/**
 * Every test fails at 10 s rather than waiting forever: a mutant that leaves
 * a promise unsettled (sleepFor with its timer removed) otherwise held the
 * suite open to the gate's limit, twice per retry pass, and outgrew its
 * 15-minute budget (veda#654). Failing inside the limit, the test kills it.
 */
const it = (name: string, fn: () => void | Promise<void>) => test(name, { timeout: 10_000 }, fn);

/**
 * Once every test has ended, a process still alive 5 s later is held open by
 * a handle nothing closed: it fails, and exits. The timer is unref'd, so a
 * healthy run ends as before.
 */
after(() => {
  setTimeout(() => {
    process.stderr.write("turn.test.ts: still running 5 s after the last test; a handle was left open\n");
    process.exit(1);
  }, 5_000).unref();
});

const SELF = 4242;
const OTHER = 999;
const THIRD = 777;
const SELF_START = `${START_IDENTITY_FORMAT} Sat Sep 19 10:00:00 2026`;
const OTHER_START = `${START_IDENTITY_FORMAT} Sat Sep 19 09:00:00 2026`;
const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);

interface World {
  system: LivenessSystem;
  alive: Set<number>;
  starts: Map<number, string | null>;
  clock: number;
  /** startIdentityOf calls, by pid. */
  startReads: number[];
}

const world = (): World => {
  const state: World = {
    alive: new Set([SELF, OTHER, THIRD]),
    starts: new Map<number, string | null>([
      [SELF, SELF_START],
      [OTHER, OTHER_START],
      [THIRD, null],
    ]),
    clock: T0,
    startReads: [],
    system: {
      pid: SELF,
      now: () => state.clock,
      isAlive: (pid) => state.alive.has(pid),
      startIdentityOf: (pid) => {
        state.startReads.push(pid);
        return state.starts.get(pid) ?? null;
      },
    },
  };
  return state;
};

let dir: string;
let w: World;
const realHome = process.env["HOME"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvara-turn-"));
  w = world();
  // The home folder is scratch too: a mutant that drops DVARA_TURN_DIR
  // lands here, never in the machine's queue the reading replays.
  process.env["HOME"] = join(dir, "home");
});

afterEach(() => {
  process.env["HOME"] = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  token: "their-token",
  pid: OTHER,
  startIdentity: OTHER_START,
  class: "other",
  exclusive: false,
  askedAt: T0 - 120_000,
  grantedAt: T0 - 120_000,
  overBound: false,
  label: "pnpm check",
  repo: "acme-policy",
  worktree: "brave-curie",
  branch: "claude/x",
  ...overrides,
});

const settings = (overrides: Partial<TurnSettings> = {}): TurnSettings => ({
  mode: "enforce",
  turns: 2,
  waitMinutes: 30,
  reason: "env",
  ...overrides,
});

const fakeGit =
  (answers: Record<string, string | null>, calls: string[][] = []): Git =>
  (cwd, args) => {
    calls.push([cwd, ...args]);
    return answers[args[0] ?? ""] ?? null;
  };

const REPO_GIT = fakeGit({
  "rev-parse": "/code/veda/.claude/worktrees/brave\n/code/veda/.git",
  branch: "claude/brave",
});

describe("turnDirectory", () => {
  it("is DVARA_TURN_DIR as given, else the machine's folder under ~/.dvara/turns", () => {
    assert.equal(turnDirectory({ DVARA_TURN_DIR: "/q" }), "/q");
    assert.equal(turnDirectory({ DVARA_TURN_DIR: "" }), join(homedir(), ".dvara", "turns", hostname()));
    assert.equal(turnDirectory({}), join(homedir(), ".dvara", "turns", hostname()));
    assert.equal(TURN_DIR_ENV, "DVARA_TURN_DIR");
  });
});

describe("readSettingsFile", () => {
  it("reads the settings object from the queue folder", () => {
    writeFileSync(join(dir, SETTINGS_FILENAME), JSON.stringify({ mode: "enforce", turns: 3 }));
    assert.deepEqual(readSettingsFile(dir), { mode: "enforce", turns: 3 });
    assert.equal(SETTINGS_FILENAME, "settings.json");
  });

  it("is empty when the file is missing, not JSON or not an object", () => {
    assert.deepEqual(readSettingsFile(dir), {});
    writeFileSync(join(dir, SETTINGS_FILENAME), "{");
    assert.deepEqual(readSettingsFile(dir), {});
    writeFileSync(join(dir, SETTINGS_FILENAME), "null");
    assert.deepEqual(readSettingsFile(dir), {});
    writeFileSync(join(dir, SETTINGS_FILENAME), "7");
    assert.deepEqual(readSettingsFile(dir), {});
  });
});

describe("resolveSettings", () => {
  it("defaults to record mode, two turns and a 30-minute bound", () => {
    assert.deepEqual(resolveSettings({}, {}), {
      mode: "record",
      turns: 2,
      waitMinutes: 30,
      reason: "default",
    });
    assert.equal(DEFAULT_TURNS, 2);
    assert.equal(DEFAULT_WAIT_MINUTES, 30);
  });

  it("takes the settings file, and the environment over it", () => {
    const file = { mode: "enforce", turns: 3, waitMinutes: 20 };
    assert.deepEqual(resolveSettings({}, file), {
      mode: "enforce",
      turns: 3,
      waitMinutes: 20,
      reason: "settings",
    });
    assert.deepEqual(
      resolveSettings({ [TURN_MODE_ENV]: "off", [TURNS_ENV]: "4", [TURN_WAIT_ENV]: "5" }, file),
      { mode: "off", turns: 4, waitMinutes: 5, reason: "env" },
    );
    assert.equal(TURN_MODE_ENV, "DVARA_TURN_MODE");
    assert.equal(TURNS_ENV, "DVARA_TURNS");
    assert.equal(TURN_WAIT_ENV, "DVARA_TURN_WAIT_MINUTES");
  });

  it("ignores values that are not a mode or a positive integer", () => {
    for (const bad of ["", "0", "-1", "1.5", "two", "enforcing"])
      assert.deepEqual(
        resolveSettings(
          { [TURN_MODE_ENV]: bad, [TURNS_ENV]: bad, [TURN_WAIT_ENV]: bad },
          { mode: 3, turns: "three", waitMinutes: 0 },
        ),
        { mode: "record", turns: 2, waitMinutes: 30, reason: "default" },
      );
    for (const odd of [true, null, [3], "3x", -2])
      assert.deepEqual(resolveSettings({}, { mode: null, turns: odd, waitMinutes: odd }), {
        mode: "record",
        turns: 2,
        waitMinutes: 30,
        reason: "default",
      });
  });

  it("reads counts in the settings file written as text or as numbers", () => {
    assert.deepEqual(resolveSettings({}, { turns: "3", waitMinutes: 12 }), {
      mode: "record",
      turns: 3,
      waitMinutes: 12,
      reason: "default",
    });
  });

  it("is off in CI, whatever else says", () => {
    for (const ci of ["true", "1", "yes"])
      assert.deepEqual(resolveSettings({ CI: ci, [TURN_MODE_ENV]: "enforce" }, {}), {
        mode: "off",
        turns: 2,
        waitMinutes: 30,
        reason: "CI",
      });
    for (const notCi of ["", "false", "0"])
      assert.equal(resolveSettings({ CI: notCi }, {}).mode, "record");
  });
});

describe("whoAsks", () => {
  it("names a linked worktree's repository, worktree and branch", () => {
    const calls: string[][] = [];
    const git = fakeGit(
      {
        "rev-parse": "/code/acme_store/.claude/worktrees/w55\n/code/acme_store/.git",
        branch: "claude/4015",
      },
      calls,
    );
    assert.deepEqual(whoAsks("/here", git), {
      repo: "acme_store",
      worktree: "w55",
      branch: "claude/4015",
    });
    assert.deepEqual(calls, [
      ["/here", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      ["/here", "branch", "--show-current"],
    ]);
  });

  it("names no worktree in the main checkout, and no branch when detached", () => {
    const git = fakeGit({ "rev-parse": "/code/veda\n/code/veda/.git", branch: "" });
    assert.deepEqual(whoAsks("/code/veda", git), { repo: "veda", worktree: null, branch: null });
  });

  it("reads a bare common directory's name without its last .git", () => {
    const git = fakeGit({ "rev-parse": "/w/tree\n/srv/niyam.git", branch: null });
    assert.deepEqual(whoAsks("/w/tree", git), { repo: "niyam", worktree: "tree", branch: null });
    const dotted = fakeGit({ "rev-parse": "/w/t\n/srv/my.github.git", branch: "b" });
    assert.equal(whoAsks("/w/t", dotted).repo, "my.github");
    const plain = fakeGit({ "rev-parse": "/w/t\n/srv/plain", branch: "b" });
    assert.equal(whoAsks("/w/t", plain).repo, "plain");
  });

  it("reads a real repository through the real git, and nothing outside one", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    // A hook's GIT_DIR would point git at the real repository: none of the outer GIT_ variables apply here.
    const saved = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"));
    for (const [key] of saved) delete process.env[key];
    const isolation = {
      GIT_CEILING_DIRECTORIES: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    Object.assign(process.env, isolation);
    try {
      execFileSync("git", ["-C", repo, "init", "-q", "-b", "trunk"], { stdio: "ignore" });
      assert.deepEqual(whoAsks(repo, gitIn), { repo: "repo", worktree: null, branch: "trunk" });
      assert.equal(gitIn(dir, ["rev-parse", "--show-toplevel"]), null);
    } finally {
      for (const key of Object.keys(isolation)) delete process.env[key];
      for (const [key, value] of saved) process.env[key] = value;
    }
  });

  it("names the folder outside a repository", () => {
    assert.deepEqual(whoAsks("/some/folder", fakeGit({})), {
      repo: "folder",
      worktree: null,
      branch: null,
    });
    assert.deepEqual(whoAsks("/some/folder", fakeGit({ "rev-parse": "/only/one" })), {
      repo: "folder",
      worktree: null,
      branch: null,
    });
  });
});

describe("parseTicket", () => {
  it("reads a complete ticket", () => {
    assert.deepEqual(parseTicket(JSON.stringify(ticket())), ticket());
    const waiting = ticket({ grantedAt: null, startIdentity: null, worktree: null, branch: null });
    assert.deepEqual(parseTicket(JSON.stringify(waiting)), waiting);
    const push = ticket({ class: "push", exclusive: true, overBound: true });
    assert.deepEqual(parseTicket(JSON.stringify(push)), push);
  });

  it("reads a ticket of a later format, dropping what it does not know", () => {
    const later = { schema: 2, ...ticket(), priority: "high" };
    assert.deepEqual(parseTicket(JSON.stringify(later)), ticket());
  });

  it("refuses anything incomplete", () => {
    const bad: Array<Record<string, unknown>> = [
      { token: "" },
      { token: 5 },
      { pid: 0 },
      { pid: "999" },
      { pid: 1.5 },
      { startIdentity: 5 },
      { class: "fast" },
      { exclusive: "no" },
      { askedAt: "now" },
      { askedAt: Number.NaN },
      { grantedAt: "then" },
      { overBound: 0 },
      { label: null },
      { repo: 1 },
      { worktree: 1 },
      { branch: 1 },
    ];
    for (const change of bad)
      assert.equal(parseTicket(JSON.stringify({ ...ticket(), ...change })), null, JSON.stringify(change));
    for (const raw of ["", "{", "null", "7", '"text"'])
      assert.equal(parseTicket(raw), null, raw);
  });
});

describe("tickets on disk", () => {
  it("are written whole and read back", () => {
    writeTicket(dir, ticket());
    writeTicket(dir, ticket({ token: "mine", pid: SELF }));
    assert.equal(ticketPath(dir, "mine"), join(dir, "tickets", "mine.json"));
    assert.equal(TICKETS_DIRNAME, "tickets");
    assert.deepEqual(readdirSync(join(dir, TICKETS_DIRNAME)).sort(), ["mine.json", "their-token.json"]);
    assert.deepEqual(JSON.parse(readFileSync(ticketPath(dir, "mine"), "utf8")), {
      schema: 1,
      ...ticket({ token: "mine", pid: SELF }),
    });
    assert.equal(TICKET_SCHEMA, 1);
    assert.deepEqual(
      readTickets(dir).map((entry) => entry.token).sort(),
      ["mine", "their-token"],
    );
    // The holder's files are its own: no one else on the machine reads its turn.
    assert.equal(statSync(ticketPath(dir, "mine")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, TICKETS_DIRNAME)).mode & 0o777, 0o700);
  });

  it("skip what is not a ticket", () => {
    writeTicket(dir, ticket());
    writeFileSync(join(dir, TICKETS_DIRNAME, "torn.json"), "{");
    writeFileSync(join(dir, TICKETS_DIRNAME, "x.json.tmp"), JSON.stringify(ticket({ token: "t" })));
    mkdirSync(join(dir, TICKETS_DIRNAME, "folder.json"));
    assert.deepEqual(readTickets(dir), [ticket()]);
  });

  it("are none in a queue with no tickets folder", () => {
    assert.deepEqual(readTickets(join(dir, "nowhere")), []);
  });
});

describe("liveness", () => {
  it("checks a ticket's start once, then its pid alone", () => {
    const alive = liveness(w.system);
    assert.equal(alive(ticket()), true);
    assert.equal(alive(ticket()), true);
    assert.deepEqual(w.startReads, [OTHER]);
    w.alive.delete(OTHER);
    assert.equal(alive(ticket()), false);
  });

  it("finds a reused pid gone", () => {
    const alive = liveness(w.system);
    assert.equal(alive(ticket({ startIdentity: SELF_START })), false);
    assert.equal(alive(ticket({ startIdentity: SELF_START })), false);
  });
});

describe("sleepFor", () => {
  it("resolves after the time it is given, not before", async () => {
    const started = performance.now();
    await sleepFor(30);
    assert.ok(performance.now() - started >= 25);
  });
});

describe("underQueueLock", () => {
  const sleeps: number[] = [];
  // A try past the last fails the test: a mutant that never stops trying
  // would otherwise spin on this sleep, which never yields to the timeout.
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    if (sleeps.length > LOCK_TRIES) throw new Error("slept past the last try");
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("decides under the queue lock and releases it", async () => {
    const lock = join(dir, lockFilename(QUEUE_LOCK_NAME));
    const seen = await underQueueLock(dir, w.system, sleep, () => existsSync(lock));
    assert.equal(seen, true);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(sleeps, []);
    assert.equal(QUEUE_LOCK_NAME, "queue");
  });

  it("releases the lock when the decision throws", async () => {
    await assert.rejects(
      underQueueLock(dir, w.system, sleep, () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(existsSync(join(dir, lockFilename(QUEUE_LOCK_NAME))), false);
  });

  it("waits for a live holder, and decides without the lock after every try", async () => {
    const lock = join(dir, lockFilename(QUEUE_LOCK_NAME));
    writeFileSync(
      lock,
      JSON.stringify({ pid: OTHER, startIdentity: OTHER_START, branch: "queue", rootDir: dir, token: "t", since: T0 }),
    );
    let decided = 0;
    const result = await underQueueLock(dir, w.system, sleep, () => ++decided);
    assert.equal(result, 1);
    assert.equal(sleeps.length, LOCK_TRIES);
    assert.ok(sleeps.every((ms) => ms === LOCK_RETRY_MS));
    assert.equal(LOCK_TRIES, 100);
    assert.equal(LOCK_RETRY_MS, 10);
    assert.equal(existsSync(lock), true);
  });

  it("takes the lock as soon as its holder lets go", async () => {
    const lock = join(dir, lockFilename(QUEUE_LOCK_NAME));
    writeFileSync(
      lock,
      JSON.stringify({ pid: OTHER, startIdentity: OTHER_START, branch: "queue", rootDir: dir, token: "t", since: T0 }),
    );
    const held = await underQueueLock(
      dir,
      w.system,
      async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) rmSync(lock);
      },
      () => existsSync(lock),
    );
    assert.equal(held, true);
    assert.equal(sleeps.length, 3);
  });
});

const mine = (overrides: Partial<Ticket> = {}): Ticket =>
  ticket({ token: "mine", pid: SELF, startIdentity: SELF_START, askedAt: T0, grantedAt: null, ...overrides });

describe("look", () => {
  it("grants a free turn and writes it down", () => {
    const me = mine();
    writeTicket(dir, me);
    const view = look(dir, me, settings(), T0 + 5, liveness(w.system));
    assert.equal(view.me.grantedAt, T0 + 5);
    assert.equal(view.me.overBound, false);
    assert.deepEqual(parseTicket(readFileSync(ticketPath(dir, "mine"), "utf8")), view.me);
    assert.deepEqual(view.holders, []);
    assert.equal(view.inUse, 0);
    assert.equal(view.place, 0);
  });

  it("keeps a request waiting behind the holders, and names its place", () => {
    writeTicket(dir, ticket({ exclusive: true }));
    writeTicket(dir, ticket({ token: "ahead", pid: THIRD, grantedAt: null, askedAt: T0 - 1 }));
    const me = mine();
    writeTicket(dir, me);
    const view = look(dir, me, settings(), T0 + 5, liveness(w.system));
    assert.equal(view.me, me);
    assert.equal(view.inUse, 2);
    assert.equal(view.place, 2);
    assert.deepEqual(view.holders.map((entry) => entry.token), ["their-token"]);
    assert.equal(parseTicket(readFileSync(ticketPath(dir, "mine"), "utf8"))?.grantedAt, null);
  });

  it("lists the holders longest held first", () => {
    writeTicket(dir, ticket({ token: "z-early", grantedAt: T0 - 9000 }));
    writeTicket(dir, ticket({ token: "a-late", pid: THIRD, grantedAt: T0 - 10 }));
    writeTicket(dir, ticket({ token: "m-mid", grantedAt: T0 - 500 }));
    const view = look(dir, mine(), settings({ turns: 3 }), T0, liveness(w.system));
    assert.deepEqual(view.holders.map((entry) => entry.token), ["z-early", "m-mid", "a-late"]);
  });

  it("removes a dead process's ticket and serves the next in line", () => {
    writeTicket(dir, ticket({ exclusive: true }));
    w.alive.delete(OTHER);
    const me = mine();
    writeTicket(dir, me);
    const view = look(dir, me, settings(), T0 + 5, liveness(w.system));
    assert.equal(view.me.grantedAt, T0 + 5);
    assert.equal(existsSync(ticketPath(dir, "their-token")), false);
  });

  it("grants at the bound, over the turns in use", () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const me = mine();
    const bound = T0 + 30 * 60_000;
    assert.equal(look(dir, me, settings(), bound - 1, liveness(w.system)).me.grantedAt, null);
    const view = look(dir, me, settings(), bound, liveness(w.system));
    assert.equal(view.me.grantedAt, bound);
    assert.equal(view.me.overBound, true);
  });

  it("leaves a granted request as it was", () => {
    const me = mine({ grantedAt: T0 });
    const view = look(dir, me, settings(), T0 + 99, liveness(w.system));
    assert.equal(view.me, me);
    assert.equal(existsSync(ticketPath(dir, "mine")), false);
  });

  it("never counts its own ticket among the others", () => {
    const me = mine({ grantedAt: T0 });
    writeTicket(dir, me);
    const view = look(dir, me, settings({ turns: 1 }), T0 + 99, liveness(w.system));
    assert.deepEqual(view.holders, []);
    assert.equal(view.inUse, 0);
    const waiting = mine({ token: "waiting" });
    writeTicket(dir, waiting);
    writeTicket(dir, ticket({ exclusive: true, grantedAt: T0 }));
    const behind = look(dir, waiting, settings({ turns: 1 }), T0 + 99, liveness(w.system));
    assert.equal(behind.place, 1);
  });

  it("is granted only its own turn, not the turn of one ahead of it", () => {
    writeTicket(dir, ticket({ token: "ahead", pid: THIRD, grantedAt: null, askedAt: T0 - 1 }));
    const me = mine();
    const view = look(dir, me, settings({ turns: 1 }), T0 + 5, liveness(w.system));
    assert.equal(view.me.grantedAt, null);
    assert.equal(view.place, 2);
    assert.equal(view.inUse, 0);
  });
});

describe("ordinal", () => {
  it("writes English ordinals", () => {
    const cases: Array<[number, string]> = [
      [1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [10, "10th"],
      [11, "11th"], [12, "12th"], [13, "13th"], [14, "14th"],
      [21, "21st"], [22, "22nd"], [23, "23rd"], [101, "101st"], [111, "111th"], [113, "113th"],
    ];
    for (const [n, text] of cases) assert.equal(ordinal(n), text);
  });
});

describe("waitingLines", () => {
  it("says the count in use, the place and the wait, then one aligned line per holder", () => {
    const view: Look = {
      me: mine(),
      holders: [
        ticket({ grantedAt: T0 - 6 * 60_000 + 1 }),
        ticket({
          token: "b",
          repo: "acme_store",
          label: "mutation gate",
          worktree: null,
          branch: "claude/w-58-hooks",
          grantedAt: T0 - 2 * 60_000,
        }),
        ticket({ token: "c", repo: "veda", label: "tsc", worktree: null, branch: null, grantedAt: T0 }),
      ],
      inUse: 2,
      place: 1,
    };
    assert.deepEqual(waitingLines(view, settings(), T0 + 3 * 60_000), [
      "⏳ Waiting for a heavy-work turn (2 of 2 in use, you are 1st in line); waited 3 min of up to 30.",
      "     acme-policy  pnpm check     for 8 min  (worktree brave-curie)",
      "     acme_store   mutation gate  for 5 min  (branch claude/w-58-hooks)",
      "     veda         tsc            for 3 min",
    ]);
    // Exactly five: a hook that hides a stage's output passes on these lines by that indent.
    assert.equal(HOLDER_INDENT, " ".repeat(5));
    for (const line of waitingLines(view, settings(), T0).slice(1)) assert.match(line, /^ {5}\S/);
  });

  it("is the one line with no holders", () => {
    const view: Look = { me: mine(), holders: [], inUse: 0, place: 3 };
    assert.deepEqual(waitingLines(view, settings({ turns: 1, waitMinutes: 5 }), T0 + 59_999), [
      "⏳ Waiting for a heavy-work turn (0 of 1 in use, you are 3rd in line); waited 0 min of up to 5.",
    ]);
  });
});

describe("parseTurnArgs", () => {
  it("takes the flags in any order before --", () => {
    assert.deepEqual(parseTurnArgs(["--", "pnpm", "check"]), {
      exclusive: false,
      class: "other",
      label: null,
      command: ["pnpm", "check"],
    });
    assert.deepEqual(
      parseTurnArgs(["--label", "android flows", "--exclusive", "--class", "push", "--", "x", "--", "y"]),
      { exclusive: true, class: "push", label: "android flows", command: ["x", "--", "y"] },
    );
    assert.equal(parseTurnArgs(["--class", "other", "--", "x"]).hasOwnProperty("error"), false);
    // A label that reads like a class is a label.
    assert.deepEqual(parseTurnArgs(["--label", "push", "--", "x"]), {
      exclusive: false,
      class: "other",
      label: "push",
      command: ["x"],
    });
  });

  it("refuses a missing command and bad or repeated options", () => {
    assert.deepEqual(parseTurnArgs(["pnpm"]), { error: "missing -- <command>" });
    assert.deepEqual(parseTurnArgs(["--"]), { error: "missing -- <command>" });
    const bad: string[][] = [
      ["--exclusive", "--exclusive"],
      ["--class", "fast"],
      ["--class"],
      ["--class", "push", "--class", "other"],
      ["--label"],
      ["--label", "  "],
      ["--label", "a", "--label", "b"],
      ["--width", "2"],
    ];
    for (const flags of bad) {
      const parsed = parseTurnArgs([...flags, "--", "x"]);
      assert.ok("error" in parsed, flags.join(" "));
    }
    assert.deepEqual(parseTurnArgs(["--class", "fast", "--", "x"]), {
      error: "bad or repeated option --class",
    });
  });
});

describe("cleanLabel", () => {
  it("makes one short line", () => {
    assert.equal(cleanLabel("  pnpm\tcheck \n now "), "pnpm check now");
    assert.equal(cleanLabel("x".repeat(100)), "x".repeat(80));
  });
});

describe("currentStage", () => {
  it("is the last stage marked in the hook's stage file", () => {
    const file = join(dir, "run.stages");
    writeFileSync(file, "0\tlint\n12\tmutation\n40\tandroid\n\n");
    assert.equal(currentStage({ DVARA_STAGE_FILE: file }), "android");
  });

  it("is null outside a hook, before the first marker, or for a marker with no name", () => {
    assert.equal(currentStage({}), null);
    assert.equal(currentStage({ DVARA_STAGE_FILE: "" }), null);
    assert.equal(currentStage({ DVARA_STAGE_FILE: join(dir, "none") }), null);
    writeFileSync(join(dir, "empty"), "");
    assert.equal(currentStage({ DVARA_STAGE_FILE: join(dir, "empty") }), null);
    writeFileSync(join(dir, "bare"), "4\n");
    assert.equal(currentStage({ DVARA_STAGE_FILE: join(dir, "bare") }), null);
  });
});

describe("appendLine", () => {
  it("appends a line, creating the folder", () => {
    const path = join(dir, "a", "b.jsonl");
    appendLine(path, "one");
    appendLine(path, "two");
    assert.equal(readFileSync(path, "utf8"), "one\ntwo\n");
  });

  it("never throws", () => {
    writeFileSync(join(dir, "file"), "");
    assert.doesNotThrow(() => appendLine(join(dir, "file", "under"), "x"));
  });
});

describe("queuedPids", () => {
  it("finds a waiter entry whose start still matches", () => {
    mkdirSync(join(dir, WAITERS_DIRNAME));
    writeFileSync(waiterPath(dir, OTHER), OTHER_START);
    assert.equal(waiterPath(dir, OTHER), join(dir, "waiters", String(OTHER)));
    assert.equal(queuedPids(dir, [SELF, OTHER], w.system), true);
    assert.equal(queuedPids(dir, [SELF], w.system), false);
    assert.equal(queuedPids(dir, [], w.system), false);
    // Only a pid with an entry has its start read.
    assert.deepEqual(w.startReads, [OTHER]);
  });

  it("ignores an entry left by a pid since reused", () => {
    mkdirSync(join(dir, WAITERS_DIRNAME));
    writeFileSync(waiterPath(dir, SELF), OTHER_START);
    assert.equal(queuedPids(dir, [SELF], w.system), false);
  });

  it("counts an entry with no start, which cannot be told from the waiter", () => {
    mkdirSync(join(dir, WAITERS_DIRNAME));
    writeFileSync(waiterPath(dir, SELF), "");
    assert.equal(queuedPids(dir, [SELF], w.system), true);
    assert.deepEqual(w.startReads, []);
  });
});

class FakeChild extends EventEmitter implements SlotChild {
  readonly killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

interface Run {
  readonly child: FakeChild;
  readonly spawned: Array<Parameters<SpawnSlotChild>>;
  /** Resolves once the command was spawned. */
  readonly started: Promise<void>;
  readonly signals: EventEmitter;
  readonly stderr: string[];
  readonly sleeps: number[];
  readonly status: Promise<number>;
}

interface StartOptions {
  readonly env?: Record<string, string | undefined>;
  readonly spawn?: SpawnSlotChild;
  /** Called at each sleep, after the clock moved on. */
  readonly onSleep?: (count: number) => void;
}

const start = (argv: readonly string[], options: StartOptions = {}): Run => {
  const child = new FakeChild();
  const spawned: Array<Parameters<SpawnSlotChild>> = [];
  const signals = new EventEmitter();
  const stderr: string[] = [];
  const sleeps: number[] = [];
  let onStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  const status = turn(argv, {
    err: (line) => stderr.push(line),
    env: { DVARA_TURN_DIR: dir, KEEP: "x", ...options.env },
    cwd: "/code/veda/.claude/worktrees/brave",
    system: w.system,
    signals,
    git: REPO_GIT,
    sleep: async (ms) => {
      sleeps.push(ms);
      w.clock += ms;
      options.onSleep?.(sleeps.length);
      await new Promise((resolve) => setImmediate(resolve));
    },
    spawn: (...call) => {
      spawned.push(call);
      onStarted();
      return options.spawn ? options.spawn(...call) : child;
    },
  });
  return { child, spawned, started, signals, stderr, sleeps, status };
};

const logLines = (): Array<Record<string, unknown>> =>
  existsSync(join(dir, TURN_LOG_FILENAME))
    ? readFileSync(join(dir, TURN_LOG_FILENAME), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

const tickets = (): string[] =>
  existsSync(join(dir, TICKETS_DIRNAME)) ? readdirSync(join(dir, TICKETS_DIRNAME)) : [];

describe("turn", () => {
  // Each case is bounded: a mutant that leaves a wait hanging fails it here,
  // at once, rather than at the mutation run's limit.
  it("refuses bad arguments with its usage", async () => {
    const run = start(["--class", "fast", "--", "x"]);
    assert.equal(await run.status, 2);
    assert.deepEqual(run.stderr, ["dvara turn: bad or repeated option --class", TURN_USAGE]);
    assert.equal(
      TURN_USAGE,
      "usage: dvara turn [--exclusive] [--class push|other] [--label <text>] -- <command> [args…]",
    );
    assert.deepEqual(run.spawned, []);
  });

  it("runs a free request at once with the turn passed down, and logs it", async () => {
    const run = start(["--label", "veda check", "--", "pnpm", "check"], {
      env: { DVARA_MEASURED_HOOK: "pre-push" },
    });
    await run.started;
    assert.deepEqual(tickets(), ["" + (run.spawned[0]?.[2].env[TURN_HELD_ENV] ?? "") + ".json"]);
    const [command, args, options] = run.spawned[0] ?? [];
    assert.equal(command, "pnpm");
    assert.deepEqual(args, ["check"]);
    assert.equal(options?.stdio, "inherit");
    const token = options?.env[TURN_HELD_ENV] ?? "";
    assert.match(token, /^[0-9a-f]{24}$/);
    assert.deepEqual(options?.env, {
      DVARA_TURN_DIR: dir,
      KEEP: "x",
      DVARA_MEASURED_HOOK: "pre-push",
      [TURN_HELD_ENV]: token,
    });
    assert.equal(run.signals.listenerCount("SIGINT"), 1);
    assert.equal(run.signals.listenerCount("SIGTERM"), 1);
    w.clock += 5000;
    run.child.emit("exit", 3, null);
    assert.equal(await run.status, 3);
    assert.deepEqual(run.stderr, []);
    assert.deepEqual(run.sleeps, []);
    assert.deepEqual(tickets(), []);
    assert.equal(run.signals.listenerCount("SIGINT"), 0);
    assert.equal(run.signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(logLines(), [
      {
        schema: 1,
        ts: new Date(T0 + 5000).toISOString(),
        id: token,
        pid: SELF,
        mode: "record",
        turns: 2,
        waitMinutes: 30,
        class: "other",
        exclusive: false,
        width: 1,
        nested: false,
        outer: null,
        label: "veda check",
        repo: "veda",
        worktree: "brave",
        branch: "claude/brave",
        cwd: "/code/veda/.claude/worktrees/brave",
        hook: "pre-push",
        stage: null,
        askedAt: T0,
        grantedAt: T0,
        startedAt: T0,
        endedAt: T0 + 5000,
        waitedMs: 0,
        wouldWaitMs: 0,
        ranAnyway: false,
        ahead: 0,
        holders: [],
        exitCode: 3,
        signal: null,
        error: null,
      },
    ]);
    assert.equal(TURN_LOG_FILENAME, "turns.jsonl");
    assert.equal(TURN_HELD_ENV, "DVARA_TURN_HELD");
  });

  it("reads its own start once, however often it looks", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const run = start(["--", "x"], {
      onSleep: (count) => {
        if (count === 3) w.alive.delete(OTHER);
      },
    });
    await run.started;
    run.child.emit("exit", 0, null);
    await run.status;
    assert.deepEqual(
      w.startReads.filter((pid) => pid === SELF),
      [SELF],
    );
  });

  it("records, in record mode, who it found and when it would have been served", async () => {
    writeTicket(dir, ticket({ exclusive: true, grantedAt: T0 - 60_000 }));
    let ended = false;
    const run = start(["--exclusive", "--class", "push", "--", "android", "flows"], {
      onSleep: (count) => {
        if (count === 4) w.alive.delete(OTHER);
        assert.equal(ended, false);
      },
    });
    await run.started;
    assert.deepEqual(run.stderr, [
      "[dvara turn] record mode: would wait for a heavy-work turn (2 of 2 in use, you are 1st in line); running now.",
    ]);
    // Wait until the virtual line has served it.
    while (run.sleeps.length < 4) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    w.clock += 1000;
    ended = true;
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    assert.deepEqual(run.sleeps, [VIRTUAL_POLL_MS, VIRTUAL_POLL_MS, VIRTUAL_POLL_MS, VIRTUAL_POLL_MS]);
    const [line] = logLines();
    assert.equal(line?.["mode"], "record");
    assert.equal(line?.["class"], "push");
    assert.equal(line?.["exclusive"], true);
    assert.equal(line?.["width"], 2);
    assert.equal(line?.["label"], "android flows");
    assert.equal(line?.["startedAt"], T0);
    assert.equal(line?.["waitedMs"], 0);
    assert.equal(line?.["grantedAt"], T0 + 4 * VIRTUAL_POLL_MS);
    assert.equal(line?.["wouldWaitMs"], 4 * VIRTUAL_POLL_MS);
    assert.equal(line?.["ahead"], 0);
    assert.deepEqual(line?.["holders"], [
      {
        id: "their-token",
        pid: OTHER,
        repo: "acme-policy",
        worktree: "brave-curie",
        branch: "claude/x",
        label: "pnpm check",
        class: "other",
        exclusive: true,
        heldMs: 60_000,
      },
    ]);
    assert.deepEqual(tickets(), []);
  });

  it("records a request never served while its command ran with no grant", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    writeTicket(dir, ticket({ token: "ahead", pid: THIRD, grantedAt: null, askedAt: T0 - 1 }));
    const run = start(["--", "x"]);
    await run.started;
    // Its ticket stands in line while the command runs, for every other request to see.
    assert.equal(tickets().length, 3);
    while (run.sleeps.length < 2) await new Promise((resolve) => setImmediate(resolve));
    // The holders end as the command does: no look after the exit grants it.
    w.alive.delete(OTHER);
    w.alive.delete(THIRD);
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    const [line] = logLines();
    assert.equal(line?.["grantedAt"], null);
    assert.equal(line?.["wouldWaitMs"], null);
    assert.equal(line?.["ahead"], 1);
    assert.match(run.stderr[0] ?? "", /you are 2nd in line/);
  });

  it("keeps the command's status when the virtual line fails while it runs", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const run = start(["--", "x"], {
      onSleep: () => {
        // The queue's folder turns into a file: the next look cannot write the grant.
        rmSync(join(dir, TICKETS_DIRNAME), { recursive: true, force: true });
        writeFileSync(join(dir, TICKETS_DIRNAME), "");
      },
    });
    await run.started;
    while (run.sleeps.length < 1) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    run.child.emit("exit", 5, null);
    assert.equal(await run.status, 5);
    assert.equal(run.sleeps.length, 1);
    assert.equal(logLines()[0]?.["grantedAt"], null);
  });

  it("writes no waiter entry for an enforce request served at once", async () => {
    const run = start(["--", "x"], { env: { [TURN_MODE_ENV]: "enforce" } });
    await run.started;
    assert.equal(existsSync(join(dir, WAITERS_DIRNAME)), false);
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    assert.deepEqual(run.sleeps, []);
  });

  it("waits again in a queue whose waiter folder exists, and names a waiter with no start", async () => {
    mkdirSync(join(dir, WAITERS_DIRNAME));
    w.starts.set(SELF, null);
    writeTicket(dir, ticket({ exclusive: true }));
    const contents: string[] = [];
    const run = start(["--", "x"], {
      env: { [TURN_MODE_ENV]: "enforce" },
      onSleep: (count) => {
        contents.push(readFileSync(waiterPath(dir, SELF), "utf8"));
        if (count === 2) w.alive.delete(OTHER);
      },
    });
    await run.started;
    assert.deepEqual(contents, ["", ""]);
    assert.ok(!run.stderr.some((line) => line.includes("queue unavailable")), run.stderr.join("\n"));
    run.child.emit("exit", 0, null);
    await run.status;
  });

  it("keeps the waiter folder its own", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    let mode = 0;
    const run = start(["--", "x"], {
      env: { [TURN_MODE_ENV]: "enforce" },
      onSleep: () => {
        mode = statSync(join(dir, WAITERS_DIRNAME)).mode & 0o777;
        w.alive.delete(OTHER);
      },
    });
    await run.started;
    assert.equal(mode, 0o700);
    run.child.emit("exit", 0, null);
    await run.status;
  });

  it("waits in enforce mode, saying so every minute, and runs once served", async () => {
    writeTicket(dir, ticket({ exclusive: true, grantedAt: T0 - 6 * 60_000 }));
    const waiter = waiterPath(dir, SELF);
    const seen: boolean[] = [];
    const run = start(["--label", "tsc", "--", "pnpm", "typecheck"], {
      env: { [TURN_MODE_ENV]: "enforce" },
      onSleep: (count) => {
        seen.push(existsSync(waiter));
        // Served at 121 s: the third notice is due at 120 s exactly, not a second later.
        if (count === 121) w.alive.delete(OTHER);
      },
    });
    await run.started;
    assert.equal(run.sleeps.length, 121);
    assert.ok(seen.every(Boolean));
    assert.equal(existsSync(waiter), false);
    const notices = run.stderr.filter((line) => line.startsWith("⏳"));
    assert.deepEqual(notices, [
      "⏳ Waiting for a heavy-work turn (2 of 2 in use, you are 1st in line); waited 0 min of up to 30.",
      "⏳ Waiting for a heavy-work turn (2 of 2 in use, you are 1st in line); waited 1 min of up to 30.",
      "⏳ Waiting for a heavy-work turn (2 of 2 in use, you are 1st in line); waited 2 min of up to 30.",
    ]);
    assert.equal(
      run.stderr.filter((line) => line === "     acme-policy  pnpm check  for 6 min  (worktree brave-curie)").length,
      1,
    );
    assert.equal(run.stderr.length, 6);
    w.clock += 10;
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    const [line] = logLines();
    assert.equal(line?.["mode"], "enforce");
    assert.equal(line?.["waitedMs"], 121 * POLL_MS);
    assert.equal(line?.["wouldWaitMs"], 121 * POLL_MS);
    assert.equal(line?.["grantedAt"], T0 + 121 * POLL_MS);
    assert.equal(line?.["startedAt"], T0 + 121 * POLL_MS);
    assert.equal(line?.["ranAnyway"], false);
    assert.equal(NOTICE_MS, 60_000);
    assert.equal(POLL_MS, 1000);
  });

  it("runs anyway at the bound, with a warning", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const run = start(["--", "x"], { env: { [TURN_MODE_ENV]: "enforce", [TURN_WAIT_ENV]: "2" } });
    await run.started;
    assert.equal(run.sleeps.length, 120);
    assert.equal(
      run.stderr.at(-1),
      "⚠️  [dvara turn] waited 2 min for a heavy-work turn; running anyway.",
    );
    run.child.emit("exit", 4, null);
    assert.equal(await run.status, 4);
    const [line] = logLines();
    assert.equal(line?.["ranAnyway"], true);
    assert.equal(line?.["waitMinutes"], 2);
    assert.equal(line?.["waitedMs"], 120 * POLL_MS);
  });

  it("stops waiting on a signal, cleans up and logs the cancelled request", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    let run: Run | undefined;
    run = start(["--", "x"], {
      env: { [TURN_MODE_ENV]: "enforce" },
      onSleep: (count) => {
        if (count === 2) run?.signals.emit("SIGTERM", "SIGTERM");
      },
    });
    assert.equal(await run.status, 143);
    assert.deepEqual(run.spawned, []);
    assert.equal(run.sleeps.length, 2);
    assert.equal(existsSync(waiterPath(dir, SELF)), false);
    assert.deepEqual(tickets(), ["their-token.json"]);
    const [line] = logLines();
    assert.equal(line?.["signal"], "SIGTERM");
    assert.equal(line?.["exitCode"], 143);
    assert.equal(line?.["grantedAt"], null);
    assert.equal(line?.["error"], null);
    // It never ran: no start, and its wait lasted until it ended, so a replay skips it.
    assert.equal(line?.["startedAt"], null);
    assert.equal(line?.["waitedMs"], 2 * POLL_MS);
    assert.deepEqual(replayable(readFileSync(join(dir, TURN_LOG_FILENAME), "utf8"), 0), []);
    assert.equal(run.signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(run.stderr.filter((text) => !text.startsWith("⏳") && !text.startsWith(HOLDER_INDENT)), []);
  });

  it("grants a free turn at the moment it was asked for, however long git took", async () => {
    const run = turn(["--", "x"], {
      err: () => undefined,
      env: { DVARA_TURN_DIR: dir },
      cwd: dir,
      system: w.system,
      signals: new EventEmitter(),
      git: () => {
        w.clock += 40;
        return null;
      },
      sleep: async () => undefined,
      spawn: () => {
        const child = new FakeChild();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
    });
    assert.equal(await run, 0);
    const [line] = logLines();
    assert.equal(line?.["grantedAt"], T0);
    assert.equal(line?.["wouldWaitMs"], 0);
    assert.equal(line?.["startedAt"], T0 + 40);
  });

  it("books its wait to the stage it was asked in, not one its command marked later", async () => {
    const records = join(dir, "run.records");
    const stages = join(dir, "run.stages");
    writeFileSync(stages, "0\tmutation\n");
    const run = start(["--", "x"], { env: { DVARA_RECORD_FILE: records, DVARA_STAGE_FILE: stages } });
    await run.started;
    appendFileSync(stages, "9\tinner\n");
    run.child.emit("exit", 0, null);
    await run.status;
    assert.equal(logLines()[0]?.["stage"], "mutation");
    assert.match(readFileSync(records, "utf8"), /^turn\tmutation\t/);
  });

  it("spawns a real command with its arguments, the held turn and inherited stdio", async () => {
    const status = await turn(
      [
        "--",
        process.execPath,
        "-e",
        "process.exit(process.argv[1] === 'arg' && /^[0-9a-f]{24}$/.test(process.env.DVARA_TURN_HELD ?? '') ? 9 : 1)",
        "arg",
      ],
      {
        err: () => undefined,
        env: { DVARA_TURN_DIR: dir, PATH: process.env["PATH"] },
        cwd: dir,
        system: w.system,
        signals: new EventEmitter(),
        git: () => null,
        sleep: async () => undefined,
      },
    );
    assert.equal(status, 9);
  });

  it("forwards signals to the command, and the first decides the status", async () => {
    const run = start(["--", "x"]);
    await run.started;
    run.signals.emit("SIGINT", "SIGINT");
    run.signals.emit("SIGTERM", "SIGTERM");
    assert.deepEqual(run.child.killed, ["SIGINT", "SIGTERM"]);
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 130);
    assert.equal(logLines()[0]?.["signal"], "SIGINT");
  });

  it("runs a nested request at once, inside the outer turn, without a ticket", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const run = start(["--exclusive", "--", "gate"], { env: { [TURN_HELD_ENV]: "outer-token", [TURN_MODE_ENV]: "enforce" } });
    await run.started;
    assert.deepEqual(tickets(), ["their-token.json"]);
    assert.equal(run.spawned[0]?.[2].env[TURN_HELD_ENV], "outer-token");
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    const [line] = logLines();
    assert.equal(line?.["nested"], true);
    assert.equal(line?.["outer"], "outer-token");
    assert.equal(line?.["grantedAt"], null);
    assert.equal(line?.["ahead"], 0);
    assert.deepEqual(line?.["holders"], []);
    assert.deepEqual(run.sleeps, []);
    assert.deepEqual(run.stderr, []);
  });

  it("asks as usual when the held marker is empty", async () => {
    const run = start(["--", "x"], { env: { [TURN_HELD_ENV]: "" } });
    await run.started;
    assert.equal(tickets().length, 1);
    run.child.emit("exit", 0, null);
    await run.status;
    assert.equal(logLines()[0]?.["nested"], false);
  });

  it("runs directly and records nothing when off", async () => {
    const calls: string[][] = [];
    const spawned: Array<Parameters<SpawnSlotChild>> = [];
    const signals = new EventEmitter();
    const child = new FakeChild();
    const run = turn(["--", "x", "y"], {
      err: () => undefined,
      env: { DVARA_TURN_DIR: dir, CI: "true", KEEP: "k" },
      cwd: "/c/repo",
      system: w.system,
      signals,
      git: fakeGit({}, calls),
      sleep: async () => undefined,
      spawn: (...call) => {
        spawned.push(call);
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
    });
    // Signals reach the command in off mode too.
    signals.emit("SIGINT", "SIGINT");
    assert.equal(await run, 130);
    assert.deepEqual(child.killed, ["SIGINT"]);
    assert.deepEqual(spawned, [
      ["x", ["y"], { stdio: "inherit", env: { DVARA_TURN_DIR: dir, CI: "true", KEEP: "k" } }],
    ]);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("writes the stage's turn into the hook's records", async () => {
    const records = join(dir, "run.records");
    const stages = join(dir, "run.stages");
    writeFileSync(stages, "0\tlint\n3\tmutation\n");
    const run = start(["--label", "mutation\tgate", "--", "x"], {
      env: { DVARA_RECORD_FILE: records, DVARA_STAGE_FILE: stages },
    });
    await run.started;
    run.child.emit("exit", 0, null);
    await run.status;
    assert.equal(
      readFileSync(records, "utf8"),
      "turn\tmutation\tmutation gate\tother\tshared\trecord\t0\t0\t0\t0\n",
    );
    assert.equal(logLines()[0]?.["stage"], "mutation");
  });

  it("writes an exclusive, nested or bounded turn's record with its flags", async () => {
    const records = join(dir, "run.records");
    writeTicket(dir, ticket({ exclusive: true }));
    const bounded = start(["--exclusive", "--", "x"], {
      env: { DVARA_RECORD_FILE: records, [TURN_MODE_ENV]: "enforce", [TURN_WAIT_ENV]: "1" },
    });
    await bounded.started;
    bounded.child.emit("exit", 0, null);
    await bounded.status;
    const nested = start(["--", "y"], { env: { DVARA_RECORD_FILE: records, [TURN_HELD_ENV]: "o" } });
    await nested.started;
    nested.child.emit("exit", 0, null);
    await nested.status;
    assert.deepEqual(readFileSync(records, "utf8").split("\n"), [
      "turn\t\tx\tother\texclusive\tenforce\t60000\t60000\t1\t0",
      "turn\t\ty\tother\tshared\trecord\t0\t\t0\t1",
      "",
    ]);
  });

  it("writes no record outside a hook", async () => {
    const run = start(["--", "x"], { env: { DVARA_RECORD_FILE: "" } });
    await run.started;
    run.child.emit("exit", 0, null);
    await run.status;
    assert.deepEqual(readdirSync(dir).sort(), [TICKETS_DIRNAME, TURN_LOG_FILENAME].sort());
  });

  it("runs without a turn when the queue cannot be used", async () => {
    writeFileSync(join(dir, TICKETS_DIRNAME), "a file where the folder goes");
    const run = start(["--", "x"]);
    await run.started;
    run.child.emit("exit", 6, null);
    assert.equal(await run.status, 6);
    assert.match(run.stderr[0] ?? "", /^\[dvara turn\] queue unavailable \(.+\); running without a turn$/);
    const [line] = logLines();
    assert.match(String(line?.["error"]), /./);
    assert.deepEqual(run.sleeps, []);
  });

  it("exits 127 when the command cannot start, and when spawn throws", async () => {
    const failing = new FakeChild();
    const run = start(["--", "nope"], {
      spawn: () => {
        setImmediate(() => failing.emit("error", new Error("ENOENT")));
        return failing;
      },
    });
    assert.equal(await run.status, 127);
    assert.deepEqual(run.stderr, ["[dvara turn] could not start nope: ENOENT"]);
    assert.equal(logLines()[0]?.["exitCode"], 127);
    const thrown = start(["--", "bad"], {
      spawn: () => {
        throw "refused";
      },
    });
    assert.equal(await thrown.status, 127);
    assert.deepEqual(thrown.stderr, ["[dvara turn] could not start bad: refused"]);
  });

  it("stops its virtual wait as soon as the command ends", async () => {
    writeTicket(dir, ticket({ exclusive: true }));
    const run = start(["--", "x"]);
    await run.started;
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    assert.ok(run.sleeps.length <= 1, String(run.sleeps.length));
  });
});

describe("parseReplayArgs", () => {
  it("defaults to counts 1, 2 and 3, a 30-minute bound, every line and the machine's log", () => {
    assert.deepEqual(parseReplayArgs([]), {
      counts: [1, 2, 3],
      waitMinutes: 30,
      since: Number.NEGATIVE_INFINITY,
      file: null,
    });
  });

  it("takes repeated counts and the rest once", () => {
    assert.deepEqual(
      parseReplayArgs(["--count", "2", "--count", "4", "--wait-minutes", "10", "--since", "2026-12-03T00:00:00Z", "--file", "/l.jsonl"]),
      { counts: [2, 4], waitMinutes: 10, since: Date.UTC(2026, 11, 3), file: "/l.jsonl" },
    );
  });

  it("refuses anything else", () => {
    const bad: string[][] = [
      ["--count", "0"],
      ["--count"],
      ["--wait-minutes", "x"],
      ["--wait-minutes", "1", "--wait-minutes", "2"],
      ["--since", "yesterday"],
      ["--since", "2026-12-01", "--since", "2026-12-02"],
      ["--file", ""],
      ["--file", "a", "--file", "b"],
      ["--counts", "2"],
    ];
    for (const argv of bad) assert.ok("error" in parseReplayArgs(argv), argv.join(" "));
    assert.deepEqual(parseReplayArgs(["--count"]), { error: "bad or repeated option --count" });
    assert.deepEqual(parseReplayArgs(["--count", "x"]), { error: "bad or repeated option --count x" });
  });
});

const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "a",
    nested: false,
    class: "other",
    exclusive: false,
    askedAt: 100,
    startedAt: 100,
    endedAt: 200,
    ...overrides,
  });

describe("replayable", () => {
  it("reads the outermost requests since a time", () => {
    const text = [
      line(),
      line({ id: "push", class: "push", exclusive: true }),
      line({ id: "nested", nested: true }),
      line({ id: "early", askedAt: 50 }),
      "",
      "{torn",
      "null",
      line({ id: 5 }),
      line({ id: "c", class: "x" }),
      line({ id: "t", askedAt: "then" }),
      line({ id: "s", startedAt: null }),
      line({ id: "e", endedAt: undefined }),
      line({ id: "n", nested: undefined }),
      line({ id: "x", exclusive: "yes" }),
    ].join("\n");
    assert.deepEqual(replayable(text, 100), [
      { id: "a", class: "other", exclusive: false, askedAt: 100, startedAt: 100, endedAt: 200 },
      { id: "push", class: "push", exclusive: true, askedAt: 100, startedAt: 100, endedAt: 200 },
      { id: "x", class: "other", exclusive: false, askedAt: 100, startedAt: 100, endedAt: 200 },
    ]);
  });
});

describe("turnReplay", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, context: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it("prints one summary per count from the machine's log", () => {
    writeFileSync(
      join(dir, TURN_LOG_FILENAME),
      [line(), line({ id: "b", askedAt: 110, startedAt: 110, endedAt: 210 })].join("\n"),
    );
    const { out, err, context } = io();
    assert.equal(turnReplay(["--count", "1", "--count", "2", "--wait-minutes", "1"], { ...context, env: { DVARA_TURN_DIR: dir } }), 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out.map((text) => JSON.parse(text) as Record<string, unknown>), [
      { count: 1, boundMs: 60_000, requests: 2, waited: 1, totalWaitMs: 90, p50WaitMs: 0, p95WaitMs: 90, maxWaitMs: 90, overBound: 0 },
      { count: 2, boundMs: 60_000, requests: 2, waited: 0, totalWaitMs: 0, p50WaitMs: 0, p95WaitMs: 0, maxWaitMs: 0, overBound: 0 },
    ]);
  });

  it("reads the file it is given, since the time it is given", () => {
    const file = join(dir, "other.jsonl");
    writeFileSync(file, [line({ askedAt: Date.UTC(2026, 0, 1) }), line({ id: "b", askedAt: Date.UTC(2027, 0, 1) })].join("\n"));
    const { out, context } = io();
    assert.equal(turnReplay(["--file", file, "--since", "2026-06-01", "--count", "1"], { ...context, env: {} }), 0);
    assert.equal((JSON.parse(out[0] ?? "{}") as Record<string, unknown>)["requests"], 1);
  });

  it("fails on an unreadable log, and refuses bad arguments with its usage", () => {
    const missing = io();
    assert.equal(turnReplay([], { ...missing.context, env: { DVARA_TURN_DIR: join(dir, "none") } }), 1);
    assert.match(missing.err[0] ?? "", /^dvara turn-replay: cannot read .+turns\.jsonl: ENOENT/);
    const bad = io();
    assert.equal(turnReplay(["--count", "0"], { ...bad.context, env: {} }), 2);
    assert.deepEqual(bad.err, ["dvara turn-replay: bad or repeated option --count 0", REPLAY_USAGE]);
    assert.equal(
      REPLAY_USAGE,
      "usage: dvara turn-replay [--count N]… [--wait-minutes M] [--since <ISO time>] [--file <turns.jsonl>]",
    );
  });
});
