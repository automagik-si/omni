// #1742: a code in a refused sender's message is checked with the bot's outside service, in host
// code: Omni's event envelope with the raw text, a 200's reply posted once, nothing else sent
// unless staff set a refusal text, and the message on the refused path with no stranger reply.
// Made-up pattern, codes, URL, secret and texts only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OUTSIDE_CALLS_PER_MINUTE, OUTSIDE_REPLIED_MAX, OUTSIDE_SECRET_REFUSAL, OUTSIDE_URL_REFUSAL,
} from '../src/host/answer-outside-check.js'
import { install } from '../src/host/omni-events.js'
import { ANSWER_CHAT_TOOLS } from '../src/host/threads.js'
import { ANSWER_CLOCK, ANSWER_MASTER, answerBench, CHAT, CHATS, INSTANCE, saved, signal, until, use } from './thread-fixture.js'

const MIN = 60_000
const HOUR = 60 * MIN
// Made-up ids: a phone an allow rule names, a phone no rule names, a lid.
const PHONE = '5500000000001'
const STRANGER = '5500000000042'
const LID = '100000000000042'
// The check's made-up pattern and a code of it, and a code-list pattern and code (answer-codes.js).
const PATTERN = { prefix: 'QQ-', characters: 'ABCDEFGHJK0123456789', length: 6, lookAlikes: true }
const CODE = 'QQ-7K2A90'
const LIST_PATTERN = { prefix: 'ZZ-', characters: '0123456789', length: 6 }
const LIST_CODE = 'ZZ-482910'
const SITE = 'https://example.test/check'
const SECRET = 'test-secret-0001'
const SITE_REPLY = 'Thanks! Your code is confirmed. We will write to you here soon.'
const STRANGER_REPLY = 'Hello! This line answers people with a code. Ask the team for one.'
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

// Omni as the answer bench needs it (answer-codes.test.js), with the chat's address.
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
// The service: each call takes the next answer (the last one repeats). An answer is a status, a
// status with a body, 'timeout' or 'network' (before any answer), or 'body-timeout' or
// 'body-network' (a 200 whose body then fails to arrive).
function serviceFor(b, answers) {
  const service = { calls: [], answers: [...answers] }
  b.channels.outsideCheckFetch = async (url, init) => {
    service.calls.push({ url, init, body: JSON.parse(init.body) })
    const next = service.answers.length > 1 ? service.answers.shift() : service.answers[0]
    if (next === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    if (next === 'network') throw new TypeError('fetch failed')
    if (next === 'body-timeout' || next === 'body-network') {
      const failure = next === 'body-timeout' ? Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) : new TypeError('terminated')
      return { status: 200, text: async () => { throw failure }, body: { cancel: async () => {} } }
    }
    const { status, body } = typeof next === 'number' ? { status: next, body: {} } : next
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), body: { cancel: async () => {} } }
  }
  return service
}
const OK = { status: 200, body: { reply: SITE_REPLY } }
// The bench with the check set; `settings` change the answer settings first, `check` adds to the check.
async function bench(t, { settings = {}, omni: options, service = [OK], set = true, check = {} } = {}) {
  const run = await answerBench(t, { clock: ANSWER_CLOCK })
  if (Object.keys(settings).length > 0) await run.call('omni-answer-settings', { ...run.settings, ...settings })
  const b = await attach(t, run, omniOf(options))
  if (set) await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: SITE, secret: SECRET, pattern: PATTERN, ...check })
  return Object.assign(b, { service: serviceFor(b, service) })
}
const kept = b => Object.values(b.team.state.omniAnswerKept ?? {})
const requests = b => Object.values(b.team.state.omniAnswerRequests?.[ANSWER_MASTER] ?? {})
const runs = b => b.team.state.subscriptionRuns?.length ?? 0
const replyTo = (to, text = SITE_REPLY) => ({ instanceId: INSTANCE, to, text })
// Moves the clock to the next kept re-check and waits for it to finish (answer-strangers.test.js).
async function recheck(t, b, ms) {
  const reads = b.omniState.chatReads
  t.mock.timers.tick(ms)
  await until(() => b.omniState.chatReads > reads)
  await until(() => !kept(b).some(entry => entry.nextAt <= Date.now()))
}
const noSecretIn = (label, value) => assert.equal(JSON.stringify(value).includes(SECRET), false, `${label} names the secret`)
const noCodeIn = (label, value) => assert.equal(JSON.stringify(value).toUpperCase().includes('QQ-'), false, `${label} names a code`)

