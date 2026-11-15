// #1731: a waitlist code in a refused sender's message is confirmed with the bot's site, in host
// code: Omni's event envelope with the raw text, a 200's reply posted once, nothing else sent, and
// the message on the refused path with no stranger reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WAITLIST_CALLS_PER_MINUTE, WAITLIST_REPLIED_MAX, WAITLIST_SECRET_REFUSAL, WAITLIST_URL_REFUSAL, waitlistCodesIn,
} from '../src/host/answer-waitlist.js'
import { install } from '../src/host/omni-events.js'
import { ANSWER_CHAT_TOOLS } from '../src/host/threads.js'
import { ANSWER_CLOCK, ANSWER_MASTER, answerBench, CHAT, CHATS, INSTANCE, saved, signal, until, use } from './thread-fixture.js'

const MIN = 60_000
const HOUR = 60 * MIN
// Made-up ids, codes, URL and secret: a phone an allow rule names, a phone no rule names, a lid.
const PHONE = '5500000000001'
const STRANGER = '5500000000042'
const LID = '100000000000042'
const CODE = 'AMG-7K2QX9'
const SITE = 'https://example.test/waitlist/confirm'
const SECRET = 'test-secret-0001'
const SITE_REPLY = 'Thanks! Your place on the waitlist is confirmed. We will write to you here when it is your turn.'
const STRANGER_REPLY = 'Hello! This line answers invited people. Ask for an invite at the link on our page.'
const INVITE = 'INV-7K2QX9MD0'
const reply = data => ({ ok: true, json: async () => ({ data }) })
const now = () => Math.floor(Date.now() / 1000)
const eventId = seq => `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
// A person whose phone Omni knows, and whom no allow rule names; received now.
const stranger = (seq, text, from = STRANGER) => ({
  id: eventId(seq), journalSeq: seq, externalId: `WA-stranger-${seq}`, eventType: 'message.received',
  direction: 'inbound', instanceId: INSTANCE, chatUuid: CHAT, chatId: `${from}@s.whatsapp.net`, receivedAt: new Date(Date.now()).toISOString(),
  metadata: { correlationId: `corr-${seq}`, from }, textContent: text, contentType: 'text',
  rawPayload: { upsertType: 'notify', pushName: 'Ana Test', messageTimestamp: now(), key: { id: `WA-stranger-${seq}`, remoteJid: `${from}@s.whatsapp.net`, fromMe: false } },
})
// A person writing for the first time, known only by their lid.
const lidOnly = (seq, text) => ({
  ...stranger(seq, text, LID), externalId: `WA-lid-${seq}`, chatId: `${LID}@lid`,
  rawPayload: { upsertType: 'notify', addressingMode: 'lid', messageTimestamp: now(), key: { id: `WA-lid-${seq}`, remoteJid: `${LID}@lid`, fromMe: false } },
})

// Omni as the answer bench needs it (answer-invites.test.js), with the chat's address.
function omniOf({ externalId = `${STRANGER}@s.whatsapp.net` } = {}) {
  return { externalId, rules: [], deny: {}, posts: [], sends: [], acks: [], chatReads: 0, sendStatus: 201 }
}
async function attach(t, run, omni) {
  await run.channels.quiesceOmniEvents()
  const request = run.channels.omniRequest
  let queue = [], wake, closed = false
  run.warned = []
  run.channels.warn = (...args) => { run.warned.push(args) }
  run.channels.omniRequest = async (method, path, args) => {
    if (path === `/instances/${INSTANCE}`) return reply({ channel: 'whatsapp-baileys', inboundMaxAgeMinutes: 10 })
    if (path === `/chats/${CHAT}` && method === 'GET') { omni.chatReads += 1; return reply({ ...CHATS[CHAT], externalId: omni.externalId, canonicalId: null }) }
    if (path === '/access/check') {
      const id = args.body.platformUserId
      const action = omni.deny[id]
      if (action) return reply({ allowed: false, rule: { id: `deny-${action}`, ruleType: 'deny', action, instanceId: INSTANCE } })
      const rule = omni.rules.find(rule => rule.platformUserId === id)
      if (rule) return reply({ allowed: true, rule })
      return reply({ allowed: id === PHONE })
    }
    if (path === '/access/rules' && method === 'POST') {
      omni.posts.push(args.body)
      const rule = { id: `rule-${omni.rules.length + 1}`, phonePattern: null, personId: null, enabled: true, priority: 0, ...args.body }
      omni.rules.push(rule)
      return { ok: true, status: 201, json: async () => ({ data: rule }) }
    }
    if (path === `/access/rules?instanceId=${INSTANCE}&type=allow`) return { ok: true, json: async () => ({ items: [{ ruleType: 'allow', phonePattern: `+${PHONE}`, enabled: true }, ...omni.rules] }) }
    if (path === '/messages/send' && method === 'POST') {
      omni.sends.push(args.body)
      return { ok: omni.sendStatus < 300, status: omni.sendStatus, json: async () => ({ data: { messageId: 'sent-1' } }) }
    }
    if (path === '/automations?enabled=true') return { ok: true, json: async () => ({ items: [] }) }
    if (path === '/events/consumers' || method === 'DELETE' && path.startsWith('/events/consumers/')) return { ok: true }
    if (path.endsWith('/ack')) { omni.acks.push(args.body.cursor); return { ok: true } }
    if (path.endsWith('/stream')) {
      args.signal.addEventListener('abort', () => { closed = true; wake?.() }, { once: true })
      return { ok: true, body: (async function* () {
        while (!closed) {
          if (!queue.length) await new Promise(resolve => { wake = resolve })
          for (const row of queue.splice(0)) yield Buffer.from(`id: ${row.journalSeq}\ndata: ${JSON.stringify(row)}\n\n`)
        }
      })() }
    }
    return request(method, path, args)
  }
  install(run.channels)
  await run.channels.syncOmniEvents()
  t.after(() => run.channels.quiesceOmniEvents())
  let acked = 0
  run.deliver = async (row) => { const before = acked; queue.push(row); wake?.(); await until(() => omni.acks.length > before); acked = omni.acks.length }
  return Object.assign(run, { omniState: omni })
}
// The site: each call takes the next answer (the last one repeats). An answer is a status, a
// status with a body, 'timeout' or 'network' (before any answer), or 'body-timeout' or
// 'body-network' (a 200 whose body then fails to arrive).
function siteFor(b, answers) {
  const site = { calls: [], answers: [...answers] }
  b.channels.waitlistFetch = async (url, init) => {
    site.calls.push({ url, init, body: JSON.parse(init.body) })
    const next = site.answers.length > 1 ? site.answers.shift() : site.answers[0]
    if (next === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    if (next === 'network') throw new TypeError('fetch failed')
    if (next === 'body-timeout' || next === 'body-network') {
      const failure = next === 'body-timeout' ? Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) : new TypeError('terminated')
      return { status: 200, text: async () => { throw failure }, body: { cancel: async () => {} } }
    }
    const { status, body } = typeof next === 'number' ? { status: next, body: {} } : next
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), body: { cancel: async () => {} } }
  }
  return site
}
const OK = { status: 200, body: { reply: SITE_REPLY } }
// The bench with the site set; `settings` change the answer settings first.
async function bench(t, { settings = {}, omni: options, site = [OK], set = true } = {}) {
  const run = await answerBench(t, { clock: ANSWER_CLOCK })
  if (Object.keys(settings).length > 0) await run.call('omni-answer-settings', { ...run.settings, ...settings })
  const b = await attach(t, run, omniOf(options))
  if (set) await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: SITE, secret: SECRET })
  return Object.assign(b, { site: siteFor(b, site) })
}
const kept = b => Object.values(b.team.state.omniAnswerKept ?? {})
const requests = b => Object.values(b.team.state.omniAnswerRequests?.[ANSWER_MASTER] ?? {})
const runs = b => b.team.state.subscriptionRuns?.length ?? 0
const replyTo = to => ({ instanceId: INSTANCE, to, text: SITE_REPLY })
// Moves the clock to the next kept re-check and waits for it to finish (answer-strangers.test.js).
async function recheck(t, b, ms) {
  const reads = b.omniState.chatReads
  t.mock.timers.tick(ms)
  await until(() => b.omniState.chatReads > reads)
  await until(() => !kept(b).some(entry => entry.nextAt <= Date.now()))
}
const noSecretIn = (label, value) => assert.equal(JSON.stringify(value).includes(SECRET), false, `${label} names the secret`)
const noCodeIn = (label, value) => assert.equal(JSON.stringify(value).toUpperCase().includes('AMG-'), false, `${label} names a code`)

test('waitlist pre-filter: AMG- and 6 Crockford characters, O read as 0 and I/L as 1 in the tail only, at most 2', () => {
  assert.deepEqual(waitlistCodesIn('my code is amg-7k2qx9, thanks'), [CODE])
  assert.deepEqual(waitlistCodesIn('(AMG-O1LIQ9).'), ['AMG-0111Q9'])
  // Never the prefix, a U stays a U (no code has one), and other lengths or prefixes never match.
  assert.deepEqual(waitlistCodesIn('AMC-7K2QX9 ANG-7K2QX9 AMG-7K2QXU AMG-UUUUUU AMG-7K2QX AMG-7K2QX9X XAMG-7K2QX9 AMG_7K2QX9 AMG 7K2QX9'), [])
  // Ordinary words never trigger.
  assert.deepEqual(waitlistCodesIn('Among the AMG cars, order 123456 and #A1B2C3, call 5500000000001, invitation 2026, INV-7K2QX9MD0'), [])
  // At most two per message, in their order, each once.
  assert.deepEqual(waitlistCodesIn(`AMG-3N8RW4 ${CODE.toLowerCase()} ${CODE} AMG-5G4ZB7`), ['AMG-3N8RW4', CODE])
  assert.deepEqual([waitlistCodesIn(''), waitlistCodesIn(null), waitlistCodesIn(undefined)], [[], [], []])
})

test('waitlist call: Omni\'s event envelope, the raw text and exactly the contract\'s headers, once per message', async t => {
  const b = await bench(t)
  const row = stranger(1, 'Hi! my code: amg-7k2qxo, see you')
  await b.deliver(row)
  assert.equal(b.site.calls.length, 1)
  const [{ url, init, body }] = b.site.calls
  assert.deepEqual([url, init.method, init.redirect, init.signal instanceof AbortSignal], [SITE, 'POST', 'manual', true])
  const { 'x-omni-delivery-id': delivery, ...headers } = init.headers
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, 'x-omni-event-id': row.id })
  assert.match(delivery, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // The JSON as sent: the raw text, never the normalised code.
  assert.deepEqual(body, {
    id: row.id, type: 'message.received', timestamp: Date.parse(row.receivedAt), metadata: { correlationId: 'corr-1', from: STRANGER },
    payload: { externalId: 'WA-stranger-1', chatId: `${STRANGER}@s.whatsapp.net`, from: STRANGER, senderName: 'Ana Test', content: { text: 'Hi! my code: amg-7k2qxo, see you' } },
  })
  assert.deepEqual([Object.keys(body), Object.keys(body.payload)], [['id', 'type', 'timestamp', 'metadata', 'payload'], ['externalId', 'chatId', 'from', 'senderName', 'content']])
  assert.equal(body.payload.content.text.includes(CODE), false)
  // With no push name, senderName is left out, as Omni's own event leaves it out.
  await b.deliver({ ...stranger(2, CODE), rawPayload: { ...stranger(2, CODE).rawPayload, pushName: undefined } })
  assert.equal('senderName' in b.site.calls[1].body.payload, false)
})

test('waitlist reply: a 200 reply goes word for word to the chat once; the person stays not let in, gets no stranger reply, and the row reads waitlist', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY } })
  await b.deliver(stranger(1, `hello ${CODE}`))
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  assert.deepEqual(b.omniState.posts, [])
  assert.deepEqual(requests(b).map(row => [row.senders, row.count, row.waitlist]), [[[STRANGER], 1, { at: Date.now() }]])
  await until(() => saved(b.home).omniAnswerRequests?.[ANSWER_MASTER]?.[CHAT]?.waitlist?.at === Date.now())
  await until(() => saved(b.home).omniWaitlistReplied?.includes('WA-stranger-1'))
  // A replay of the same message calls nothing and posts nothing.
  await b.deliver(stranger(1, `hello ${CODE}`))
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [1, 1])
  await signal(t, b)
  assert.equal(runs(b), 0)
  assert.equal(b.channels.threads.byChat(CHAT), undefined)
})

test('waitlist reply: a replayed message id posts nothing, even when the site answers again; the newest 5000 ids are kept', async t => {
  const b = await bench(t)
  b.channels.state.omniWaitlistReplied = Array.from({ length: WAITLIST_REPLIED_MAX }, (_, n) => `WA-old-${n}`).concat('WA-stranger-1')
  await b.deliver(stranger(1, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends], [0, []])
  await b.deliver(stranger(2, CODE))
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  const ids = b.channels.state.omniWaitlistReplied
  assert.deepEqual([ids.length, ids.at(-1), ids.includes('WA-old-0'), ids.includes('WA-stranger-1')], [WAITLIST_REPLIED_MAX, 'WA-stranger-2', false, true])
})

test('waitlist retry: the handler waits for the first attempt only; a timeout, then a 200 at the 2 s retry, posts once with the same event id', async t => {
  const b = await bench(t, { site: ['timeout', OK], settings: { strangerReply: STRANGER_REPLY } })
  const row = stranger(1, `code ${CODE}`)
  await b.deliver(row)
  // The row is acked after the first attempt: nothing sent yet, no stranger reply, the request noted.
  assert.deepEqual([b.site.calls.length, b.omniState.sends, requests(b).map(item => item.count)], [1, [], [1]])
  t.mock.timers.tick(2_000)
  await until(() => b.omniState.sends.length === 1)
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  const [first, second] = b.site.calls
  assert.equal(second.init.headers['x-omni-event-id'], row.id)
  assert.equal(second.init.body, first.init.body)
  assert.notEqual(second.init.headers['x-omni-delivery-id'], first.init.headers['x-omni-delivery-id'])
  assert.deepEqual(requests(b).map(item => [item.count, item.waitlist]), [[1, { at: Date.now() }]])
  // No third attempt, and nothing more is sent.
  t.mock.timers.tick(10_000)
  await signal(t, b)
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [2, 1])
})

test('waitlist retry: a 503 and a network error are tried again at about 2 s and 10 s; a replay during the retries calls nothing', async t => {
  const b = await bench(t, { site: [503, 'network', OK] })
  await b.deliver(stranger(1, CODE))
  // The same message again while its retries are pending: the in-flight guard holds it.
  await b.deliver(stranger(1, CODE))
  assert.equal(b.site.calls.length, 1)
  t.mock.timers.tick(2_000)
  await until(() => b.site.calls.length === 2)
  assert.equal(b.omniState.sends.length, 0)
  t.mock.timers.tick(9_999)
  assert.equal(b.site.calls.length, 2)
  t.mock.timers.tick(1)
  await until(() => b.omniState.sends.length === 1)
  assert.deepEqual([b.site.calls.length, new Set(b.site.calls.map(call => call.body.payload.externalId)).size], [3, 1])
})

test('waitlist reply: two replies marked at once, the first save failing, keep the second\'s mark: its replay posts nothing', async t => {
  const b = await bench(t, { site: ['timeout', 'timeout', OK] })
  await b.deliver(stranger(1, CODE))
  await b.deliver(stranger(2, CODE))
  // The first mark's save fails, a few turns later; the second reply settles meanwhile.
  const save = b.channels.save
  let failing = true
  b.channels.save = async () => {
    if (failing && b.channels.state.omniWaitlistReplied?.includes('WA-stranger-1')) {
      failing = false
      for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve))
      throw new Error('disk full')
    }
    return save()
  }
  t.mock.timers.tick(2_000)
  await until(() => b.site.calls.length === 4 && b.omniState.sends.length === 1)
  await until(() => saved(b.home).omniWaitlistReplied?.includes('WA-stranger-2'))
  assert.deepEqual(b.channels.state.omniWaitlistReplied, ['WA-stranger-2'])
  assert.deepEqual(b.warned.filter(args => /waitlist reply was not sent/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'its mark was not saved']])
  b.channels.save = save
  // The second message again: marked, so nothing is called or posted.
  await b.deliver(stranger(2, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [4, 1])
})

test('waitlist retry: a 200 whose body times out or breaks is a network error, tried again and counted toward the pause; a body read in full but invalid is not', async t => {
  const b = await bench(t, { site: ['body-timeout', OK] })
  await b.deliver(stranger(1, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [1, 0])
  t.mock.timers.tick(2_000)
  await until(() => b.omniState.sends.length === 1)
  assert.equal(b.site.calls.length, 2)
  // Three in a row pause the site, warned once.
  b.site.answers = ['body-network']
  await b.deliver(stranger(2, CODE))
  t.mock.timers.tick(2_000)
  await until(() => b.site.calls.length === 4)
  t.mock.timers.tick(10_000)
  await until(() => b.warned.some(args => /not called for 5 minutes/.test(args[0])))
  assert.deepEqual(b.warned.filter(args => /waitlist/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'no answer']])
  await b.deliver(stranger(3, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [5, 1])
  // Five minutes on: a body read in full that is no answer is a bad reply, not tried again.
  t.mock.timers.setTime(Date.now() + 5 * MIN)
  b.site.answers = [{ status: 200, body: 'not json' }]
  await b.deliver(stranger(4, CODE))
  t.mock.timers.tick(2_000)
  t.mock.timers.tick(10_000)
  await signal(t, b)
  assert.deepEqual([b.site.calls.length, b.omniState.sends.length], [6, 1])
})

test('waitlist refusal: each non-200, a redirect and a bad body send nothing; the message goes on as refused, noted, with no stranger reply', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, site: [404] })
  const answers = [404, 409, 400, 401, 415, 429, 302, 500, 201, { status: 200, body: {} }, { status: 200, body: { reply: '   ' } }, { status: 200, body: { reply: 'x'.repeat(1001) } }, { status: 200, body: 'not json' }]
  for (const [index, answer] of answers.entries()) {
    // A new hour each time, so the chat's limit does not stop the call.
    t.mock.timers.setTime(Date.now() + HOUR)
    b.site.answers = [answer]
    await b.deliver(stranger(index + 1, `my code ${CODE}`))
    assert.equal(b.site.calls.length, index + 1, JSON.stringify(answer))
  }
  assert.deepEqual([b.omniState.sends, b.omniState.posts], [[], []])
  assert.deepEqual(requests(b).map(row => [row.count, row.waitlist]), [[answers.length, undefined]])
  // Warned once for the bot, with the status only.
  const warnings = b.warned.filter(args => /waitlist site did not confirm/.test(args[0]))
  assert.deepEqual(warnings.map(args => args.slice(1)), [[ANSWER_MASTER, '400']])
  noSecretIn('a warning', b.warned)
  noCodeIn('a warning', b.warned)
  // A lid-only sender: kept as #1706 keeps them, and still no stranger reply at the 30 s check.
  b.omniState.externalId = `${LID}@lid`
  t.mock.timers.setTime(Date.now() + HOUR)
  await b.deliver(lidOnly(50, `here: ${CODE}`))
  assert.deepEqual(kept(b).map(entry => entry.row.id), [eventId(50)])
  await recheck(t, b, 2_000)
  await recheck(t, b, 8_000)
  await recheck(t, b, 20_000)
  assert.deepEqual(b.omniState.sends, [])
})

test('waitlist off: with no secret (or no URL) nothing is called, and a code message gets the stranger reply exactly as before', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, set: false })
  await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: SITE })
  await b.deliver(stranger(1, `code ${CODE}`))
  assert.deepEqual([b.site.calls.length, b.omniState.sends.map(send => send.text)], [0, [STRANGER_REPLY]])
})

test('waitlist who: a sender a rule lets in, or one a rule of their own blocks, is never checked', async t => {
  const b = await bench(t)
  await b.deliver(stranger(1, `my friend's code: ${CODE}`, PHONE))
  b.omniState.deny[STRANGER] = 'block'
  await b.deliver(stranger(2, CODE))
  b.omniState.deny[LID] = 'silent_block'
  await b.deliver(lidOnly(3, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends], [0, []])
  await signal(t, b)
  await until(() => runs(b) === 1)
})

