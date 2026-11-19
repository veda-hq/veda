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
/** The most ancestors walked to find the top session. */
const MAX_DEPTH = 12

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

/** What the store keeps for a filed session: the top session whose row moved. */
export type Filed = { root: string }
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
  isRecord(value) && typeof value.root === 'string' ? { root: value.root } : null

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

/** An app call that rejects on an error answer, or when it takes longer than CALL_MS. */
export async function call($: Engine, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await Promise.race([$.mcp.call(server, tool, args), $.clock.sleep(CALL_MS).then(() => null)])
  if (result === null) throw new Error(`${tool} took over ${CALL_MS / 1000} s`)
  const text = textOf(result)
  if (result.isError === true) throw new Error(`${tool}: ${text}`)
  return text
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

/** The top session of a session's family: the first ancestor with no parent, or one moved to top level. */
export async function rootOf($: Engine, self: Row): Promise<Row> {
  let row = self
  for (let depth = 0; depth < MAX_DEPTH && row.parentSessionId !== null && !row.detached; depth += 1) {
    const parent = await sessionRow($, row.parentSessionId)
    if (parent === null) break
    row = parent
  }
  return row
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

/** Files this session: ✋ title, its top session under "Needs you", that row unread. */
export async function file($: Engine): Promise<void> {
  const self = await sessionRow($, 'self')
  if (self === null) return
  if (!marked(self.title)) {
    await call($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: withMark(self.title) })
  }
  const root = await rootOf($, self)
  await $.store.set(filedKey(self.sessionId), { root: root.sessionId } satisfies Filed)
  const section = await needsYou($)
  if (root.group !== section) {
    if (movedOf(await $.store.get(movedKey(root.sessionId))) === null) {
      await $.store.set(movedKey(root.sessionId), { group: root.group ?? null, pinned: root.pinned } satisfies Moved)
    }
    await call($, 'ccd_sidebar', 'move_sessions', { session_ids: [ref(root.sessionId, self)], section_id: section })
  }
  await call($, 'ccd_sidebar', 'set_unread', { session_id: ref(root.sessionId, self), unread: true })
}

/**
 * Whether another session filed under the same top session still waits. An
 * entry whose session is gone, archived or no longer marked is stale: it is
 * dropped, so a session archived while filed does not hold the row forever.
 */
async function stillWaiting($: Engine, rootId: string, selfId: string): Promise<boolean> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('filed:') || key === filedKey(selfId)) continue
    if (filedOf(await $.store.get(key))?.root !== rootId) continue
    const other = await sessionRow($, key.slice('filed:'.length)).catch((error: unknown) => {
      // A session the app no longer knows is gone; any other failure says nothing, so it stops the unfiling.
      if (String(error).includes('not found')) return null
      throw error
    })
    if (other !== null && !other.isArchived && marked(other.title)) return true
    await $.store.delete(key)
  }
  return false
}

/** Unfiles this session, if it filed itself: the ✋ goes, and its top session goes back once nothing under it waits. */
export async function unfile($: Engine, selfId: string): Promise<void> {
  const filed = filedOf(await $.store.get(filedKey(selfId)))
  if (filed === null) return
  await $.store.delete(filedKey(selfId))
  const self = await sessionRow($, 'self')
  if (self === null) return
  if (marked(self.title)) {
    await call($, 'ccd_session_mgmt', 'set_session_title', { session_id: 'self', title: withoutMark(self.title) })
  }
  const moved = movedOf(await $.store.get(movedKey(filed.root)))
  if (moved === null || (await stillWaiting($, filed.root, selfId))) return
  await $.store.delete(movedKey(filed.root))
  await call($, 'ccd_sidebar', 'move_sessions', {
    session_ids: [ref(filed.root, self)],
    section_id: moved.group ?? 'sessions',
  })
  if (moved.pinned) await call($, 'ccd_sidebar', 'set_pinned', { session_id: ref(filed.root, self), pinned: true })
}
