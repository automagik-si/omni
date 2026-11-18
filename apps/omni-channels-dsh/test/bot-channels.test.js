// Each Bot's channels for the team's left bar, and one Bot's chats when the bar opens it
// (src/host/bot-channels.js, #1781), on the real plugin framework: a real cordis Context with
// DSH's own session store, projections, agent registry, LLM runtime, Session titles, system
// prompt, tool runtime and native tool executor, the real Bot team and this plugin loaded
// through root.plugin with their own inject lists (start() as test/reading.test.js has it).
// Only the host services that need a live server, a filesystem workspace or a browser are
// provided small here; the Session controller makes and resolves Sessions, which confirming a
// new Bot for a channel needs. Omni is a fake of the routes these read, kept in one place: fakeOmni.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as team from '@automagik/bots-dsh'
import * as channels from '../index.js'
import { LINK_FILE } from '../src/host/omni-link.js'
import { CHANNELS_FRESH_MS, CHATS_MAX, NO_CHANNEL, NOT_OWNED, NOT_READABLE, UNKNOWN_BOT, barStatusOf, chatStatusOf } from '../src/host/bot-channels.js'
import { INSTANCE, OMNI, OTHER_INSTANCE, OWNER, record, resetFetch, teamState, until } from './thread-fixture.js'

afterEach(resetFetch)
const dshHome = mkdtempSync(join(tmpdir(), 'omni-bot-channels-dsh-'))
process.env.DSH_HOME = dshHome
after(() => rmSync(dshHome, { recursive: true, force: true }))

const LINK_KEY = 'omni_sk_link_bot_channels'
const PAIRING = '6a1d2e3f-4b5c-4d6e-8f70-0a1b2c3d4e10'
const BROKEN = '6a1d2e3f-4b5c-4d6e-8f70-0a1b2c3d4e11'
const OWNER_JID = `${OWNER}:7@s.whatsapp.net`
const chatId = n => `7b2c0d2e-3b4f-4c5d-8e6f-${String(n).padStart(12, '0')}`
const personId = n => `8c3d0d2e-3b4f-4c5d-8e6f-${String(n).padStart(12, '0')}`
const SECRET = 'the text of a message'
const at = n => new Date(Date.parse('2026-11-01T00:00:00.000Z') + n * 60_000).toISOString()
// 130 chats on INSTANCE: the owner's own chat (1), a group (2), the rest direct; 3 on OTHER_INSTANCE.
const chatRow = (n, instanceId, extra = {}) => ({
  id: chatId(n), instanceId, externalId: `55119${String(n).padStart(8, '0')}@s.whatsapp.net`, canonicalId: null, chatType: 'dm', channel: 'whatsapp-baileys',
  name: `Person ${n}`, avatarUrl: null, unreadCount: n % 3, lastMessageAt: at(n), lastMessagePreview: `${SECRET} ${n}`, lastMessageFromMe: false, updatedAt: at(n), ...extra,
})
const CHATS = [
  chatRow(1, INSTANCE, { externalId: '200000000000001@lid', canonicalId: `${OWNER}@s.whatsapp.net`, name: null, lastMessageAt: at(60.5) }),
  chatRow(2, INSTANCE, { chatType: 'group', externalId: '120363000000000002@g.us', name: 'Suppliers', avatarUrl: 'https://photos.example/group.png', lastMessageAt: at(61.5) }),
  ...Array.from({ length: 128 }, (_, n) => chatRow(n + 3, INSTANCE, n === 0 ? { avatarUrl: 'javascript:alert(1)' } : {})),
  ...Array.from({ length: 3 }, (_, n) => chatRow(500 + n, OTHER_INSTANCE, { channel: 'telegram', externalId: String(9000 + n) })),
]

