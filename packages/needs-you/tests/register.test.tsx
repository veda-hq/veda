import { expect, mock, test } from 'claude-code/testing'

import { NOT_SHOWN, afterFailure, age, isAskless, jsonOf, replies, waitingSessions } from '../hooks/register'

const BAND = {
  plugin: 'needs-you',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const SELF = 'local_self'

/** Answers the app's session tools the way the desktop app does. */
const sessions = (rows: unknown[]) => (_: unknown, e: { server: string; tool: string }) => {
  if (e.tool === 'get_session') return { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: SELF }) }], isError: false } }
  if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text', text: JSON.stringify(rows) }], isError: false } }
  return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
}

test('ages read as minutes, hours and days', () => {
  expect(age(0)).toBe('1 min')
  expect(age(5 * 60_000)).toBe('5 min')
  expect(age(3 * 3_600_000)).toBe('3 h')
  expect(age(26 * 3_600_000)).toBe('1 d')
})

test('only reply buttons become answers, not app actions', () => {
  expect(replies([{ label: 'Archive' }, { label: 'Keep' }, { action: 'commit', label: 'Commit' }])).toEqual(['Archive', 'Keep'])
  expect(replies(undefined)).toEqual([])
})

test('a side session waits when this chat started it and it is filed with ✋', () => {
  const rows = [
    { sessionId: 'a', title: '✋ Add the label', startedBy: SELF },
    { sessionId: 'b', title: 'Working away', startedBy: SELF },
    { sessionId: 'c', title: '✋ Someone else', startedBy: 'other' },
    { sessionId: 'd', title: '✋ Archived', startedBy: SELF, isArchived: true },
  ]
  expect(waitingSessions(rows, SELF)).toEqual([{ sessionId: 'a', title: '✋ Add the label' }])
  expect(waitingSessions('not a list', SELF)).toEqual([])
})

test('a question at the end of a turn shows with its reply buttons, on desktop and terminal', async ($, on) => {
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('mcp.call', sessions([]))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'The mock is published.',
    ask: 'Which placement should I build?',
    actions: [{ label: 'Build A' }, { label: 'Build B' }],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /NEEDS YOU IN THIS CHAT · 1/ }))?.text).toContain('· 1')
    expect((await ui.find({ type: 'Text', text: /Which placement/ }))?.text).toContain('Which placement should I build?')
    expect(await ui.find({ type: 'Button', text: /Build A/ })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing a reply sends it and clears the line', async ($, on) => {
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('mcp.call', sessions([]))
  on('tool.call', () => ({ result: {} }))
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Archive S-4?', actions: [{ label: 'Archive' }, { label: 'Keep' }] })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const button = await ui.find({ type: 'Button', text: /^Archive$/ })
  expect(button).toBeDefined()
  await ui.press({ key: String(button?.key) })
  expect(sent).toEqual(['Archive'])
  expect(await ui.find({ type: 'Text', text: /Archive S-4/ })).toBeUndefined()
  await ui.unmount()
})

test('a wrap-up is askless only when blocked with no question', () => {
  expect(isAskless({ blocked: true })).toBe(true)
  expect(isAskless({ blocked: true, ask: '' })).toBe(true)
  expect(isAskless({ blocked: true, ask: '   ' })).toBe(true)
  expect(isAskless({ blocked: true, ask: 42 })).toBe(true)
  expect(isAskless({ blocked: true, ask: 'Approve W-47?' })).toBe(false)
  expect(isAskless({ ask: 'Approve W-47?' })).toBe(false)
  expect(isAskless({ blocked: false })).toBe(false)
  expect(isAskless({ recap: 'Done.' })).toBe(false)
})

test('a blocked wrap-up with no question is refused before it runs, and the band stays empty', async ($, on) => {
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('mcp.call', sessions([]))
  const ran: unknown[] = []
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  for (const ask of [undefined, '', '  ']) {
    const refused = await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Waiting on the token.', blocked: true, ask })
    expect(refused.deny).toContain('needs-you: this turn waits on the person (blocked: true), but the wrap-up has no ask')
    expect(refused.deny).toContain('Call wrap_up again, keeping blocked: true, with ask')
  }
  expect(ran).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('a blocked wrap-up with its question runs and shows in the band; one with neither runs and shows nothing', async ($, on) => {
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('mcp.call', sessions([]))
  const ran: unknown[] = []
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const plain = await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Merged.' })
  expect(plain.deny).toBeUndefined()
  const empty = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await empty.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await empty.unmount()

  const asked = await $.tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'Waiting on the token.',
    blocked: true,
    ask: '  Token saved as NPM_TOKEN?  ',
    actions: [{ label: 'Done' }, { label: 'Not yet' }],
  })
  expect(asked.deny).toBeUndefined()
  expect(ran).toEqual(['mcp__ccd_turn__wrap_up', 'mcp__ccd_turn__wrap_up'])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Token saved/ }))?.text).toBe('● Token saved as NPM_TOKEN?')
  expect(await ui.find({ type: 'Button', text: /^Done$/ })).toBeDefined()
  await ui.unmount()
})