test('outside check pre-filter: only a message with a code of the bot\'s pattern is sent, once, whatever else it says', async t => {
  const b = await bench(t, { service: [404] })
  // Ordinary words, numbers, other prefixes and lengths, and a character outside the set: no call.
  await b.deliver(stranger(1, 'Hello! Order 123456 and #A1B2C3, call 5500000000001, QQ-7K2A9, QQ-7K2A901, XQQ-7K2A90, QQ-7K2A9U, ZZ-482910'))
  assert.equal(b.service.calls.length, 0)
  // Two codes and the code typed by hand: one call, with the raw text.
  await b.deliver(stranger(2, `codes qq-7k2a9o and QQ-111111, ${CODE}`))
  assert.deepEqual(b.service.calls.map(call => call.body.payload.content.text), ['codes qq-7k2a9o and QQ-111111, QQ-7K2A90'])
})

test('outside check call: Omni\'s event envelope, the raw text and exactly the contract\'s headers, once per message', async t => {
  const b = await bench(t)
  const row = stranger(1, 'Hi! my code: qq-7k2a9o, see you')
  await b.deliver(row)
  assert.equal(b.service.calls.length, 1)
  const [{ url, init, body }] = b.service.calls
  assert.deepEqual([url, init.method, init.redirect, init.signal instanceof AbortSignal], [SITE, 'POST', 'manual', true])
  const { 'x-omni-delivery-id': delivery, ...headers } = init.headers
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, 'x-omni-event-id': row.id })
  assert.match(delivery, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // The JSON as sent: the raw text, never the normalised code.
  assert.deepEqual(body, {
    id: row.id, type: 'message.received', timestamp: Date.parse(row.receivedAt), metadata: { correlationId: 'corr-1', from: STRANGER },
    payload: { externalId: 'WA-stranger-1', chatId: `${STRANGER}@s.whatsapp.net`, from: STRANGER, senderName: 'Ana Test', content: { text: 'Hi! my code: qq-7k2a9o, see you' } },
  })
  assert.deepEqual([Object.keys(body), Object.keys(body.payload)], [['id', 'type', 'timestamp', 'metadata', 'payload'], ['externalId', 'chatId', 'from', 'senderName', 'content']])
  assert.equal(body.payload.content.text.includes(CODE), false)
  // With no push name, senderName is left out, as Omni's own event leaves it out.
  await b.deliver({ ...stranger(2, CODE), rawPayload: { ...stranger(2, CODE).rawPayload, pushName: undefined } })
  assert.equal('senderName' in b.service.calls[1].body.payload, false)
})

test('outside check reply: a 200 reply goes word for word to the chat once; the person stays not let in, gets no stranger reply, and the row is confirmed with the tier', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, check: { tier: 'tier-b', label: 'Checked' } })
  await b.deliver(stranger(1, `hello ${CODE}`))
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  assert.deepEqual(b.omniState.posts, [])
  assert.deepEqual(requests(b).map(row => [row.senders, row.count, row.confirmed]), [[[STRANGER], 1, { at: Date.now(), tier: 'tier-b' }]])
  await until(() => saved(b.home).omniAnswerRequests?.[ANSWER_MASTER]?.[CHAT]?.confirmed?.tier === 'tier-b')
  await until(() => saved(b.home).omniOutsideCheckReplied?.includes('WA-stranger-1'))
  // A replay of the same message calls nothing and posts nothing.
  await b.deliver(stranger(1, `hello ${CODE}`))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [1, 1])
  await signal(t, b)
  assert.equal(runs(b), 0)
  assert.equal(b.channels.threads.byChat(CHAT), undefined)
})