// The routes the bar's reads use: the channels and their states, a channel's chats, one chat, a
// direct chat's participants and their person's identities; the overview's too. `states` changes a
// channel's state between reads.
function fakeOmni() {
  const asked = []
  const states = { [INSTANCE]: 'connected', [OTHER_INSTANCE]: 'qr', [PAIRING]: 'connecting' }
  const instances = [
    { id: INSTANCE, name: 'Sales', channel: 'whatsapp-baileys', isActive: true, ownerIdentifier: OWNER_JID },
    { id: OTHER_INSTANCE, name: 'Support bot', channel: 'telegram', isActive: true, ownerIdentifier: null },
    { id: PAIRING, name: 'Old phone', channel: 'whatsapp-baileys', isActive: false, ownerIdentifier: null },
    { id: BROKEN, name: 'Broken', channel: 'discord', isActive: true, ownerIdentifier: null },
  ]
  const json = (status, body) => new Response(JSON.stringify(body), { status })
  globalThis.fetch = async (address, init = {}) => {
    const url = new URL(String(address))
    const method = init.method ?? 'GET'
    const path = url.pathname.replace(/^\/api\/v2/, '')
    asked.push({ method, path, query: Object.fromEntries(url.searchParams) })
    if (url.origin !== OMNI || init.headers?.['x-api-key'] !== LINK_KEY) return json(401, { error: { code: 'UNAUTHORIZED' } })
    if (method !== 'GET') return json(404, { error: { code: 'NOT_FOUND' } })
    if (path === '/instances') return json(200, { items: instances })
    const status = /^\/instances\/([^/]+)\/status$/.exec(path)?.[1]
    if (status !== undefined) return states[status] ? json(200, { data: { instanceId: status, state: states[status], isConnected: states[status] === 'connected' } }) : json(500, { error: { code: 'INTERNAL' } })
    if (/^\/instances\/[^/]+\/routes$/.test(path)) return json(200, { items: [] })
    if (path === '/agents') return json(200, { items: [] })
    if (path === '/chats') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const own = CHATS.filter(chat => !url.searchParams.get('instanceId') || chat.instanceId === url.searchParams.get('instanceId')).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      return json(200, { items: own.slice(0, limit), meta: { hasMore: own.length > limit } })
    }
    const one = /^\/chats\/([^/]+)$/.exec(path)?.[1]
    if (one !== undefined) {
      const chat = CHATS.find(item => item.id === one)
      return chat ? json(200, { data: chat }) : json(404, { error: { code: 'NOT_FOUND' } })
    }
    const participants = /^\/chats\/([^/]+)\/participants$/.exec(path)?.[1]
    if (participants !== undefined) {
      const n = Number(participants.slice(-12))
      const chat = CHATS.find(item => item.id === participants)
      return json(200, { items: [{ platformUserId: `${OWNER}@s.whatsapp.net`, personId: personId(0) }, { platformUserId: chat?.externalId, personId: personId(n) }] })
    }
    const person = /^\/persons\/([^/]+)\/presence$/.exec(path)?.[1]
    if (person !== undefined) {
      const n = Number(person.slice(-12))
      const chat = CHATS.find(item => Number(item.id.slice(-12)) === n)
      return json(200, { data: { person: { id: person }, identities: [{ platformUserId: 'elsewhere', profilePicUrl: 'https://photos.example/elsewhere.png' }, { platformUserId: chat?.externalId, profilePicUrl: n === 4 ? 'javascript:alert(1)' : `https://photos.example/${n}.png` }] } })
    }
    return json(404, { error: { code: 'NOT_FOUND' } })
  }
  return { asked, states, reads: pattern => asked.filter(call => pattern.test(call.path)) }
}

function homeWith(t, state = teamState()) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-bot-channels-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(dir, 'home')
  mkdirSync(home)
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  writeFileSync(join(home, LINK_FILE), JSON.stringify({ url: OMNI, key: LINK_KEY, keyId: 'link-1', scopes: ['*'], pairedAt: '2026-10-27T00:00:00.000Z' }))
  return home
}

// One DSH start on `home`; `stop` disposes it before the home goes.
async function start(t, home) {
  const root = new Context()
  let sessions = 0
  const titles = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }
  for (const [plugin, config] of [[SessionStore], [SessionProjectionRegistry], [AgentRegistry], [LlmRuntime], [SessionTitleService, titles], [SystemPrompt, {}], [ToolRuntime, {}], [NativeToolExecutor]]) await root.plugin(plugin, config)
  await root.plugin(Object.assign((ctx) => {
    ctx.provide('connection', { fetch: { register: () => () => {} } })
    ctx.provide('sessionController', { create: async () => ({ sessionId: `s${++sessions}` }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => ({}) })
    ctx.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, archivedSessionIds: [] })
    ctx.provide('settings', {})
  }, { inject: [] }))
  await root.plugin(team, { home })
  await root.plugin(channels, {})
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await root.fiber.dispose()
  }
  t.after(stop)
  const omniTeam = root.get('omniTeam')
  await omniTeam.load()
  const endpoint = (name, body) => omniTeam.extended.endpointOf(name).fn(body)
  // What every state answer carries now, as the team sends it (channel.js).
  const live = () => omniTeam.extended.live().omniBotChannels
  // The channels as the bar first sees them: the first pull starts the read, a later one has it.
  const settled = async () => {
    live()
    await until(() => live().m1 !== undefined)
    return live()
  }
  return { root, team: omniTeam, plugin: root.get('omniChannels'), endpoint, live, settled, stop }
}

