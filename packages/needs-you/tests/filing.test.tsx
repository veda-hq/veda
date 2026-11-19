import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SECTION, filedKey, rowOf, sectionOf, withMark, withoutMark } from '../hooks/filing'
import { afterFilingFailure, unfilesOn, waitingSessions } from '../hooks/register'

type Session = {
  sessionId: string
  title: string
  group: { id: string; name: string } | null
  pinned?: boolean
  parentSessionId?: string
  startedBy?: string
  detached?: boolean
  isArchived?: boolean
}

type Section = { id: string; kind: string; name: string }

/**
 * The desktop app's session and sidebar tools, as far as filing uses them.
 * A nested session refuses to move alone, as the app does.
 */
function app(on: On, selfId: string, sessions: Session[], sections: Section[] = [{ id: 'cg-needs', kind: 'manual', name: SECTION }]) {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const id = (ref: unknown) => (ref === 'self' ? selfId : String(ref))
  const text = (value: unknown, isError = false) => ({
    value: { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], isError },
  })
  const nameOf = (sectionId: string) => sections.find(section => section.id === sectionId)?.name ?? ''
  on('mcp.call', (_, e) => {
    const args = (e.args ?? {}) as Record<string, unknown>
    calls.push({ tool: e.tool, args })
    switch (e.tool) {
      case 'get_session': {
        const found = byId.get(id(args.session_id))
        return found === undefined ? text(`Session ${String(args.session_id)} not found.`, true) : text(found)
      }
      case 'list_sessions':
        return text([...byId.values()].filter(session => session.sessionId !== selfId))
      case 'set_session_title': {
        const found = byId.get(id(args.session_id))
        if (found !== undefined) found.title = String(args.title)
        return text('Renamed.')
      }
      case 'list_sections':
        return text(sections)
      case 'create_section': {
        const made = { id: `cg-${sections.length}`, kind: 'manual', name: String(args.name) }
        sections.push(made)
        return text(made)
      }
      case 'move_sessions': {
        const refs = args.session_ids as string[]
        const nested = refs.map(ref => byId.get(id(ref))).find(found => found?.parentSessionId !== undefined && found.detached !== true)
        if (nested !== undefined) {
          return text(`Session ${nested.sessionId} is nested under ${String(nested.parentSessionId)}, and nested sessions move with their parent. Nothing was moved.`, true)
        }
        for (const ref of refs) {
          const found = byId.get(id(ref))
          const section = String(args.section_id)
          if (found !== undefined) {
            found.group = section === 'sessions' ? null : { id: section, name: nameOf(section) }
            found.pinned = false
          }
        }
        return text('Moved.')
      }
      case 'set_pinned': {
        const found = byId.get(id(args.session_id))
        if (found !== undefined) found.pinned = args.pinned === true
        return text('Pinned.')
      }
      default:
        return text('Done.')
    }
  })
  return { calls, byId, sections }
}

/** Three deep: top ← middle (archived) ← parent ← self, and a sibling of self. */
const family = (): Session[] => [
  { sessionId: 'top', title: 'Self-service research framework', group: { id: 'cg-work', name: 'Work' }, pinned: true },
  { sessionId: 'middle', title: 'ask-gate on Stop', group: null, parentSessionId: 'top', startedBy: 'top', isArchived: true },
  { sessionId: 'parent', title: 'RF-3: athya_mono on sarathi', group: null, parentSessionId: 'middle', startedBy: 'middle' },
  { sessionId: 'self', title: 'Approve veda#259', group: null, parentSessionId: 'parent', startedBy: 'parent' },
  { sessionId: 'sibling', title: 'Another side session', group: null, parentSessionId: 'parent', startedBy: 'parent' },
]

