import type { EngineInterface, McpToolResult } from 'claude-code'

/**
 * Filing: a session whose turn ends on a question to the person files itself
 * in the desktop app's sidebar, so the person sees it without opening the
 * chat that started it. Its title gets a leading ✋, the row the sidebar
 * draws moves under the "Needs you" section, and that row is marked unread.
 *
 * A nested side session cannot move alone: the app moves it only with the top
 * session of its family ("nested sessions move with their parent"), so the
 * top session is the row that moves, found by walking `parentSessionId` up.
 * The plugin makes these calls itself; the model makes none.
 *
 * Unfiling takes the ✋ off and puts the top session back where it was, once
 * no other filed session lives under it. What was moved is kept in the
 * plugin's store, a file shared by every session on this machine, so the
 * session that unfiles last need not be the one that filed first.
 */

type Engine = EngineInterface

/** A filed session's title starts with this. */
export const WAITING = '✋'
/** The sidebar section a waiting session's row moves under. */
export const SECTION = 'Needs you'
/** How long one app call may take: a call the app holds for an approval card gives up here. */
export const CALL_MS = 20_000
/** Past this many ancestors the walk gives up as a loop would: an error, not a guess. */
const MAX_DEPTH = 100

/** The fields of a `get_session` answer that filing reads. */
export type Row = {
  sessionId: string
  title: string
  /** The sidebar group's id; null for none; undefined when the app has not reported groups. */
  group: string | null | undefined
  pinned: boolean
  parentSessionId: string | null
  detached: boolean
  isArchived: boolean
}

/**
 * What the store keeps for a filed session: the top session whose row moved,
 * and when the record was written (0 for a record written before 0.2.0 kept
 * the time).
 */
export type Filed = { root: string; at: number }
/**
 * How long a fresh record counts as waiting before its ✋ lands: another
 * session's filing writes the record first and its title after, so an
 * unmarked title inside this time is a filing under way, not a stale record.
 */
export const FRESH_MS = 2 * 60_000
/** What the store keeps for a moved top session: where it was before. */
export type Moved = { group: string | null; pinned: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const marked = (title: string): boolean => title.trimStart().startsWith(WAITING)
export const withMark = (title: string): string => (marked(title) ? title : `${WAITING} ${title}`)
export const withoutMark = (title: string): string =>
  marked(title) ? title.trimStart().slice(WAITING.length).trimStart() : title

/** A `get_session` answer's fields, or null when it is not one. */
export const rowOf = (value: unknown): Row | null => {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.title !== 'string') return null
  const group = value.group
  return {
    sessionId: value.sessionId,
    title: value.title,
    group: group === null ? null : isRecord(group) && typeof group.id === 'string' ? group.id : undefined,
    pinned: value.pinned === true,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
    detached: value.detached === true,
    isArchived: value.isArchived === true,
  }
}

/** The id of the "Needs you" section in a `list_sections` or `create_section` answer. */
export const sectionOf = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const found = value.filter(isRecord).find(row => row.kind === 'manual' && row.name === SECTION)
    return found !== undefined && typeof found.id === 'string' ? found.id : null
  }
  return isRecord(value) && typeof value.id === 'string' ? value.id : null
}

export const filedOf = (value: unknown): Filed | null =>
  isRecord(value) && typeof value.root === 'string'
    ? { root: value.root, at: typeof value.at === 'number' ? value.at : 0 }
    : null

export const movedOf = (value: unknown): Moved | null =>
  isRecord(value) && (value.group === null || typeof value.group === 'string')
    ? { group: value.group, pinned: value.pinned === true }
    : null

/** Store keys. */
export const filedKey = (sessionId: string): string => `filed:${sessionId}`
export const movedKey = (sessionId: string): string => `moved:${sessionId}`

/** The text of an MCP answer. */
const textOf = (result: McpToolResult): string =>
  result.content.map(block => (block.type === 'text' ? block.text : '')).join('')

/** An app call the app answered with an error: it did nothing. A timeout is no such answer. */
export class Refused extends Error {}

