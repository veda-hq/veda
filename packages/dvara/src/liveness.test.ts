import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ExecFileSyncOptions,
} from "node:child_process";
import { describe, it } from "node:test";
import {
  defaultLivenessSystem,
  errorCode,
  isGone,
  parseParty,
  processLivenessSystem,
  START_IDENTITY_FORMAT,
  UNREADABLE_GRACE_MS,
  type LivenessSystem,
  type Party,
  type ProcessCalls,
} from "./liveness.ts";

const OTHER = 999;

/** A process table: who is alive, and the start each one reads. */
const table = (
  alive: number[],
  starts: Record<number, string | null>,
): LivenessSystem => ({
  pid: 4242,
  now: () => 0,
  isAlive: (pid) => alive.includes(pid),
  startIdentityOf: (pid) => starts[pid] ?? null,
});

const at = (time: string): string => `${START_IDENTITY_FORMAT} ${time}`;

describe("isGone", () => {
  it("compares a start recorded as lstart-utc-c/1, as every record on disk is", () => {
    const system = table([OTHER], { [OTHER]: at("Thu Sep 17 11:30:00 2026") });
    assert.equal(
      isGone({ pid: OTHER, startIdentity: at("Thu Sep 17 09:00:00 2026") }, system),
      true,
    );
    assert.equal(START_IDENTITY_FORMAT, "lstart-utc-c/1");
  });

  it("calls a dead pid gone", () => {
    assert.equal(isGone({ pid: OTHER, startIdentity: null }, table([], {})), true);
  });

  it("keeps a live pid whose start is the one recorded", () => {
    const start = at("Thu Sep 17 09:00:00 2026");
    assert.equal(
      isGone({ pid: OTHER, startIdentity: start }, table([OTHER], { [OTHER]: start })),
      false,
    );
  });

  it("does NOT call a live holder gone whose start was recorded in another format", () => {
    const system = table([OTHER], { [OTHER]: at("Thu Sep 17 11:30:00 2026") });
    assert.equal(
      isGone({ pid: OTHER, startIdentity: "Thu Sep 17 09:00:00 2026" }, system),
      false,
    );
    // Nor when the reading is the one in another format.
    const odd = table([OTHER], { [OTHER]: "lstart-local/0 Thu Sep 17 11:30:00 2026" });
    assert.equal(
      isGone({ pid: OTHER, startIdentity: at("Thu Sep 17 09:00:00 2026") }, odd),
      false,
    );
  });

  it("does NOT call a live holder gone whose start cannot be read", () => {
    const system = table([OTHER], { [OTHER]: null });
    assert.equal(
      isGone({ pid: OTHER, startIdentity: at("Thu Sep 17 09:00:00 2026") }, system),
      false,
    );
  });

  it("calls a reused pid gone when it exits between the liveness and start reads", () => {
    let probes = 0;
    const system: LivenessSystem = {
      ...table([], {}),
      isAlive: () => {
        probes += 1;
        return probes === 1;
      },
    };
    assert.equal(
      isGone({ pid: OTHER, startIdentity: at("Thu Sep 17 09:00:00 2026") }, system),
      true,
    );
    assert.equal(probes, 2);
  });
});