test('waitlist order: a valid invite code runs first and lets the person in, so the site is not called; an invite code that fails leaves the call', async t => {
  const b = await bench(t, { site: [404] })
  await b.call('omni-invite-codes-add', { entries: [{ code: INVITE, project: 'proj-a', expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString() }] })
  await b.deliver(stranger(1, `INV-3N8RW4HT5 and ${CODE}`))
  assert.deepEqual([b.omniState.posts.length, b.site.calls.length], [0, 1])
  await b.deliver(stranger(2, `${INVITE} and ${CODE}`))
  assert.deepEqual([b.omniState.posts.map(post => post.platformUserId), b.site.calls.length], [[STRANGER], 1])
})

test('waitlist limits: the chat\'s 5 calls an hour are shared with the invite redeem; past them nothing is called or sent', async t => {
  const b = await bench(t, { site: [404] })
  // An unknown invite code and a waitlist code: two of the chat's calls each.
  await b.deliver(stranger(1, `INV-000000001 ${CODE}`))
  await b.deliver(stranger(2, `INV-000000002 ${CODE}`))
  assert.equal(b.site.calls.length, 2)
  // The fifth call is the invite redeem's; the waitlist has none left.
  await b.deliver(stranger(3, `INV-000000003 ${CODE}`))
  await b.deliver(stranger(4, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends], [2, []])
  t.mock.timers.setTime(Date.now() + HOUR)
  await b.deliver(stranger(5, CODE))
  assert.equal(b.site.calls.length, 3)
})

