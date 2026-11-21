import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { LINK_FILE } from '../src/host/omni-link.js'
import { boot, CHAT, ELSEWHERE, fakeOmni, GROUP, homeFor, INSTANCE, OMNI, readOnlyPresets, record, resetFetch, saved, teamState, until } from './thread-fixture.js'

afterEach(resetFetch)

const action = 'select_conversation_training'
const start = (t, home) => boot(t, home, { services: { permissionPresets: readOnlyPresets() } })
const owners = () => ({ defaultBotId: 'm1', channels: { [INSTANCE]: 'm1' } })
const answering = (answer = {}, extra = {}) => teamState({
  bots: { m1: { ...teamState().bots.m1, answer: { enabled: true, newChildMode: 'sending', ...answer } } },
  omniOwnership: owners(), ...extra,
})
const selection = async (run, chats, selected = true) => {
  const reply = await run.http(action, { chats, selected })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  return reply.value.results
}
const postEvents = (handle) => {
  const inner = globalThis.fetch
  globalThis.fetch = (url, init) => new URL(url).pathname.endsWith('/events/trigger')
    ? handle(JSON.parse(init.body), new URL(url)) : inner(url, init)
}
const trackFlush = (run) => {
  const flush = run.channels.flushOmniEventOutbox
  let latest
  run.channels.flushOmniEventOutbox = () => { latest = flush(); return latest }
  return () => latest
}

test('concurrent owner requests save one child born in training with its event, then retry it at startup', async (t) => {
  const omni = fakeOmni()
  const home = homeFor(t, omni, answering())
  const events = []
  let status = 429
  postEvents((body) => {
    events.push({ body, state: saved(home) })
    return new Response(null, { status })
  })
  const run = await start(t, home)
  const snapshots = []
  const save = run.channels.save
  run.channels.save = (options) => {
    snapshots.push(structuredClone(run.team.state))
    return save(options)
  }
  let deliveries = 0
  run.channels.deliver = () => { deliveries += 1 }
  const before = saved(home)
  const [[first], [again]] = await Promise.all([selection(run, [CHAT]), selection(run, [CHAT])])
  assert.deepEqual(first, { chatId: CHAT, selected: true, threadId: first.threadId, sendingMode: 'training', refusal: null })
  assert.deepEqual(first, again)
  const thread = saved(home).omniThreads[first.threadId]
  assert.ok(Number.isFinite(thread.trainingSelectedAt))
  assert.equal(thread.notes, '')
  const firstSave = snapshots.find(state => state.omniThreads?.[thread.id])
  assert.equal(firstSave.omniThreads[thread.id].sendingMode, 'training')
  assert.equal(firstSave.omniThreads[thread.id].trainingSelectedAt, thread.trainingSelectedAt)
  await until(() => events.length === 1)
  const event = {
    eventType: 'custom.omni-channels.training.selected', instanceId: INSTANCE,
    idempotencyKey: `training.selected:${thread.id}:${firstSave.revision + 1}`,
    payload: { chatId: CHAT, threadId: thread.id, selected: true, at: thread.trainingSelectedAt },
  }
  assert.deepEqual(events[0].body, event)
  const entry = { origin: OMNI, event }
  assert.deepEqual(events[0].state.omniEventOutbox, [entry])
  assert.equal(events[0].state.omniThreads[thread.id].trainingSelectedAt, thread.trainingSelectedAt)
  assert.deepEqual(saved(home).omniEventOutbox, [entry])
  assert.equal(run.view().omniThreads[0].trainingSelected, true)
  assert.deepEqual(run.made, [thread.sessionId])
  assert.equal(omni.asked.filter(call => call === 'POST /keys/children').length, 1)
  assert.deepEqual(omni.sent, [])
  assert.deepEqual(run.agentOf(thread.sessionId).calls, [])
  assert.deepEqual(run.agentOf('m1').calls, [])
  assert.deepEqual(saved(home).requests, before.requests)
  assert.deepEqual(saved(home).subscriptionRuns ?? [], before.subscriptionRuns ?? [])
  assert.equal(deliveries, 0)

  await run.stop()
  status = 201
  const restarted = await start(t, home)
  await until(() => events.length === 2 && saved(home).omniEventOutbox?.length === 0)
  assert.deepEqual(events[1].body, event)
  status = 403
  assert.deepEqual(await selection(restarted, [CHAT], false), [{ ...first, selected: false }])
  await until(() => events.length === 3 && saved(home).omniEventOutbox?.length === 0)
  assert.equal(events[2].body.eventType, 'custom.omni-channels.training.deselected')
  assert.ok(events[2].body.idempotencyKey.startsWith(`training.deselected:${thread.id}:`))
  assert.equal(events[2].state.omniThreads[thread.id].trainingSelectedAt, undefined)
  assert.equal(restarted.view().omniThreads[0].trainingSelected, false)
  assert.equal(saved(home).omniThreads[thread.id].sessionId, thread.sessionId)
  assert.deepEqual(restarted.archived, [])
})