test('outside check reply: with no tier set, the confirmed row has none', async t => {
  const b = await bench(t)
  await b.deliver(stranger(1, CODE))
  assert.deepEqual(requests(b).map(row => row.confirmed), [{ at: Date.now() }])
})

test('outside check reply: a replayed message id posts nothing, even when the service answers again; the newest 5000 ids are kept', async t => {
  const b = await bench(t)
  b.channels.state.omniOutsideCheckReplied = Array.from({ length: OUTSIDE_REPLIED_MAX }, (_, n) => `WA-old-${n}`).concat('WA-stranger-1')
  await b.deliver(stranger(1, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends], [0, []])
  await b.deliver(stranger(2, CODE))
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  const ids = b.channels.state.omniOutsideCheckReplied
  assert.deepEqual([ids.length, ids.at(-1), ids.includes('WA-old-0'), ids.includes('WA-stranger-1')], [OUTSIDE_REPLIED_MAX, 'WA-stranger-2', false, true])
})

test('outside check retry: the handler waits for the first attempt only; a timeout, then a 200 at the 2 s retry, posts once with the same event id', async t => {
  const b = await bench(t, { service: ['timeout', OK], settings: { strangerReply: STRANGER_REPLY } })
  const row = stranger(1, `code ${CODE}`)
  await b.deliver(row)
  // The row is acked after the first attempt: nothing sent yet, no stranger reply, the request noted.
  assert.deepEqual([b.service.calls.length, b.omniState.sends, requests(b).map(item => item.count)], [1, [], [1]])
  t.mock.timers.tick(2_000)
  await until(() => b.omniState.sends.length === 1)
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`)])
  const [first, second] = b.service.calls
  assert.equal(second.init.headers['x-omni-event-id'], row.id)
  assert.equal(second.init.body, first.init.body)
  assert.notEqual(second.init.headers['x-omni-delivery-id'], first.init.headers['x-omni-delivery-id'])
  assert.deepEqual(requests(b).map(item => [item.count, item.confirmed]), [[1, { at: Date.now() }]])
  // No third attempt, and nothing more is sent.
  t.mock.timers.tick(10_000)
  await signal(t, b)
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [2, 1])
})

test('outside check retry: a 503 and a network error are tried again at about 2 s and 10 s; a replay during the retries calls nothing', async t => {
  const b = await bench(t, { service: [503, 'network', OK] })
  await b.deliver(stranger(1, CODE))
  // The same message again while its retries are pending: the in-flight guard holds it.
  await b.deliver(stranger(1, CODE))
  assert.equal(b.service.calls.length, 1)
  t.mock.timers.tick(2_000)
  await until(() => b.service.calls.length === 2)
  assert.equal(b.omniState.sends.length, 0)
  t.mock.timers.tick(9_999)
  assert.equal(b.service.calls.length, 2)
  t.mock.timers.tick(1)
  await until(() => b.omniState.sends.length === 1)
  assert.deepEqual([b.service.calls.length, new Set(b.service.calls.map(call => call.body.payload.externalId)).size], [3, 1])
})

test('outside check reply: two replies marked at once, the first save failing, keep the second\'s mark: its replay posts nothing', async t => {
  const b = await bench(t, { service: ['timeout', 'timeout', OK] })
  await b.deliver(stranger(1, CODE))
  await b.deliver(stranger(2, CODE))
  // The first mark's save fails, a few turns later; the second reply settles meanwhile.
  const save = b.channels.save
  let failing = true
  b.channels.save = async () => {
    if (failing && b.channels.state.omniOutsideCheckReplied?.includes('WA-stranger-1')) {
      failing = false
      for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve))
      throw new Error('disk full')
    }
    return save()
  }
  t.mock.timers.tick(2_000)
  await until(() => b.service.calls.length === 4 && b.omniState.sends.length === 1)
  await until(() => saved(b.home).omniOutsideCheckReplied?.includes('WA-stranger-2'))
  assert.deepEqual(b.channels.state.omniOutsideCheckReplied, ['WA-stranger-2'])
  assert.deepEqual(b.warned.filter(args => /outside check reply was not sent/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'its mark was not saved']])
  b.channels.save = save
  // The second message again: marked, so nothing is called or posted.
  await b.deliver(stranger(2, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [4, 1])
})

test('outside check retry: a 200 whose body times out or breaks is a network error, tried again and counted toward the pause; a body read in full but invalid is not', async t => {
  const b = await bench(t, { service: ['body-timeout', OK] })
  await b.deliver(stranger(1, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [1, 0])
  t.mock.timers.tick(2_000)
  await until(() => b.omniState.sends.length === 1)
  assert.equal(b.service.calls.length, 2)
  // Three in a row pause the service, warned once.
  b.service.answers = ['body-network']
  await b.deliver(stranger(2, CODE))
  t.mock.timers.tick(2_000)
  await until(() => b.service.calls.length === 4)
  t.mock.timers.tick(10_000)
  await until(() => b.warned.some(args => /not called for 5 minutes/.test(args[0])))
  assert.deepEqual(b.warned.filter(args => /outside check/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'no answer']])
  await b.deliver(stranger(3, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [5, 1])
  // Five minutes on: a body read in full that is no answer is a bad reply, not tried again.
  t.mock.timers.setTime(Date.now() + 5 * MIN)
  b.service.answers = [{ status: 200, body: 'not json' }]
  await b.deliver(stranger(4, CODE))
  t.mock.timers.tick(2_000)
  t.mock.timers.tick(10_000)
  await signal(t, b)
  assert.deepEqual([b.service.calls.length, b.omniState.sends.length], [6, 1])
})

test('outside check refusal: with no refusal texts, each non-200, a redirect and a bad body send nothing; the message goes on as refused, noted, with no stranger reply', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, service: [404] })
  const answers = [404, 409, 400, 401, 415, 429, 302, 500, 201, { status: 200, body: {} }, { status: 200, body: { reply: '   ' } }, { status: 200, body: { reply: 'x'.repeat(1001) } }, { status: 200, body: 'not json' }]
  for (const [index, answer] of answers.entries()) {
    // A new hour each time, so the chat's limit does not stop the call.
    t.mock.timers.setTime(Date.now() + HOUR)
    b.service.answers = [answer]
    await b.deliver(stranger(index + 1, `my code ${CODE}`))
    assert.equal(b.service.calls.length, index + 1, JSON.stringify(answer))
  }
  assert.deepEqual([b.omniState.sends, b.omniState.posts], [[], []])
  assert.deepEqual(requests(b).map(row => [row.count, row.confirmed]), [[answers.length, undefined]])
  // Warned once for the bot, with the status only.
  const warnings = b.warned.filter(args => /outside check did not confirm/.test(args[0]))
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

test('outside check refusal: a 4xx with a refusal text set sends that text once; other statuses still send nothing, and the row is not confirmed', async t => {
  const texts = { 404: 'We could not find that code.', 409: 'That code was already used.' }
  const b = await bench(t, { service: [404], check: { refusalTexts: texts } })
  await b.deliver(stranger(1, CODE))
  assert.deepEqual(b.omniState.sends, [replyTo(`${STRANGER}@s.whatsapp.net`, texts[404])])
  // The same message again posts nothing; a 409 for the next message sends its own text.
  await b.deliver(stranger(1, CODE))
  b.service.answers = [409]
  await b.deliver(stranger(2, CODE))
  t.mock.timers.setTime(Date.now() + HOUR)
  b.service.answers = [400]
  await b.deliver(stranger(3, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.map(send => send.text)], [3, [texts[404], texts[409]]])
  assert.deepEqual(requests(b).map(row => row.confirmed), [undefined])
  assert.deepEqual(b.warned.filter(args => /outside check did not confirm/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, '400']])
})

test('outside check off: with no secret, no URL or no pattern nothing is called, and a code message gets the stranger reply exactly as before', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, set: false })
  await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: SITE, pattern: PATTERN })
  await b.deliver(stranger(1, `code ${CODE}`))
  await b.call('omni-outside-check', { botId: ANSWER_MASTER, secret: SECRET, pattern: null })
  t.mock.timers.setTime(Date.now() + 25 * HOUR)
  await b.deliver(stranger(2, `code ${CODE}`))
  await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: null, pattern: PATTERN })
  t.mock.timers.setTime(Date.now() + 25 * HOUR)
  await b.deliver(stranger(3, `code ${CODE}`))
  assert.deepEqual([b.service.calls.length, b.omniState.sends.map(send => send.text)], [0, [STRANGER_REPLY, STRANGER_REPLY, STRANGER_REPLY]])
})

test('outside check who: a sender a rule lets in, or one a rule of their own blocks, is never checked', async t => {
  const b = await bench(t)
  await b.deliver(stranger(1, `my friend's code: ${CODE}`, PHONE))
  b.omniState.deny[STRANGER] = 'block'
  await b.deliver(stranger(2, CODE))
  b.omniState.deny[LID] = 'silent_block'
  await b.deliver(lidOnly(3, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends], [0, []])
  await signal(t, b)
  await until(() => runs(b) === 1)
})