const CHANNELS_OF_M1 = [
  { id: INSTANCE, name: 'Sales', kind: 'whatsapp-baileys', status: 'connected' },
  { id: OTHER_INSTANCE, name: 'Support bot', kind: 'telegram', status: 'needs-pairing' },
  { id: PAIRING, name: 'Old phone', kind: 'whatsapp-baileys', status: 'disconnected' },
  { id: BROKEN, name: 'Broken', kind: 'discord', status: 'error' },
]

test('the team view carries each Bot\'s channels with their status, read once per 30 s while the state is pulled and never a chat', async (t) => {
  const omni = fakeOmni()
  const dsh = await start(t, homeWith(t))
  // The first pull has nothing yet and starts one read; pulls meanwhile start no other.
  assert.deepEqual(dsh.live(), {})
  for (let n = 0; n < 5; n += 1) dsh.live()
  assert.deepEqual(await dsh.settled(), { m1: CHANNELS_OF_M1 })
  assert.equal(omni.reads(/^\/instances$/).length, 1)
  // Within CHANNELS_FRESH_MS, pulls read nothing more; no chat is read for the view.
  for (let n = 0; n < 5; n += 1) dsh.live()
  assert.equal(omni.reads(/^\/instances$/).length, 1)
  assert.deepEqual(omni.reads(/^\/chats|^\/persons/), [])
  // The overview's read (the Channels page, the Omni tree) brings a new state without a read of its own.
  omni.states[OTHER_INSTANCE] = 'connected'
  await dsh.endpoint('omni-overview', {})
  assert.equal(omni.reads(/^\/instances$/).length, 2)
  assert.equal(dsh.live().m1[1].status, 'connected')
  assert.equal(omni.reads(/^\/instances$/).length, 2)
  // Once the read is older than CHANNELS_FRESH_MS, the next pull reads again, once.
  omni.states[INSTANCE] = 'qr'
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + CHANNELS_FRESH_MS + 1)
  dsh.live()
  dsh.live()
  await until(() => dsh.live().m1[0].status === 'needs-pairing')
  assert.equal(omni.reads(/^\/instances$/).length, 3)
})

test('Omni not reachable: the channels it had turn to error; no link, no channels', async (t) => {
  fakeOmni()
  const dsh = await start(t, homeWith(t))
  await dsh.settled()
  globalThis.fetch = async () => { throw new Error('offline') }
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + CHANNELS_FRESH_MS + 1)
  dsh.live()
  await until(() => dsh.live().m1.every(channel => channel.status === 'error'))
  assert.deepEqual(dsh.live().m1.map(channel => channel.id), CHANNELS_OF_M1.map(channel => channel.id))
  // Disconnected from Omni: nothing to draw.
  await dsh.endpoint('omni-disconnect', {})
  assert.deepEqual(dsh.live(), {})
})

test('a first read that fails waits its 30 s too: pulls meanwhile read nothing, and the bar has no channels', async (t) => {
  const asked = []
  globalThis.fetch = async (address) => { asked.push(String(address)); throw new Error('offline') }
  const dsh = await start(t, homeWith(t))
  const reads = () => asked.filter(address => address.endsWith('/instances?limit=100')).length
  dsh.live()
  await until(() => reads() === 1)
  for (let n = 0; n < 5; n += 1) dsh.live()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads(), 1)
  assert.deepEqual(dsh.live(), {})
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + CHANNELS_FRESH_MS + 1)
  dsh.live()
  await until(() => reads() === 2)
})

test('the overview lists the chat open in the chat view though its newest chats do not hold it', async (t) => {
  const omni = fakeOmni()
  const dsh = await start(t, homeWith(t))
  const quiet = chatId(3)
  const plain = await dsh.endpoint('omni-overview', {})
  assert.equal(plain.chats.length, 100)
  assert.ok(!plain.chats.some(chat => chat.id === quiet))
  assert.deepEqual(omni.reads(/^\/chats\/[^/]+$/), [])
  const open = await dsh.endpoint('omni-overview', { chatId: quiet })
  assert.equal(open.chats.length, 101)
  assert.deepEqual(open.chats.at(-1), { ...open.chats.at(-1), id: quiet, channelId: INSTANCE, name: 'Person 3' })
  // One already listed, or an odd id, reads nothing more.
  await dsh.endpoint('omni-overview', { chatId: chatId(130) })
  await dsh.endpoint('omni-overview', { chatId: '../keys' })
  assert.equal(omni.reads(/^\/chats\/[^/]+$/).length, 1)
})