const BAND = {
  plugin: 'needs-you',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

/** What a session's engine answers beneath the plugin, for a turn and its wrap-up. */
function turns(on: On) {
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { logged }
}

test('the mark goes on once and comes off whole', () => {
  expect(withMark('Approve #42')).toBe('✋ Approve #42')
  expect(withMark('✋ Approve #42')).toBe('✋ Approve #42')
  expect(withoutMark('✋ Approve #42')).toBe('Approve #42')
  expect(withoutMark(' ✋  Approve #42')).toBe('Approve #42')
  expect(withoutMark('Approve #42')).toBe('Approve #42')
})

test('a session row and the section are read from the app’s answers', () => {
  expect(rowOf({ sessionId: 'a', title: 't', group: { id: 'g' }, parentSessionId: 'p', detached: true })).toEqual({
    sessionId: 'a', title: 't', group: 'g', pinned: false, parentSessionId: 'p', detached: true, isArchived: false,
  })
  expect(rowOf({ sessionId: 'a', title: 't', group: null })?.group).toBeNull()
  expect(rowOf({ sessionId: 'a', title: 't' })?.group).toBeUndefined()
  expect(rowOf('Session x not found.')).toBeNull()
  expect(sectionOf([{ id: 'pinned', kind: 'pinned', name: '' }, { id: 'cg-1', kind: 'manual', name: SECTION }])).toBe('cg-1')
  expect(sectionOf([{ id: 'cg-2', kind: 'manual', name: 'Later' }])).toBeNull()
  expect(sectionOf({ id: 'cg-3', name: SECTION })).toBe('cg-3')
})

test('only the person and a relayed message unfile; app events do not', () => {
  expect(unfilesOn({ text: 'Approved, go', origin: { kind: 'composer' } })).toBe(true)
  expect(unfilesOn({ text: 'yes', origin: { kind: 'bridge' } })).toBe(true)
  expect(unfilesOn({ text: 'yes', origin: { kind: 'sdk' } })).toBe(true)
  expect(unfilesOn({ text: '<cross-session-message from="x">Alok approved #289</cross-session-message>', origin: { kind: 'sdk' } })).toBe(true)
  expect(unfilesOn({ text: 'Alok approved #289', origin: { kind: 'peer' } })).toBe(true)
  expect(unfilesOn({ text: '<side-sessions-event>done</side-sessions-event>', origin: { kind: 'sdk' } })).toBe(false)
  expect(unfilesOn({ text: '<ci-monitor-event>failed</ci-monitor-event>', origin: { kind: 'sdk' } })).toBe(false)
  expect(unfilesOn({ text: 'report', origin: { kind: 'task-notification' } })).toBe(false)
  expect(unfilesOn({ text: 'yes', isMeta: true, origin: { kind: 'composer' } })).toBe(false)
})

test('a failure to file is logged once, and never in a session with no sidebar', () => {
  const refused = 'Error: move_sessions: not allowed'
  const first = afterFilingFailure(refused, null)
  expect(first).toEqual({ lastLogged: refused, line: `needs-you: the sidebar was not updated (${refused})` })
  expect(afterFilingFailure(refused, first.lastLogged).line).toBeNull()
  expect(afterFilingFailure('HooksError: needs-you: $.mcp.call: no connected MCP tool "get_session"', null).line).toBeNull()
})

test('the band lists waiting sessions all the way down, through an archived one', () => {
  const rows = [
    { sessionId: 'middle', title: 'ask-gate', startedBy: 'top', isArchived: true },
    { sessionId: 'parent', title: 'RF-3', startedBy: 'middle' },
    { sessionId: 'self', title: '✋ Approve veda#259', startedBy: 'parent' },
    { sessionId: 'elsewhere', title: '✋ Not ours', startedBy: 'someone' },
    { sessionId: 'loop-a', title: '✋ a', startedBy: 'loop-b' },
    { sessionId: 'loop-b', title: '✋ b', startedBy: 'loop-a' },
  ]
  expect(waitingSessions(rows, 'top')).toEqual([{ sessionId: 'self', title: '✋ Approve veda#259' }])
  expect(waitingSessions(rows, 'parent')).toEqual([{ sessionId: 'self', title: '✋ Approve veda#259' }])
  expect(waitingSessions(rows, 'self')).toEqual([])
})

test('a nested session filed on its question moves its top session, and the answer puts it back', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  turns(on)
  const fake = app(on, 'self', family())
  const settle = async (done: () => boolean) => {
    for (let tick = 0; tick < 50 && !done(); tick += 1) await clock.settle()
  }

  // An interrupted turn files nothing.
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Approve #289?', actions: [{ label: 'Approved' }] })
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: true, turnId: 't0', reason: 'aborted' })
  await clock.settle()
  expect(fake.calls.filter(c => c.tool === 'move_sessions')).toEqual([])

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Approve #289?', actions: [{ label: 'Approved' }] })
  await $.turn.complete({ answer: 'Needs you: approve #289.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => fake.calls.some(c => c.tool === 'set_unread'))

  expect(fake.byId.get('self')?.title).toBe('✋ Approve veda#259')
  expect(fake.byId.get('top')?.group?.id).toBe('cg-needs')
  expect(fake.calls.filter(c => c.tool === 'move_sessions').map(c => c.args.session_ids)).toEqual([['top']])
  expect(fake.calls.filter(c => c.tool === 'set_unread').map(c => c.args)).toEqual([{ session_id: 'top', unread: true }])

  // The person answers from the band.
  const ui = await $.ui.mount(BAND)
  const button = await ui.find({ type: 'Button', text: /^Approved$/ })
  await ui.press({ key: String(button?.key) })
  await ui.unmount()
  await settle(() => fake.byId.get('top')?.group?.id === 'cg-work')

  expect(fake.byId.get('self')?.title).toBe('Approve veda#259')
  expect(fake.byId.get('top')?.group?.id).toBe('cg-work')
  expect(fake.byId.get('top')?.pinned).toBe(true)
})