test('outside check order: a valid code from a staff list runs first and lets the person in, so the service is not called; a list code that fails leaves the call', async t => {
  const b = await bench(t, { service: [404] })
  await b.call('omni-code-lists-add', { list: 'list-a', pattern: LIST_PATTERN, entries: [{ code: LIST_CODE, expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString() }] })
  await b.deliver(stranger(1, `ZZ-375028 and ${CODE}`))
  assert.deepEqual([b.omniState.posts.length, b.service.calls.length], [0, 1])
  await b.deliver(stranger(2, `${LIST_CODE} and ${CODE}`))
  assert.deepEqual([b.omniState.posts.map(post => post.platformUserId), b.service.calls.length], [[STRANGER], 1])
})

test('outside check limits: the chat\'s 5 checks an hour are shared with the code lists; past them nothing is called or sent', async t => {
  const b = await bench(t, { service: [404] })
  await b.call('omni-code-lists-add', { list: 'list-a', pattern: LIST_PATTERN, entries: [{ code: LIST_CODE, expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString() }] })
  // An unknown list code and a check code: two of the chat's checks each.
  await b.deliver(stranger(1, `ZZ-000001 ${CODE}`))
  await b.deliver(stranger(2, `ZZ-000002 ${CODE}`))
  assert.equal(b.service.calls.length, 2)
  // The fifth check is the list's; the service gets none.
  await b.deliver(stranger(3, `ZZ-000003 ${CODE}`))
  await b.deliver(stranger(4, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends], [2, []])
  t.mock.timers.setTime(Date.now() + HOUR)
  await b.deliver(stranger(5, CODE))
  assert.equal(b.service.calls.length, 3)
})

