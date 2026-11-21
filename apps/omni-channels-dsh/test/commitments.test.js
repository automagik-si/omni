import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { COMMITMENTS_FILE } from '../src/host/commitments.js'
import { LINK_FILE } from '../src/host/omni-link.js'
import { ANSWER_MASTER, answerState, boot, CHAT, ELSEWHERE, fakeOmni, GROUP, homeFor, INSTANCE, OMNI, OTHER_INSTANCE, readOnlyPresets, record as threadRecord, resetFetch, saved, teamState, until, use } from './thread-fixture.js'

afterEach(resetFetch)

const uuid = n => `37300000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SOURCE = uuid(1)
const LATER = uuid(2)
const EARLIER = uuid(3)
const FOREIGN = uuid(4)
const SAME_TIME = uuid(5)
const AT = '2026-11-12T10:00:00.000Z'
const AFTER = '2026-11-12T12:00:00.000Z'
const QUOTE = 'I will send the revised sketch'
const OTHER_QUOTE = 'The sample will arrive on Friday'
const CLOSING = 'The revised sketch has been sent'
const PRIVATE = 'Private commitment marker'
const base = { chat: CHAT, sourceMessageId: SOURCE, quote: QUOTE, text: PRIVATE, owner: 'user' }
const reply = (chatId, id, textContent, platformTimestamp = AT) => ({ id, chatId, textContent, platformTimestamp })

function fake(t, state) {
  const omni = fakeOmni()
  const home = homeFor(t, omni, state)
  const path = join(home, COMMITMENTS_FILE)
  const messages = new Map([
    [SOURCE, reply(CHAT, SOURCE, `I will\n send the revised sketch. ${OTHER_QUOTE}. ${QUOTE}.`)],
    [LATER, reply(CHAT, LATER, CLOSING, AFTER)],
    [EARLIER, reply(CHAT, EARLIER, CLOSING, '2026-11-11T12:00:00.000Z')],
    [FOREIGN, reply(ELSEWHERE, FOREIGN, `${CLOSING}. ${QUOTE}`, AFTER)],
    [SAME_TIME, reply(CHAT, SAME_TIME, CLOSING)],
  ])
  const events = []
  const controls = { eventStatus: 201, onRead: async () => {} }
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/api\/v2/, '')
    if (init.headers?.['x-api-key'] === omni.link.text && route === '/events/trigger') {
      events.push({ body: JSON.parse(init.body), saved: saved(home) })
      return new Response(null, { status: controls.eventStatus })
    }
    const override = await controls.onRead(route)
    if (override !== undefined) return override
    const message = messages.get(route.split('/')[2])
    if (init.method === 'GET' && route.startsWith('/messages/') && message !== undefined && init.headers?.['x-api-key'] === omni.link.text) {
      return Response.json({ data: message })
    }
    return inner(url, init)
  }
  const start = () => boot(t, home, { services: { permissionPresets: readOnlyPresets() } })
  const file = () => JSON.parse(readFileSync(path, 'utf8'))
  return { omni, home, path, messages, events, controls, start, file }
}

const record = (run, fields = {}, session = 'm1') => use(run, 'record_commitment', session, { ...base, ...fields })
const close = (run, id, fields = {}, session = 'm1') => use(run, 'close_commitment', session, { id, status: 'done', closingMessageId: LATER, quote: CLOSING, ...fields })
const list = (run, fields = {}, session = 'm1') => use(run, 'list_commitments', session, fields)
const review = (run, id, decision) => run.http('review_commitment', { id, decision })
const read = (run, fields = {}) => run.call('omni-commitments', fields).then(value => value.commitments)
const displayFields = ({ origin, sourceMessageId, quotes, recordedBy, reviewedAt, closing, ...fields }) =>
  closing ? { ...fields, closing: { at: closing.at } } : fields
function idOf(text) {
  assert.match(text, /^Commitment [0-9a-f]{16}: /)
  return text.split(' ')[1].slice(0, -1)
}

test('a record requires a verifiable canonical source and replays by normalized, contained quote', async (t) => {
  const env = fake(t)
  const run = await env.start()
  for (const quote of ['short', 'x'.repeat(301)]) assert.match(await record(run, { quote }), /6 to 300/)
  assert.match(await record(run, { text: 'x'.repeat(501) }), /at most 500/)
  assert.match(await record(run, { deadline: 'tomorrow' }), /valid commitment tool arguments/)
  assert.match(await record(run, { quote: QUOTE.toUpperCase() }), /verbatim/)
  assert.match(await record(run, { sourceMessageId: FOREIGN }), /message from this chat/)
  assert.match(await record(run, { sourceMessageId: uuid(100) }), /message from this chat/)
  assert.equal(existsSync(env.path), false)

  const id = idOf(await record(run, { quote: 'I will\t send the revised sketch', deadline: '2026-11-12T13:00:00+01:00', nextAction: 'Check the draft', ownerName: 'Sender' }))
  assert.equal(id, createHash('sha256').update([OMNI, CHAT, SOURCE, QUOTE].join('\0')).digest('hex').slice(0, 16))
  assert.equal(env.file().items[id].sourceAt, AT)
  assert.equal(env.file().items[id].deadline, AFTER)
  assert.equal(env.file().items[id].recordedBy, 'm1')
  assert.equal(env.file().items[id].status, 'candidate')
  assert.equal(idOf(await record(run, { text: 'Reworded paraphrase', owner: 'other' })), id)
  assert.equal(env.file().items[id].quotes.length, 1)
  assert.equal(env.file().items[id].deadline, AFTER)
  assert.equal(env.file().items[id].nextAction, 'Check the draft')
  for (const quote of ['send the revised sketch', `${QUOTE}.`, 'the revised sketch']) {
    assert.equal(idOf(await record(run, { quote, text: 'Short summary', deadline: null, nextAction: 'Check again' })), id)
  }
  const item = env.file().items[id]
  assert.equal(item.text, 'Short summary')
  assert.equal(item.nextAction, 'Check again')
  assert.equal(item.deadline, null)
  assert.equal(item.owner, 'user')
  assert.equal(item.ownerName, 'Sender')
  assert.deepEqual(item.quotes, ['I will\t send the revised sketch', 'send the revised sketch', `${QUOTE}.`])
  const second = idOf(await record(run, { quote: OTHER_QUOTE }))
  assert.notEqual(second, id)
  assert.equal((await read(run)).length, 2)
})

test('a quote spanning two commitments is refused and an exact replay keeps its own id', async (t) => {
  const env = fake(t)
  const run = await env.start()
  const first = 'Deliver report'
  const second = 'arrange pickup'
  const spanning = `${first} and ${second}`
  env.messages.set(SOURCE, reply(CHAT, SOURCE, spanning))
  const firstId = idOf(await record(run, { quote: first, text: first }))
  const secondId = idOf(await record(run, { quote: second, text: second }))
  assert.notEqual(firstId, secondId)
  await run.channels.flushOmniEventOutbox()
  const previous = env.file()
  assert.equal(await record(run, { quote: spanning, text: 'Combined work' }), 'this quote spans more than one commitment; quote one of them')
  assert.deepEqual(env.file(), previous)
  assert.equal(saved(env.home).omniEventOutbox.length, 0)
  assert.equal(idOf(await record(run, { quote: second, text: 'Updated pickup plan' })), secondId)
  assert.deepEqual(env.file().items[firstId], previous.items[firstId])
  assert.equal(env.file().items[secondId].text, 'Updated pickup plan')
})

test('a deadline outside the stored UTC range leaves the item and pending outbox intact', async (t) => {
  const env = fake(t)
  env.controls.eventStatus = 429
  const run = await env.start()
  const id = idOf(await record(run, { deadline: AFTER }))
  await run.channels.flushOmniEventOutbox()
  const previous = env.file()
  const pending = saved(env.home).omniEventOutbox
  assert.equal(pending.length, 1)
  const attempts = env.events.length
  assert.match(await record(run, { deadline: '9999-12-31T23:59:59-01:00', text: 'A changed plan' }), /deadline.*ISO time in UTC/)
  assert.deepEqual(env.file(), previous)
  assert.deepEqual(await read(run), [displayFields(previous.items[id])])
  assert.deepEqual(saved(env.home).omniEventOutbox, pending)
  assert.deepEqual(run.team.state.omniEventOutbox, pending)
  assert.equal(env.events.length, attempts)
})

test('a whitespace-padded short quote is refused and lookup and filter failures give distinct messages', async (t) => {
  const env = fake(t)
  const run = await env.start()
  env.messages.set(SOURCE, reply(CHAT, SOURCE, `${QUOTE}. I do`))
  env.messages.set(LATER, reply(CHAT, LATER, `${CLOSING}. I do`, AFTER))
  assert.match(await record(run, { quote: 'I    do' }), /Quotes must be 6 to 300/)
  assert.equal(existsSync(env.path), false)
  const id = idOf(await record(run))
  assert.match(await close(run, id, { quote: 'I    do' }), /Quotes must be 6 to 300/)

  const unreachable = 'Omni could not be reached; try again'
  for (const routeToFail of [`/chats/${CHAT}`, `/messages/${SOURCE}`, `/messages/${LATER}`]) {
    env.controls.onRead = async (route) => {
      if (route === routeToFail) return new Response(null, { status: 503 })
    }
    assert.equal(routeToFail.endsWith(LATER) ? await close(run, id) : await record(run), unreachable)
    env.controls.onRead = async (route) => {
      if (route === routeToFail) throw new TypeError('fetch failed')
    }
    assert.equal(routeToFail.endsWith(LATER) ? await close(run, id) : await record(run), unreachable)
  }
  env.controls.onRead = async () => {}
  assert.equal(await record(run, { sourceMessageId: FOREIGN }), 'Give a message from this chat.')
  assert.equal(await record(run, { quote: QUOTE.toUpperCase() }), 'The quote must occur verbatim in that message, allowing for whitespace differences.')
  assert.equal(await list(run, { chat: 'missing' }), 'Use a valid chat id, commitment status, or true/false verified value to filter commitments.')
  assert.equal(env.file().items[id].status, 'candidate')
})

test('close needs a different message from the same chat with later platform time and a verbatim quote', async (t) => {
  const env = fake(t)
  const run = await env.start()
  const id = idOf(await record(run))
  const initial = env.file()
  assert.match(await close(run, id, { closingMessageId: SOURCE, quote: QUOTE }), /different message/)
  assert.match(await close(run, id, { closingMessageId: EARLIER }), /later than/)
  assert.match(await close(run, id, { closingMessageId: SAME_TIME }), /later than/)
  assert.match(await close(run, id, { closingMessageId: FOREIGN }), /message from this chat/)
  assert.match(await close(run, id, { quote: 'I have sent it' }), /verbatim/)
  assert.match(await close(run, id, { closingMessageId: uuid(99) }), /message from this chat/)
  assert.deepEqual(env.file(), initial)
  assert.equal(await close(run, id), `Commitment ${id}: done.`)
  assert.deepEqual(env.file().items[id].closing, { messageId: LATER, quote: CLOSING, at: AFTER })
  assert.equal(env.file().items[id].verified, false)
  const closed = env.file()
  assert.equal(idOf(await record(run, { quote: 'send the revised sketch', text: 'Try to change the closed item' })), id)
  assert.deepEqual(env.file(), closed)
})

test('owner review, Bot closing and terminal replay follow the transition table', async (t) => {
  const env = fake(t)
  const run = await env.start()
  async function candidate(n) {
    const sourceMessageId = uuid(n)
    env.messages.set(sourceMessageId, reply(CHAT, sourceMessageId, QUOTE))
    return idOf(await record(run, { sourceMessageId }))
  }
  const open = await candidate(20)
  assert.deepEqual((await review(run, open, 'verify')).value, { id: open, status: 'open', verified: true })
  const verified = env.file().items[open]
  assert.ok(verified.reviewedAt)
  assert.deepEqual((await review(run, open, 'verify')).value, { id: open, status: 'open', verified: true })
  assert.deepEqual(env.file().items[open], verified)
  assert.equal((await review(run, open, 'dismiss')).ok, false)
  assert.equal(idOf(await record(run, { sourceMessageId: uuid(20), text: 'Try to change the verified item' })), open)
  assert.deepEqual(env.file().items[open], verified)
  assert.equal(await close(run, open, { status: 'cancelled' }), `Commitment ${open}: cancelled.`)
  assert.equal(env.file().items[open].verified, true)

  const dismissed = await candidate(21)
  assert.deepEqual((await review(run, dismissed, 'dismiss')).value, { id: dismissed, status: 'dismissed', verified: false })
  const rejected = env.file().items[dismissed]
  assert.equal((await review(run, dismissed, 'dismiss')).ok, true)
  assert.equal((await review(run, dismissed, 'verify')).ok, false)
  assert.match(await close(run, dismissed), /Only candidates and open/)
  assert.equal(idOf(await record(run, { sourceMessageId: uuid(21), quote: 'send the revised sketch', text: 'Try to reopen the dismissed item' })), dismissed)
  assert.deepEqual(env.file().items[dismissed], rejected)

  for (const [n, status] of [[22, 'done'], [23, 'cancelled']]) {
    const id = await candidate(n)
    assert.equal(await close(run, id, { status }), `Commitment ${id}: ${status}.`)
    assert.match(await close(run, id), /Only candidates and open/)
    assert.equal((await review(run, id, 'dismiss')).ok, false)
    const evidence = env.file().items[id].closing
    assert.deepEqual((await review(run, id, 'verify')).value, { id, status, verified: true })
    const verifiedClosed = env.file().items[id]
    assert.deepEqual(verifiedClosed.closing, evidence)
    assert.equal((await review(run, id, 'verify')).ok, true)
    assert.deepEqual(env.file().items[id], verifiedClosed)
  }
  assert.equal((await run.http('review_commitment', { id: open, decision: 'verify', text: PRIVATE })).ok, false)
})

test('only the Bot own session acts, and a default Bot with read authority alone can only list', async (t) => {
  const threadId = uuid(10)
  const env = fake(t, answerState())
  const run = await env.start()
  await run.call('omni-answer-settings', { botId: ANSWER_MASTER, enabled: true, visibility: 'isolated', allowedTools: [], sharedNotes: '' })
  const child = await run.channels.threads.answerFor({ ownerBotId: ANSWER_MASTER, channelId: INSTANCE, chatId: CHAT })
  run.team.state.omniThreads[threadId] = threadRecord(threadId, 'ordinary', { ownerBotId: ANSWER_MASTER })
  run.team.taskOwners.set('task', { botId: ANSWER_MASTER })
  const master = run.team.chatOf(ANSWER_MASTER)
  const id = idOf(await record(run, {}, master))
  const initial = env.file()
  for (const session of ['ordinary', child.sessionId, 'task']) {
    assert.match(await record(run, {}, session), /own session/)
    assert.match(await close(run, id, {}, session), /own session/)
    assert.match(await list(run, {}, session), /own session/)
  }
  assert.ok(run.restricts.length > 0)
  for (const { filter } of run.restricts) {
    for (const name of ['record_commitment', 'list_commitments', 'close_commitment']) assert.ok(!filter.allow.includes(name))
  }
  assert.match(await record(run), /No commitment chat available/)
  assert.match(await close(run, id), /No commitment chat available/)
  assert.match(await list(run), new RegExp(id))
  assert.deepEqual(env.file(), initial)
})

test('concurrent owner verify and Bot replay serialize at the point of save', async (t) => {
  const env = fake(t)
  const run = await env.start()
  const id = idOf(await record(run))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const save = run.channels.saveOmniTransition
  run.channels.saveOmniTransition = async (...args) => {
    if (args[0] === 'commitment.verified') {
      entered.resolve()
      await release.promise
    }
    return save(...args)
  }
  const verifying = review(run, id, 'verify')
  await entered.promise
  const replaying = record(run, { text: 'A replay while verification is saving' })
  release.resolve()
  const [reviewed, replayed] = await Promise.all([verifying, replaying])
  assert.deepEqual(reviewed.value, { id, status: 'open', verified: true })
  assert.equal(replayed, `Commitment ${id}: open.`)
  assert.equal(env.file().items[id].text, PRIVATE)
})

test('writes recheck read-only, current link and authority after awaits and roll back a failed team save', async (t) => {
  const env = fake(t, answerState())
  const run = await env.start()
  const master = run.team.chatOf(ANSWER_MASTER)
  const id = idOf(await record(run, {}, master))
  await run.channels.flushOmniEventOutbox()
  const initial = env.file()
  let readOnly = 'Host is read-only.'
  run.team.readOnly = () => readOnly
  assert.equal((await review(run, id, 'verify')).error.code, 'bot/read-only')
  assert.match(await record(run, {}, master), /Host is read-only/)
  readOnly = undefined
  env.controls.onRead = async (route) => {
    if (route === `/messages/${LATER}`) run.team.state.omniOwnership.channels[INSTANCE] = 'm1'
  }
  assert.match(await close(run, id, {}, master), /No commitment chat available/)
  assert.deepEqual(env.file(), initial)
  env.controls.onRead = async () => {}
  const transition = run.channels.saveOmniTransition
  run.channels.saveOmniTransition = (...args) => {
    readOnly = 'Became read-only before rename.'
    return transition(...args)
  }
  const refused = await review(run, id, 'verify')
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Became read-only before rename/)
  assert.deepEqual(env.file(), initial)
  assert.deepEqual(saved(env.home).omniEventOutbox, [])

  readOnly = undefined
  run.channels.saveOmniTransition = transition
  const linkPath = join(env.home, LINK_FILE)
  const previousLink = readFileSync(linkPath)
  env.controls.onRead = async (route) => { if (route === `/chats/${CHAT}`) rmSync(linkPath, { force: true }) }
  assert.equal((await review(run, id, 'verify')).ok, false)
  assert.deepEqual(env.file(), initial)

  writeFileSync(linkPath, previousLink, { mode: 0o600 })
  env.controls.onRead = async () => {}
  const save = run.channels.save
  run.channels.save = async () => { throw new Error('test save failed') }
  assert.equal((await review(run, id, 'verify')).ok, false)
  run.channels.save = save
  assert.deepEqual(env.file(), initial)
  assert.deepEqual(run.team.state.omniEventOutbox, [])
  assert.equal((await review(run, id, 'verify')).ok, true)
})

test('the private file holds evidence, and the text-free outbox persists, retries, and sends each transition', async (t) => {
  const env = fake(t)
  env.controls.eventStatus = 429
  const run = await env.start()
  const before = saved(env.home)
  let deliveries = 0
  run.channels.deliver = () => { deliveries++ }
  const id = idOf(await record(run, { ownerName: 'Private owner', counterpart: 'Private counterpart', nextAction: 'Private next action' }))
  await until(() => env.events.length === 1)
  const first = env.events[0].body
  const item = env.file().items[id]
  assert.equal(statSync(env.path).mode & 0o777, 0o600)
  assert.deepEqual(first, {
    eventType: 'custom.omni-channels.commitment.recorded', instanceId: INSTANCE,
    idempotencyKey: `commitment.recorded:${id}:${env.events[0].saved.revision}`,
    payload: { commitmentId: id, chatId: CHAT, sourceMessageId: SOURCE, status: 'candidate', verified: false, updatedAt: item.updatedAt },
  })
  assert.deepEqual(env.events[0].saved.omniEventOutbox, [{ origin: OMNI, event: first }])
  await run.stop()
  env.controls.eventStatus = 201
  const restarted = await env.start()
  restarted.channels.deliver = run.channels.deliver
  await until(() => env.events.length === 2 && saved(env.home).omniEventOutbox?.length === 0)
  assert.deepEqual(env.events[1].body, first)
  assert.equal((await review(restarted, id, 'verify')).ok, true)
  assert.equal(await close(restarted, id), `Commitment ${id}: done.`)
  const second = idOf(await record(restarted, { quote: OTHER_QUOTE }))
  assert.equal((await review(restarted, second, 'dismiss')).ok, true)
  await restarted.channels.flushOmniEventOutbox()
  assert.deepEqual(env.events.slice(2).map(event => event.body.eventType), ['verified', 'closed', 'recorded', 'dismissed'].map(name => `custom.omni-channels.commitment.${name}`))
  assert.equal(new Set(env.events.slice(1).map(event => event.body.idempotencyKey)).size, 5)
  assert.equal(env.events.find(event => event.body.payload.status === 'done').body.payload.closingMessageId, LATER)
  assert.deepEqual(saved(env.home).omniEventOutbox, [])
  assert.deepEqual((await read(restarted, { chat: CHAT })).find(row => row.id === id), displayFields(env.file().items[id]))
  const exposed = JSON.stringify([saved(env.home), restarted.view(), env.events])
  for (const text of [PRIVATE, QUOTE, OTHER_QUOTE, CLOSING, 'Private owner', 'Private counterpart', 'Private next action']) assert.ok(!exposed.includes(text))
  assert.deepEqual(env.omni.sent, [])
  assert.deepEqual(saved(env.home).requests, before.requests)
  assert.deepEqual(saved(env.home).subscriptionRuns ?? [], before.subscriptionRuns ?? [])
  assert.deepEqual(restarted.made, [])
  assert.equal(deliveries, 0)
})

for (const failure of ['rename failure', 'authority refusal']) {
  test(`a commitment replacement with ${failure} preserves the candidate and publishes no verification, even after restart`, async (t) => {
    const env = fake(t)
    const run = await env.start()
    const id = idOf(await record(run))
    await run.channels.flushOmniEventOutbox()
    const previous = env.file()
    const save = run.channels.save
    const readOnly = run.team.readOnly
    let saves = 0
    run.channels.save = async options => {
      await save(options)
      if (!options?.required || ++saves !== 1) return
      assert.deepEqual(env.file(), previous)
      const [entry] = saved(env.home).omniEventOutbox
      assert.equal(entry.event.eventType, 'custom.omni-channels.commitment.verified')
      assert.equal(entry.event.payload.commitmentId, id)
      if (failure === 'authority refusal') {
        run.team.readOnly = () => 'Became read-only during the team save.'
      } else {
        const staged = readdirSync(env.home).filter(file => file.startsWith(`${COMMITMENTS_FILE}.`) && file.endsWith('.tmp'))
        assert.equal(staged.length, 1)
        rmSync(join(env.home, staged[0]))
      }
    }

    const failed = await review(run, id, 'verify')
    assert.equal(failed.ok, false)
    assert.match(failed.error.message, failure === 'authority refusal' ? /Became read-only/ : /ENOENT/)
    assert.equal(saves, 2)
    run.team.readOnly = readOnly
    run.channels.save = save
    await run.channels.flushOmniEventOutbox()
    assert.deepEqual(env.file(), previous)
    assert.deepEqual(saved(env.home).omniEventOutbox, [])
    assert.deepEqual(run.team.state.omniEventOutbox, [])
    const published = env.events.map(({ body }) => body.eventType)
    assert.deepEqual(published, ['custom.omni-channels.commitment.recorded'])
    await run.stop()

    const restarted = await env.start()
    await restarted.channels.flushOmniEventOutbox()
    assert.deepEqual(env.events.map(({ body }) => body.eventType), published)
    assert.deepEqual(saved(env.home).omniEventOutbox, [])
    assert.deepEqual(env.file(), previous)
    assert.equal(env.file().items[id].status, 'candidate')
  })
}

test('the read endpoint and conversation counts use current, readable chats, and the list filters and orders visible items', async (t) => {
  const row = (chatId, channelId) => ({ chatId, channelId, outcome: 'done', state: 'done', counts: { stored: 1 } })
  const backfill = { id: uuid(14), from: AT, to: AFTER, startedAt: 1, rows: [row(CHAT, INSTANCE), row(GROUP, INSTANCE), row(ELSEWHERE, OTHER_INSTANCE)] }
  const env = fake(t, teamState({ omniBackfillRuns: [backfill] }))
  const run = await env.start()
  const open = idOf(await record(run))
  const candidate = idOf(await record(run, { quote: OTHER_QUOTE }))
  const closedId = idOf(await record(run, { sourceMessageId: EARLIER, quote: CLOSING }))
  assert.equal(await close(run, closedId), `Commitment ${closedId}: done.`)
  assert.equal((await review(run, open, 'verify')).ok, true)
  const foreign = idOf(await record(run, { chat: ELSEWHERE, sourceMessageId: FOREIGN, text: 'Hidden commitment' }))
  run.team.state.bots.other = { id: 'other', name: 'Other Bot' }
  run.team.state.omniOwnership = { defaultBotId: 'other', channels: { [INSTANCE]: 'm1', [OTHER_INSTANCE]: 'other' } }
  assert.equal(run.team.extended.endpointOf('omni-commitments').read, true)
  const ids = rows => rows.map(row => row.id)
  assert.deepEqual(ids(await read(run)), [open, candidate, closedId])
  assert.deepEqual(ids(await read(run, { chat: CHAT, status: 'candidate' })), [candidate])
  assert.deepEqual(await read(run, { chat: ELSEWHERE }), [])
  assert.equal((await review(run, foreign, 'verify')).ok, false)
  assert.deepEqual((await list(run)).split('\n').map(line => line.split(' | ')[0]), [open, candidate, closedId])
  assert.match(await list(run, { verified: true, chat: CHAT }), new RegExp(`^${open} \\| open`))
  assert.match(await list(run, { status: 'candidate', verified: false }), new RegExp(`^${candidate} \\| candidate`))
  assert.deepEqual(ids(await read(run, { verified: true })), [open])
  assert.deepEqual(ids(await read(run, { status: 'done', verified: false })), [closedId])
  assert.deepEqual(await read(run, { status: 'done', verified: true }), [])
  await assert.rejects(read(run, { verified: 'false' }))
  const conversations = await run.call('omni-conversations', {})
  assert.deepEqual(conversations.chats.map(chat => [chat.id, chat.commitments]), [[CHAT, { candidate: 1, open: 1 }], [GROUP, { candidate: 0, open: 0 }]])
  assert.equal(conversations.summary.total, 2)
  const closedRow = (await read(run, { status: 'done' }))[0]
  assert.deepEqual(closedRow, {
    id: closedId, chatId: CHAT, channelId: INSTANCE, text: PRIVATE, owner: 'user',
    deadline: null,
    sourceAt: '2026-11-11T12:00:00.000Z', status: 'done', verified: false,
    createdAt: env.file().items[closedId].createdAt, updatedAt: env.file().items[closedId].updatedAt,
    closing: { at: AFTER },
  })
  assert.equal((await review(run, candidate, 'dismiss')).ok, true)
  assert.deepEqual(ids(await read(run)), [open, closedId])
  assert.deepEqual(ids(await read(run, { status: 'dismissed', verified: false })), [candidate])
  rmSync(join(env.home, LINK_FILE), { force: true })
  assert.deepEqual(await read(run), [])
  assert.equal(await list(run), 'No visible commitments match.')
})

test('two links that resolve the same chat and channel ids keep commitments separate', async (t) => {
  const backfill = { id: uuid(14), from: AT, to: AFTER, startedAt: 1, rows: [
    { chatId: CHAT, channelId: INSTANCE, outcome: 'done', state: 'done', counts: { stored: 1 } },
  ] }
  const env = fake(t, teamState({ omniBackfillRuns: [backfill] }))
  const run = await env.start()
  const first = idOf(await record(run, { text: 'First link commitment' }))
  assert.equal((await review(run, first, 'verify')).ok, true)
  await run.channels.flushOmniEventOutbox()
  const firstItem = env.file().items[first]
  assert.equal(firstItem.origin, OMNI)
  const counts = async () => (await run.call('omni-conversations', {})).chats[0].commitments
  assert.deepEqual(await counts(), { candidate: 0, open: 1 })

  const linkPath = join(env.home, LINK_FILE)
  const originalLink = JSON.parse(readFileSync(linkPath, 'utf8'))
  const secondOrigin = 'http://localhost'
  // The fake serves the same chat, channel and evidence IDs at both URLs.
  writeFileSync(linkPath, JSON.stringify({ ...originalLink, url: secondOrigin }), { mode: 0o600 })
  assert.deepEqual(await read(run), [])
  assert.equal(await list(run), 'No visible commitments match.')
  assert.deepEqual(await counts(), { candidate: 0, open: 0 })
  assert.equal((await review(run, first, 'verify')).ok, false)
  assert.match(await close(run, first), /No commitment chat available/)
  assert.deepEqual(env.file().items[first], firstItem)

  const second = idOf(await record(run, { text: 'Second link commitment' }))
  assert.notEqual(second, first)
  assert.equal(env.file().items[second].origin, secondOrigin)
  await run.channels.flushOmniEventOutbox()
  assert.deepEqual((await read(run)).map(item => item.id), [second])
  assert.match(await list(run), /Second link commitment$/)
  assert.deepEqual(await counts(), { candidate: 1, open: 0 })
  writeFileSync(linkPath, JSON.stringify(originalLink), { mode: 0o600 })
  assert.deepEqual(await read(run), [displayFields(firstItem)])
  assert.deepEqual(await counts(), { candidate: 0, open: 1 })
  assert.equal((await review(run, second, 'verify')).ok, false)
  assert.match(await close(run, second), /No commitment chat available/)
})

test('a legacy commitment with no origin stays on disk and is hidden after a new record', async (t) => {
  const env = fake(t)
  const run = await env.start()
  const id = idOf(await record(run))
  await run.channels.flushOmniEventOutbox()
  const legacy = env.file().items[id]
  legacy.id = createHash('sha256').update([CHAT, SOURCE, QUOTE].join('\0')).digest('hex').slice(0, 16)
  delete legacy.origin
  writeFileSync(env.path, JSON.stringify({ version: 1, items: { [legacy.id]: legacy } }), { mode: 0o600 })
  assert.deepEqual(await read(run), [])
  assert.equal((await review(run, legacy.id, 'verify')).ok, false)
  assert.match(await close(run, legacy.id), /No commitment chat available/)
  assert.equal(idOf(await record(run, { text: 'New commitment' })), id)
  assert.deepEqual(env.file().items[legacy.id], legacy)
  assert.deepEqual((await read(run)).map(item => item.id), [id])
})

test('listing is limited to 100 lines and resolves distinct chats at most eight at a time', async (t) => {
  const env = fake(t)
  const run = await env.start()
  const id = idOf(await record(run))
  await run.channels.flushOmniEventOutbox()
  const file = env.file()
  const known = new Set([CHAT])
  for (let n = 1; n <= 105; n++) {
    const itemId = n.toString(16).padStart(16, '0')
    const chatId = uuid(100 + (n % 10))
    known.add(chatId)
    file.items[itemId] = { ...file.items[id], id: itemId, chatId, text: 'One line\nper commitment' }
  }
  writeFileSync(env.path, JSON.stringify(file), { mode: 0o600 })
  let reads = 0
  let active = 0
  let max = 0
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const chat = new URL(url).pathname.split('/').at(-1)
    if (!known.has(chat)) return inner(url, init)
    reads++
    active++
    max = Math.max(max, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return Response.json({ data: { id: chat, instanceId: INSTANCE } })
  }
  const lines = (await list(run)).split('\n')
  assert.equal(lines.length, 100)
  assert.ok(lines.some(line => line.endsWith('One line per commitment')))
  assert.equal(reads, 11)
  assert.equal(max, 8)
})

test('an unreadable file stays put on reads and moves aside privately on a valid write', async (t) => {
  const env = fake(t)
  const unreadable = 'private but malformed'
  writeFileSync(env.path, unreadable, { mode: 0o644 })
  const run = await env.start()
  assert.deepEqual(await read(run), [])
  assert.equal(readFileSync(env.path, 'utf8'), unreadable)
  const id = idOf(await record(run))
  const aside = readdirSync(env.home).find(name => name.startsWith(`${COMMITMENTS_FILE}.unreadable-`))
  assert.ok(aside)
  assert.equal(statSync(join(env.home, aside)).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(env.home, aside), 'utf8'), unreadable)
  assert.equal(env.file().items[id].text, PRIVATE)
})
