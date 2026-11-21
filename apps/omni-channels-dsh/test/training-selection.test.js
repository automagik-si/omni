import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { boot, CHAT, ELSEWHERE, fakeOmni, GROUP, homeFor, INSTANCE, readOnlyPresets, record, resetFetch, saved, teamState, until } from './thread-fixture.js'

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
    ? handle(JSON.parse(init.body)) : inner(url, init)
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
  assert.deepEqual(events[0].state.omniEventOutbox, [event])
  assert.equal(events[0].state.omniThreads[thread.id].trainingSelectedAt, thread.trainingSelectedAt)
  assert.deepEqual(saved(home).omniEventOutbox, [event])
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