test('outside check limits: at most 30 calls a minute from the plugin, whatever the chat', async t => {
  const b = await bench(t, { service: [404] })
  const chat = n => `3e8b4f40-9d84-4a8b-8d74-${String(n).padStart(12, '0')}`
  for (let n = 1; n <= OUTSIDE_CALLS_PER_MINUTE + 1; n += 1) await b.channels.answerOutsideCheck({ ...stranger(n, CODE), chatUuid: chat(n) }, ANSWER_MASTER)
  assert.deepEqual([OUTSIDE_CALLS_PER_MINUTE, b.service.calls.length], [30, 30])
  t.mock.timers.setTime(Date.now() + MIN)
  await b.channels.answerOutsideCheck({ ...stranger(40, CODE), chatUuid: chat(40) }, ANSWER_MASTER)
  assert.equal(b.service.calls.length, 31)
})

test('outside check pause: after 3 failures in a row no call for 5 minutes, warned once; those messages get no stranger reply; then calls go again', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, service: ['timeout'] })
  await b.deliver(stranger(1, CODE))
  t.mock.timers.tick(2_000)
  await until(() => b.service.calls.length === 2)
  t.mock.timers.tick(10_000)
  await until(() => b.service.calls.length === 3)
  await until(() => b.warned.some(args => /not called for 5 minutes/.test(args[0])))
  // Paused: no call, and the message stays refused with no stranger reply.
  await b.deliver(stranger(2, `again ${CODE}`))
  t.mock.timers.setTime(Date.now() + 4 * MIN)
  await b.deliver(stranger(3, `again ${CODE}`))
  assert.deepEqual([b.service.calls.length, b.omniState.sends], [3, []])
  assert.deepEqual(requests(b).map(row => row.count), [3])
  assert.deepEqual(b.warned.filter(args => /outside check/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, 'a timeout']])
  // Five minutes on, the service is called again.
  t.mock.timers.setTime(Date.now() + MIN)
  b.service.answers = [OK]
  await b.deliver(stranger(4, CODE))
  assert.deepEqual([b.service.calls.length, b.omniState.sends], [4, [replyTo(`${STRANGER}@s.whatsapp.net`)]])
})

