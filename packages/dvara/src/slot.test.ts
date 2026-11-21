import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  START_IDENTITY_FORMAT,
  UNREADABLE_GRACE_MS,
  type LivenessSystem,
  type Party,
} from "./liveness.ts";
import {
  decide,
  DEFAULT_SLOT_DIR,
  exitStatus,
  lockFilename,
  parseSlotArgs,
  RECLAIM_STALE_MS,
  reclaimDirname,
  recordEvent,
  skipReason,
  slot,
  SLOT_DIR_ENV,
  SLOT_LOG_FILENAME,
  SLOT_SWITCH_ENV,
  SLOT_USAGE,
  slotDirectory,
  tryTakeSlot,
  type SlotArgs,
  type SlotChild,
  type SlotFiles,
  type SpawnSlotChild,
} from "./slot.ts";

/*
 * The slot runs against a REAL directory, as the gate lock's tests do: `link`
 * refusing an existing name is the property the slot is built on, and a fake
 * filesystem would test the fake. Only the clock and the process table are
 * faked. `link` and `rm` pass through to the real calls: a test only injects
 * a fault no real directory can produce on demand (a link refused with no
 * lock on disk, a non-Error throw), or reads the options a removal was made
 * with.
 */

const SELF = 4242;
const OTHER = 999;
const SELF_START = `${START_IDENTITY_FORMAT} Sat Sep 19 10:00:00 2026`;
const OTHER_START = `${START_IDENTITY_FORMAT} Sat Sep 19 09:00:00 2026`;

interface Fake {
  system: LivenessSystem;
  alive: Set<number>;
  starts: Map<number, string | null>;
  clock: number;
}

const fake = (): Fake => {
  const alive = new Set([SELF]);
  const starts = new Map<number, string | null>([[SELF, SELF_START]]);
  const state: Fake = {
    alive,
    starts,
    clock: Date.now(),
    system: {
      pid: SELF,
      now: () => state.clock,
      isAlive: (pid) => alive.has(pid),
      startIdentityOf: (pid) => starts.get(pid) ?? null,
    },
  };
  return state;
};

type Removal = readonly [string, { recursive?: boolean; force: boolean }];

/** The real calls, recorded, with faults to put in place of the next links. */
interface Recorded {
  readonly files: SlotFiles;
  readonly removals: Removal[];
  readonly faults: Array<() => void>;
  links: number;
}

const recorded = (): Recorded => {
  const state: Recorded = {
    removals: [],
    faults: [],
    links: 0,
    files: {
      link: (existing, path) => {
        state.links += 1;
        const fault = state.faults.shift();
        if (fault) fault();
        else linkSync(existing, path);
      },
      rm: (path, options) => {
        state.removals.push([path, options]);
        rmSync(path, options);
      },
    },
  };
  return state;
};

const holder = (overrides: Partial<Party> = {}): Party => ({
  pid: OTHER,
  startIdentity: OTHER_START,
  branch: "mobile",
  rootDir: "/elsewhere",
  token: "their-token",
  since: Date.now() - 5_000,
  ...overrides,
});

let dir: string;
let world: Fake;
let fs: Recorded;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvara-slot-"));
  world = fake();
  fs = recorded();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = (name = "mobile"): string => join(dir, lockFilename(name));
const reclaimPath = (name = "mobile"): string => join(dir, reclaimDirname(name));
const placeHolder = (party: Party, name = party.branch): void => {
  writeFileSync(lockPath(name), JSON.stringify(party));
};
const lockToken = (name = "mobile"): string | undefined =>
  existsSync(lockPath(name))
    ? (JSON.parse(readFileSync(lockPath(name), "utf8")) as Party).token
    : undefined;
const removalsOf = (path: string): Removal[] =>
  fs.removals.filter(([target]) => target === path);
const take = (name = "mobile", system: LivenessSystem = world.system) =>
  tryTakeSlot({ dir, name, cwd: "/repo", system, files: fs.files });

