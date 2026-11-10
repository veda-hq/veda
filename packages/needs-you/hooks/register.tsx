import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Ask } from '../types'

const asks = atom({ plugin: 'needs-you', key: 'asks' } as const, [] as Ask[])
const isHidden = atom({ plugin: 'needs-you', key: 'isHidden' } as const, false)
const isExpanded = atom({ plugin: 'needs-you', key: 'isExpanded' } as const, false)

/** A published page an ask links. */
const PAGE = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/
/** App events delivered as a prompt: not the person replying. */
const NOT_PERSON = /^\s*<(side-sessions-event|cross-session-message|ci-monitor-event)\b/
/** Prompts the person typed or sent from the phone or the desktop app. */
const PERSON_KINDS: readonly string[] = ['composer', 'bridge', 'sdk']
/** A side session waiting on the person files itself with a title starting with this. */
const WAITING = '✋'
const SHOWN = 3
const POLL_MS = 60_000

type Engine = EngineInterface

type Session = { sessionId: string; title: string; startedBy?: string; isArchived?: boolean }

/** Joins the text blocks of an MCP result. */
export const textOf = (result: McpToolResult): string =>
  result.content.map(block => (block.type === 'text' ? block.text : '')).join('')

/** "2 min", "3 h", "1 d". */
export const age = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The side sessions this chat started that wait on the person. */
export const waitingSessions = (rows: unknown, selfId: string): Session[] =>
  (Array.isArray(rows) ? rows : [])
    .filter(isRecord)
    .filter(
      row =>
        typeof row.sessionId === 'string' &&
        typeof row.title === 'string' &&
        row.startedBy === selfId &&
        row.isArchived !== true &&
        row.title.startsWith(WAITING),
    )
    .map(row => ({ sessionId: String(row.sessionId), title: String(row.title) }))

/** The reply buttons of a wrap_up: its actions that are replies, not app actions. */
export const replies = (actions: unknown): string[] =>
  (Array.isArray(actions) ? actions : [])
    .filter(isRecord)
    .filter(action => action.action === undefined && typeof action.label === 'string')
    .map(action => String(action.label))

/** A wrap-up's question: its `ask`, trimmed; empty when it has none. */
export const askOf = (args: Record<string, unknown>): string => (typeof args.ask === 'string' ? args.ask.trim() : '')

/**
 * A wrap-up that says the turn waits on the person (`blocked: true`) but asks
 * nothing: the band would stay empty while the chat waits. The app's own
 * contract for `blocked` is that the work stops until the person answers, so
 * such a call always has a question to ask.
 */
export const isAskless = (args: Record<string, unknown>): boolean => args.blocked === true && askOf(args) === ''

/** What the model reads when its askless wrap-up is refused. */
export const ASKLESS =
  'this turn waits on the person (blocked: true), but the wrap-up has no ask, so the band above the prompt shows nothing and the person cannot see that this chat needs them. ' +
  'Call wrap_up again, keeping blocked: true, with ask (the one question, in a sentence) and actions (reply buttons that answer it). ' +
  'If the turn does not wait on the person, leave blocked out instead.'

/** An MCP answer's JSON; undefined for an error or plain text, such as "Session … not found.". */
export const jsonOf = (result: McpToolResult): unknown => {
  if (result.isError) return undefined
  try {
    return JSON.parse(textOf(result))
  } catch {
    return undefined
  }
}

/** The engine's refusal when this session has no app session tools (a terminal session). */
const NO_TOOL = /no connected MCP tool/

/** This session's id, read once per load. */
let selfId: string | null = null
/** The asks this turn added, given the turn's page when it ends. */
let addedThisTurn: string[] = []
/** False once the app's session tools proved absent: no more reads until the session starts again. */
let reading = true
/** The failure logged last, so a repeat stays out of the transcript until a read succeeds. */
let lastLogged: string | null = null

/** Lists the side sessions this chat started that wait on the person. */
async function syncSessions($: Engine): Promise<void> {
    if (selfId === null) {
      const self = jsonOf(await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' }))
      selfId = isRecord(self) && typeof self.sessionId === 'string' ? self.sessionId : null
    }
    if (selfId === null) return
    const listed = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { linked: true })
    if (listed.isError) return
    // Plain text ("No sessions …") lists nothing.
    const waiting = waitingSessions(jsonOf(listed), selfId)
    const now = await $.clock.now()
    await update($, asks, current => {
      const kept = current.filter(ask => ask.from !== 'session')
      const fresh = waiting.map(session => {
        const before = current.find(ask => ask.id === session.sessionId)
        return {
          id: session.sessionId,
          from: 'session' as const,
          text: session.title.replace(WAITING, '').trim(),
          page: PAGE.exec(session.title)?.[0] ?? null,
          answers: [],
          since: before?.since ?? now,
          sessionId: session.sessionId,
        }
      })
      return [...kept, ...fresh]
    })
}

/** The one line a session without the app's session tools gets. */
export const NOT_SHOWN = 'needs-you: side sessions are not shown in this session (no app session tools)'

/** After a failed read: whether to keep reading, the failure now logged last, and the line to log (none for a repeat). */
export const afterFailure = (
  error: unknown,
  logged: string | null,
): { reading: boolean; lastLogged: string | null; line: string | null } => {
  const text = String(error)
  if (NO_TOOL.test(text)) return { reading: false, lastLogged: text, line: NOT_SHOWN }
  if (text === logged) return { reading: true, lastLogged: logged, line: null }
  return { reading: true, lastLogged: text, line: `needs-you: side sessions not read (${text})` }
}