test('a pending event for Omni A survives a restart on B and is sent on returning to A', async (t) => {
  const home = homeFor(t, fakeOmni(), answering())
  const path = join(home, LINK_FILE)
  const original = readFileSync(path, 'utf8')
  const attempts = []
  let available = false
  postEvents((body, url) => {
    attempts.push({ origin: url.origin, body })
    return available ? Response.json({ published: true }, { status: 201 }) : new Response(null, { status: 429 })
  })
  const first = await start(t, home)
  const flushed = trackFlush(first)
  assert.equal((await selection(first, [CHAT]))[0].selected, true)
  await flushed()
  const [entry] = saved(home).omniEventOutbox
  assert.equal(entry.origin, OMNI)
  assert.deepEqual(attempts, [{ origin: OMNI, body: entry.event }])
  await first.stop()

  available = true
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), url: 'https://other-omni.example.com', key: 'test-key-b' }))
  const restarted = await start(t, home)
  await restarted.channels.flushOmniEventOutbox()
  assert.deepEqual(saved(home).omniEventOutbox, [entry])
  assert.equal(attempts.length, 1)

  writeFileSync(path, original)
  await restarted.channels.flushOmniEventOutbox()
  assert.deepEqual(attempts, [{ origin: OMNI, body: entry.event }, { origin: OMNI, body: entry.event }])
  assert.deepEqual(saved(home).omniEventOutbox, [])
})

test('a 201 without a publish retries with the same key and a confirmed duplicate settles it', async (t) => {
  const home = homeFor(t, fakeOmni(), answering())
  const attempts = []
  let duplicate = false
  postEvents((body) => {
    attempts.push(body)
    return Response.json({ published: false, ...(duplicate ? { duplicate } : {}) }, { status: 201 })
  })
  const run = await start(t, home)
  const flushed = trackFlush(run)
  await selection(run, [CHAT])
  await flushed()
  const [entry] = saved(home).omniEventOutbox
  assert.deepEqual(attempts, [entry.event])

  duplicate = true
  await run.channels.flushOmniEventOutbox()
  assert.deepEqual(attempts, [entry.event, entry.event])
  assert.deepEqual(saved(home).omniEventOutbox, [])
})

test('a failed selection keeps its later deselection pending until both can reach the journal in order', async (t) => {
  const home = homeFor(t, fakeOmni(), answering())
  const attempts = []
  const journal = []
  const selected = 'custom.omni-channels.training.selected'
  const deselected = 'custom.omni-channels.training.deselected'
  postEvents(({ eventType }) => {
    attempts.push(eventType)
    if (eventType === selected && attempts.length <= 2) return new Response(null, { status: 429 })
    journal.push(eventType)
    return Response.json({ published: true }, { status: 201 })
  })
  const run = await start(t, home)
  const flushed = trackFlush(run)
  assert.equal((await selection(run, [CHAT]))[0].selected, true)
  await flushed()
  assert.equal((await selection(run, [CHAT], false))[0].selected, false)
  await flushed()
  assert.deepEqual(attempts, [selected, selected])
  assert.deepEqual(journal, [])
  assert.deepEqual(saved(home).omniEventOutbox.map(({ event }) => event.eventType), [selected, deselected])

  await run.channels.flushOmniEventOutbox()
  assert.deepEqual(attempts, [selected, selected, selected, deselected])
  assert.deepEqual(journal, [selected, deselected])
  assert.deepEqual(saved(home).omniEventOutbox, [])
})