// A second Bot of the team, of kind omni, as confirming a channel's own Bot makes it
// (subscriptions.js confirm, which needs a live DSH Session this bench does not make).
const SERVICE = 'service-bot'
const withService = (extra = {}) => teamState({
  bots: { ...teamState().bots, [SERVICE]: { id: SERVICE, kind: 'omni', name: 'Service', instructions: '', model: 'deepseek/flash', createdAt: 2 } },
  omniOwnership: { defaultBotId: 'm1', channels: {} },
  ...extra,
})

test('a channel moved to another Bot moves to it in the view; the endpoint then refuses it to the first', async (t) => {
  fakeOmni()
  const dsh = await start(t, homeWith(t, withService()))
  assert.deepEqual(await dsh.settled(), { m1: CHANNELS_OF_M1 })
  // The move as confirm writes it: the channel's owner in the team's ownership.
  dsh.team.state.omniOwnership = { defaultBotId: 'm1', channels: { [OTHER_INSTANCE]: SERVICE } }
  const view = dsh.live()
  assert.deepEqual(view, { m1: CHANNELS_OF_M1.filter(channel => channel.id !== OTHER_INSTANCE), [SERVICE]: [CHANNELS_OF_M1[1]] })
  // m1 reads every channel as the events Bot, but this one is not its own any more.
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: 'm1', channelId: OTHER_INSTANCE }), { code: 'bot/refused', message: NOT_OWNED })
  const theirs = await dsh.endpoint('omni-bot-chats', { botId: SERVICE })
  assert.deepEqual(theirs.channels.map(channel => [channel.channelId, channel.chats.length]), [[OTHER_INSTANCE, 3]])
  const mine = await dsh.endpoint('omni-bot-chats', { botId: 'm1' })
  assert.deepEqual(mine.channels.map(channel => channel.channelId), [INSTANCE, PAIRING, BROKEN])
  // And back.
  dsh.team.state.omniOwnership = { defaultBotId: 'm1', channels: {} }
  assert.deepEqual(dsh.live(), { m1: CHANNELS_OF_M1 })
})

test('a Bot\'s chats come only from the endpoint: newest first, 20 per channel by default, at most 100, labels, counts, who and a photo, never a message\'s text', async (t) => {
  const omni = fakeOmni()
  const dsh = await start(t, homeWith(t, teamState({
    omniThreads: {
      staff: record('staff', 'staff-session', { chatId: chatId(130), chatIds: [chatId(130)], answerChild: true, needsStaff: { at: 1, reason: 'asks for a refund' } }),
      paused: record('paused', 'paused-session', { chatId: chatId(129), chatIds: [chatId(129)], answerChild: true, paused: true, lastStaffAt: Date.now() }),
    },
  })))
  await dsh.settled()
  const answer = await dsh.endpoint('omni-bot-chats', { botId: 'm1' })
  assert.equal(answer.botId, 'm1')
  assert.deepEqual(answer.channels.map(channel => channel.channelId), [INSTANCE, OTHER_INSTANCE, PAIRING, BROKEN])
  const [sales, support] = answer.channels
  assert.equal(sales.chats.length, 20)
  assert.equal(support.chats.length, 3)
  assert.deepEqual(sales.chats.map(chat => chat.lastAt), sales.chats.map(chat => chat.lastAt).sort((a, b) => b - a))
  assert.deepEqual(Object.keys(sales.chats[0]).sort(), ['id', 'lastAt', 'name', 'status', 'unread', 'who'])
  assert.deepEqual(sales.chats[0], {
    id: chatId(130), name: 'Person 130', status: 'needs-someone', unread: 130 % 3, lastAt: Date.parse(at(130)),
    who: { name: 'Person 130', photo: 'https://photos.example/130.png', self: false },
  })
  assert.equal(sales.chats[1].status, 'paused')
  assert.equal(sales.chats[2].status, 'idle')
  // Never a message's text, in any field.
  assert.ok(!JSON.stringify(answer).includes(SECRET))
  // The reads: the chats of each channel the Bot owns, by activity, 20 each; a photo for at most
  // PEOPLE_READS new direct chats a read.
  assert.deepEqual(omni.reads(/^\/chats$/).map(call => call.query), answer.channels.map(channel => ({ instanceId: channel.channelId, limit: '20', sort: 'activity' })))
  assert.equal(omni.reads(/\/participants$/).length, 8)
  // A larger limit is held to CHATS_MAX; one channel only when named.
  const many = await dsh.endpoint('omni-bot-chats', { botId: 'm1', channelId: INSTANCE, limit: 500 })
  assert.deepEqual(many.channels.map(channel => [channel.channelId, channel.chats.length]), [[INSTANCE, CHATS_MAX]])
  const few = await dsh.endpoint('omni-bot-chats', { botId: 'm1', channelId: INSTANCE, limit: 3 })
  assert.equal(few.channels[0].chats.length, 3)
  // The owner's own chat (its canonical id is the channel's number), a group's picture, an odd address.
  const all = many.channels[0].chats
  const own = all.find(chat => chat.id === chatId(1))
  assert.deepEqual(own.who, { name: `+${OWNER}`, photo: own.who.photo, self: true })
  assert.equal(own.name, `+${OWNER}`)
  assert.equal(all.filter(chat => chat.who.self).length, 1)
  assert.deepEqual(all.find(chat => chat.id === chatId(2)).who, { name: 'Suppliers', photo: 'https://photos.example/group.png', self: false })
  for (const chat of all) assert.ok(chat.who.photo === null || chat.who.photo.startsWith('https://'), chat.who.photo)
})