/**
 * An app call that rejects on an error answer (Refused), or when it takes
 * longer than CALL_MS. `$.mcp.call` takes no signal, so a call that times
 * out is not cancelled: the app may still carry it out later, and callers
 * keep what they need to undo it.
 */
export async function call($: Engine, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await Promise.race([$.mcp.call(server, tool, args), $.clock.sleep(CALL_MS).then(() => null)])
  if (result === null) throw new Error(`${tool} took over ${CALL_MS / 1000} s`)
  const text = textOf(result)
  if (result.isError === true) throw new Refused(`${tool}: ${text}`)
  return text
}

/** This session's id, read through `call`, so a held answer gives up like every other. */
export async function selfIdOf($: Engine): Promise<string | null> {
  return (await sessionRow($, 'self'))?.sessionId ?? null
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // fail-open: plain text ("Session … not found.") is no row; the caller reads it as none.
    return undefined
  }
}

async function sessionRow($: Engine, sessionId: string): Promise<Row | null> {
  return rowOf(parsed(await call($, 'ccd_session_mgmt', 'get_session', { session_id: sessionId })))
}

/** Why the last walk up stopped short, when it did: reported with the filing's other failures. */
let lastWalkError: string | null = null

/**
 * The top session of a session's family: the first ancestor with no parent,
 * or one moved to top level. The walk stops at the last row it could read,
 * so an ancestor the app cannot find (deleted) leaves the highest one found;
 * a parent seen before (a loop) or a family past MAX_DEPTH stops it too, and
 * each says so with the filing's other failures.
 */
export async function rootOf($: Engine, self: Row): Promise<Row> {
  let row = self
  const seen = new Set([self.sessionId])
  while (row.parentSessionId !== null && !row.detached) {
    if (seen.has(row.parentSessionId) || seen.size > MAX_DEPTH) {
      lastWalkError = `the walk up from ${self.sessionId} went round or past ${MAX_DEPTH} ancestors`
      break
    }
    const parent = await sessionRow($, row.parentSessionId).catch((error: unknown) => {
      // fail-open: an unreadable ancestor ends the walk; filing goes on from the highest row read, and the error is logged with the move it spoils.
      lastWalkError = String(error)
      return null
    })
    if (parent === null) break
    seen.add(parent.sessionId)
    row = parent
  }
  return row
}

/** Runs each step, whatever the ones before did, and fails at the end with the first failure. */
async function each(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    await step().catch((error: unknown) => {
      // fail-open: kept and rethrown below once every step has had its turn.
      failures.push(error)
    })
  }
  if (failures.length > 0) throw failures[0]
}

/** The "Needs you" section's id, made when the sidebar has none. */
async function needsYou($: Engine): Promise<string> {
  const listed = sectionOf(parsed(await call($, 'ccd_sidebar', 'list_sections', {})))
  if (listed !== null) return listed
  const made = sectionOf(parsed(await call($, 'ccd_sidebar', 'create_section', { name: SECTION })))
  if (made === null) throw new Error(`create_section gave no id for "${SECTION}"`)
  return made
}

/** How a call names a session: "self" for this one, which the app lets a session change without asking. */
const ref = (sessionId: string, self: Row): string => (sessionId === self.sessionId ? 'self' : sessionId)

/**
 * Files this session: ✋ title, its top session under "Needs you", and an
 * unread dot. The record goes first, so the answer can undo whatever lands.
 * Each part runs whatever the others did: the app may refuse a change to
 * another session's row, and the title and the session's own dot still say
 * it waits.
 */