describe("parseParty", () => {
  const valid: Party = {
    pid: 4242,
    startIdentity: at("Sat Sep 19 10:00:00 2026"),
    branch: "plateau-slot-mobile",
    rootDir: "/repo",
    token: "0123456789abcdef01234567",
    since: 1_760_000_000_000,
  };

  it("accepts a complete party", () => {
    assert.deepEqual(parseParty(JSON.stringify(valid)), valid);
    assert.deepEqual(parseParty(JSON.stringify({ ...valid, startIdentity: null })), {
      ...valid,
      startIdentity: null,
    });
  });

  it("drops the priority and demand an older gate wrote (0114 W-33)", () => {
    assert.deepEqual(
      parseParty(JSON.stringify({ ...valid, priority: "background", demand: "/d" })),
      valid,
    );
    assert.deepEqual(
      parseParty(JSON.stringify({ ...valid, priority: "urgent", demand: 5 })),
      valid,
    );
  });

  it("reads a pid beyond the safe-integer range, as the gate lock's schema did", () => {
    assert.equal(parseParty(JSON.stringify({ ...valid, pid: 2 ** 60 }))?.pid, 2 ** 60);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["not JSON", "{"],
    ["not an object", "42"],
    ["null", "null"],
    ["a zero pid", JSON.stringify({ ...valid, pid: 0 })],
    ["a fractional pid", JSON.stringify({ ...valid, pid: 1.5 })],
    ["a string pid", JSON.stringify({ ...valid, pid: "4242" })],
    ["a numeric start identity", JSON.stringify({ ...valid, startIdentity: 7 })],
    ["no start identity", JSON.stringify({ ...valid, startIdentity: undefined })],
    ["no branch", JSON.stringify({ ...valid, branch: undefined })],
    ["no root", JSON.stringify({ ...valid, rootDir: 3 })],
    ["an empty token", JSON.stringify({ ...valid, token: "" })],
    ["a numeric token", JSON.stringify({ ...valid, token: 5 })],
    ["a string since", JSON.stringify({ ...valid, since: "now" })],
    [
      "a non-finite since",
      '{"pid":1,"startIdentity":null,"branch":"b","rootDir":"r","token":"t","since":1e999}',
    ],
  ];
  for (const [label, raw] of rejected)
    it(`rejects ${label}`, () => {
      assert.equal(parseParty(raw), null);
    });
});

describe("errorCode", () => {
  it("reads a code off anything that has one, and nothing off the rest", () => {
    assert.equal(errorCode(Object.assign(new Error("x"), { code: "EEXIST" })), "EEXIST");
    assert.equal(errorCode({ code: 7 }), "7");
    assert.equal(errorCode(new Error("x")), undefined);
    assert.equal(errorCode("EEXIST"), undefined);
    assert.equal(errorCode(null), undefined);
  });

  it("keeps the gate lock's grace for an unreadable record", () => {
    assert.equal(UNREADABLE_GRACE_MS, 10_000);
  });
});

describe("defaultLivenessSystem", () => {
  it("sees this process as alive, with a start time", () => {
    assert.equal(defaultLivenessSystem.pid, process.pid);
    assert.equal(defaultLivenessSystem.isAlive(process.pid), true);
    assert.match(defaultLivenessSystem.startIdentityOf(process.pid) ?? "", /\d/);
    assert.ok(Math.abs(defaultLivenessSystem.now() - Date.now()) < 1_000);
  });

  it("reads a process's start time the same way whatever time zone the reader runs in", () => {
    // `ps -o lstart` prints LOCAL time. Two readers whose shells carry
    // different TZ values would read different strings for one live holder,
    // and the second would judge it a reused PID and reclaim a held lock.
    const saved = process.env["TZ"];
    try {
      process.env["TZ"] = "UTC";
      const inUtc = defaultLivenessSystem.startIdentityOf(process.pid);
      process.env["TZ"] = "Pacific/Kiritimati";
      const farAway = defaultLivenessSystem.startIdentityOf(process.pid);
      assert.notEqual(inUtc, null);
      assert.equal(farAway, inUtc);
    } finally {
      if (saved === undefined) delete process.env["TZ"];
      else process.env["TZ"] = saved;
    }
  });

  it("sees a zombie as dead, though signal 0 still reaches it", { timeout: 20_000 }, async () => {
    // A process that has exited but not been reaped answers `kill(pid, 0)`.
    // A real one: `sh` backgrounds a child, then `exec`s into a `sleep` that
    // never reaps it. The child must not exit until the exec has happened,
    // or the shell can reap it, so it sleeps as long as the parent and is
    // killed only once `ps` shows the parent has become `sleep`.
    const parent = spawn("sh", ["-c", "sleep 30 & echo $!; exec sleep 30"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parentPid = parent.pid ?? -1;
    let zombie = -1;
    try {
      zombie = await new Promise<number>((resolve) => {
        parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });
      const deadline = Date.now() + 10_000;
      // Read with `ps` directly, so no wait is satisfied by the function under test.
      const psField = (field: string, pid: number): string => {
        try {
          return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          // fail-open: a pid ps cannot find reads as no field; the wait polls again.
          return "";
        }
      };
      const until = (done: () => boolean): Promise<void> =>
        done() || Date.now() >= deadline
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              setTimeout(resolve, 50);
            }).then(() => until(done));

      const execed = (): boolean => /(^|\/)sleep$/.test(psField("comm", parentPid));
      await until(execed);
      assert.match(psField("comm", parentPid), /(^|\/)sleep$/);

      process.kill(zombie, "SIGKILL");
      await until(() => psField("stat", zombie).startsWith("Z"));
      assert.match(psField("stat", zombie), /^Z/);

      // The precondition that makes this test mean anything: signal 0 still
      // reaches the pid, so liveness by signal alone would call it alive.
      assert.doesNotThrow(() => process.kill(zombie, 0));
      assert.equal(defaultLivenessSystem.isAlive(zombie), false);
      assert.equal(defaultLivenessSystem.isAlive(parentPid), true);
    } finally {
      if (zombie > 0) {
        try {
          process.kill(zombie, "SIGKILL");
        } catch {
          // fail-open: already reaped.
        }
      }
      parent.kill("SIGKILL");
    }
  });

  it("sees an exited process as dead, with no start time", () => {
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.ok((child.pid ?? 0) > 0);
    assert.equal(defaultLivenessSystem.isAlive(child.pid ?? 0), false);
    assert.equal(defaultLivenessSystem.startIdentityOf(child.pid ?? 0), null);
  });
});

describe("processLivenessSystem", () => {
  interface Call {
    readonly file: string;
    readonly args: string[];
    readonly options: ExecFileSyncOptions;
  }

  /** Calls whose `ps` prints `output`, or throws it when it is an Error. */
  const calls = (
    output: string | Error,
    kill: (pid: number) => void = () => undefined,
  ): { made: Call[]; killed: number[]; calls: ProcessCalls } => {
    const made: Call[] = [];
    const killed: number[] = [];
    return {
      made,
      killed,
      calls: {
        exec: (file, args, options) => {
          made.push({ file, args, options });
          if (output instanceof Error) throw output;
          return Buffer.from(output);
        },
        kill: (pid, signal) => {
          assert.equal(signal, 0);
          killed.push(pid);
          kill(pid);
        },
      },
    };
  };
  const thrown = (value: unknown) => (): void => {
    throw value;
  };
  const errno = (code: string): Error => Object.assign(new Error(code), { code });

  it("asks ps for the state, quietly and in the C locale, once signal 0 reaches the pid", () => {
    const probe = calls("S+\n");
    assert.equal(processLivenessSystem(probe.calls).isAlive(42), true);
    assert.deepEqual(probe.killed, [42]);
    assert.deepEqual(probe.made, [
      {
        file: "ps",
        args: ["-o", "stat=", "-p", "42"],
        options: {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, LC_ALL: "C" },
        },
      },
    ]);
  });

  it("reads a zombie as dead, and a ps that fails as alive", () => {
    assert.equal(processLivenessSystem(calls("Z\n").calls).isAlive(42), false);
    assert.equal(processLivenessSystem(calls(new Error("no ps")).calls).isAlive(42), true);
  });

  it("reads only ESRCH as no such process; a pid another user owns is asked of ps", () => {
    const gone = calls("S\n", thrown(errno("ESRCH")));
    assert.equal(processLivenessSystem(gone.calls).isAlive(42), false);
    assert.deepEqual(gone.made, []);

    const owned = calls("S\n", thrown(errno("EPERM")));
    assert.equal(processLivenessSystem(owned.calls).isAlive(42), true);
    assert.equal(owned.made.length, 1);
    const ownedZombie = calls("Z\n", thrown(errno("EPERM")));
    assert.equal(processLivenessSystem(ownedZombie.calls).isAlive(42), false);
  });

  const refusals: ReadonlyArray<readonly [string, unknown]> = [
    ["another errno", errno("EINVAL")],
    ["null", null],
    ["a string", "refused"],
    ["an object without a code", {}],
  ];
  for (const [label, value] of refusals)
    it(`asks ps when signal 0 is refused with ${label}, which proves nothing`, () => {
      const probe = calls("S\n", thrown(value));
      assert.equal(processLivenessSystem(probe.calls).isAlive(42), true);
      assert.equal(probe.made.length, 1);
    });

  it("reads the start time in UTC and the C locale, in the format it records", () => {
    const probe = calls("Thu Oct  8 15:35:58 2026\n");
    assert.equal(
      processLivenessSystem(probe.calls).startIdentityOf(42),
      "lstart-utc-c/1 Thu Oct  8 15:35:58 2026",
    );
    assert.deepEqual(probe.made, [
      {
        file: "ps",
        args: ["-o", "lstart=", "-p", "42"],
        options: {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        },
      },
    ]);
  });

  it("has no start time when ps prints none, or fails", () => {
    assert.equal(processLivenessSystem(calls(" \n").calls).startIdentityOf(42), null);
    assert.equal(
      processLivenessSystem(calls(new Error("no ps")).calls).startIdentityOf(42),
      null,
    );
  });
});