test('a side session filed with ✋ shows with an Open session button', async ($, on) => {
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  const opened: unknown[] = []
  on('mcp.call', (_, e) => {
    if (e.tool === 'open_session_in') opened.push(e.args)
    return sessions([
      { sessionId: 'local_side', title: '✋ Add the approved label to #42', startedBy: SELF },
      { sessionId: 'local_page', title: '✋ Approve the plan https://claude.ai/artifact/plan-1', startedBy: SELF },
    ])(_, e)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The first read of the session list runs beside the start; the band redraws when it lands.
  let row = await ui.find({ type: 'Text', text: /approved label/ })
  for (let tick = 0; tick < 20 && row === undefined; tick += 1) row = await ui.find({ type: 'Text', text: /approved label/ })
  expect(row?.text).toContain('Add the approved label to #42')
  const link = await ui.find({ type: 'Link', text: /page/ })
  expect(link?.props.href).toBe('https://claude.ai/artifact/plan-1')
  const buttons = await ui.findAll({ type: 'Button', text: /^Open session$/ })
  expect(buttons.map(button => button.key)).toEqual(['open:local_side', 'open:local_page'])
  await ui.press({ key: String(buttons[0]?.key) })
  expect(opened).toEqual([{ session_id: 'local_side', target: 'split' }])
  await ui.unmount()
})

/** An MCP answer of one text block. */
const answer = (text: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text }], isError } })

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('an answer is JSON only when it is not an error and parses', () => {
  expect(jsonOf(answer('[{"sessionId":"a"}]').value)).toEqual([{ sessionId: 'a' }])
  expect(jsonOf(answer('No session matches "self".').value)).toBeUndefined()
  expect(jsonOf(answer('Session local_x not found.', true).value)).toBeUndefined()
  expect(jsonOf(answer('{"sessionId":"a"}', true).value)).toBeUndefined()
})

test('a plain-text or error answer reads as no session and logs nothing', async ($, on) => {
  const clock = mock.clock(on)
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  const reads: string[] = []
  on('mcp.call', (_, e) => {
    reads.push(e.tool)
    if (e.tool === 'get_session' && reads.length === 1) return answer('No session matches "self".')
    if (e.tool === 'get_session' && reads.length === 2) return answer('Session self not found.', true)
    if (e.tool === 'get_session') return answer(JSON.stringify({ sessionId: SELF }))
    return reads.length === 4 ? answer('No sessions found.') : answer('Not available right now.', true)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start(START)
  await clock.settle()
  for (let poll = 0; poll < 3; poll += 1) await clock.advance(60_000)
  expect(reads).toEqual(['get_session', 'get_session', 'get_session', 'list_sessions', 'list_sessions'])
  expect(logged).toEqual([])
})

test('without the app session tools, reading stops after one line', () => {
  const missing = 'HooksError: needs-you: $.mcp.call: no connected MCP tool "get_session" on a server named "ccd_session_mgmt"'
  expect(afterFailure(missing, null)).toEqual({ reading: false, lastLogged: missing, line: NOT_SHOWN })
})

test('a repeated failure logs nothing; a different one logs its line', () => {
  const error = 'SyntaxError: JSON Parse error: Unexpected identifier "No"'
  const first = afterFailure(error, null)
  expect(first).toEqual({ reading: true, lastLogged: error, line: `needs-you: side sessions not read (${error})` })
  expect(afterFailure(error, first.lastLogged)).toEqual({ reading: true, lastLogged: error, line: null })
  expect(afterFailure('Error: timed out', first.lastLogged).line).toBe('needs-you: side sessions not read (Error: timed out)')
})

test('a failing read logs once in a session, and again only after a read has succeeded', async ($, on) => {
  const clock = mock.clock(on)
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  // While failing, nothing beneath answers the call, so it rejects as a dropped server's would.
  let failing = true
  let reads = 0
  on('mcp.call', async (_, e, next) => {
    reads += 1
    if (failing) return next(e)
    return sessions([])(_, e)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start(START)
  await clock.settle()
  for (let poll = 0; poll < 5; poll += 1) await clock.advance(60_000)
  expect(reads).toBe(6)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain('needs-you: side sessions not read (')

  failing = false
  await clock.advance(60_000)
  failing = true
  for (let poll = 0; poll < 3; poll += 1) await clock.advance(60_000)
  expect(logged).toHaveLength(2)
  expect(logged[1]).toBe(logged[0])
})

test('with nothing waiting the band is the engine’s', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