test('outside check envelope: a message received more than 2 minutes ahead, or over 32 KB, is not sent', async t => {
  const b = await bench(t, { service: [404] })
  await b.deliver({ ...stranger(1, CODE), receivedAt: new Date(Date.now() + 2 * MIN + 1).toISOString() })
  await b.deliver(stranger(2, `${CODE} ${'x'.repeat(32 * 1024)}`))
  assert.equal(b.service.calls.length, 0)
  await b.deliver({ ...stranger(3, CODE), receivedAt: new Date(Date.now() + 2 * MIN).toISOString() })
  assert.equal(b.service.calls.length, 1)
})

test('outside check reply: a lid-only sender\'s confirmed message is kept as before and noted once, with the row marked; no stranger reply at its 30 s check', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, omni: { externalId: `${LID}@lid` } })
  await b.deliver(lidOnly(1, `hi ${CODE}`))
  assert.deepEqual(b.omniState.sends, [replyTo(`${LID}@lid`)])
  assert.deepEqual(kept(b).map(entry => entry.row.id), [eventId(1)])
  assert.deepEqual(requests(b).map(row => [row.senders, row.count, row.confirmed]), [[[LID], 1, { at: Date.now() }]])
  await recheck(t, b, 2_000)
  await recheck(t, b, 8_000)
  await recheck(t, b, 20_000)
  assert.deepEqual([b.omniState.sends.length, requests(b).map(row => row.count)], [1, [1]])
})