test('waitlist limits: at most 30 calls a minute from the plugin, whatever the chat', async t => {
  const b = await bench(t, { site: [404] })
  const chat = n => `3e8b4f40-9d84-4a8b-8d74-${String(n).padStart(12, '0')}`
  for (let n = 1; n <= WAITLIST_CALLS_PER_MINUTE + 1; n += 1) await b.channels.answerWaitlist({ ...stranger(n, CODE), chatUuid: chat(n) }, ANSWER_MASTER)
  assert.deepEqual([WAITLIST_CALLS_PER_MINUTE, b.site.calls.length], [30, 30])
  t.mock.timers.setTime(Date.now() + MIN)
  await b.channels.answerWaitlist({ ...stranger(40, CODE), chatUuid: chat(40) }, ANSWER_MASTER)
  assert.equal(b.site.calls.length, 31)
})

test('waitlist pause: after 3 failures in a row no call for 5 minutes, warned once; those messages get no stranger reply; then calls go again', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, site: ['timeout'] })
  await b.deliver(stranger(1, CODE))
  t.mock.timers.tick(2_000)
  await until(() => b.site.calls.length === 2)
  t.mock.timers.tick(10_000)
  await until(() => b.site.calls.length === 3)
  await until(() => b.warned.some(args => /not called for 5 minutes/.test(args[0])))
  // Paused: no call, and the message stays refused with no stranger reply.
  await b.deliver(stranger(2, `again ${CODE}`))
  t.mock.timers.setTime(Date.now() + 4 * MIN)
  await b.deliver(stranger(3, `again ${CODE}`))
  assert.deepEqual([b.site.calls.length, b.omniState.sends], [3, []])
  assert.deepEqual(requests(b).map(row => row.count), [3])
  assert.deepEqual(b.warned.filter(args => /waitlist/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'a timeout']])
  // Five minutes on, the site is called again.
  t.mock.timers.setTime(Date.now() + MIN)
  b.site.answers = [OK]
  await b.deliver(stranger(4, CODE))
  assert.deepEqual([b.site.calls.length, b.omniState.sends], [4, [replyTo(`${STRANGER}@s.whatsapp.net`)]])
})

