/** One thing this chat waits on from the person. */
export type Ask = {
  /** The tool_use id of the question, or the side session's id. */
  id: string
  /** `chat`: this chat asked; `dialog`: an open question dialog; `session`: a side session it started. */
  from: 'chat' | 'dialog' | 'session'
  /** What it needs, one line. */
  text: string
  /** The page the ask links (a claude.ai artifact), when it has one. */
  page: string | null
  /** Reply buttons: pressing one sends its label as the person's reply. */
  answers: string[]
  /** Milliseconds since the epoch when it was first seen. */
  since: number
  /** The side session's id, for `session` asks. */
  sessionId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'needs-you': { asks: Ask[]; isHidden: boolean; isExpanded: boolean }
  }
}
