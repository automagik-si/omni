// #1731: a waitlist confirmation code in a refused sender's message is confirmed with a site, in
// host code only. The answer bot names the site's URL and a secret (omni-waitlist-confirm, staff
// only); with both set, a message of a sender the answer intake refuses by default (`denied`) or
// knows only by their lid (`unmatched`), never one a rule of its own refuses and never an admitted
// one (omni-events.js calls this only on such a refusal, after an invite code had its turn and the
// refused path ran), whose text has a code of the waitlist shape, is sent to the site as Omni's
// own event: one call per message, the raw text. The site matches the code itself; the shape
// below only decides whether to call.
//
// Only an HTTP 200 with a `reply` is an answer: the reply goes word for word to the person's chat
// (Omni's send for that chat, as the stranger reply goes), once per message id, and the chat's
// request row is marked `waitlist`. The person stays not let in. Anything else sends nothing.
// Whatever the outcome, the message stays on the refused path (noted, kept as #1706 keeps it)
// but never gets the stranger reply: it carried a code (answer-strangers.js asks waitlistCodeIn).
//
// The event handler waits for the first attempt only. On a timeout, a network error or a 503 the
// message goes on at once, and the attempt is tried again twice in the background, after about
// 2 s and 10 s, with the same event id and message id; a 200 then still posts the reply once.
// After 3 such failures in a row no call is made for 5 minutes. At most
// WAITLIST_CALLS_PER_MINUTE attempts a minute from this plugin, and a message's call shares the
// chat's limit with the invite redeem (answer-invites.js). Past any of these, nothing is called.
// The model never sees the code, the call, the secret or the reply; warnings name a status only.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendInChat } from './answer-strangers.js'

export const WAITLIST_CODES_PER_MESSAGE = 2
export const WAITLIST_CALLS_PER_MINUTE = 30
export const WAITLIST_TIMEOUT_MS = 10_000
export const WAITLIST_RETRY_MS = Object.freeze([2_000, 10_000])
export const WAITLIST_FAILURES_MAX = 3
export const WAITLIST_PAUSE_MS = 5 * 60_000
export const WAITLIST_BODY_MAX_BYTES = 32 * 1024
export const WAITLIST_REPLY_MAX = 1000
export const WAITLIST_REPLIED_MAX = 5_000
export const WAITLIST_URL_REFUSAL = 'The waitlist URL must be an https address.'
export const WAITLIST_SECRET_REFUSAL = 'The secret must be letters, digits and symbols, with no spaces.'
const FUTURE_MAX_MS = 2 * 60_000
const FROM_MAX = 256
const MINUTE_MS = 60_000
const ANSWER_MAX_CHARS = 16 * 1024

// `AMG-` and 6 characters; in the tail only O is read as 0 and I and L as 1, then it must be
// Crockford base32 (0-9 and A-Z but I, L, O, U).
const LOOSE = /\bAMG-[0-9A-Z]{6}\b/g
const STRICT = /^[0-9A-HJKMNP-TV-Z]{6}$/
const tailOf = tail => tail.replace(/O/g, '0').replace(/[IL]/g, '1')

/** The waitlist codes a message's text carries, normalised, in their order, at most WAITLIST_CODES_PER_MESSAGE. */
export function waitlistCodesIn(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  for (const [loose] of text.toUpperCase().matchAll(LOOSE)) {
    const tail = tailOf(loose.slice(4))
    const code = `AMG-${tail}`
    if (STRICT.test(tail) && !found.includes(code)) found.push(code)
    if (found.length === WAITLIST_CODES_PER_MESSAGE) break
  }
  return found
}

