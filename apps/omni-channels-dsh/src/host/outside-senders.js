// The Bot team's hard-step list (automagik bots-dsh, rt.stepHooks.sendsOutside, RFC 0031 D6 there):
// what Omni lets out with no card of its own and the call alone shows, an omni_call post into a
// group or channel and a presence update with text. Sends to a person and deletes already ask on
// Omni's own card at execute; automation event runs and chat threads keep Omni's rules. A team that
// does not pass the Session gets nothing flagged, as before.
import { isThreadSession } from './grants.js'
import { SENDS, postsToRoom } from './omni-api.js'

export function sendsOutside(rt, step = {}) {
  try {
    const { tool, args, sessionId } = step
    if (typeof sessionId !== 'string' || isThreadSession(rt, sessionId)) return false
    if (rt.chatOwners?.has(sessionId) !== true && (rt.state?.subscriptionRuns ?? []).some(run => run.sessionId === sessionId)) return false
    if (typeof tool !== 'string' || tool.replace(/^mcp__dsh__/, '') !== 'omni_call') return false

    const method = String(args?.method ?? 'GET').toUpperCase()
    const path = String(args?.path ?? '').trim().replace(/^\/api\/v2(?=\/)/, '')
    let body = args?.body
    if (typeof body === 'string') {
      // A malformed send body cannot tell us who would receive the message.
      try { body = JSON.parse(body) } catch { return method === 'POST' && SENDS.test(path) }
    }
    return postsToRoom(method, path, body)
  } catch {
    return false
  }
}

export function install(rt) {
  if (typeof rt.stepHooks?.sendsOutside === 'function') {
    rt.ctx.effect(() => rt.stepHooks.sendsOutside(step => sendsOutside(rt, step)), 'omni-channels: outside senders')
  }
}