test('outside check setting: staff only; https only; the secret is written, never read back, logged or put in the view; null clears, left out keeps', async t => {
  const b = await bench(t, { service: [401], set: false })
  const check = () => b.channels.state.omniOutsideCheck?.[ANSWER_MASTER]
  const empty = { url: null, secretSet: false, pattern: null, label: null, tier: null, refusalTexts: {} }
  assert.deepEqual(await b.call('omni-outside-check', { botId: ANSWER_MASTER }), empty)
  const set = await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: ` ${SITE} `, secret: SECRET, pattern: { ...PATTERN, prefix: 'qq-' }, label: ' Checked ', tier: 'tier-b', refusalTexts: { 404: ' Not found. ', 409: '  ' } })
  const full = { url: SITE, secretSet: true, pattern: PATTERN, label: 'Checked', tier: 'tier-b', refusalTexts: { 404: 'Not found.' } }
  assert.deepEqual(set, full)
  assert.deepEqual(b.view().omniAnswers[ANSWER_MASTER].outsideCheck, full)
  noSecretIn('the view', b.view())
  // Left out keeps; null or empty clears; the URL alone keeps the secret.
  assert.deepEqual(await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: 'https://example.test/other' }), { ...full, url: 'https://example.test/other' })
  assert.deepEqual(check(), { url: 'https://example.test/other', secret: SECRET, pattern: PATTERN, label: 'Checked', tier: 'tier-b', refusalTexts: { 404: 'Not found.' } })
  assert.deepEqual(await b.call('omni-outside-check', { botId: ANSWER_MASTER, secret: null, label: '', tier: null, refusalTexts: {} }), { ...empty, url: 'https://example.test/other', pattern: PATTERN })
  assert.deepEqual(await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: '', pattern: null }), empty)
  assert.equal(check(), undefined)
  // Refused: not https, a secret with a space, a bad pattern or refusal status, another bot kind, unknown fields, a read-only window.
  for (const url of ['http://example.test/check', 'example.test/check', 'ftp://example.test/x']) await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, url }), { message: OUTSIDE_URL_REFUSAL })
  await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, secret: 'two words' }), { message: OUTSIDE_SECRET_REFUSAL })
  await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, pattern: { characters: '.*', length: 6 } }))
  await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, refusalTexts: { 503: 'Try later.' } }))
  await assert.rejects(b.call('omni-outside-check', { botId: 'm1', url: SITE }), /channel bot/)
  await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, url: SITE, reply: 'x' }))
  b.channels.readOnly = () => 'This window shows the team but cannot change it.'
  await assert.rejects(b.call('omni-outside-check', { botId: ANSWER_MASTER, url: SITE, secret: SECRET }), /cannot change it/)
  b.channels.readOnly = () => undefined
  await b.call('omni-outside-check', { botId: ANSWER_MASTER, url: SITE, secret: SECRET, pattern: PATTERN })
  // A failing service is warned with its status only: no secret, code or text.
  await b.deliver(stranger(1, `please ${CODE}`))
  assert.deepEqual(b.warned.filter(args => /outside check/.test(args[0])).map(args => args.slice(1)), [[ANSWER_MASTER, '401']])
  noSecretIn('a warning', b.warned)
  noCodeIn('a warning', b.warned)
  assert.equal(JSON.stringify(b.warned).includes('please'), false)
  // An answer child, from an admitted person's message.
  b.omniState.externalId = `${PHONE}@s.whatsapp.net`
  await b.deliver(stranger(2, 'Hello', PHONE))
  await signal(t, b)
  await until(() => b.channels.threads.byChat(CHAT) !== undefined)
  const child = b.channels.threads.byChat(CHAT)
  const before = JSON.stringify(check())
  const hostile = { botId: ANSWER_MASTER, url: 'https://example.test/evil', secret: null, endpoint: 'omni-outside-check', chatId: CHAT, query: 'secret' }
  // The child's tools read only its own chat, and no model-visible answer names the secret.
  for (const name of ['answer_chats', 'thread_history']) noSecretIn(name, await use(b, name, child.sessionId, hostile).catch(error => error.message))
  // omni_call, from the Omni Bot and from the child, at the route's names.
  for (const agent of [{ id: 'm1' }, b.agentOf(child.sessionId)]) {
    for (const path of ['/omni-outside-check', '/api/omni-ui', '/../omni-ui/omni-outside-check']) {
      const answer = await b.ctx.registeredTools.get('omni_call').execute({ method: 'POST', path, body: JSON.stringify({ endpoint: 'omni-outside-check', payload: hostile }) }, { agent }).catch(error => error.message)
      noSecretIn(`omni_call ${path}`, answer)
    }
  }
  assert.equal(JSON.stringify(check()), before)
  assert.equal(ANSWER_CHAT_TOOLS.some(name => /outside|check/i.test(name)), false)
  const visible = JSON.stringify([...b.ctx.registeredTools.values()].map(tool => [tool.name, tool.description, tool.parameters]))
  for (const word of ['omni-outside-check', 'outside check', SECRET]) assert.equal(visible.toLowerCase().includes(word.toLowerCase()), false, word)
  noSecretIn('the view', b.view())
})
