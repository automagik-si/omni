// Reading a chat's history (src/host/reading.js) on the real plugin framework: a real cordis
// Context with DSH's own session store, projections, agent registry, LLM runtime, Session
// titles, system prompt, tool runtime and native tool executor, the real Bot team and this
// plugin loaded through root.plugin with their own inject lists, and each tool run through
// tools.execute as DSH runs a model's call. Only the host services that need a live server,
// a filesystem workspace or a browser (the connection, the Session controller, the workspace
// registry, settings) are provided small here.
// Omni is a fake of the two routes reading uses (O1's contract), kept in one place: omniO1.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as team from '@automagik/bots-dsh'
import * as channels from '../index.js'
import { LINK_FILE } from '../src/host/omni-link.js'
import { ANSWER_CHILD_REFUSAL, BAD_CURSOR, CURSOR_WINDOW, LINE_TEXT_MAX, NOT_OPERATOR, NOT_READABLE, NOTES_FILE, PAGE_CHARS_MAX } from '../src/host/reading.js'
import { INSTANCE, OMNI, OTHER_INSTANCE, resetFetch, teamState } from './thread-fixture.js'

const realFetch = globalThis.fetch
afterEach(resetFetch)
// The team reads DSH's home from the environment: a scratch one, never the user's.
const dshHome = mkdtempSync(join(tmpdir(), 'omni-reading-dsh-'))
process.env.DSH_HOME = dshHome
after(() => rmSync(dshHome, { recursive: true, force: true }))

const LINK_KEY = 'omni_sk_link_reading'
const CHAT = '7a1c0d2e-3b4f-4c5d-8e6f-0a1b2c3d4e01'
const BIG = '7a1c0d2e-3b4f-4c5d-8e6f-0a1b2c3d4e02'
const ELSEWHERE = '7a1c0d2e-3b4f-4c5d-8e6f-0a1b2c3d4e03'
const ODD = '7a1c0d2e-3b4f-4c5d-8e6f-0a1b2c3d4e04'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SAME = '2026-05-10T12:00:00.000Z'
const message = (n, platformTimestamp, extra = {}) => ({
  id: id(n), chatId: CHAT, platformTimestamp, createdAt: platformTimestamp, isFromMe: false, source: 'realtime', senderDisplayName: 'Ana',
  messageType: 'text', textContent: null, hasMedia: false, status: 'active', editCount: 0, editedAt: null, deletedAt: null, reactions: null, ...extra,
})
// Eight messages of one chat, five of them at the same millisecond; one is deleted.
const MESSAGES = [
  message(1, '2026-03-02T10:00:00.000Z', { textContent: 'Hi, is the order ready?' }),
  message(2, SAME, { messageType: 'audio', hasMedia: true, transcription: 'call me tomorrow', source: 'sync' }),
  message(3, SAME, { messageType: 'image', hasMedia: true, imageDescription: 'a receipt', textContent: 'here it is', reactions: [{ emoji: '👍', platformUserId: 'u1', displayName: 'Ana', at: SAME }] }),
  message(4, SAME, { textContent: 'Thursday works', status: 'edited', editCount: 1, editedAt: '2026-05-10T12:01:00.000Z' }),
  message(5, SAME, { textContent: 'wrong chat', status: 'deleted', deletedAt: '2026-05-10T12:02:00.000Z' }),
  message(6, SAME, { textContent: 'Sure, see you then', isFromMe: true, source: 'api', senderDisplayName: null }),
  message(7, '2026-08-01T09:00:00.000Z', { textContent: 'Thanks again', isFromMe: true, senderDisplayName: null }),
  message(8, '2026-11-01T08:00:00.000Z', { messageType: 'document', hasMedia: true, source: 'import' }),
]
// A chat with one row in a form no message has (its time a number).
const ODD_MESSAGES = [{ ...message(2000, '2026-04-01T00:00:00.000Z', { textContent: 'fine' }), chatId: ODD }, { id: 'odd-row', chatId: ODD, platformTimestamp: 1_775_000_000 }]
// 205 long messages of another chat, one a minute.
const LONG = 'x'.repeat(LINE_TEXT_MAX + 100)
const BIG_MESSAGES = Array.from({ length: 205 }, (_, n) => ({ ...message(1000 + n, new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 60_000).toISOString(), { textContent: LONG }), chatId: BIG }))
const CHATS = {
  [CHAT]: { id: CHAT, name: 'Ana', instanceId: INSTANCE, externalId: '5511988880000@s.whatsapp.net', chatType: 'dm' },
  [BIG]: { id: BIG, name: 'Supplier', instanceId: INSTANCE, externalId: '5511977770000@s.whatsapp.net', chatType: 'dm' },
  [ELSEWHERE]: { id: ELSEWHERE, name: 'Elsewhere', instanceId: OTHER_INSTANCE, externalId: '5511966660000@s.whatsapp.net', chatType: 'dm' },
  [ODD]: { id: ODD, name: 'Odd', instanceId: INSTANCE, externalId: '5511955550000@s.whatsapp.net', chatType: 'dm' },
}