describe("tryTakeSlot", () => {
  it("takes a free slot, records this process as holder, and releases it", () => {
    const attempt = take();
    assert.equal(attempt.taken, true);
    const held = JSON.parse(readFileSync(lockPath(), "utf8")) as Party;
    assert.equal(held.pid, SELF);
    assert.equal(held.startIdentity, SELF_START);
    assert.equal(held.branch, "mobile");
    assert.equal(held.rootDir, "/repo");
    if (!attempt.taken) throw new Error("expected the slot");
    attempt.release();
    assert.equal(existsSync(lockPath()), false);
    attempt.release();
    assert.equal(existsSync(lockPath()), false);
    // Each removal tolerates a file a racing run already removed: `force`,
    // and the release removes only once, when the lock still names it.
    assert.deepEqual(removalsOf(lockPath()), [[lockPath(), { force: true }]]);
    const temps = fs.removals.filter(([target]) => target.endsWith(".tmp"));
    assert.equal(temps.length, 1);
    assert.match(temps[0]?.[0] ?? "", /mobile\.lock\.[0-9a-f]{24}\.tmp$/);
    assert.deepEqual(temps[0]?.[1], { force: true });
  });

  it("creates the slot directory when it does not exist yet", () => {
    const nested = join(dir, "slots", "host");
    const attempt = tryTakeSlot({
      dir: nested,
      name: "web",
      cwd: "/repo",
      system: world.system,
    });
    assert.equal(attempt.taken, true);
    assert.equal(existsSync(join(nested, lockFilename("web"))), true);
  });

  it("leaves no temporary record behind, taken or not", () => {
    take("mobile");
    take("web");
    // A refused take writes its record before the link fails; it must clean that up too.
    assert.equal(take("mobile").taken, false);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("runs without the slot while a live run holds it, and never waits", () => {
    world.alive.add(OTHER);
    world.starts.set(OTHER, OTHER_START);
    placeHolder(holder());
    const attempt = take();
    assert.equal(attempt.taken, false);
    if (attempt.taken) return;
    assert.equal(attempt.reason, "held by pid 999 (mobile)");
    assert.equal(lockToken(), "their-token");
  });

  it("a second run of the same slot cannot take it while the first holds it", () => {
    const first = take();
    const second = take();
    assert.equal(first.taken, true);
    assert.equal(second.taken, false);
    if (second.taken) return;
    assert.equal(second.reason, `held by pid ${SELF} (mobile)`);
  });

  it("two names each hold their own slot at once, never a second of either", () => {
    const mobile = take("mobile");
    const web = take("web");
    assert.equal(mobile.taken, true);
    assert.equal(web.taken, true);
    assert.equal(take("web").taken, false);
    if (!mobile.taken) throw new Error("expected the mobile slot");
    mobile.release();
    assert.equal(existsSync(lockPath("mobile")), false);
    assert.equal(existsSync(lockPath("web")), true);
  });

  it("reclaims the slot from a holder that died without releasing it", () => {
    placeHolder(holder());
    assert.equal(take().taken, true);
    assert.notEqual(lockToken(), "their-token");
    assert.equal(existsSync(reclaimPath()), false);
    assert.deepEqual(removalsOf(reclaimPath()), [
      [reclaimPath(), { recursive: true, force: true }],
    ]);
  });

  it("re-judges the holder inside the reclaim directory and keeps one that came back alive", () => {
    world.starts.set(OTHER, OTHER_START);
    let judged = 0;
    const system: LivenessSystem = {
      ...world.system,
      // Dead when first judged, alive (same start time) when judged again under the guard.
      isAlive: (pid) => {
        judged += 1;
        return pid === OTHER && judged > 1;
      },
    };
    const party = holder();
    placeHolder(party);
    assert.deepEqual(take("mobile", system), {
      taken: false,
      holder: party,
      reason: "a dead holder is being reclaimed",
    });
    assert.equal(judged, 2);
    assert.equal(lockToken(), "their-token");
    assert.equal(existsSync(reclaimPath()), false);
  });

  it("keeps a lock whose holder changed before the reclaim, even when the new one is dead too", () => {
    const first = holder();
    const replaced = holder({ token: "newer" });
    let replacedOnce = false;
    const system: LivenessSystem = {
      ...world.system,
      // The first judgement races a run that swaps in another (also dead) holder.
      isAlive: () => {
        if (!replacedOnce) placeHolder(replaced);
        replacedOnce = true;
        return false;
      },
    };
    placeHolder(first);
    assert.deepEqual(take("mobile", system), {
      taken: false,
      holder: first,
      reason: "a dead holder is being reclaimed",
    });
    assert.equal(lockToken(), "newer");
  });

  it("gives up as contended after two refused links, never trying a third", () => {
    const exists = (): never => {
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    };
    // Refused both times, yet gone when read: a holder released between each link and read.
    fs.faults.push(exists, exists);
    assert.deepEqual(take(), { taken: false, holder: null, reason: "contended" });
    assert.equal(fs.links, 2);
    assert.equal(existsSync(lockPath()), false);
  });

  it("reclaims from a live PID whose start time shows it was reused", () => {
    world.alive.add(OTHER);
    world.starts.set(OTHER, `${START_IDENTITY_FORMAT} Sat Sep 19 11:30:00 2026`);
    placeHolder(holder());
    assert.equal(take().taken, true);
  });

  it("keeps a live holder whose start time cannot be read", () => {
    world.alive.add(OTHER);
    world.starts.set(OTHER, null);
    placeHolder(holder());
    assert.equal(take().taken, false);
  });

  it("stands aside while another run is reclaiming a dead holder", () => {
    placeHolder(holder());
    mkdirSync(reclaimPath());
    const attempt = take();
    assert.equal(attempt.taken, false);
    if (attempt.taken) return;
    assert.equal(attempt.reason, "a dead holder is being reclaimed");
    assert.equal(lockToken(), "their-token");
    assert.equal(existsSync(reclaimPath()), true);
  });

  it("clears a reclaim directory abandoned longer than the stale limit, then stands aside", () => {
    placeHolder(holder());
    const guard = reclaimPath();
    mkdirSync(guard);
    const old = new Date(world.clock - RECLAIM_STALE_MS - 1_000);
    utimesSync(guard, old, old);
    assert.equal(take().taken, false);
    assert.equal(existsSync(guard), false);
    // `force`: two runs can both find the same abandoned directory.
    assert.deepEqual(removalsOf(guard), [[guard, { recursive: true, force: true }]]);
    assert.equal(take().taken, true);
  });

  it("keeps a reclaim directory exactly at the stale limit", () => {
    placeHolder(holder());
    const guard = reclaimPath();
    mkdirSync(guard);
    const whole = new Date(Math.floor(world.clock / 1_000) * 1_000 - 60_000);
    utimesSync(guard, whole, whole);
    world.clock = statSync(guard).mtimeMs + RECLAIM_STALE_MS;
    const attempt = take();
    assert.equal(attempt.taken, false);
    if (attempt.taken) return;
    assert.equal(attempt.reason, "a dead holder is being reclaimed");
    assert.equal(existsSync(guard), true);
    assert.deepEqual(removalsOf(guard), []);
  });

  it("keeps the gate lock's limits", () => {
    assert.equal(RECLAIM_STALE_MS, 30_000);
    assert.equal(UNREADABLE_GRACE_MS, 10_000);
  });

  it("treats a fresh unreadable holder as held", () => {
    writeFileSync(lockPath(), "{not json");
    assert.deepEqual(take(), { taken: false, holder: null, reason: "unreadable holder" });
    assert.equal(readFileSync(lockPath(), "utf8"), "{not json");
  });

  it("reclaims an unreadable holder older than the grace period", () => {
    writeFileSync(lockPath(), "{not json");
    const old = new Date(world.clock - UNREADABLE_GRACE_MS - 1_000);
    utimesSync(lockPath(), old, old);
    assert.equal(take().taken, true);
  });

  it("keeps an unreadable holder exactly at the grace period", () => {
    writeFileSync(lockPath(), "{not json");
    const whole = new Date(Math.floor(world.clock / 1_000) * 1_000 - 60_000);
    utimesSync(lockPath(), whole, whole);
    world.clock = statSync(lockPath()).mtimeMs + UNREADABLE_GRACE_MS;
    assert.deepEqual(take(), { taken: false, holder: null, reason: "unreadable holder" });
    assert.equal(readFileSync(lockPath(), "utf8"), "{not json");
  });

  it("does not reclaim an old unreadable holder while another reclaim runs", () => {
    writeFileSync(lockPath(), "{not json");
    const old = new Date(world.clock - UNREADABLE_GRACE_MS - 1_000);
    utimesSync(lockPath(), old, old);
    mkdirSync(reclaimPath());
    assert.deepEqual(take(), { taken: false, holder: null, reason: "unreadable holder" });
  });

  it("treats an unreadable holder that vanishes before its age is read as held", () => {
    writeFileSync(lockPath(), "{not json");
    // The clock is read for the record, then just before the stat: the
    // holder is removed in between the second read and the stat.
    let reads = 0;
    const system: LivenessSystem = {
      ...world.system,
      now: () => {
        reads += 1;
        if (reads === 2) rmSync(lockPath(), { force: true });
        return world.clock;
      },
    };
    assert.deepEqual(take("mobile", system), {
      taken: false,
      holder: null,
      reason: "unreadable holder",
    });
  });

  it("release never removes a lock that another run took after this one", () => {
    const mine = take();
    if (!mine.taken) throw new Error("expected the slot");
    placeHolder(holder({ token: "newer" }));
    mine.release();
    assert.equal(lockToken(), "newer");
  });

  it("passes on a link failure that is not a refused name", () => {
    fs.faults.push(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    assert.throws(() => take(), /EACCES/);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("passes on a reclaim directory it cannot make for another reason", () => {
    placeHolder(holder());
    // A file where the reclaim directory goes: mkdir says EEXIST, which is
    // "another reclaimer"; a missing parent is what says something else.
    const system: LivenessSystem = {
      ...world.system,
      isAlive: () => {
        rmSync(dir, { recursive: true, force: true });
        return false;
      },
    };
    assert.throws(() => take("mobile", system), /ENOENT/);
    mkdirSync(dir);
  });

  it("passes on a lock it cannot read for another reason than its absence", () => {
    mkdirSync(lockPath());
    // A directory at the lock's name: the link is refused, the read is EISDIR.
    assert.throws(() => take(), /EISDIR/);
  });
});

describe("the lock, as plateau-slot.ts reads and writes it", () => {
  it("lives at <dir>/<hostname>/<name>.lock, beside <name>.reclaim", () => {
    const base = join(dir, "capacity");
    const machine = slotDirectory(base, {});
    assert.equal(machine, join(base, hostname()));
    assert.equal(lockFilename("plateau-slot-mobile"), "plateau-slot-mobile.lock");
    assert.equal(reclaimDirname("plateau-slot-mobile"), "plateau-slot-mobile.reclaim");
  });

  it("writes the gate lock's record, key for key and in order, readable only by its owner", () => {
    const attempt = take("plateau-slot-mobile");
    assert.equal(attempt.taken, true);
    const raw = readFileSync(lockPath("plateau-slot-mobile"), "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), [
      "pid",
      "startIdentity",
      "branch",
      "rootDir",
      "token",
      "since",
    ]);
    assert.equal(raw, JSON.stringify(record));
    assert.equal(record["branch"], "plateau-slot-mobile");
    assert.match(String(record["token"]), /^[0-9a-f]{24}$/);
    assert.equal(statSync(lockPath("plateau-slot-mobile")).mode & 0o777, 0o600);
    const nested = join(dir, "fresh");
    tryTakeSlot({ dir: nested, name: "x", cwd: "/", system: world.system });
    assert.equal(statSync(nested).mode & 0o777, 0o700);
  });

  it("respects a live holder plateau-slot.ts wrote, and reclaims a dead one", () => {
    // A record as the old code wrote it: `branch` held the suite kind.
    const old = `{"pid":${OTHER},"startIdentity":${JSON.stringify(OTHER_START)},"branch":"mobile","rootDir":"/project","token":"the-old-holders-token","since":1760000000000}`;
    writeFileSync(lockPath("plateau-slot-mobile"), old);
    world.alive.add(OTHER);
    world.starts.set(OTHER, OTHER_START);
    const held = take("plateau-slot-mobile");
    assert.equal(held.taken, false);
    if (held.taken) return;
    assert.equal(held.reason, "held by pid 999 (mobile)");
    world.alive.delete(OTHER);
    assert.equal(take("plateau-slot-mobile").taken, true);
  });
});

describe("skipReason", () => {
  const SET = ["GRANT_WORKERS"];
  const skips: ReadonlyArray<readonly [Record<string, string>, string]> = [
    [{ CI: "true" }, "CI"],
    [{ CI: "1" }, "CI"],
    [{ GRANT_WORKERS: "6" }, "GRANT_WORKERS already set"],
    [{ GRANT_WORKERS: "" }, "GRANT_WORKERS already set"],
    [{ DVARA_SLOT: "off" }, "DVARA_SLOT=off"],
  ];
  for (const [env, reason] of skips)
    it(`skips the slot for ${JSON.stringify(env)}`, () => {
      assert.equal(skipReason(env, SET), reason);
    });

  const tries: ReadonlyArray<Record<string, string>> = [
    {},
    { CI: "" },
    { CI: "false" },
    { CI: "0" },
    { DVARA_SLOT: "on" },
  ];
  for (const env of tries)
    it(`tries the slot for ${JSON.stringify(env)}`, () => {
      assert.equal(skipReason(env, SET), null);
    });

  it("names the first --set variable the environment already has, and only those", () => {
    assert.equal(skipReason({ B: "1", C: "2" }, ["A", "B", "C"]), "B already set");
    assert.equal(skipReason({ B: "1" }, []), null);
    assert.equal(SLOT_SWITCH_ENV, "DVARA_SLOT");
  });
});

describe("slotDirectory", () => {
  it("honours the override, as given, with no hostname", () => {
    assert.equal(slotDirectory("/ignored", { [SLOT_DIR_ENV]: "/tmp/x" }), "/tmp/x");
  });

  it("defaults to ~/.dvara/slots/<hostname>", () => {
    assert.equal(DEFAULT_SLOT_DIR, "~/.dvara/slots");
    assert.equal(
      slotDirectory(DEFAULT_SLOT_DIR, { [SLOT_DIR_ENV]: "" }),
      join(homedir(), ".dvara", "slots", hostname()),
    );
  });

  it("reads a leading ~ as the home directory, and nothing else", () => {
    assert.equal(slotDirectory("~", {}), join(homedir(), hostname()));
    assert.equal(
      slotDirectory("~/.example/capacity", {}),
      join(homedir(), ".example", "capacity", hostname()),
    );
    assert.equal(slotDirectory("~bob/x", {}), join("~bob", "x", hostname()));
    assert.equal(slotDirectory("/a/~/b", {}), join("/a", "~", "b", hostname()));
  });
});

describe("parseSlotArgs", () => {
  it("reads the name, the directory, the variables and the command", () => {
    assert.deepEqual(
      parseSlotArgs([
        "--name",
        "plateau-slot-mobile",
        "--dir",
        "~/.example/capacity",
        "--set",
        "GRANT_WORKERS=12",
        "--unset",
        "VITEST_MAX_WORKERS",
        "--",
        "vitest",
        "run",
        "--coverage",
      ]),
      {
        name: "plateau-slot-mobile",
        dir: "~/.example/capacity",
        set: [["GRANT_WORKERS", "12"]],
        unset: ["VITEST_MAX_WORKERS"],
        command: ["vitest", "run", "--coverage"],
      },
    );
  });

  it("defaults the directory, takes any number of variables, and keeps a value's own =", () => {
    assert.deepEqual(
      parseSlotArgs([
        "--set",
        "A=x=y",
        "--name",
        "web",
        "--set",
        "B=",
        "--unset",
        "C",
        "--unset",
        "D",
        "--",
        "cmd",
        "--",
        "--set",
      ]),
      {
        name: "web",
        dir: DEFAULT_SLOT_DIR,
        set: [
          ["A", "x=y"],
          ["B", ""],
        ],
        unset: ["C", "D"],
        command: ["cmd", "--", "--set"],
      },
    );
  });

  const refused: ReadonlyArray<readonly string[]> = [
    ["--name", "mobile", "--set", "X=1"],
    ["--name", "mobile", "--set", "X=1", "--"],
    ["--set", "X=1", "--", "vitest"],
    ["--name", "mobile", "--set", "=1", "--", "vitest"],
    ["--name", "mobile", "--set", "X", "--", "vitest"],
    ["--name", "Mobile!", "--", "vitest"],
    ["--name", "mobile", "--name", "web", "--", "vitest"],
    ["--name", "--set", "X=1", "--", "vitest"],
    ["--name", "mobile", "--extra", "x", "--", "vitest"],
    ["--name", "mobile", "--set", "1X=1", "--", "vitest"],
    ["--name", "mobile", "--unset", "X-Y", "--", "vitest"],
    ["--name", "mobile", "--dir", "", "--", "vitest"],
    ["--name", "mobile", "--dir", "/a", "--dir", "/b", "--", "vitest"],
    ["--name", "mobile", "--set", "X=1", "--unset", "X", "--", "vitest"],
    ["--name", "mobile", "--unset", "X", "--unset", "X", "--", "vitest"],
    ["--name", "mobile", "--unset", "X=1", "--", "vitest"],
  ];
  for (const argv of refused)
    it(`refuses ${JSON.stringify(argv)}`, () => {
      assert.ok("error" in parseSlotArgs(argv));
    });

  const why: ReadonlyArray<readonly [readonly string[], string]> = [
    [["--", "vitest"], "--name is required"],
    [["--name", "mobile", "--"], "missing -- <command>"],
    [["--name", "--set", "X=1", "--", "vitest"], "--name needs a value"],
    [["--name", "mobile", "--set", "--", "vitest"], "--set needs a value"],
    [
      ["--name", "mobile", "--set", "X=1", "--set", "X=2", "--", "vitest"],
      "bad or repeated option --set X=2",
    ],
    [["--extra", "7", "--name", "mobile", "--", "vitest"], "bad or repeated option --extra 7"],
    [
      ["--name", "mobile", "--name", "web", "--set", "X=3", "--", "vitest"],
      "bad or repeated option --name web",
    ],
  ];
  for (const [argv, error] of why)
    it(`refuses ${JSON.stringify(argv)} saying exactly why`, () => {
      assert.deepEqual(parseSlotArgs(argv), { error });
    });
});

describe("decide", () => {
  const args: SlotArgs = {
    name: "mobile",
    dir: "/ignored",
    set: [["GRANT_WORKERS", "12"]],
    unset: ["VITEST_MAX_WORKERS"],
    command: ["vitest"],
  };
  const context = (env: Record<string, string>) => ({
    env: { [SLOT_DIR_ENV]: dir, ...env },
    cwd: "/repo",
    system: world.system,
    files: fs.files,
  });

  it("gives the command the --set variables when the slot is free", () => {
    const decision = decide(args, context({ KEEP: "x" }));
    assert.equal(decision.dir, dir);
    assert.equal(decision.childEnv["GRANT_WORKERS"], "12");
    assert.equal(decision.childEnv["KEEP"], "x");
    assert.equal(decision.line, "[dvara slot] mobile: took the slot");
    assert.deepEqual(decision.event, {
      ts: new Date(world.clock).toISOString(),
      name: "mobile",
      pid: SELF,
      taken: true,
      set: { GRANT_WORKERS: "12" },
    });
    decision.release();
    assert.equal(existsSync(lockPath()), false);
  });

  it("gives no --set variables, and names the holder, when the slot is held", () => {
    world.alive.add(OTHER);
    world.starts.set(OTHER, OTHER_START);
    placeHolder(holder());
    const decision = decide(args, context({}));
    assert.equal(decision.childEnv["GRANT_WORKERS"], undefined);
    assert.equal(
      decision.line,
      "[dvara slot] mobile: slot held by pid 999 (mobile); running without it",
    );
    assert.deepEqual(decision.event["holder"], { pid: OTHER, name: "mobile" });
    assert.equal(decision.event["taken"], false);
    decision.release();
    assert.equal(lockToken(), "their-token");
  });

  it("names no holder when the one there could not be read", () => {
    writeFileSync(lockPath(), "{not json");
    const decision = decide(args, context({}));
    assert.equal(decision.event["holder"], null);
    assert.equal(decision.event["reason"], "unreadable holder");
  });

  it("never touches the slot, and passes a preset value through, when told to skip", () => {
    const decision = decide(args, context({ GRANT_WORKERS: "3" }));
    assert.equal(decision.childEnv["GRANT_WORKERS"], "3");
    assert.equal(
      decision.line,
      "[dvara slot] mobile: slot not tried (GRANT_WORKERS already set)",
    );
    assert.deepEqual(decision.event, {
      ts: new Date(world.clock).toISOString(),
      name: "mobile",
      pid: SELF,
      taken: false,
      reason: "GRANT_WORKERS already set",
    });
    assert.equal(existsSync(lockPath()), false);
  });

  it("removes every --unset variable and only those", () => {
    const decision = decide(
      { ...args, unset: ["A", "B"] },
      context({ A: "1", B: "2", C: "3" }),
    );
    assert.equal("A" in decision.childEnv, false);
    assert.equal("B" in decision.childEnv, false);
    assert.equal(decision.childEnv["C"], "3");
    decision.release();
  });

  it("runs without the slot, naming the value, when the filesystem throws a non-Error", () => {
    const refusal: unknown = "link refused";
    fs.faults.push(() => {
      throw refusal;
    });
    const decision = decide(args, context({}));
    assert.equal(
      decision.line,
      "[dvara slot] mobile: slot unavailable: link refused; running without it",
    );
    assert.equal(decision.event["taken"], false);
    assert.equal(decision.event["reason"], "unavailable: link refused");
    assert.equal(decision.childEnv["GRANT_WORKERS"], undefined);
    assert.deepEqual(readdirSync(dir), []);
  });

  for (const [label, extra] of [
    ["taken", {}],
    ["skipped", { GRANT_WORKERS: "3" }],
  ] as const)
    it(`never passes an inherited --unset variable to the command (${label})`, () => {
      const decision = decide(args, context({ VITEST_MAX_WORKERS: "16", ...extra }));
      assert.equal("VITEST_MAX_WORKERS" in decision.childEnv, false);
      decision.release();
    });

  it("runs without the slot when the slot directory cannot be created", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    const decision = decide(args, context({ [SLOT_DIR_ENV]: join(blocker, "sub") }));
    assert.equal(decision.childEnv["GRANT_WORKERS"], undefined);
    assert.match(decision.line, /slot unavailable: .*running without it/);
    assert.equal(decision.event["taken"], false);
  });

  it("takes the real filesystem when given none", () => {
    const decision = decide(args, {
      env: { [SLOT_DIR_ENV]: dir },
      cwd: "/repo",
      system: world.system,
    });
    assert.equal(decision.line, "[dvara slot] mobile: took the slot");
    decision.release();
    assert.equal(existsSync(lockPath()), false);
  });
});

describe("recordEvent", () => {
  it("appends one JSON line per start", () => {
    recordEvent(dir, { name: "mobile", taken: true });
    recordEvent(dir, { name: "web", taken: false });
    const lines = readFileSync(join(dir, SLOT_LOG_FILENAME), "utf8").trim().split("\n");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      [
        { name: "mobile", taken: true },
        { name: "web", taken: false },
      ],
    );
    assert.equal(SLOT_LOG_FILENAME, "slots.jsonl");
  });

  it("swallows a log that cannot be written", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    assert.doesNotThrow(() => recordEvent(join(blocker, "sub"), {}));
  });
});

describe("exitStatus", () => {
  const plain: ReadonlyArray<readonly [number | null, string | null, number]> = [
    [0, null, 0],
    [3, null, 3],
    [null, "SIGINT", 130],
    [null, "SIGTERM", 143],
    [null, "SIGKILL", 137],
    [null, "SIGUSR2", 128],
    [null, null, 128],
  ];
  for (const [code, signal, status] of plain)
    it(`code ${code}, signal ${signal} → ${status}`, () => {
      assert.equal(exitStatus(code, signal), status);
    });

  const forwarded: ReadonlyArray<readonly [number | null, string | null, string, number]> = [
    [0, null, "SIGINT", 130],
    [0, null, "SIGTERM", 143],
    [1, null, "SIGTERM", 143],
    [null, "SIGKILL", "SIGINT", 130],
  ];
  for (const [code, signal, by, status] of forwarded)
    it(`a forwarded signal wins: code ${code}, signal ${signal}, forwarded ${by} → ${status}`, () => {
      assert.equal(exitStatus(code, signal, by), status);
    });
});

/**
 * The process wiring, in this process: the command, the signals and stderr
 * replaced, so what it spawns, forwards and exits with can be seen.
 */
describe("the slot wiring, in this process", () => {
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
    readonly signals: EventEmitter;
    readonly stderr: string[];
    readonly status: Promise<number>;
  }

  const start = (
    argv: readonly string[],
    spawnImpl?: SpawnSlotChild,
    files?: SlotFiles,
  ): Run => {
    const child = new FakeChild();
    const spawned: Array<Parameters<SpawnSlotChild>> = [];
    const signals = new EventEmitter();
    const stderr: string[] = [];
    const status = slot(argv, {
      err: (line) => stderr.push(line),
      env: { CI: "", [SLOT_DIR_ENV]: dir, KEEP: "x", VITEST_MAX_WORKERS: "16" },
      cwd: "/repo",
      system: world.system,
      signals,
      ...(files ? { files } : {}),
      spawn: (...call) => {
        spawned.push(call);
        return spawnImpl ? spawnImpl(...call) : child;
      },
    });
    return { child, spawned, signals, stderr, status };
  };

  const TOOK = "[dvara slot] mobile: took the slot";
  const takes = [
    "--name",
    "mobile",
    "--set",
    "GRANT_WORKERS=12",
    "--unset",
    "VITEST_MAX_WORKERS",
    "--",
  ];

  it("spawns the command with the variables, inherits stdio, and exits with its status", async () => {
    const run = start([...takes, "cmd", "a", "b"]);
    assert.deepEqual(run.stderr, [TOOK]);
    assert.deepEqual(run.spawned, [
      [
        "cmd",
        ["a", "b"],
        {
          stdio: "inherit",
          env: { CI: "", [SLOT_DIR_ENV]: dir, KEEP: "x", GRANT_WORKERS: "12" },
        },
      ],
    ]);
    assert.equal(existsSync(lockPath()), true);
    run.child.emit("exit", 7, null);
    assert.equal(await run.status, 7);
    assert.equal(existsSync(lockPath()), false);
    assert.equal(run.signals.listenerCount("SIGINT"), 0);
    assert.equal(run.signals.listenerCount("SIGTERM"), 0);
    const log = JSON.parse(readFileSync(join(dir, SLOT_LOG_FILENAME), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(log["taken"], true);
  });

  it("forwards SIGINT and SIGTERM to the command, and the first forwarded decides the status", async () => {
    const run = start([...takes, "cmd"]);
    assert.equal(run.signals.listenerCount("SIGINT"), 1);
    assert.equal(run.signals.listenerCount("SIGTERM"), 1);
    run.signals.emit("SIGTERM", "SIGTERM");
    run.signals.emit("SIGINT", "SIGINT");
    assert.deepEqual(run.child.killed, ["SIGTERM", "SIGINT"]);
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 143);
  });

  it("exits 127, naming the command, when the command cannot start", async () => {
    const run = start([...takes, "cmd"]);
    run.child.emit("error", new Error("spawn cmd ENOENT"));
    assert.equal(await run.status, 127);
    assert.deepEqual(run.stderr, [TOOK, "[dvara slot] could not start cmd: spawn cmd ENOENT"]);
    assert.equal(existsSync(lockPath()), false);
  });

  it("exits 127, and releases the slot, when spawn refuses the command by throwing", async () => {
    const run = start([...takes, "cmd"], () => {
      throw new TypeError("bad argument");
    });
    assert.equal(await run.status, 127);
    assert.deepEqual(run.stderr, [TOOK, "[dvara slot] could not start cmd: bad argument"]);
    assert.equal(existsSync(lockPath()), false);
    assert.equal(run.signals.listenerCount("SIGINT"), 0);
    const thrown = start([...takes, "cmd"], () => {
      throw "refused";
    });
    assert.equal(await thrown.status, 127);
    assert.equal(thrown.stderr[1], "[dvara slot] could not start cmd: refused");
  });

  it("keeps the command's exit status when releasing the slot fails", async () => {
    const files: SlotFiles = {
      link: (existing, path) => {
        linkSync(existing, path);
      },
      // Only the release's removal of the lock fails; taking the slot removes its temp file.
      rm: (path, options) => {
        if (path === lockPath()) throw new Error("EACCES: permission denied");
        rmSync(path, options);
      },
    };
    const run = start([...takes, "cmd"], undefined, files);
    run.child.emit("exit", 0, null);
    assert.equal(await run.status, 0);
    assert.deepEqual(run.stderr, [
      TOOK,
      "[dvara slot] could not release the slot: EACCES: permission denied",
    ]);
    // Left behind, it is this run's own lock, and reclaimable once this process is gone.
    assert.equal(existsSync(lockPath()), true);
    assert.equal(run.signals.listenerCount("SIGINT"), 0);
    rmSync(lockPath());
    const odd = start([...takes, "cmd"], undefined, {
      ...files,
      rm: (path, options) => {
        if (path === lockPath()) throw "refused";
        rmSync(path, options);
      },
    });
    odd.child.emit("exit", 3, null);
    assert.equal(await odd.status, 3);
    assert.equal(odd.stderr[1], "[dvara slot] could not release the slot: refused");
  });

  it("writes the usage error and exits 2 before spawning anything", async () => {
    const run = start(["--name", "mobile"]);
    assert.equal(await run.status, 2);
    assert.deepEqual(run.stderr, ["dvara slot: missing -- <command>", SLOT_USAGE]);
    assert.deepEqual(run.spawned, []);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("runs a real command on the process's own signals when given no wiring", async () => {
    const before = process.listenerCount("SIGINT");
    const stderr: string[] = [];
    const status = await slot(
      ["--name", "mobile", "--", process.execPath, "-e", "process.exit(3)"],
      {
        err: (line) => stderr.push(line),
        env: { ...process.env, [SLOT_DIR_ENV]: dir, CI: "", [SLOT_SWITCH_ENV]: undefined },
        cwd: dir,
      },
    );
    assert.equal(status, 3);
    assert.deepEqual(stderr, [TOOK]);
    assert.equal(process.listenerCount("SIGINT"), before);
    assert.equal(existsSync(lockPath()), false);
  });
});