/**
 * One read of the side sessions; never thrown. A failure is logged once, not on every
 * read; a session without the app's session tools stops reading after one line.
 */
function poll($: Engine): void {
  if (!reading) return
  syncSessions($).then(
    () => {
      lastLogged = null
    },
    (error: unknown) => {
      const after = afterFailure(error, lastLogged)
      reading = after.reading
      lastLogged = after.lastLogged
      if (after.line !== null) $.ui.log(after.line)
    },
  )
}

/** Sends a reply button's label as the person's reply and takes the ask off. */
async function answer($: Engine, ask: Ask, label: string): Promise<void> {
  await update($, asks, current => current.filter(old => old.id !== ask.id))
  await $.prompt.submit({ text: label, asUser: true })
}

/** Shows a side session beside this chat. */
function openSession($: Engine, ask: Ask): void {
  if (ask.sessionId === null) return
  $.mcp
    .call('ccd_window', 'open_session_in', { session_id: ask.sessionId, target: 'split' })
    .catch((error: unknown) => $.ui.toast(`Open it from the sidebar (${String(error)})`))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    selfId = null
    reading = true
    lastLogged = null
    poll($)
    $.clock.every(POLL_MS, () => poll($))
    return started
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const args: Record<string, unknown> = { ...e }
    if (name === 'AskUserQuestion') {
      const questions = (Array.isArray(args.questions) ? args.questions : []).filter(isRecord)
      const now = await $.clock.now()
      const open: Ask[] = questions.map((question, index) => ({
        id: `${e.tool_use_id}:${index}`,
        from: 'dialog',
        text: String(question.question),
        page: PAGE.exec(String(question.question))?.[0] ?? null,
        answers: [],
        since: now,
        sessionId: null,
      }))
      await update($, asks, current => [...current, ...open])
      try {
        return await next(e)
      } finally {
        await update($, asks, current => current.filter(ask => !ask.id.startsWith(`${e.tool_use_id}:`)))
      }
    }
    const isWrapUp = name === 'mcp__ccd_turn__wrap_up'
    if (isWrapUp && isAskless(args)) return { deny: `${$.plugin.name}: ${ASKLESS}` }
    const result = await next(e)
    const question = askOf(args)
    if (isWrapUp && question !== '') {
      const ask: Ask = {
        id: e.tool_use_id,
        from: 'chat',
        text: question,
        page: PAGE.exec(`${args.ask} ${String(args.recap)}`)?.[0] ?? null,
        answers: replies(args.actions),
        since: await $.clock.now(),
        sessionId: null,
      }
      addedThisTurn = [...addedThisTurn, ask.id]
      await update($, asks, current => [...current.filter(old => old.from !== 'chat'), ask])
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    const added = addedThisTurn
    addedThisTurn = []
    if (added.length > 0) {
      const last = [...(await $.session.messages())].reverse().find(message => message.role === 'assistant')
      const page = last === undefined ? null : PAGE.exec(last.text)?.[0] ?? null
      if (page !== null) {
        await update($, asks, current =>
          current.map(ask => (added.includes(ask.id) && ask.page === null ? { ...ask, page } : ask)),
        )
      }
    }
    return completed
  })

  on('prompt.submit', async ($, e, next) => {
    const fromPerson = e.isMeta !== true && PERSON_KINDS.includes(e.origin.kind) && !NOT_PERSON.test(e.text)
    if (fromPerson) {
      await update($, asks, current => current.filter(ask => ask.from !== 'chat'))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, asks)
    if (e.props.hasSurvey || list.length === 0 || e.props.view.agentId !== undefined) {
      return next(e)
    }
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const count = list.length
    if (await read($, isHidden)) {
      return (
        <Box>
          <Button key="show" plain label={`✋ Needs you in this chat · ${count} · show`} onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }
    const now = await $.clock.now()
    const sorted = [...list].sort((a, b) => a.since - b.since)
    const expanded = await read($, isExpanded)
    const shown = expanded ? sorted : sorted.slice(0, SHOWN)
    const more = count - shown.length
    const who = (ask: Ask): string => (ask.from === 'session' ? 'side session' : 'this chat')

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="warning" bold>
            ✋ NEEDS YOU IN THIS CHAT · {count}
          </Text>
          <Button key="hide" plain label="hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {shown.map(ask => (
          <Box key={`row:${ask.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="column" flexShrink={1}>
              <Text wrap="truncate-end">● {ask.text}</Text>
              <Box flexDirection="row">
                <Text dimColor>{who(ask)} · </Text>
                {ask.page === null ? null : <Link href={ask.page} label="page ↗" />}
                <Text dimColor>
                  {ask.page === null ? '' : ' · '}
                  {age(now - ask.since)}
                </Text>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1}>
              {ask.from === 'chat'
                ? ask.answers.map((label, index) => (
                    <Button
                      key={`answer:${ask.id}:${label}`}
                      label={label}
                      variant={index === 0 ? 'primary' : 'secondary'}
                      onPress={() => void answer($, ask, label)}
                    />
                  ))
                : null}
              {ask.from === 'session' ? (
                <Button key={`open:${ask.id}`} label="Open session" variant="primary" onPress={() => openSession($, ask)} />
              ) : null}
            </Box>
          </Box>
        ))}
        {more > 0 ? (
          <Button key="more" plain label={`+ ${more} more · show all`} onPress={() => update($, isExpanded, () => true)} />
        ) : null}
        {expanded && count > SHOWN ? (
          <Button key="less" plain label="show fewer" onPress={() => update($, isExpanded, () => false)} />
        ) : null}
      </Box>
    )
  })
}