export async function file($: Engine): Promise<void> {
  const self = await sessionRow($, 'self')
  if (self === null) return
  lastWalkError = null
  const root = await rootOf($, self)
  await $.store.set(filedKey(self.sessionId), { root: root.sessionId, at: await $.clock.now() } satisfies Filed)
  const isTop = root.sessionId === self.sessionId
  await each([
    async () => {
      if (!marked(self.title)) {
        await call($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: withMark(self.title) })
      }
    },
    async () => {
      if (!isTop) await call($, 'ccd_sidebar', 'set_unread', { session_id: 'self', unread: true })
    },
    async () => {
      // The top session's row is read again now that this session's record is in the store: a
      // sibling's unfiling that moved it back either did so before this read, so the row moves
      // again here, or its second look sees this record and files the row again itself.
      const top = (await sessionRow($, root.sessionId)) ?? root
      // A group the app has not reported is unknown: moving the row would lose where it goes back to.
      if (top.group === undefined) throw new Error('the top session was not moved: the app has not reported its sidebar group')
      const section = await needsYou($)
      if (top.group === section) return
      // Where the row goes back to is kept before the move, and only the first time. A
      // refused move takes it off again; a move that timed out keeps it, since the app
      // may still make the move after the call gave up.
      const journaled = movedOf(await $.store.get(movedKey(root.sessionId))) === null
      if (journaled) await $.store.set(movedKey(root.sessionId), { group: top.group, pinned: top.pinned } satisfies Moved)
      try {
        await call($, 'ccd_sidebar', 'move_sessions', { session_ids: [ref(root.sessionId, self)], section_id: section })
      } catch (error) {
        if (journaled && error instanceof Refused) await $.store.delete(movedKey(root.sessionId))
        throw error
      }
    },
    // A dot on the top session's row shows even where the move was refused.
    () => call($, 'ccd_sidebar', 'set_unread', { session_id: ref(root.sessionId, self), unread: true }).then(() => undefined),
    async () => {
      if (lastWalkError !== null) throw new Error(`the top session was not found (${lastWalkError})`)
    },
  ])
}

/**
 * Whether another session filed under the same top session still waits. A
 * marked session waits; so does one whose record is fresh (FRESH_MS), since
 * its filing writes the record before the ✋. An entry whose session is gone,
 * archived, or unmarked past that time is stale: it is dropped, so a session
 * archived while filed does not hold the row forever.
 */
async function stillWaiting($: Engine, rootId: string, selfId: string): Promise<boolean> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('filed:') || key === filedKey(selfId)) continue
    const entry = filedOf(await $.store.get(key))
    if (entry?.root !== rootId) continue
    const other = await sessionRow($, key.slice('filed:'.length)).catch((error: unknown) => {
      // A session the app no longer knows is gone; any other failure says nothing, so it stops the unfiling.
      if (String(error).includes('not found')) return null
      throw error
    })
    if (other !== null && !other.isArchived && (marked(other.title) || now - entry.at < FRESH_MS)) return true
    await $.store.delete(key)
  }
  return false
}

/**
 * Unfiles this session, if it filed itself: the ✋ goes, and its top session
 * goes back once nothing under it waits. The record goes last, so a step
 * that fails is tried again on the next answer.
 */
export async function unfile($: Engine, selfId: string): Promise<void> {
  const filed = filedOf(await $.store.get(filedKey(selfId)))
  if (filed === null) return
  const self = await sessionRow($, 'self')
  if (self === null) return
  if (marked(self.title)) {
    await call($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: withoutMark(self.title) })
  }
  const moved = movedOf(await $.store.get(movedKey(filed.root)))
  if (moved !== null && !(await stillWaiting($, filed.root, selfId))) {
    await call($, 'ccd_sidebar', 'move_sessions', {
      session_ids: [ref(filed.root, self)],
      section_id: moved.group ?? 'sessions',
    })
    if (moved.pinned) await call($, 'ccd_sidebar', 'set_pinned', { session_id: ref(filed.root, self), pinned: true })
    await $.store.delete(movedKey(filed.root))
    // The store has no compare-and-set, so another session may have filed under the same
    // top session while this one moved it back: look once more, and file the row again.
    if (await stillWaiting($, filed.root, selfId)) {
      await $.store.set(movedKey(filed.root), moved satisfies Moved)
      await call($, 'ccd_sidebar', 'move_sessions', { session_ids: [ref(filed.root, self)], section_id: await needsYou($) })
    }
  }
  await $.store.delete(filedKey(selfId))
}
