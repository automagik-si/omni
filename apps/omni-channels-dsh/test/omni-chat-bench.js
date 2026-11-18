// One chat on a stand-in Omni, answering as Omni's routes do (packages/api), and the host's
// endpoints the chat views call, run on it (#1773). Nothing leaves the test.
//
// - POST /messages/send answers 201 with the channel's message id and stores no row
//   (routes/v2/messages.ts). The row comes later, when Omni's message.sent consumer runs
//   (plugins/message-persistence.ts): `persist()` here. It carries that id as its externalId,
//   isFromMe true and source 'realtime'.
// - GET /chats/:id answers { data: chat }; GET /chats/:id/messages answers { items }, newest
//   first, at most `limit` (services/messages.ts getChatMessages).
//
// `call` routes the views' endpoints: omni-messages and omni-send through the host's own code
// (omni.js, omni-channel-actions.js); omni-phone-send as thread-tools.js answers it once Omni
// accepted the send (phone-send.test.js covers that endpoint itself).

import { randomUUID } from 'node:crypto'
import { KEY, install as installOmni } from '../src/host/omni.js'
import { install as installActions } from '../src/host/omni-channel-actions.js'
import { install as installHooks } from '@automagik/bots-dsh/src/host/extend.js'

const ORIGIN = 'https://omni.bench'
const SECRET = 'omni_sk_bench'

export function chatBench({ chatId, instanceId = '33333333-3333-4333-8333-333333333333', rows = [], messageIds = true } = {}) {
  const chat = { id: chatId, instanceId, externalId: 'person-1@bench', chatType: 'dm', name: 'Person One' }
  const stored = rows.map(row => ({ chatId, ...row }))
  const queued = []
  let sends = 0
  let clock = Date.parse('2026-11-15T12:00:00.000Z')

  const answer = (method, path, body) => {
    const [route, query = ''] = path.split('?')
    if (method === 'GET' && route === `/chats/${chatId}`) return [200, { data: chat }]
    if (method === 'GET' && route === `/chats/${chatId}/messages`) {
      const limit = Number(new URLSearchParams(query).get('limit') ?? 100)
      const items = stored.toSorted((a, b) => Date.parse(b.platformTimestamp) - Date.parse(a.platformTimestamp)).slice(0, limit)
      return [200, { items: structuredClone(items) }]
    }
    if (method === 'POST' && route === '/messages/send') {
      sends += 1
      clock += 1000
      const externalId = `CHANNEL-MSG-${sends}`
      queued.push({ externalId, text: body.text, at: new Date(clock).toISOString() })
      // A channel that names no id answers with an empty one.
      return [201, { data: { messageId: messageIds ? externalId : '', externalMessageId: messageIds ? externalId : '', status: 'sent', instanceId: body.instanceId, to: body.to, timestamp: clock } }]
    }
    return [404, { error: { code: 'NOT_FOUND', message: `no route ${method} ${path}` } }]
  }

  // Omni's message.sent consumer: each accepted send becomes its row (the first `count` of them).
  const persist = (count = queued.length) => {
    for (const sent of queued.splice(0, count)) {
      stored.push({
        id: randomUUID(), chatId, externalId: sent.externalId, source: 'realtime', isFromMe: true, senderDisplayName: null,
        messageType: 'text', textContent: sent.text, hasMedia: false, platformTimestamp: sent.at, createdAt: sent.at, deliveryStatus: 'sent',
      })
    }
  }

  // The host's omni.js reads Omni with fetch; omni-channel-actions.js through rt.omniRequest.
  const fetch = async (address, init = {}) => {
    const path = String(address).replace(`${ORIGIN}/api/v2`, '')
    const [status, json] = answer(init.method ?? 'GET', path, init.body ? JSON.parse(init.body) : undefined)
    return new Response(JSON.stringify(json), { status })
  }
  const rt = {
    config: { omni: { url: ORIGIN } },
    ctx: { effect: run => run(), get: name => (name === 'credentials' ? { resolve: async ref => (ref === KEY ? { value: SECRET } : undefined) } : undefined) },
    omniRequest: async (method, path, { body } = {}) => {
      const [status, json] = answer(method, path, body)
      return new Response(JSON.stringify(json), { status })
    },
  }
  installHooks(rt)
  installOmni(rt)
  installActions(rt)

  // Only this bench's origin is answered here; any other address goes where it went before.
  const before = globalThis.fetch
  globalThis.fetch = (address, init) => (String(address).startsWith(ORIGIN) ? fetch(address, init) : before(address, init))

  const call = async (endpoint, body) => {
    if (endpoint === 'omni-messages') return rt.omniEndpoint('omni-messages', body)
    if (endpoint === 'omni-send') return rt.omniChannelEndpoint('omni-send', body)
    if (endpoint === 'omni-phone-send') {
      const sent = await rt.omniRequest('POST', '/messages/send', { body: { instanceId: chat.instanceId, to: chat.externalId, text: body.text.trim() } })
      const reply = await sent.json()
      return { sent: true, messageId: reply.data.messageId || null, paused: false, draft: null }
    }
    throw new Error(`the bench has no endpoint ${endpoint}`)
  }

  return { chat, stored, queued, persist, call, answer }
}

/** A row Omni stored for a message the person in the chat wrote. */
export const theirRow = (chatId, text, at, extra = {}) => ({
  id: randomUUID(), chatId, externalId: `THEIR-${randomUUID()}`, source: 'realtime', isFromMe: false, senderDisplayName: 'Person One',
  messageType: 'text', textContent: text, hasMedia: false, platformTimestamp: at, createdAt: at, ...extra,
})
