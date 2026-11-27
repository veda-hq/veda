// The heavy-work turn queue's rules: who is served next, and a replay of the
// request log at any count. Pure: turn.ts does the files, the clock and the
// processes.
//
// The line is ordered by class, pushes first, then by arrival. A turn goes to
// the head of the line, then to each next in line while its width still fits,
// and to no one past the first that does not fit: nothing overtakes, so a
// queued exclusive request holds back everyone behind it and is never
// starved. A request that has waited the bound is granted whatever is in use.

export type TurnClass = "push" | "other";

/** One request, waiting or granted. */
export interface Request {
  readonly token: string;
  readonly class: TurnClass;
  /** Takes every turn rather than one. */
  readonly exclusive: boolean;
  /** Milliseconds since the epoch. */
  readonly askedAt: number;
  /** When it was granted (in record mode, when it would have been); null while it waits. */
  readonly grantedAt: number | null;
}

/** The turns a request takes when there are `count`. */
export const widthOf = (request: Pick<Request, "exclusive">, count: number): number =>
  request.exclusive ? count : 1;

/** The turns the granted requests hold. */
export const inUse = (requests: readonly Request[], count: number): number =>
  requests.reduce(
    (sum, request) => (request.grantedAt === null ? sum : sum + widthOf(request, count)),
    0,
  );

const rank = (request: Request): number => (request.class === "push" ? 0 : 1);

/** The waiting requests in the order they are served: pushes first, then by arrival, then by token. */
export const inLine = <T extends Request>(requests: readonly T[]): T[] =>
  requests
    .filter((request) => request.grantedAt === null)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.askedAt - b.askedAt ||
        a.token.localeCompare(b.token),
    );

export interface Grant {
  readonly token: string;
  /** Granted because it waited the bound, not because a turn was free. */
  readonly overBound: boolean;
}

/** Who is granted at `now`, in line order. */
export const grants = (
  requests: readonly Request[],
  count: number,
  now: number,
  boundMs: number,
): Grant[] => {
  let free = count - inUse(requests, count);
  let blocked = false;
  const granted: Grant[] = [];
  for (const request of inLine(requests)) {
    const width = widthOf(request, count);
    if (!blocked && width <= free) {
      free -= width;
      granted.push({ token: request.token, overBound: false });
    } else {
      blocked = true;
      if (now - request.askedAt >= boundMs)
        granted.push({ token: request.token, overBound: true });
    }
  }
  return granted;
};

/** A request as the log records it, all a replay needs. */
export interface Logged {
  readonly id: string;
  readonly class: TurnClass;
  readonly exclusive: boolean;
  readonly askedAt: number;
  /** When its command started and ended: the run time a replay gives it. */
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface Replayed {
  readonly id: string;
  readonly waitMs: number;
  readonly overBound: boolean;
}

interface Job {
  readonly logged: Logged;
  readonly runMs: number;
  grantedAt: number | null;
  endAt: number;
  /** Set when it is granted, as every job is in the end. */
  grant?: Grant;
}

const jobRequest = (job: Job): Request => ({
  token: job.logged.id,
  class: job.logged.class,
  exclusive: job.logged.exclusive,
  askedAt: job.logged.askedAt,
  grantedAt: job.grantedAt,
});

/**
 * Replay the logged requests through a queue of `count` turns and a bound of
 * `boundMs`: each arrives when it asked and, once granted, runs as long as
 * its command ran. Returns each one's wait, in the order given.
 */
export const replay = (
  lines: readonly Logged[],
  count: number,
  boundMs: number,
): Replayed[] => {
  const jobs: Job[] = lines.map((logged) => ({
    logged,
    runMs: Math.max(0, logged.endedAt - logged.startedAt),
    grantedAt: null,
    endAt: Number.POSITIVE_INFINITY,
  }));
  let now = Number.NEGATIVE_INFINITY;
  for (;;) {
    const unfinished = jobs.filter((job) => job.endAt > now);
    if (unfinished.length === 0) break;
    // The next moment anything changes, each strictly later than now: an
    // arrival, a bound reached, or an end.
    now = Math.min(
      ...unfinished.map((job) =>
        job.logged.askedAt > now
          ? job.logged.askedAt
          : job.grantedAt === null
            ? job.logged.askedAt + boundMs
            : job.endAt,
      ),
    );
    // Grant until nothing changes: a run of no length frees its turn at the moment it got it.
    for (;;) {
      const present = unfinished.filter((job) => job.logged.askedAt <= now && job.endAt > now);
      const byId = new Map(present.map((job) => [job.logged.id, job]));
      const granted = grants(present.map(jobRequest), count, now, boundMs);
      if (granted.length === 0) break;
      for (const grant of granted) {
        const job = byId.get(grant.token) as Job;
        job.grantedAt = now;
        job.endAt = now + job.runMs;
        job.grant = grant;
      }
    }
  }
  return jobs.map((job) => ({
    id: job.logged.id,
    waitMs: (job.grantedAt as number) - job.logged.askedAt,
    overBound: (job.grant as Grant).overBound,
  }));
};

/** The value at fraction `q` of sorted `values` (nearest rank), or 0 when there are none. */
export const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] as number;
};

export interface ReplaySummary {
  readonly count: number;
  readonly boundMs: number;
  readonly requests: number;
  /** Requests that would have waited at all. */
  readonly waited: number;
  readonly totalWaitMs: number;
  readonly p50WaitMs: number;
  readonly p95WaitMs: number;
  readonly maxWaitMs: number;
  /** Requests that would have run anyway at the bound. */
  readonly overBound: number;
}

/** The replay at `count` turns, summed up. */
export const summarize = (
  lines: readonly Logged[],
  count: number,
  boundMs: number,
): ReplaySummary => {
  const waits = replay(lines, count, boundMs);
  const ms = waits.map((wait) => wait.waitMs);
  return {
    count,
    boundMs,
    requests: waits.length,
    waited: ms.filter((wait) => wait > 0).length,
    totalWaitMs: ms.reduce((sum, wait) => sum + wait, 0),
    p50WaitMs: quantile(ms, 0.5),
    p95WaitMs: quantile(ms, 0.95),
    maxWaitMs: Math.max(0, ...ms),
    overBound: waits.filter((wait) => wait.overBound).length,
  };
};
