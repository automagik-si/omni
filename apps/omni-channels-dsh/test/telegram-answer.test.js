import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/omni-events.js'
import { answerBench, ANSWER_CLOCK, CHAT, CHATS, dsh, ELSEWHERE, GROUP, INSTANCE, OTHER_INSTANCE, signal, until } from './thread-fixture.js'

const ADDRESS = '824600001'
const SENDER = '824600002'
const reply = data => ({ ok: true, json: async () => ({ data }) })
const incoming = (changes = {}) => ({
  id: 'telegram-row-1', journalSeq: 1, externalId: 'telegram-message-1', eventType: 'message.received',
  direction: 'inbound', instanceId: INSTANCE, chatUuid: CHAT, chatId: ADDRESS,
  metadata: { from: SENDER }, textContent: 'Can you help with my order?', rawPayload: {}, ...changes,
})

// The real subscription, intake, child and send gates, with only Omni and DSH mocked.
async function bench(t, { allowed = true } = {}) {
  const before = { ...CHATS }
  CHATS[CHAT] = { id: CHAT, instanceId: INSTANCE, externalId: ADDRESS, chatType: 'dm', name: 'Person' }
  CHATS[GROUP] = { id: GROUP, instanceId: INSTANCE, externalId: '-824600003', chatType: 'group', name: 'Group' }
  CHATS[ELSEWHERE] = { id: ELSEWHERE, instanceId: OTHER_INSTANCE, externalId: '824600004', chatType: 'dm', name: 'Other person' }
  t.after(() => Object.assign(CHATS, before))
  const b = await answerBench(t, { clock: ANSWER_CLOCK })
  await b.channels.quiesceOmniEvents()
  const request = b.channels.omniRequest
  const checks = [], acks = [], queuedAtAck = []
  let queue = [], wake, closed = false
  b.channels.omniRequest = async (method, path, args) => {
    if (path === `/instances/${INSTANCE}`) return reply({ channel: 'telegram', inboundMaxAgeMinutes: 10 })
    if (path === '/access/check') { checks.push(args.body); return reply({ allowed }) }
    if (path === '/automations?enabled=true') return { ok: true, json: async () => ({ items: [] }) }
    if (path === '/events/consumers' || method === 'DELETE' && path.startsWith('/events/consumers/')) return { ok: true }
    if (path.endsWith('/ack')) {
      queuedAtAck.push(b.team.state.subscriptionRuns.length)
      acks.push(args.body.cursor)
      return { ok: true }
    }
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
  install(b.channels)
  await b.channels.syncOmniEvents()
  t.after(() => b.channels.quiesceOmniEvents())
  return { ...b, checks, acks, queuedAtAck, async deliver(row) {
    const before = acks.length
    queue.push(row)
    wake?.()
    await until(() => acks.length > before && acks.at(-1) === row.journalSeq)
  } }
}

test('Telegram DM: SSE admits the sender, queues before ack, wakes its child and sends to the canonical address', async t => {
  const b = await bench(t)
  await b.deliver(incoming())
  assert.deepEqual(b.checks, [{ instanceId: INSTANCE, platformUserId: SENDER, channel: 'telegram' }])
  assert.deepEqual(b.queuedAtAck, [1])
  const child = b.channels.threads.byChat(CHAT)
  assert.equal(child.answerChild, true)
  assert.equal(child.chatJid, ADDRESS)
  await signal(t, b)
  await until(() => b.agentOf(child.sessionId).calls.length === 1)
  assert.match(JSON.stringify(b.agentOf(child.sessionId).calls[0]), /Can you help with my order/)
  const sent = await dsh(b, 'thread_say', child.sessionId, { text: 'I can help.' })
  assert.equal(sent.card, true, 'the existing training approval still applies')
  assert.match(sent.result, /Sent into the chat/)
  assert.deepEqual(b.omni.sent.map(({ path, body }) => ({ path, body })), [
    { path: '/messages/send', body: { instanceId: INSTANCE, to: ADDRESS, text: 'I can help.' } },
  ])
  assert.deepEqual(b.acks, [1])
  await b.deliver(incoming())
  assert.equal(b.team.state.subscriptionRuns.length, 1, 'replay does not queue a second answer')
  assert.equal(b.omni.sent.length, 1)
})

for (const [label, options, row, accessChecks] of [
  ['denied sender', { allowed: false }, incoming(), 1],
  ['group chat', {}, incoming({ chatUuid: GROUP, chatId: '-824600003' }), 0],
  ['another instance', {}, incoming({ instanceId: OTHER_INSTANCE, chatUuid: ELSEWHERE, chatId: '824600004' }), 0],
]) test(`Telegram DM: ${label} is acked without a child, wake or send`, async t => {
  const b = await bench(t, options)
  await b.deliver(row)
  await signal(t, b)
  assert.equal(b.checks.length, accessChecks)
  assert.equal(b.channels.threads.list().length, 0)
  assert.equal(b.team.state.subscriptionRuns.length, 0)
  assert.equal(b.omni.sent.length, 0)
  assert.deepEqual(b.acks, [1])
})