const Settings = z.object({
  botId: z.string().min(1),
  // null or empty clears it, left out keeps it.
  url: z.string().max(2048).nullable().optional(),
  // Write-only: never read back. null clears it, left out keeps it.
  secret: z.string().max(1024).nullable().optional(),
}).strict()
const Answer = z.object({ reply: z.string().max(WAITLIST_REPLY_MAX).refine(reply => reply.trim() !== '') }).passthrough()
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const httpsOf = (value) => {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
// A wait that a stop ends early.
const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

export function install(rt) {
  const sites = () => (rt.state.omniWaitlistConfirm ??= {})
  const replied = () => (rt.state.omniWaitlistReplied ??= [])
  const inFlight = new Set(), warned = new Set(), tasks = new Set()
  let calls = [], failures = 0, pausedUntil = 0, stop = new AbortController(), marking = Promise.resolve()

  const siteOf = (botId) => {
    const site = rt.state.omniWaitlistConfirm?.[botId]
    return typeof site?.url === 'string' && typeof site.secret === 'string' ? site : undefined
  }
  /** What staff and the client read of a bot's setting: never the secret. */
  rt.waitlistSettingOf = (botId) => {
    const site = rt.state.omniWaitlistConfirm?.[botId]
    return { url: site?.url ?? null, secretSet: typeof site?.secret === 'string' }
  }
  /** True when bot `botId`'s site is on and the message's text has a waitlist code: no stranger reply. */
  rt.waitlistCodeIn = (row, botId) => siteOf(botId) !== undefined && waitlistCodesIn(row?.textContent).length > 0

  // Every attempt counts: at most WAITLIST_CALLS_PER_MINUTE in any minute, none while paused.
  const room = (now = Date.now()) => {
    calls = calls.filter(at => now - at < MINUTE_MS)
    return now >= pausedUntil && calls.length < WAITLIST_CALLS_PER_MINUTE
  }
  const take = (now = Date.now()) => {
    if (!room(now)) return false
    calls.push(now)
    return true
  }

  // Once per bot and kind until it works there again; a status or a fixed word only.
  function warn(kind, botId, status) {
    const key = `${kind}:${botId}`
    if (warned.has(key)) return
    warned.add(key)
    rt.warn(`omni-channels: ${kind} for answer bot %s: %s`, botId, status)
  }
  const worked = (kind, botId) => warned.delete(`${kind}:${botId}`)

  // One attempt: `{ reply }` on a 200 with one, else `{ status, again }`, the status or a word
  // naming what went wrong, and whether it is tried again (a timeout, a network error, a 503).
  // Those count toward the pause, a 200 whose body fails to arrive too; any complete answer of
  // the site's ends the run of failures.
  async function attempt(site, eventId, body, botId, signal) {
    let response
    try {
      response = await (rt.waitlistFetch ?? fetch)(site.url, {
        method: 'POST', redirect: 'manual', body, signal: AbortSignal.any([AbortSignal.timeout(WAITLIST_TIMEOUT_MS), signal]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${site.secret}`, 'x-omni-event-id': eventId, 'x-omni-delivery-id': randomUUID() },
      })
    } catch (error) {
      // A stop is not the site's failure.
      if (signal.aborted) return { status: 'stopped', again: false }
      return failed(botId, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'a timeout' : 'no answer')
    }
    if (response.status === 503) {
      await response.body?.cancel?.().catch(() => {})
      return failed(botId, '503')
    }
    let text
    if (response.status === 200) {
      // A body that times out or breaks on the way is the network's failure, not a bad reply.
      try { text = await response.text() } catch (error) {
        if (signal.aborted) return { status: 'stopped', again: false }
        return failed(botId, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'a timeout' : 'no answer')
      }
    }
    failures = 0
    worked('the waitlist site failed 3 times in a row, so it is not called for 5 minutes', botId)
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {})
      return { status: String(response.status), again: false }
    }
    // Read in full but not an answer: a bad reply, not tried again.
    let parsed
    try { parsed = text.length > ANSWER_MAX_CHARS ? undefined : Answer.safeParse(JSON.parse(text)) } catch { parsed = undefined }
    return parsed?.success ? { reply: parsed.data.reply } : { status: 'a bad reply', again: false }
  }
  function failed(botId, status) {
    failures += 1
    if (failures >= WAITLIST_FAILURES_MAX) {
      failures = 0
      pausedUntil = Date.now() + WAITLIST_PAUSE_MS
      warn('the waitlist site failed 3 times in a row, so it is not called for 5 minutes', botId, status)
    }
    return { status, again: true }
  }

  // The event as Omni publishes it, with the message's raw text; undefined when the row cannot
  // make one the site takes.
  function envelopeOf(row) {
    const externalId = row.externalId
    const from = row.metadata?.from
    const at = Date.parse(row.receivedAt ?? '')
    if (typeof externalId !== 'string' || externalId === '' || typeof from !== 'string' || from === '' || from.length > FROM_MAX) return undefined
    if (typeof row.chatId !== 'string' || row.chatId === '' || !Number.isFinite(at) || at - Date.now() > FUTURE_MAX_MS) return undefined
    const senderName = typeof row.rawPayload?.pushName === 'string' && row.rawPayload.pushName !== '' ? row.rawPayload.pushName : undefined
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
    const body = JSON.stringify({
      id: row.id, type: 'message.received', timestamp: at, metadata,
      payload: { externalId, chatId: row.chatId, from, ...(senderName === undefined ? {} : { senderName }), content: { text: row.textContent } },
    })
    return Buffer.byteLength(body) > WAITLIST_BODY_MAX_BYTES ? undefined : body
  }

  // Marks the message id answered, the newest WAITLIST_REPLIED_MAX kept: 'marked' once saved,
  // 'already' when it was marked before, 'failed' when the save failed. One mark at a time, so
  // a failed save takes back only its own id (and the ids the bound pushed out for it), never
  // a mark another reply made meanwhile.
  function mark(externalId) {
    const run = marking.then(async () => {
      if (replied().includes(externalId)) return 'already'
      const before = replied()
      const next = [...before, externalId].slice(-WAITLIST_REPLIED_MAX)
      const evicted = before.filter(id => !next.includes(id))
      rt.state.omniWaitlistReplied = next
      try { await rt.save(); return 'marked' } catch {
        const now = replied().filter(id => id !== externalId)
        rt.state.omniWaitlistReplied = [...evicted.filter(id => !now.includes(id)), ...now]
        return 'failed'
      }
    })
    marking = run.catch(() => {})
    return run
  }

  // What an attempt's outcome does: a reply is posted once per message id (marked and saved
  // before the post), and the chat's request row marked; a failure is warned.
  async function settle(row, botId, outcome) {
    if (outcome.reply === undefined) {
      // 404 and 409 are the site's word on the code itself, not a failure.
      if (!['404', '409'].includes(outcome.status)) warn('the waitlist site did not confirm', botId, outcome.status)
      return
    }
    worked('the waitlist site did not confirm', botId)
    const marked = await mark(row.externalId)
    if (marked === 'already') return
    if (marked === 'failed') return warn('the waitlist reply was not sent', botId, 'its mark was not saved')
    const why = await sendInChat(rt, row, botId, outcome.reply)
    if (why !== undefined) return warn('the waitlist reply was not sent', botId, why)
    worked('the waitlist reply was not sent', botId)
    try { await rt.answerRequestWaitlisted?.(row, botId) } catch {
      warn('a request row was not marked waitlist confirmed', botId, 'not saved')
    }
  }

  // The second and third attempts, in the background; a stop ends them.
  async function retry(site, row, body, botId, signal) {
    let outcome
    for (const ms of WAITLIST_RETRY_MS) {
      await wait(ms, signal)
      if (signal.aborted || replied().includes(row.externalId) || !take()) return
      outcome = await attempt(site, row.id, body, botId, signal)
      if (signal.aborted) return
      if (!outcome.again) return settle(row, botId, outcome)
    }
    if (Date.now() >= pausedUntil) warn('the waitlist site did not confirm', botId, outcome.status)
  }

  // A message of a sender the intake refused by default or knows only by their lid, on bot
  // `botId`'s answer channel, after the refused path ran. Resolves once the first attempt is
  // settled; any retries go on in the background.
  rt.answerWaitlist = async (row, botId) => {
    const site = siteOf(botId)
    if (site === undefined || row?.eventType !== 'message.received' || !row.instanceId || !row.chatUuid || row.rawPayload?.isFromMe === true) return
    if (waitlistCodesIn(row.textContent).length === 0) return
    const body = envelopeOf(row)
    if (body === undefined || replied().includes(row.externalId) || inFlight.has(row.externalId)) return
    if (!room() || !rt.takeAnswerChatCall?.(`${row.instanceId}:${row.chatUuid}`) || !take()) return
    const { signal } = stop
    inFlight.add(row.externalId)
    let later
    try {
      const outcome = await attempt(site, row.id, body, botId, signal)
      if (outcome.again && !signal.aborted) later = retry(site, row, body, botId, signal)
      else if (!signal.aborted) await settle(row, botId, outcome)
    } finally {
      if (later === undefined) inFlight.delete(row.externalId)
    }
    if (later === undefined) return
    const task = later.catch(error => rt.warn('omni-channels: a waitlist retry failed for answer bot %s: %s', botId, error?.name ?? 'error'))
      .finally(() => { inFlight.delete(row.externalId); tasks.delete(task) })
    tasks.add(task)
  }
  // Stopping the events (omni-events.js): retries in the background end now; the next start
  // calls again.
  rt.stopAnswerWaitlist = () => {
    stop.abort()
    stop = new AbortController()
    return Promise.all(tasks)
  }

  // Staff only: the site and its secret. Answers what any read gets: the URL and whether a
  // secret is set, never the secret.
  rt.ctx.effect(() => rt.hooks.endpoint('omni-waitlist-confirm', async (body) => {
    const input = Settings.parse(body ?? {})
    await rt.load()
    if (rt.readOnly?.() !== undefined) throw refused(rt.readOnly())
    if (rt.botOf(input.botId)?.kind !== 'omni') throw refused('Waitlist confirmation belongs to a channel bot.')
    const url = typeof input.url === 'string' ? input.url.trim() : input.url
    if (typeof url === 'string' && url !== '' && !httpsOf(url)) throw refused(WAITLIST_URL_REFUSAL)
    if (typeof input.secret === 'string' && input.secret !== '' && !/^[\x21-\x7e]+$/.test(input.secret)) throw refused(WAITLIST_SECRET_REFUSAL)
    const before = sites()[input.botId]
    const next = {
      ...(url === undefined ? (before?.url ? { url: before.url } : {}) : url ? { url } : {}),
      ...(input.secret === undefined ? (before?.secret ? { secret: before.secret } : {}) : input.secret ? { secret: input.secret } : {}),
    }
    if (Object.keys(next).length === 0) delete sites()[input.botId]
    else sites()[input.botId] = next
    try { await rt.save() } catch (error) {
      if (before === undefined) delete sites()[input.botId]
      else sites()[input.botId] = before
      throw error
    }
    return rt.waitlistSettingOf(input.botId)
  }), 'omni-channels: omni-waitlist-confirm')
}