test('refusals carry no data: an unknown Bot, a channel it does not own, one it may not read, one Omni does not have, and a bad body', async (t) => {
  fakeOmni()
  const dsh = await start(t, homeWith(t, withService()))
  await dsh.settled()
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: 'nobody' }), { code: 'bot/refused', message: UNKNOWN_BOT })
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: 'm1', channelId: '9f9f9f9f-0000-4000-8000-000000000000' }), { code: 'bot/refused', message: NO_CHANNEL })
  await assert.rejects(dsh.endpoint('omni-bot-chats', {}), { code: 'bot/invalid' })
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: 'm1', limit: 0 }), { code: 'bot/invalid' })
  // A channel this Bot owns but may not read now (as while its owner changes).
  const canChannel = dsh.plugin.canChannel
  dsh.plugin.canChannel = (botId, channelId, action) => (channelId === INSTANCE ? false : canChannel(botId, channelId, action))
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: 'm1', channelId: INSTANCE }), { code: 'bot/refused', message: NOT_READABLE })
  // Without a channel named, the one it may not read is left out, and the view drops it.
  const answer = await dsh.endpoint('omni-bot-chats', { botId: 'm1' })
  assert.ok(!answer.channels.some(channel => channel.channelId === INSTANCE))
  assert.ok(!dsh.live().m1.some(channel => channel.id === INSTANCE))
  // A Bot of the team asking for another Bot's channel, and a Bot that owns none.
  await assert.rejects(dsh.endpoint('omni-bot-chats', { botId: SERVICE, channelId: OTHER_INSTANCE }), { code: 'bot/refused', message: NOT_OWNED })
  assert.deepEqual(await dsh.endpoint('omni-bot-chats', { botId: SERVICE }), { botId: SERVICE, channels: [] })
  assert.equal(dsh.live()[SERVICE], undefined)
})

test('a channel\'s status in the bar, and a chat\'s from its threads', () => {
  assert.equal(barStatusOf({ isActive: true }, { state: 'connected' }), 'connected')
  assert.equal(barStatusOf({ isActive: true }, { state: 'qr' }), 'needs-pairing')
  assert.equal(barStatusOf({ isActive: true }, { state: 'error' }), 'error')
  assert.equal(barStatusOf({ isActive: true }, null), 'error')
  for (const state of ['disconnected', 'connecting', 'reconnecting']) assert.equal(barStatusOf({ isActive: true }, { state }), 'disconnected')
  assert.equal(barStatusOf({ isActive: false }, { state: 'connected' }), 'disconnected')
  const running = () => true
  assert.equal(chatStatusOf([], running), 'idle')
  assert.equal(chatStatusOf([{ status: 'working' }], running), 'answering')
  assert.equal(chatStatusOf([{ status: 'working' }], () => false), 'idle')
  assert.equal(chatStatusOf([{ status: 'waiting' }], running), 'needs-someone')
  assert.equal(chatStatusOf([{ answerChild: true, paused: true, status: 'working' }], running), 'paused')
  assert.equal(chatStatusOf([{ answerChild: true, paused: true }, { answerChild: true, needsStaff: { at: 1 } }], running), 'needs-someone')
})