test('a top session files itself as "self", and the section is made when missing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  turns(on)
  const fake = app(on, 'solo', [{ sessionId: 'solo', title: 'Release 0.8.0', group: null }], [])

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Tag v0.8.0?', actions: [{ label: 'Tag it' }] })
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  for (let tick = 0; tick < 50 && !fake.calls.some(c => c.tool === 'set_unread'); tick += 1) await clock.settle()

  expect(fake.calls.find(c => c.tool === 'create_section')?.args).toEqual({ name: SECTION })
  expect(fake.calls.find(c => c.tool === 'move_sessions')?.args).toEqual({ session_ids: ['self'], section_id: 'cg-0' })
  expect(fake.calls.find(c => c.tool === 'set_unread')?.args).toEqual({ session_id: 'self', unread: true })
  expect(fake.byId.get('solo')?.title).toBe('✋ Release 0.8.0')
})

test('the top session stays under Needs you while another filed session under it waits', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { [filedKey('sibling')]: { root: 'top' } })
  turns(on)
  const sessions = family()
  const sibling = sessions.find(s => s.sessionId === 'sibling')
  if (sibling !== undefined) sibling.title = '✋ Another side session'
  const fake = app(on, 'self', sessions)
  const settle = async (done: () => boolean) => {
    for (let tick = 0; tick < 50 && !done(); tick += 1) await clock.settle()
  }
  const askAndAnswer = async (turnId: string) => {
    const unreads = fake.calls.filter(c => c.tool === 'set_unread').length
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Approve #289?', actions: [{ label: 'Approved' }] })
    await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await settle(() => fake.calls.filter(c => c.tool === 'set_unread').length > unreads)
    const titles = fake.calls.filter(c => c.tool === 'set_session_title').length
    const ui = await $.ui.mount(BAND)
    const button = await ui.find({ type: 'Button', text: /^Approved$/ })
    await ui.press({ key: String(button?.key) })
    await ui.unmount()
    await settle(() => fake.calls.filter(c => c.tool === 'set_session_title').length > titles)
    for (let tick = 0; tick < 5; tick += 1) await clock.settle()
  }

  await askAndAnswer('t1')
  expect(fake.byId.get('self')?.title).toBe('Approve veda#259')
  expect(fake.byId.get('top')?.group?.id).toBe('cg-needs')

  // The sibling was archived without unfiling: its entry is stale and holds the row no longer.
  if (sibling !== undefined) sibling.isArchived = true
  await askAndAnswer('t2')
  expect(fake.byId.get('top')?.group?.id).toBe('cg-work')
})

test('a wrap-up with no question files nothing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  turns(on)
  const fake = app(on, 'self', family())

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Merged.' })
  await $.turn.complete({ answer: 'Merged.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  for (let tick = 0; tick < 5; tick += 1) await clock.settle()

  expect(fake.calls).toEqual([])
})

test('a call the app holds past its time is given up and logged once', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const { logged } = turns(on)
  on('mcp.call', () => new Promise(() => undefined))

  for (const turnId of ['t1', 't2']) {
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Approve #289?', actions: [{ label: 'Approved' }] })
    await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await clock.settle()
    await clock.advance(20_000)
    for (let tick = 0; tick < 5; tick += 1) await clock.settle()
  }

  expect(logged).toEqual(['needs-you: the sidebar was not updated (Error: get_session took over 20 s)'])
})
