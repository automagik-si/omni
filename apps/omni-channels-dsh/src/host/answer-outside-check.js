// #1742: a code in a refused sender's message is checked with an outside HTTPS service of the
// answer bot's staff, in host code only, and the service's reply is relayed to the person.
// Per bot, staff set on the omni-outside-check route (staff only): the service's URL, a secret
// that is written only, and a code pattern (code-pattern.js; no default, so the check is off
// until staff set one), plus three optional steps: the label staff see on a confirmed request
// row, a tier name written on that row, and texts the person gets when the service refuses with
// a 4xx status. A step with no value is skipped; nothing here has built-in wording.
//
// With URL, secret and pattern set, a message of a sender the answer intake refuses by default
// (`denied`) or knows only by their lid (`unmatched`), never one a rule of its own refuses and
// never an admitted one (omni-events.js calls this only on such a refusal, after the code lists
// had their turn and the refused path ran), whose text has a code of the pattern, is sent to the
// service as Omni's own event: one call per message, the raw text. The service matches the code
// itself; the pattern only decides whether to call.
//
// Only an HTTP 200 with a `reply` is an answer: the reply goes word for word to the person's chat
// (Omni's send for that chat, as the stranger reply goes), once per message id, and the chat's
// request row is marked `confirmed` (with the tier, when one is set). The person stays not let
// in. A 4xx with a refusal text set for its status sends that text, once per message id; anything
// else sends nothing. Whatever the outcome, the message stays on the refused path (noted, kept as
// #1706 keeps it) but never gets the stranger reply: it carried a code (answer-strangers.js asks
// outsideCodeIn).
//
// The event handler waits for the first attempt only. On a timeout, a network error or a 503 the
// message goes on at once, and the attempt is tried again twice in the background, after about
// 2 s and 10 s, with the same event id and message id; a 200 then still posts the reply once.
// After 3 such failures in a row no call is made for 5 minutes. At most OUTSIDE_CALLS_PER_MINUTE
// attempts a minute from this plugin, and a message's call shares the chat's limit with the code
// lists (answer-codes.js). Past any of these, nothing is called. The model never sees the code,
// the call, the secret or the reply; warnings name a status only.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CodePattern, codesIn } from './code-pattern.js'
import { sendInChat } from './answer-strangers.js'

export const OUTSIDE_CODES_PER_MESSAGE = 2
export const OUTSIDE_CALLS_PER_MINUTE = 30
export const OUTSIDE_TIMEOUT_MS = 10_000
export const OUTSIDE_RETRY_MS = Object.freeze([2_000, 10_000])
export const OUTSIDE_FAILURES_MAX = 3
export const OUTSIDE_PAUSE_MS = 5 * 60_000
export const OUTSIDE_BODY_MAX_BYTES = 32 * 1024
export const OUTSIDE_REPLY_MAX = 1000
export const OUTSIDE_REPLIED_MAX = 5_000
export const OUTSIDE_LABEL_MAX = 60
export const OUTSIDE_TIER_MAX = 60
export const OUTSIDE_TEXTS_MAX = 10
export const OUTSIDE_URL_REFUSAL = 'Use an https:// address for the outside check.'
export const OUTSIDE_SECRET_REFUSAL = 'Use printable characters for the secret, and no spaces.'
const FUTURE_MAX_MS = 2 * 60_000
const FROM_MAX = 256
const MINUTE_MS = 60_000
const ANSWER_MAX_CHARS = 16 * 1024
const PAUSED = 'the outside check failed 3 times in a row, so it is not called for 5 minutes'