test('a failed deselection reports the restored selection only while the owner remains authorized', async (t) => {
  const home = homeFor(t, fakeOmni(), answering())
  postEvents(() => Response.json({ published: true }, { status: 201 }))
  const run = await start(t, home)
  const flushed = trackFlush(run)
  const [selected] = await selection(run, [CHAT])
  await flushed()
  const thread = saved(home).omniThreads[selected.threadId]
  assert.ok(Number.isFinite(thread.trainingSelectedAt))
  const save = run.channels.save
  let loseOwner = false
  run.channels.save = async (options) => {
    if (!options?.required) return save(options)
    if (loseOwner) delete run.team.state.omniOwnership.channels[INSTANCE]
    throw new Error('Required save failed.')
  }

  assert.deepEqual(await selection(run, [CHAT], false), [{ ...selected, refusal: 'Required save failed.' }])
  assert.equal(run.team.state.omniThreads[thread.id].trainingSelectedAt, thread.trainingSelectedAt)
  assert.equal(saved(home).omniThreads[thread.id].trainingSelectedAt, thread.trainingSelectedAt)
  assert.deepEqual(saved(home).omniEventOutbox, [])

  loseOwner = true
  const [closed] = await selection(run, [CHAT], false)
  assert.deepEqual(closed, { chatId: CHAT, selected: false, threadId: null, sendingMode: null, refusal: 'This chat needs a channel with the same explicit Bot owner.' })
})

for (const first of ['inbound', 'selection']) {
  test(`overlapping inbound and training selection create one child when ${first} reaches mint first`, async (t) => {
    const omni = fakeOmni()
    const home = homeFor(t, omni, answering())
    const run = await start(t, home)
    const mintStarted = Promise.withResolvers()
    const mintMayFinish = Promise.withResolvers()
    const mint = run.channels.threadKeys.mint
    run.channels.threadKeys.mint = async (...args) => {
      mintStarted.resolve()
      await mintMayFinish.promise
      return mint(...args)
    }
    const inbound = () => run.channels.threads.answerFor({ ownerBotId: 'm1', channelId: INSTANCE, chatId: CHAT })
    const select = () => selection(run, [CHAT])
    const started = first === 'inbound' ? inbound() : select()
    await mintStarted.promise
    const overlapping = first === 'inbound' ? select() : inbound()
    await new Promise(resolve => setImmediate(resolve))
    mintMayFinish.resolve()
    const [child, [selected]] = await Promise.all(first === 'inbound' ? [started, overlapping] : [overlapping, started])
    const mode = first === 'inbound' ? 'sending' : 'training'
    assert.deepEqual(selected, { chatId: CHAT, selected: true, threadId: child.id, sendingMode: mode, refusal: null })
    assert.deepEqual(Object.keys(saved(home).omniThreads), [child.id])
    assert.equal(saved(home).omniThreads[child.id].sendingMode, mode)
    assert.equal(child.sendingMode, mode)
    assert.deepEqual(run.made, [child.sessionId])
    assert.equal(omni.asked.filter(call => call === 'POST /keys/children').length, 1)
  })
}