test('waitlist envelope: a message received more than 2 minutes ahead, or over 32 KB, is not sent', async t => {
  const b = await bench(t, { site: [404] })
  await b.deliver({ ...stranger(1, CODE), receivedAt: new Date(Date.now() + 2 * MIN + 1).toISOString() })
  await b.deliver(stranger(2, `${CODE} ${'x'.repeat(32 * 1024)}`))
  assert.equal(b.site.calls.length, 0)
  await b.deliver({ ...stranger(3, CODE), receivedAt: new Date(Date.now() + 2 * MIN).toISOString() })
  assert.equal(b.site.calls.length, 1)
})

test('waitlist reply: a lid-only sender\'s confirmed message is kept as before and noted once, with the row marked; no stranger reply at its 30 s check', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, omni: { externalId: `${LID}@lid` } })
  await b.deliver(lidOnly(1, `hi ${CODE}`))
  assert.deepEqual(b.omniState.sends, [replyTo(`${LID}@lid`)])
  assert.deepEqual(kept(b).map(entry => entry.row.id), [eventId(1)])
  assert.deepEqual(requests(b).map(row => [row.senders, row.count, row.waitlist]), [[[LID], 1, { at: Date.now() }]])
  await recheck(t, b, 2_000)
  await recheck(t, b, 8_000)
  await recheck(t, b, 20_000)
  assert.deepEqual([b.omniState.sends.length, requests(b).map(row => row.count)], [1, [1]])
})