// A short text staff type; empty is none.
const Words = max => z.string().max(max)
const Settings = z.object({
  botId: z.string().min(1),
  // Each: null or empty clears it, left out keeps it.
  url: z.string().max(2048).nullable().optional(),
  // Write-only: never read back.
  secret: z.string().max(1024).nullable().optional(),
  pattern: CodePattern.nullable().optional(),
  label: Words(OUTSIDE_LABEL_MAX).nullable().optional(),
  tier: Words(OUTSIDE_TIER_MAX).nullable().optional(),
  // The text the person gets when the service answers that 4xx status; an empty map clears them.
  refusalTexts: z.record(z.string().regex(/^4\d\d$/, 'a refusal text is for a 4xx status'), Words(OUTSIDE_REPLY_MAX))
    .refine(texts => Object.keys(texts).length <= OUTSIDE_TEXTS_MAX, `at most ${OUTSIDE_TEXTS_MAX} refusal texts`).nullable().optional(),
}).strict()
const Answer = z.object({ reply: z.string().max(OUTSIDE_REPLY_MAX).refine(reply => reply.trim() !== '') }).passthrough()
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const httpsOf = (value) => {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
const textOf = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
// A wait that a stop ends early.
const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

export function install(rt) {
  const checks = () => (rt.state.omniOutsideCheck ??= {})
  const replied = () => (rt.state.omniOutsideCheckReplied ??= [])
  const inFlight = new Set(), warned = new Set(), tasks = new Set()
  let calls = [], failures = 0, pausedUntil = 0, stop = new AbortController(), marking = Promise.resolve()

  // The bot's check when it is on: URL, secret and pattern all set.
  const checkOf = (botId) => {
    const check = rt.state.omniOutsideCheck?.[botId]
    return typeof check?.url === 'string' && typeof check.secret === 'string' && check.pattern ? check : undefined
  }
  /** What staff and the client read of a bot's setting: everything but the secret. */
  rt.outsideCheckSettingOf = (botId) => {
    const check = rt.state.omniOutsideCheck?.[botId]
    return {
      url: check?.url ?? null, secretSet: typeof check?.secret === 'string', pattern: check?.pattern ?? null,
      label: check?.label ?? null, tier: check?.tier ?? null, refusalTexts: check?.refusalTexts ?? {},
    }
  }
  const codesOf = (check, row) => codesIn(row?.textContent, check.pattern, OUTSIDE_CODES_PER_MESSAGE)
  /** True when bot `botId`'s check is on and the message's text has a code of its pattern: no stranger reply. */
  rt.outsideCodeIn = (row, botId) => {
    const check = checkOf(botId)
    return check !== undefined && codesOf(check, row).length > 0
  }

  // Every attempt counts: at most OUTSIDE_CALLS_PER_MINUTE in any minute, none while paused.
  const room = (now = Date.now()) => {
    calls = calls.filter(at => now - at < MINUTE_MS)
    return now >= pausedUntil && calls.length < OUTSIDE_CALLS_PER_MINUTE
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
  // the service's ends the run of failures.
  async function attempt(check, eventId, body, botId, signal) {
    let response
    try {
      response = await (rt.outsideCheckFetch ?? fetch)(check.url, {
        method: 'POST', redirect: 'manual', body, signal: AbortSignal.any([AbortSignal.timeout(OUTSIDE_TIMEOUT_MS), signal]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${check.secret}`, 'x-omni-event-id': eventId, 'x-omni-delivery-id': randomUUID() },
      })
    } catch (error) {
      // A stop is not the service's failure.
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
    worked(PAUSED, botId)
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
    if (failures >= OUTSIDE_FAILURES_MAX) {
      failures = 0
      pausedUntil = Date.now() + OUTSIDE_PAUSE_MS
      warn(PAUSED, botId, status)
    }
    return { status, again: true }
  }

  // The event as Omni publishes it, with the message's raw text; undefined when the row cannot
  // make one the service takes.
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
    return Buffer.byteLength(body) > OUTSIDE_BODY_MAX_BYTES ? undefined : body
  }

  // Marks the message id answered, the newest OUTSIDE_REPLIED_MAX kept: 'marked' once saved,
  // 'already' when it was marked before, 'failed' when the save failed. One mark at a time, so
  // a failed save takes back only its own id (and the ids the bound pushed out for it), never
  // a mark another reply made meanwhile.
  function mark(externalId) {
    const run = marking.then(async () => {
      if (replied().includes(externalId)) return 'already'
      const before = replied()
      const next = [...before, externalId].slice(-OUTSIDE_REPLIED_MAX)
      const evicted = before.filter(id => !next.includes(id))
      rt.state.omniOutsideCheckReplied = next
      try { await rt.save(); return 'marked' } catch {
        const now = replied().filter(id => id !== externalId)
        rt.state.omniOutsideCheckReplied = [...evicted.filter(id => !now.includes(id)), ...now]
        return 'failed'
      }
    })
    marking = run.catch(() => {})
    return run
  }

  // Posts `text` once per message id: marked and saved before the post. True when it went.
  async function post(row, botId, text) {
    const marked = await mark(row.externalId)
    if (marked === 'already') return false
    if (marked === 'failed') { warn('the outside check reply was not sent', botId, 'the reply mark was not saved'); return false }
    const why = await sendInChat(rt, row, botId, text)
    if (why !== undefined) { warn('the outside check reply was not sent', botId, why); return false }
    worked('the outside check reply was not sent', botId)
    return true
  }

  // What an attempt's outcome does: a reply is posted once per message id and the chat's request
  // row marked; a 4xx with a refusal text set posts that text the same way; a failure is warned.
  async function settle(row, botId, check, outcome) {
    if (outcome.reply === undefined) {
      const refusal = textOf(check.refusalTexts?.[outcome.status])
      if (refusal !== undefined) await post(row, botId, refusal)
      // 404 and 409 are the service's word on the code itself, not a failure.
      if (!['404', '409'].includes(outcome.status)) warn('the outside check did not confirm', botId, outcome.status)
      return
    }
    worked('the outside check did not confirm', botId)
    if (!await post(row, botId, outcome.reply)) return
    try { await rt.answerRequestConfirmed?.(row, botId, textOf(check.tier)) } catch {
      warn('a request row was not marked confirmed', botId, 'not saved')
    }
  }

  // The second and third attempts, in the background; a stop ends them.
  async function retry(check, row, body, botId, signal) {
    let outcome
    for (const ms of OUTSIDE_RETRY_MS) {
      await wait(ms, signal)
      if (signal.aborted || replied().includes(row.externalId) || !take()) return
      outcome = await attempt(check, row.id, body, botId, signal)
      if (signal.aborted) return
      if (!outcome.again) return settle(row, botId, check, outcome)
    }
    if (Date.now() >= pausedUntil) warn('the outside check did not confirm', botId, outcome.status)
  }

  // A message of a sender the intake refused by default or knows only by their lid, on bot
  // `botId`'s answer channel, after the refused path ran. Resolves once the first attempt is
  // settled; any retries go on in the background.
  rt.answerOutsideCheck = async (row, botId) => {
    const check = checkOf(botId)
    if (check === undefined || row?.eventType !== 'message.received' || !row.instanceId || !row.chatUuid || row.rawPayload?.isFromMe === true) return
    if (codesOf(check, row).length === 0) return
    const body = envelopeOf(row)
    if (body === undefined || replied().includes(row.externalId) || inFlight.has(row.externalId)) return
    if (!room() || !rt.takeAnswerChatCall?.(`${row.instanceId}:${row.chatUuid}`) || !take()) return
    const { signal } = stop
    inFlight.add(row.externalId)
    let later
    try {
      const outcome = await attempt(check, row.id, body, botId, signal)
      if (outcome.again && !signal.aborted) later = retry(check, row, body, botId, signal)
      else if (!signal.aborted) await settle(row, botId, check, outcome)
    } finally {
      if (later === undefined) inFlight.delete(row.externalId)
    }
    if (later === undefined) return
    const task = later.catch(error => rt.warn('omni-channels: an outside check retry failed for answer bot %s: %s', botId, error?.name ?? 'error'))
      .finally(() => { inFlight.delete(row.externalId); tasks.delete(task) })
    tasks.add(task)
  }
  // Stopping the events (omni-events.js): retries in the background end now; the next start
  // calls again.
  rt.stopAnswerOutsideCheck = () => {
    stop.abort()
    stop = new AbortController()
    return Promise.all(tasks)
  }

  // Staff only: the bot's check. Answers what any read gets: everything but the secret.
  rt.ctx.effect(() => rt.hooks.endpoint('omni-outside-check', async (body) => {
    const input = Settings.parse(body ?? {})
    await rt.load()
    if (rt.readOnly?.() !== undefined) throw refused(rt.readOnly())
    if (rt.botOf(input.botId)?.kind !== 'omni') throw refused('The outside check belongs to a channel bot.')
    const url = typeof input.url === 'string' ? input.url.trim() : input.url
    if (typeof url === 'string' && url !== '' && !httpsOf(url)) throw refused(OUTSIDE_URL_REFUSAL)
    if (typeof input.secret === 'string' && input.secret !== '' && !/^[\x21-\x7e]+$/.test(input.secret)) throw refused(OUTSIDE_SECRET_REFUSAL)
    const before = checks()[input.botId]
    // A field left out keeps what was there; null or empty clears it.
    const field = (key, value) => (value === undefined ? (before?.[key] === undefined ? {} : { [key]: before[key] }) : value ? { [key]: value } : {})
    const texts = input.refusalTexts === undefined ? undefined
      : Object.fromEntries(Object.entries(input.refusalTexts ?? {}).map(([status, text]) => [status, textOf(text)]).filter(([, text]) => text !== undefined))
    const next = {
      ...field('url', url), ...field('secret', input.secret), ...field('pattern', input.pattern),
      ...field('label', input.label === undefined ? undefined : textOf(input.label) ?? null),
      ...field('tier', input.tier === undefined ? undefined : textOf(input.tier) ?? null),
      ...field('refusalTexts', texts === undefined ? undefined : Object.keys(texts).length > 0 ? texts : null),
    }
    if (Object.keys(next).length === 0) delete checks()[input.botId]
    else checks()[input.botId] = next
    try { await rt.save() } catch (error) {
      if (before === undefined) delete checks()[input.botId]
      else checks()[input.botId] = before
      throw error
    }
    return rt.outsideCheckSettingOf(input.botId)
  }), 'omni-channels: omni-outside-check')
}