// O1's contract: GET /chats/:id/messages pages back by (platformTimestamp desc, id desc) from an
// opaque cursor, exclusive, `before`/`after` inclusive, deleted rows only with includeDeleted;
// GET /chats/:id/coverage answers { data } with from/to bounding countInWindow only.
function omniO1() {
  const asked = []
  const rows = [...MESSAGES, ...BIG_MESSAGES, ...ODD_MESSAGES]
  const json = (status, body) => new Response(JSON.stringify(body), { status })
  const later = (a, b) => (a.platformTimestamp === b.platformTimestamp ? (a.id > b.id ? -1 : 1) : (a.platformTimestamp > b.platformTimestamp ? -1 : 1))
  globalThis.fetch = async (address, init = {}) => {
    const url = new URL(String(address))
    const method = init.method ?? 'GET'
    const path = url.pathname.replace(/^\/api\/v2/, '')
    asked.push({ method, path, query: Object.fromEntries(url.searchParams) })
    if (url.origin !== OMNI || init.headers?.['x-api-key'] !== LINK_KEY) return json(401, { error: { code: 'UNAUTHORIZED' } })
    if (method !== 'GET') return json(404, { error: { code: 'NOT_FOUND' } })
    const [, chatId, part] = /^\/chats\/([^/]+)(?:\/(messages|coverage))?$/.exec(path) ?? []
    if (chatId === undefined) return json(404, { error: { code: 'NOT_FOUND' } })
    if (!CHATS[chatId]) return json(404, { error: { code: 'NOT_FOUND', message: 'Chat not found' } })
    if (part === undefined) return json(200, { data: CHATS[chatId] })
    const query = url.searchParams
    const withDeleted = query.get('includeDeleted') === 'true'
    const own = rows.filter(row => row.chatId === chatId && (withDeleted || !row.deletedAt))
    if (part === 'coverage') {
      const from = query.get('from')
      const to = query.get('to')
      // Omni's coverage is SQL over the stored column: a row's time there is always a time.
      const times = own.map(row => row.platformTimestamp).filter(time => typeof time === 'string').sort()
      const newestOf = list => list.map(row => row.platformTimestamp).filter(time => typeof time === 'string').sort().at(-1) ?? null
      return json(200, { data: {
        oldest: times[0] ?? null, newest: times.at(-1) ?? null, count: own.length,
        countInWindow: own.filter(row => (!from || row.platformTimestamp >= from) && (!to || row.platformTimestamp <= to)).length,
        mediaMissing: own.filter(row => row.hasMedia).length, deletedCount: rows.filter(row => row.chatId === chatId && row.deletedAt).length,
        lastInbound: newestOf(own.filter(row => !row.isFromMe)), lastOutbound: newestOf(own.filter(row => row.isFromMe)),
      } })
    }
    let page = own.filter(row => (!query.get('after') || row.platformTimestamp >= query.get('after')) && (!query.get('before') || row.platformTimestamp <= query.get('before'))).sort(later)
    const cursor = query.get('cursor')
    if (cursor !== null) {
      let mark
      try { mark = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { return json(400, { error: { code: 'VALIDATION', message: 'Invalid cursor' } }) }
      if (!Array.isArray(mark) || mark.length !== 2) return json(400, { error: { code: 'VALIDATION', message: 'Invalid cursor' } })
      page = page.filter(row => later({ platformTimestamp: mark[0], id: mark[1] }, row) < 0)
    }
    const limit = Number(query.get('limit') ?? 100)
    const items = page.slice(0, limit)
    const hasMore = page.length > limit
    return json(200, { items, meta: { hasMore, cursor: hasMore ? Buffer.from(JSON.stringify([items.at(-1).platformTimestamp, items.at(-1).id])).toString('base64url') : null } })
  }
  return { asked, reads: () => asked.filter(call => /\/(messages|coverage)$/.test(call.path)) }
}

// A home with the team and the link to the fake Omni.
function homeWith(t, state = teamState()) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-reading-'))
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
  // Session titles as DSH's base bundle configures them.
  const titles = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }
  for (const [plugin, config] of [[SessionStore], [SessionProjectionRegistry], [AgentRegistry], [LlmRuntime], [SessionTitleService, titles], [SystemPrompt, {}], [ToolRuntime, {}], [NativeToolExecutor]]) await root.plugin(plugin, config)
  await root.plugin(Object.assign((ctx) => {
    ctx.provide('connection', { fetch: { register: () => () => {} } })
    ctx.provide('sessionController', { create: async () => ({ sessionId: 'unused' }), resolveAgent: async () => ({}), selectModel: async () => ({}) })
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
  // A model's call, as DSH runs it: through the pre-execute policy, the guards and the executor.
  const run = async (name, args, sessionId = 'm1') => {
    const batch = await root.tools.execute({ signal: new AbortController().signal, agent: { id: sessionId }, calls: [{ type: 'tool-call', id: ToolCallId(name), name, arguments: JSON.stringify(args) }] })
    const result = batch.results[0].result
    return result.isError ? `ERROR ${result.error?.message ?? JSON.stringify(result.error)}` : String(result.value)
  }
  const endpoint = (name, body) => omniTeam.extended.endpointOf(name).fn(body)
  return { root, team: omniTeam, run, endpoint, stop }
}

const idsOf = text => [...text.matchAll(/\| id ([0-9a-f-]{36})$/gm)].map(match => match[1])
const linesOf = text => text.split('\n\n').slice(1).join('\n\n').split('\n').filter(Boolean)
const cursorOf = text => /cursor (\S+)$/m.exec(text)?.[1]

test('read_history reads a chat over several pages with equal timestamps: each message once, newest page first, each page oldest first, with every mark', async (t) => {
  const omni = omniO1()
  const dsh = await start(t, homeWith(t))
  // Registered globally, so an agent's restrictions can name them (#1728).
  const restrictable = dsh.root.tools.view(undefined).restrictableNames
  for (const name of ['read_history', 'save_reading_note']) assert.ok(restrictable.has(name), name)

  const pages = []
  let page = await dsh.run('read_history', { chat: CHAT, size: 3 })
  pages.push(page)
  while (cursorOf(page)) {
    page = await dsh.run('read_history', { chat: CHAT, cursor: cursorOf(page) })
    pages.push(page)
  }
  assert.equal(pages.length, 3)
  assert.match(pages[0], /^Reading Ana \(chat [0-9a-f-]+\), from its first message to now\.$/m)
  assert.match(pages[0], /^Page 1 of about 3, newest pages first: 3 messages, oldest first, 2026-05-10T12:00:00Z to 2026-11-01T08:00:00Z\.$/m)
  assert.match(pages[1], /^Page 2 of about 3, /m)
  assert.match(pages[2], /^Page 3 of about 3, /m)
  assert.match(pages[2], /^This is the last page of this window\.$/m)
  assert.match(pages[0], /^Coverage: Omni holds 8 messages of this chat \(2026-03-02T10:00:00Z to 2026-11-01T08:00:00Z\), 8 in this window; 1 deleted; 3 with media whose file Omni does not hold\.$/m)
  assert.match(pages[0], /^Last contact: from them 2026-11-01T08:00:00Z, from the user 2026-08-01T09:00:00Z\.$/m)
  // Every message once, deleted one included; pages go back in time and each reads oldest first.
  const order = pages.flatMap(idsOf)
  assert.deepEqual(order, [id(6), id(7), id(8), id(3), id(4), id(5), id(1), id(2)])
  assert.equal(new Set(order).size, MESSAGES.length)

  const line = n => pages.flatMap(linesOf).find(text => text.endsWith(`| id ${id(n)}`))
  assert.equal(line(1), `2026-03-02T10:00:00Z Ana: Hi, is the order ready? | id ${id(1)}`)
  assert.equal(line(2), `2026-05-10T12:00:00Z Ana: audio: call me tomorrow | history | id ${id(2)}`)
  assert.equal(line(3), `2026-05-10T12:00:00Z Ana: here it is | image: a receipt | reactions: 👍 Ana | id ${id(3)}`)
  assert.equal(line(4), `2026-05-10T12:00:00Z Ana: Thursday works | edited | id ${id(4)}`)
  assert.equal(line(5), `2026-05-10T12:00:00Z Ana: wrong chat | deleted | id ${id(5)}`)
  assert.equal(line(6), `2026-05-10T12:00:00Z the user, through Omni: Sure, see you then | id ${id(6)}`)
  assert.equal(line(7), `2026-08-01T09:00:00Z the user: Thanks again | id ${id(7)}`)
  assert.equal(line(8), `2026-11-01T08:00:00Z Ana: document: no transcript or description yet | history | id ${id(8)}`)

  // Only reads: every chat request a GET, deleted rows asked for, and nothing sent or changed
  // (the one other call is the plugin's start retiring an old events consumer).
  assert.ok(omni.asked.filter(call => call.path.startsWith('/chats/')).every(call => call.method === 'GET'))
  assert.deepEqual(omni.asked.filter(call => call.method !== 'GET' && !call.path.startsWith('/events/consumers/')), [])
  for (const call of omni.reads()) assert.equal(call.query.includeDeleted, 'true')
  assert.deepEqual(omni.reads().filter(call => call.path.endsWith('/messages')).map(call => call.query.limit), ['3', '3', '3'])

  // A cursor belongs to its chat and its window.
  assert.equal(await dsh.run('read_history', { chat: BIG, cursor: cursorOf(pages[0]) }), BAD_CURSOR)
  assert.equal(await dsh.run('read_history', { chat: CHAT, cursor: 'not-a-cursor' }), BAD_CURSOR)
  assert.equal(await dsh.run('read_history', { chat: CHAT, cursor: cursorOf(pages[0]), size: 5 }), CURSOR_WINDOW)
})

test('read_history: a page of 200 keeps all 200 lines within what DSH keeps whole, cutting texts shorter with a mark; an odd row stays a line; a size over 200 is refused', async (t) => {
  omniO1()
  const dsh = await start(t, homeWith(t))
  const page = await dsh.run('read_history', { chat: BIG, size: 200 })
  assert.equal(idsOf(page).length, 200)
  assert.ok(page.length <= PAGE_CHARS_MAX, `${page.length} characters`)
  assert.match(page, /^Page 1 of about 2, newest pages first: 200 messages, /m)
  const limit = Number(/^Texts on this page are cut at (\d+) characters to keep the page whole; a smaller size keeps more of each\.$/m.exec(page)?.[1])
  assert.ok(limit > 0 && limit < LINE_TEXT_MAX, String(limit))
  assert.ok(linesOf(page).every(line => line.includes(`: ${'x'.repeat(limit)}…[+${LONG.length - limit} chars] | id `)))
  const rest = await dsh.run('read_history', { chat: BIG, cursor: cursorOf(page) })
  assert.equal(idsOf(rest).length, 5)
  assert.equal(new Set([...idsOf(page), ...idsOf(rest)]).size, 205)
  // A page that fits keeps texts up to LINE_TEXT_MAX and says nothing of a cut.
  assert.ok(linesOf(rest).every(line => line.includes(`${'x'.repeat(LINE_TEXT_MAX)}…[+100 chars]`)))
  assert.doesNotMatch(rest, /^Texts on this page are cut/m)
  // One row that is no message as Omni gives one does not keep the rest from being read.
  const odd = await dsh.run('read_history', { chat: ODD })
  assert.deepEqual(linesOf(odd).sort(), [`2026-04-01T00:00:00Z Ana: fine | id ${id(2000)}`, 'a row Omni gave in a form this tool cannot read | id odd-row'])
  assert.match(await dsh.run('read_history', { chat: BIG, size: 201 }), /size of 1 to 200/)
})

test('read_history within a date window: only its messages, its count, the window kept by the cursor, and a backfill hint before what Omni holds', async (t) => {
  const omni = omniO1()
  const dsh = await start(t, homeWith(t))
  const first = await dsh.run('read_history', { chat: CHAT, from: '2026-05-01', to: '2026-08-31', size: 4 })
  assert.match(first, /^Reading Ana \(chat [0-9a-f-]+\), from 2026-05-01T00:00:00Z to 2026-08-31T23:59:59\.999Z\.$/m)
  assert.match(first, /, 6 in this window; /)
  assert.match(first, /^Page 1 of about 2, /m)
  assert.doesNotMatch(first, /backfill/)
  const second = await dsh.run('read_history', { chat: CHAT, cursor: cursorOf(first) })
  assert.match(second, /^Page 2 of about 2, /m)
  assert.deepEqual([...idsOf(first), ...idsOf(second)].sort(), [2, 3, 4, 5, 6, 7].map(id).sort())
  // The window went to Omni on both pages, the second with Omni's own cursor.
  const asks = omni.reads().filter(call => call.path.endsWith('/messages'))
  assert.deepEqual(asks.map(call => [call.query.after, call.query.before]), [['2026-05-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'], ['2026-05-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z']])
  assert.equal(asks[0].query.cursor, undefined)
  assert.ok(asks[1].query.cursor)
  assert.deepEqual(omni.reads().filter(call => call.path.endsWith('/coverage')).map(call => [call.query.from, call.query.to]).at(-1), ['2026-05-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'])
  // Another window with the same cursor is refused.
  assert.equal(await dsh.run('read_history', { chat: CHAT, cursor: cursorOf(first), from: '2026-06-01' }), CURSOR_WINDOW)
  // Before the oldest message Omni holds: nothing in the window, and ask for a backfill first.
  const early = await dsh.run('read_history', { chat: CHAT, from: '2026-01-01', to: '2026-02-28' })
  assert.match(early, /^Page 1 of about 1: no messages in this window\.$/m)
  assert.match(early, /^Omni holds nothing before 2026-03-02T10:00:00Z: if you need earlier messages, ask the user for a backfill first\.$/m)
  assert.equal(idsOf(early).length, 0)
  assert.equal(await dsh.run('read_history', { chat: CHAT, from: '2026-09-01', to: '2026-08-01' }), 'from is after to.')
})

test('answer children are refused both tools, read nothing and keep thread_history; a Bot that does not operate Omni, or whose channel is another bot\'s, is refused too', async (t) => {
  const omni = omniO1()
  const thread = { id: 'thread-1', sessionId: 'child-1', chatId: CHAT, chatIds: [CHAT], chatJid: CHATS[CHAT].externalId, chatName: 'Ana', channelId: INSTANCE, origin: OMNI, ownerBotId: 'svc', answerChild: true, self: null, title: 'Ana', status: 'idle', turnOpenAt: null, at: 1 }
  const state = teamState({
    bots: {
      ...teamState().bots,
      svc: { id: 'svc', kind: 'omni', name: 'Service', instructions: '', createdAt: 2, answer: { enabled: true, visibility: 'isolated', allowedTools: [] } },
      w1: { id: 'w1', name: 'Dev', role: '', instructions: '', createdAt: 3 },
    },
    omniOwnership: { defaultBotId: 'm1', channels: { [INSTANCE]: 'svc', [OTHER_INSTANCE]: 'm1' } },
    omniThreads: { [thread.id]: thread },
  })
  const dsh = await start(t, homeWith(t, state))
  assert.equal(dsh.root.get('omniChannels').threads.bySession('child-1').answerChild, true)
  const reads = omni.reads().length
  // Through DSH's pipeline the child's containment (thread-tools.js) denies first: this bench's
  // stand-in Session has no scoped tool registry, so it is never contained and nothing runs.
  for (const [name, args] of [['read_history', { chat: CHAT }], ['save_reading_note', { chat: CHAT, note: 'x', readThrough: '2026-11-01' }]]) {
    assert.equal(await dsh.run(name, args, 'child-1'), 'ERROR This Session has no scoped tool registry.', name)
  }
  // The tool's own refusal, whatever an answer child is allowed.
  const tool = name => dsh.root.tools.get(name)
  assert.equal(await tool('read_history').execute({ chat: CHAT }, { agent: { id: 'child-1' } }), ANSWER_CHILD_REFUSAL)
  assert.equal(await tool('save_reading_note').execute({ chat: CHAT, note: 'x', readThrough: '2026-11-01' }, { agent: { id: 'child-1' } }), ANSWER_CHILD_REFUSAL)
  assert.equal(omni.reads().length, reads)
  // A Bot with no Omni to operate.
  assert.equal(await dsh.run('read_history', { chat: CHAT }, 'w1'), NOT_OPERATOR)
  assert.equal(await dsh.run('save_reading_note', { chat: CHAT, note: 'x', readThrough: '2026-11-01' }, 'w1'), NOT_OPERATOR)
  // The answer bot reads its own channel, never the default bot's other one.
  assert.match(await dsh.run('read_history', { chat: CHAT, size: 1 }, 'svc'), /^Page 1 of about 8, /m)
  assert.equal(await dsh.run('read_history', { chat: ELSEWHERE }, 'svc'), NOT_READABLE)
  assert.equal(await dsh.run('save_reading_note', { chat: ELSEWHERE, note: 'x', readThrough: '2026-11-01' }, 'svc'), NOT_READABLE)
  assert.equal(omni.reads().filter(call => call.path.startsWith(`/chats/${ELSEWHERE}/`)).length, 0)
})

test('the reading note survives a restart: saved in its own 0600 file, shown on read_history\'s first page, and read by the kit\'s endpoint with the coverage', async (t) => {
  omniO1()
  const home = homeWith(t)
  const first = await start(t, home)
  const note = 'Who: a client of the user since March.\nOpen: the order for Thursday.\nLast contact: 1 Nov.\nTone: short and friendly.'
  assert.equal(await first.run('save_reading_note', { chat: CHAT, note, readThrough: '2026-11-01T08:00:00Z' }), `Reading note saved for Ana: ${note.length} characters, read through 2026-11-01T08:00:00Z.`)
  assert.equal(statSync(join(home, NOTES_FILE)).mode & 0o777, 0o600)
  assert.match(await first.run('save_reading_note', { chat: CHAT, note: 'y'.repeat(8001), readThrough: '2026-11-01' }), /8001 characters; keep it to at most 8000/)
  await first.stop()

  const second = await start(t, home)
  const page = await second.run('read_history', { chat: CHAT, size: 3 })
  assert.match(page, /^Reading note \(read through 2026-11-01T08:00:00Z, updated \d{4}-\d{2}-\d{2}T[\d:.]+Z\):$/m)
  assert.ok(page.includes(`):\n${note}\n`))
  const next = await second.run('read_history', { chat: CHAT, cursor: cursorOf(page) })
  assert.match(next, /^Reading note: kept \(read through 2026-11-01T08:00:00Z, updated .+\); page 1 shows it\.$/m)
  assert.ok(!next.includes(note))
  assert.match(await second.run('read_history', { chat: BIG, size: 1 }), /^Reading note: none yet for this chat\.$/m)

  const card = await second.endpoint('omni-reading-note', { chat: CHAT })
  assert.deepEqual({ ...card, note: { ...card.note, updatedAt: typeof card.note.updatedAt } }, {
    chat: { id: CHAT, name: 'Ana', channelId: INSTANCE },
    note: { text: note, readThrough: '2026-11-01T08:00:00.000Z', updatedAt: 'string' },
    coverage: { oldest: '2026-03-02T10:00:00.000Z', newest: '2026-11-01T08:00:00.000Z', count: 8, mediaMissing: 3, deletedCount: 1, lastInbound: '2026-11-01T08:00:00.000Z', lastOutbound: '2026-08-01T09:00:00.000Z' },
  })
  assert.equal((await second.endpoint('omni-reading-note', { chat: BIG })).note, null)
  await assert.rejects(second.endpoint('omni-reading-note', { chat: 'not-a-chat' }))
})

test('the reading note never reaches state.json, a log, the team view or any other file', async (t) => {
  omniO1()
  const said = []
  const streams = [process.stdout, process.stderr]
  const writes = streams.map(stream => stream.write)
  streams.forEach((stream, index) => {
    stream.write = function (chunk, ...rest) {
      said.push(String(chunk))
      return writes[index].call(this, chunk, ...rest)
    }
  })
  t.after(() => streams.forEach((stream, index) => { stream.write = writes[index] }))
  const home = homeWith(t)
  const marker = 'NOTE-MARKER-4c7e: open order, prefers voice notes'
  const first = await start(t, home)
  assert.match(await first.run('save_reading_note', { chat: CHAT, note: marker, readThrough: '2026-11-01' }), /^Reading note saved/)
  // An unreadable notes file is set aside and said once, without its notes.
  writeFileSync(join(home, NOTES_FILE), `{"version":1,"chats":"${marker}"`)
  assert.match(await first.run('read_history', { chat: CHAT, size: 1 }), /^Reading note: none yet for this chat\.$/m)
  assert.match(await first.run('save_reading_note', { chat: CHAT, note: marker, readThrough: '2026-11-01' }), /^Reading note saved/)
  const views = JSON.stringify([first.team.extended.view(), first.team.extended.live()])
  await first.stop()
  const second = await start(t, home)
  assert.ok((await second.run('read_history', { chat: CHAT, size: 1 })).includes(marker))
  await second.stop()

  assert.ok(!views.includes(marker), 'team view')
  assert.ok(!said.join('').includes(marker), 'log')
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))
  const holding = [...files(home), ...files(dshHome)].filter(file => readFileSync(file, 'utf8').includes(marker)).map(file => file.slice(home.length + 1))
  // The live file, and the unreadable one set aside (0600) rather than lost.
  assert.deepEqual(holding.map(file => file.replace(/unreadable-\d+$/, 'unreadable-N')).sort(), [NOTES_FILE, `${NOTES_FILE}.unreadable-N`])
  for (const file of holding) assert.equal(statSync(join(home, file)).mode & 0o777, 0o600, file)
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(marker))
  globalThis.fetch = realFetch
})