test('waitlist setting: staff only; https only; the secret is written, never read back, logged or put in the view; null clears, left out keeps', async t => {
  const b = await bench(t, { site: [401], set: false })
  const site = () => b.channels.state.omniWaitlistConfirm?.[ANSWER_MASTER]
  assert.deepEqual(await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER }), { url: null, secretSet: false })
  const set = await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: ` ${SITE} `, secret: SECRET })
  assert.deepEqual(set, { url: SITE, secretSet: true })
  assert.deepEqual(b.view().omniAnswers[ANSWER_MASTER].waitlist, { url: SITE, secretSet: true })
  noSecretIn('the view', b.view())
  // Left out keeps; null clears; the URL alone keeps the secret.
  assert.deepEqual(await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: 'https://example.test/other' }), { url: 'https://example.test/other', secretSet: true })
  assert.deepEqual(site(), { url: 'https://example.test/other', secret: SECRET })
  assert.deepEqual(await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, secret: null }), { url: 'https://example.test/other', secretSet: false })
  assert.deepEqual(await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: '' }), { url: null, secretSet: false })
  assert.equal(site(), undefined)
  // Refused: not https, a secret with a space, another bot kind, unknown fields, a read-only window.
  for (const url of ['http://example.test/waitlist', 'example.test/waitlist', 'ftp://example.test/x']) await assert.rejects(b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url }), { message: WAITLIST_URL_REFUSAL })
  await assert.rejects(b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, secret: 'two words' }), { message: WAITLIST_SECRET_REFUSAL })
  await assert.rejects(b.call('omni-waitlist-confirm', { botId: 'm1', url: SITE }), /channel bot/)
  await assert.rejects(b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: SITE, reply: 'x' }))
  b.channels.readOnly = () => 'This window shows the team but cannot change it.'
  await assert.rejects(b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: SITE, secret: SECRET }), /cannot change it/)
  b.channels.readOnly = () => undefined
  await b.call('omni-waitlist-confirm', { botId: ANSWER_MASTER, url: SITE, secret: SECRET })
  // A failing site is warned with its status only: no secret, code or text.
  await b.deliver(stranger(1, `please ${CODE}`))
  assert.deepEqual(b.warned.filter(args => /waitlist/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, '401']])
  noSecretIn('a warning', b.warned)
  noCodeIn('a warning', b.warned)
  assert.equal(JSON.stringify(b.warned).includes('please'), false)
  // An answer child, from an admitted person's message.
  b.omniState.externalId = `${PHONE}@s.whatsapp.net`
  await b.deliver(stranger(2, 'Hello', PHONE))
  await signal(t, b)
  await until(() => b.channels.threads.byChat(CHAT) !== undefined)
  const child = b.channels.threads.byChat(CHAT)
  const before = JSON.stringify(site())
  const hostile = { botId: ANSWER_MASTER, url: 'https://example.test/evil', secret: null, endpoint: 'omni-waitlist-confirm', chatId: CHAT, query: 'waitlist' }
  // The child's tools read only its own chat, and no model-visible answer names the secret.
  for (const name of ['answer_chats', 'thread_history']) noSecretIn(name, await use(b, name, child.sessionId, hostile).catch(error => error.message))
  // omni_call, from the Omni Bot and from the child, at the route's names.
  for (const agent of [{ id: 'm1' }, b.agentOf(child.sessionId)]) {
    for (const path of ['/omni-waitlist-confirm', '/api/omni-ui', '/../omni-ui/omni-waitlist-confirm']) {
      const answer = await b.ctx.registeredTools.get('omni_call').execute({ method: 'POST', path, body: JSON.stringify({ endpoint: 'omni-waitlist-confirm', payload: hostile }) }, { agent }).catch(error => error.message)
      noSecretIn(`omni_call ${path}`, answer)
    }
  }
  assert.equal(JSON.stringify(site()), before)
  assert.equal(ANSWER_CHAT_TOOLS.some(name => /waitlist/i.test(name)), false)
  const visible = JSON.stringify([...b.ctx.registeredTools.values()].map(tool => [tool.name, tool.description, tool.parameters]))
  for (const word of ['omni-waitlist-confirm', 'waitlist', SECRET]) assert.equal(visible.toLowerCase().includes(word.toLowerCase()), false, word)
  noSecretIn('the view', b.view())
})