test('selection reuses an inbound-first child and preserves sending mode, streak, pause and binding', async (t) => {
  const omni = fakeOmni()
  const home = homeFor(t, omni, answering())
  const run = await start(t, home)
  const child = await run.channels.threads.answerFor({ ownerBotId: 'm1', channelId: INSTANCE, chatId: CHAT })
  const kept = { sendingMode: 'sending', approvedStreak: 5, paused: true, lastStaffAt: Date.now(), personRuleId: 'kept-rule' }
  Object.assign(child, kept)
  await run.channels.save()
  const [selected] = await selection(run, [CHAT])
  assert.deepEqual(selected, { chatId: CHAT, selected: true, threadId: child.id, sendingMode: 'sending', refusal: null })
  const stored = saved(home).omniThreads[child.id]
  for (const [field, value] of Object.entries(kept)) assert.equal(stored[field], value, field)
  assert.equal(run.made.length, 1)
  assert.equal(omni.children().length, 1)
  assert.equal((await run.http('omni-thread-remove', { threadId: child.id })).ok, true)
  assert.equal(saved(home).omniThreads[child.id], undefined)
})

test('owner route validates input and refuses ineligible chats without provisioning them', async (t) => {
  const omni = fakeOmni()
  const threadId = randomUUID()
  const home = homeFor(t, omni, answering({}, { omniThreads: { [threadId]: record(threadId, 'ordinary', { ownerBotId: 'm1' }) } }))
  const run = await start(t, home)
  assert.equal((await run.http(action, { chats: [CHAT], selected: true, extra: 1 })).ok, false)
  const [group, ordinary, unowned] = await selection(run, [GROUP, CHAT, ELSEWHERE])
  assert.match(group.refusal, /requires a direct chat/)
  assert.match(ordinary.refusal, /non-answer thread/)
  assert.match(unowned.refusal, /explicit Bot owner/)
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const response = await inner(url, init)
    if (new URL(url).pathname.endsWith(`/chats/${GROUP}`) && response.ok) {
      const { data } = await response.json()
      return Response.json({ data: { ...data, chatType: 'dm' } })
    }
    return response
  }
  assert.match((await selection(run, [GROUP]))[0].refusal, /requires a direct chat/)
  run.team.state.bots.m1.answer.needsStaffChatId = CHAT
  assert.match((await selection(run, [CHAT]))[0].refusal, /staff chat/)
  run.team.state.bots.m1.answer.enabled = false
  assert.match((await selection(run, [CHAT]))[0].refusal, /Answer Mode is off/)
  assert.deepEqual(run.made, [])
  assert.deepEqual(omni.children(), [])
  assert.deepEqual(saved(home).omniThreads[threadId], record(threadId, 'ordinary', { ownerBotId: 'm1' }))
})

test('the HTTP route refuses a read-only host and an authority change during chat lookup or child setup', async (t) => {
  const omni = fakeOmni()
  const home = homeFor(t, omni, answering())
  const run = await start(t, home)
  let readOnly = 'Read-only for this test.'
  run.team.readOnly = () => readOnly
  assert.equal((await run.http(action, { chats: [CHAT], selected: true })).error.code, 'bot/read-only')
  const inner = globalThis.fetch
  readOnly = undefined
  globalThis.fetch = async (url, init) => {
    const response = await inner(url, init)
    if (new URL(url).pathname.endsWith(`/chats/${CHAT}`)) readOnly = 'Became read-only during lookup.'
    return response
  }
  assert.match((await selection(run, [CHAT]))[0].refusal, /Became read-only/)
  assert.deepEqual(run.made, [])
  assert.deepEqual(omni.children(), [])
  assert.equal(Object.keys(saved(home).omniThreads ?? {}).length, 0)
  assert.equal(saved(home).omniEventOutbox, undefined)

  globalThis.fetch = inner
  readOnly = undefined
  const prepare = run.channels.prepareAnswerThread
  run.channels.prepareAnswerThread = async (thread) => {
    await prepare(thread)
    delete run.team.state.omniOwnership.channels[INSTANCE]
  }
  assert.match((await selection(run, [CHAT]))[0].refusal, /same explicit Bot owner/)
  assert.equal(run.made.length, 1)
  assert.deepEqual(run.archived, run.made)
  assert.equal(omni.children()[0].revoked, true)
  assert.equal(Object.keys(saved(home).omniThreads ?? {}).length, 0)
  assert.equal(saved(home).omniEventOutbox, undefined)
})
