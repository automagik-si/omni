// Backfilling chats' history (backfill.js) on the real plugin framework, the bench reading's
// tests use (#1767): a real cordis Context with DSH's SessionStore, SessionProjectionRegistry,
// AgentRegistry, LlmRuntime, SessionTitleService, SystemPrompt, ToolRuntime and native tool
// executor; the real Bot team and this plugin loaded through root.plugin with their own inject
// lists; every model call run through tools.execute, as DSH runs one. Four injected services
// are minimal provided objects (connection, sessionController, workspaceRegistry, settings),
// because the real ones need a live host.
//
// Omni is a fake of O3's backfill routes and of the durable consumer stream, kept in one place
// (omniO3): POST /chats/:id/backfill answers 202 { jobId } on a strict { from, to }; the job
// route spreads the job (its config and error included) with its progress and live coverage;
// cancel flips a pending or running job to cancelled and answers the job as it is; sync.*
// events reach the plugin as journal rows on its consumer's SSE stream, their payloads as
// SyncJobService publishes them (sync.completed and sync.failed carry no chatId).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { ANSWER_CHILD_REFUSAL, NOT_OPERATOR, NOT_READABLE } from '../src/host/backfill.js'
import { BACKFILL_START_REFUSAL } from '../src/host/omni-api.js'
import { LINK_FILE } from '../src/host/omni-link.js'
import { INSTANCE, OMNI, OTHER_INSTANCE, resetFetch, teamState } from './thread-fixture.js'
import { until } from './until.js'

afterEach(resetFetch)
// The team reads DSH's home from the environment: a scratch one, never the user's.
const dshHome = mkdtempSync(join(tmpdir(), 'omni-backfill-dsh-'))
process.env.DSH_HOME = dshHome
after(() => rmSync(dshHome, { recursive: true, force: true }))

const LINK_KEY = 'omni_sk_link_backfill'
const chatId = n => `7b2c0d2e-3b4f-4c5d-8e6f-0a1b2c3d4e0${n}`
const [ANA, BRUNO, CARLA, DAVI, ELSEWHERE] = [1, 2, 3, 4, 5].map(chatId)
// Text the chats hold and the job keeps: none of it may reach a proposal, a row or state.json.
const PREVIEW = 'the last thing someone wrote'
const ERROR = 'phone said something private'
const jidOf = n => `55119${String(n).padStart(8, '0')}@s.whatsapp.net`
const chat = (id, name, instanceId, n) => ({ id, name, instanceId, externalId: jidOf(n), chatType: 'dm', lastMessagePreview: `${PREVIEW} ${n}`, lastMessageFromMe: false })
const CHATS = {
  [ANA]: chat(ANA, 'Ana', INSTANCE, 1),
  [BRUNO]: chat(BRUNO, 'Bruno', INSTANCE, 2),
  [CARLA]: chat(CARLA, 'Carla', INSTANCE, 3),
  [DAVI]: chat(DAVI, 'Davi', INSTANCE, 4),
  [ELSEWHERE]: chat(ELSEWHERE, 'Elsewhere', OTHER_INSTANCE, 5),
}
const FROM = '2026-03-01T00:00:00.000Z'
const TO = '2026-11-15T23:59:59.999Z'
const coverage = n => ({ oldest: '2026-03-02T09:00:00.000Z', newest: '2026-11-14T18:00:00.000Z', count: 100 + n, countInWindow: 90 + n, deletedCount: 1, mediaMissing: n, lastInbound: '2026-11-14T18:00:00.000Z', lastOutbound: '2026-11-13T10:00:00.000Z' })

// O3's routes and the consumer stream, as the branch feat/chat-backfill-edits has them.
function omniO3() {
  const asked = []
  const jobs = new Map()
  const streams = []
  let seq = 0
  let pending = []
  const json = (status, body) => new Response(JSON.stringify(body), { status })
  const jobView = job => ({ ...job, ...job.progress, chatId: job.config.backfill.chatId, state: job.progress.state, coverage: coverage(1) })
  const open = () => streams.filter(stream => !stream.closed)
  const send = frame => {
    const live = open()
    if (live.length === 0) pending.push(frame)
    else for (const stream of live) stream.controller.enqueue(new TextEncoder().encode(frame))
  }
  // One journal row, as the plugin's consumer receives it.
  const emit = (eventType, payload) => {
    seq += 1
    const row = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, eventType, journalSeq: seq, instanceId: payload.instanceId, rawPayload: payload, direction: 'internal' }
    send(`id: ${seq}\nevent: ${eventType}\ndata: ${JSON.stringify(row)}\n\n`)
  }
  globalThis.fetch = async (address, init = {}) => {
    const url = new URL(String(address))
    const method = init.method ?? 'GET'
    const path = url.pathname.replace(/^\/api\/v2/, '')
    const body = init.body ? JSON.parse(init.body) : undefined
    asked.push({ method, path, query: Object.fromEntries(url.searchParams), body })
    if (url.origin !== OMNI || init.headers?.['x-api-key'] !== LINK_KEY) return json(401, { error: { code: 'UNAUTHORIZED' } })
    if (method === 'GET' && path === '/chats') return json(200, { items: Object.values(CHATS), meta: { hasMore: false } })
    if (method === 'GET' && path === '/instances') return json(200, { items: [{ id: INSTANCE, name: 'Shop line' }, { id: OTHER_INSTANCE, name: 'Other line' }] })
    if (path === '/events/consumers' && method === 'POST') return json(201, { data: { name: body.name } })
    if (/^\/events\/consumers\/[^/]+\/ack$/.test(path)) return json(200, { data: { cursor: body.cursor } })
    if (/^\/events\/consumers\/[^/]+\/stream$/.test(path)) {
      const stream = { closed: false, name: decodeURIComponent(path.split('/')[3]) }
      const close = () => { if (!stream.closed) { stream.closed = true; try { stream.controller.close() } catch { /* closed */ } } }
      const readable = new ReadableStream({ start(controller) { stream.controller = controller } })
      streams.push(stream)
      init.signal?.addEventListener('abort', close, { once: true })
      const queued = pending
      pending = []
      for (const frame of queued) send(frame)
      return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (path.startsWith('/events/consumers/')) return json(404, { error: { code: 'NOT_FOUND' } })
    const [, id, rest] = /^\/chats\/([^/]+)(\/.*)?$/.exec(path) ?? []
    if (id === undefined || !CHATS[id]) return json(404, { error: { code: 'NOT_FOUND', message: 'Chat not found' } })
    if (method === 'GET' && rest === undefined) return json(200, { data: CHATS[id] })
    if (method === 'POST' && rest === '/backfill') {
      const keys = Object.keys(body ?? {}).sort().join()
      if (keys !== 'from,to' || !(Date.parse(body.from) < Date.parse(body.to))) return json(400, { error: { code: 'VALIDATION_ERROR' } })
      const job = {
        id: `9a000000-0000-4000-8000-${String(jobs.size + 1).padStart(12, '0')}`, instanceId: CHATS[id].instanceId, type: 'messages', status: 'pending', channel: 'whatsapp-baileys',
        config: { backfill: { chatId: id, chatJid: CHATS[id].externalId, from: body.from, to: body.to } }, errorMessage: null,
        progress: { fetched: 0, stored: 0, duplicates: 0, mediaDownloaded: 0, state: 'queued', lastProgressAt: new Date().toISOString() },
      }
      jobs.set(job.id, job)
      return json(202, { jobId: job.id })
    }
    const [, jobId, action] = /^\/backfill\/([^/]+)(\/cancel)?$/.exec(rest ?? '') ?? []
    const job = jobs.get(jobId)
    if (!job || job.config.backfill.chatId !== id) return json(404, { error: { code: 'NOT_FOUND', message: 'Backfill job not found for this chat' } })
    if (method === 'GET' && action === undefined) return json(200, { data: jobView(job) })
    if (method === 'POST' && action === '/cancel') {
      if (['pending', 'running'].includes(job.status)) {
        job.status = 'cancelled'
        job.progress = { ...job.progress, coverage: coverage(3), state: 'cancelled', outcome: 'Cancelled by person' }
        emit('sync.cancelled', { jobId: job.id, instanceId: job.instanceId, type: job.type, progress: job.progress, chatId: id })
      }
      return json(200, { data: { ...job, ...job.progress, chatId: id } })
    }
    return json(404, { error: { code: 'NOT_FOUND' } })
  }
  // What SyncJobService publishes: progress after each round, then one terminal event.
  const progress = (jobId, patch) => {
    const job = jobs.get(jobId)
    job.status = 'running'
    job.progress = { ...job.progress, ...patch, lastProgressAt: new Date(Date.now() + seq).toISOString() }
    emit('sync.progress', { jobId, instanceId: job.instanceId, type: job.type, progress: job.progress, chatId: job.config.backfill.chatId })
  }
  const complete = (jobId) => {
    const job = jobs.get(jobId)
    job.status = 'completed'
    emit('sync.completed', { jobId, instanceId: job.instanceId, type: job.type, progress: job.progress })
  }
  const fail = (jobId) => {
    const job = jobs.get(jobId)
    job.status = 'failed'
    job.errorMessage = ERROR
    job.progress = { ...job.progress, state: 'failed', outcome: ERROR }
    emit('sync.failed', { jobId, instanceId: job.instanceId, type: job.type, error: ERROR })
  }
  const starts = () => asked.filter(call => call.method === 'POST' && /^\/chats\/[^/]+\/backfill$/.test(call.path))
  const jobReads = () => asked.filter(call => call.method === 'GET' && /\/backfill\/[^/]+$/.test(call.path))
  return { asked, jobs, streams, open, emit, progress, complete, fail, starts, jobReads }
}

// A home with the team and the link to the fake Omni. Homes go once every test is over: a
// test's own cleanup would run before its DSH stops, and that DSH still saves.
const homes = []
after(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
function homeWith(state = teamState()) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-backfill-'))
  homes.push(dir)
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
  // The kit's owner actions, as the sidebar posts them.
  const endpoint = (name, body) => omniTeam.extended.endpointOf(name).fn(body)
  const proposals = () => omniTeam.extended.view().omniBackfillProposals
  const live = () => omniTeam.extended.live().omniBackfills
  const rowOf = jobId => live().flatMap(item => item.rows).find(row => row.jobId === jobId)
  return { root, team: omniTeam, run, endpoint, proposals, live, rowOf, stop, home }
}

const ticked = proposal => proposal.chats.filter(item => item.ticked).map(item => item.id)

test('propose_backfill starts nothing: one card of the chats the Bot may read, pre-ticked only those named, with the range given; no tool or omni_call starts a job', async (t) => {
  const omni = omniO3()
  const dsh = await start(t, homeWith())
  const text = await dsh.run('propose_backfill', { chats: [BRUNO, DAVI], from: '2026-03-01', to: '2026-11-15' })
  assert.match(text, /^Proposed a backfill \(proposal [0-9a-f-]{36}\): a card lists 5 chats, 2 ticked, range 2026-03-01 to 2026-11-15\. Nothing starts until the user ticks/)
  const [card] = dsh.proposals()
  assert.equal(dsh.proposals().length, 1)
  assert.deepEqual({ botId: card.botId, from: card.from, to: card.to }, { botId: 'm1', from: FROM, to: TO })
  // Named first, then by activity; labels and their channel only.
  assert.deepEqual(card.chats.map(item => item.name), ['Bruno', 'Davi', 'Ana', 'Carla', 'Elsewhere'])
  assert.deepEqual(ticked(card), [BRUNO, DAVI])
  assert.deepEqual(card.chats[0], { id: BRUNO, name: 'Bruno', kind: 'dm', channelId: INSTANCE, channel: 'Shop line', ticked: true })
  assert.doesNotMatch(JSON.stringify(card), new RegExp(`${PREVIEW}|whatsapp\\.net`))
  // A new card from the same Bot replaces the open one, and starts empty when nothing is named.
  await dsh.run('propose_backfill', {})
  assert.equal(dsh.proposals().length, 1)
  assert.notEqual(dsh.proposals()[0].id, card.id)
  assert.deepEqual(ticked(dsh.proposals()[0]), [])
  assert.deepEqual([dsh.proposals()[0].from, dsh.proposals()[0].to], [null, null])
  assert.equal(await dsh.run('propose_backfill', { from: '2026-11-15', to: '2026-03-01' }), 'from must be before to.')
  // There is no tool that starts one, and omni_call refuses the route in every spelling.
  assert.equal(dsh.root.tools.get('start_backfill'), undefined)
  for (const path of [`/chats/${ANA}/backfill`, `/api/v2/chats/${ANA}/backfill`, `/chats//${ANA}/backfill/`, `/chats/${ANA}/./backfill`, `/chats/${ANA}%2Fbackfill`]) {
    assert.deepEqual(JSON.parse(await dsh.run('omni_call', { method: 'POST', path, body: JSON.stringify({ from: FROM, to: TO }) })), { status: 0, error: BACKFILL_START_REFUSAL }, path)
  }
  assert.equal(omni.starts().length, 0)
  assert.equal(omni.asked.some(call => call.method !== 'GET' && call.path.startsWith('/chats/')), false)
})

test('one Start on the card starts one job per ticked chat, each read-checked as the proposing Bot; the proposal is single use and a chat off the card or another bot\'s is refused', async (t) => {
  const omni = omniO3()
  const state = teamState({
    bots: { ...teamState().bots, svc: { id: 'svc', kind: 'omni', name: 'Service', instructions: '', createdAt: 2 } },
    omniOwnership: { defaultBotId: 'm1', channels: { [INSTANCE]: 'svc', [OTHER_INSTANCE]: 'm1' } },
  })
  const dsh = await start(t, homeWith(state))
  // A dedicated channel bot's card lists only its own line's chats; naming another's is refused.
  assert.equal(await dsh.run('propose_backfill', { chats: [ELSEWHERE] }, 'svc'), NOT_READABLE)
  await dsh.run('propose_backfill', { chats: [ANA] }, 'svc')
  const [card] = dsh.proposals()
  assert.deepEqual(card.chats.map(item => item.id), [ANA, BRUNO, CARLA, DAVI])
  await assert.rejects(dsh.endpoint('start_backfill', { proposalId: card.id, chats: [ANA, ELSEWHERE], from: FROM, to: TO }), /A ticked chat is not on this card\./)
  await assert.rejects(dsh.endpoint('start_backfill', { proposalId: card.id, chats: [ANA], from: TO, to: FROM }), /from must be before to\./)
  await assert.rejects(dsh.endpoint('start_backfill', { proposalId: card.id, chats: [ANA], from: FROM, to: TO, extra: true }))
  assert.equal(omni.starts().length, 0)
  // One approval, three jobs: the user's ticks and range, not the Bot's.
  const started = await dsh.endpoint('start_backfill', { proposalId: card.id, chats: [BRUNO, CARLA, DAVI], from: '2026-03-01', to: '2026-11-15' })
  assert.equal(started.runId, card.id)
  assert.deepEqual(started.jobs.map(job => job.chatId), [BRUNO, CARLA, DAVI])
  assert.ok(started.jobs.every(job => job.jobId.startsWith('9a000000-') && job.state === 'queued'))
  assert.deepEqual(omni.starts().map(call => [call.path, call.body]), [BRUNO, CARLA, DAVI].map(id => [`/chats/${id}/backfill`, { from: FROM, to: TO }]))
  assert.deepEqual(dsh.proposals(), [])
  await assert.rejects(dsh.endpoint('start_backfill', { proposalId: card.id, chats: [ANA], from: FROM, to: TO }), /This proposal is no longer open/)
  // Each chat is checked again at Start: a line its Bot no longer reads starts nothing.
  await dsh.run('propose_backfill', {}, 'svc')
  const next = dsh.proposals()[0]
  dsh.team.state.omniOwnership.channels[INSTANCE] = 'm1'
  await dsh.team.save()
  await assert.rejects(dsh.endpoint('start_backfill', { proposalId: next.id, chats: [ANA], from: FROM, to: TO }), new RegExp(NOT_READABLE))
  assert.equal(omni.starts().length, 3)
  // The rows are recorded and saved, with the jobs Omni gave.
  const saved = JSON.parse(readFileSync(join(dsh.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.omniBackfillRuns[0].rows.map(row => row.jobId), started.jobs.map(job => job.jobId))
})

test('rows move with Omni\'s sync.* events on the plugin\'s stream, read by route on connect; Cancel really stops; each ends done, phone did not answer, stopped or failed with its coverage; no message text anywhere', async (t) => {
  const omni = omniO3()
  const dsh = await start(t, homeWith())
  await dsh.run('propose_backfill', {})
  const card = dsh.proposals()[0]
  const { jobs } = await dsh.endpoint('start_backfill', { proposalId: card.id, chats: [ANA, BRUNO, CARLA, DAVI], from: FROM, to: TO })
  const [ana, bruno, carla, davi] = jobs.map(job => job.jobId)
  // The stream opens for sync.* only while a job is unfinished, after reading each job's route.
  await until(() => omni.open().length === 1)
  assert.match(omni.open()[0].name, /\.backfills$/)
  assert.equal(omni.asked.find(call => call.path === '/events/consumers' && call.method === 'POST').body.eventType, 'sync.*')
  assert.ok(jobs.every(job => omni.jobReads().some(call => call.path.endsWith(`/backfill/${job.jobId}`))))
  const readsBefore = omni.jobReads().length
  assert.deepEqual(dsh.live()[0].summary, { total: 4, running: 4, done: 0, phoneDidNotAnswer: 0, stopped: 0, failed: 0 })

  // A round: the row moves with the event, with no read of the job.
  omni.progress(ana, { state: 'fetching', round: 1, fetched: 50, stored: 40, duplicates: 10, mediaDownloaded: 5, mediaMissing: 1, reactionsApplied: 2, editsApplied: 1, deletionsApplied: 1, oldestReached: '2026-06-01T00:00:00.000Z' })
  await until(() => dsh.rowOf(ana).state === 'fetching')
  assert.deepEqual(dsh.rowOf(ana).counts, { fetched: 50, stored: 40, duplicates: 10, mediaDownloaded: 5, mediaMissing: 1, reactions: 2, edits: 1, deletions: 1, unmatched: 0 })
  assert.equal(dsh.rowOf(ana).round, 1)
  assert.equal(dsh.rowOf(ana).coverage, null)
  // Done: the last progress says done with the coverage, and the job's end (sync.completed, no
  // chatId) ends the row.
  omni.progress(ana, { state: 'done', round: 2, stored: 80, coverage: coverage(1), outcome: 'Finished requesting chat history' })
  await until(() => dsh.rowOf(ana).state === 'done')
  assert.deepEqual([dsh.rowOf(ana).outcome, dsh.rowOf(ana).coverage], [null, null])
  omni.complete(ana)
  await until(() => dsh.rowOf(ana).outcome === 'done')
  assert.deepEqual(dsh.rowOf(ana).coverage, coverage(1))
  // The phone did not answer: Omni says so in a round while the job still runs; the coverage,
  // then the job's end, come after. The row runs until then, and says so, not "done".
  omni.progress(bruno, { state: 'phone-did-not-answer', round: 1, outcome: 'Phone did not answer the chat history request' })
  await until(() => dsh.rowOf(bruno).state === 'phone-did-not-answer')
  assert.deepEqual([dsh.rowOf(bruno).outcome, dsh.rowOf(bruno).coverage], [null, null])
  assert.equal(dsh.live()[0].summary.running, 3)
  omni.progress(bruno, { round: 2, coverage: coverage(2) })
  await until(() => dsh.rowOf(bruno).round === 2)
  assert.equal(dsh.rowOf(bruno).outcome, null)
  omni.complete(bruno)
  await until(() => dsh.rowOf(bruno).outcome === 'phone-did-not-answer')
  assert.equal(dsh.rowOf(bruno).state, 'phone-did-not-answer')
  assert.deepEqual(dsh.rowOf(bruno).coverage, coverage(2))
  // Cancel from the card: the cancel route, and the row stops at once; a late round leaves it.
  omni.progress(carla, { state: 'fetching', round: 1, fetched: 10, stored: 10 })
  await until(() => dsh.rowOf(carla).state === 'fetching')
  assert.deepEqual(await dsh.endpoint('cancel_backfill', { jobId: carla }), { jobId: carla, state: 'cancelled', outcome: 'stopped' })
  assert.ok(omni.asked.some(call => call.method === 'POST' && call.path === `/chats/${CARLA}/backfill/${carla}/cancel`))
  assert.equal(omni.jobs.get(carla).status, 'cancelled')
  assert.deepEqual(dsh.rowOf(carla).coverage, coverage(3))
  omni.progress(carla, { state: 'fetching', round: 2, fetched: 99 })
  // Another sync of this Omni, and a job no Start here queued, are acked and left.
  omni.emit('sync.progress', { jobId: '9b000000-0000-4000-8000-000000000001', instanceId: INSTANCE, type: 'messages', progress: { fetched: 1, stored: 1, duplicates: 0, mediaDownloaded: 0, state: 'fetching' } })
  omni.emit('sync.completed', { jobId: 'not-a-job', instanceId: INSTANCE, type: 'contacts', progress: {} })
  // Failed: sync.failed carries only the error, which stays in Omni.
  omni.fail(davi)
  await until(() => dsh.rowOf(davi).outcome === 'failed')
  assert.equal(dsh.rowOf(carla).counts.fetched, 10)
  assert.equal(dsh.rowOf(carla).state, 'cancelled')
  assert.deepEqual(dsh.live()[0].summary, { total: 4, running: 0, done: 1, phoneDidNotAnswer: 1, stopped: 1, failed: 1 })
  // Nothing unfinished: the stream closes. Rounds came by event, never by reading a job again.
  await until(() => omni.open().length === 0)
  await until(() => !dsh.root.get('omniChannels').omniEventsView().listening.includes('backfills'))
  assert.equal(omni.jobReads().length, readsBefore)
  const acks = omni.asked.filter(call => call.path.endsWith('/ack')).map(call => call.body.cursor)
  assert.deepEqual(acks, [...acks].sort((a, b) => a - b))
  assert.ok(acks.length >= 10)
  // The events fed the rows and nothing else: no message was looked up for an answer.
  assert.equal(omni.asked.some(call => call.path.includes('/messages')), false)
  // Labels and counts only, in the live answer, the team view and state.json.
  await dsh.team.save()
  const shown = JSON.stringify([dsh.team.extended.live(), dsh.team.extended.view(), readFileSync(join(dsh.home, 'state.json'), 'utf8')])
  for (const text of [PREVIEW, ERROR, 'whatsapp.net', 'Cancelled by person', 'Finished requesting', 'Phone did not answer the chat']) assert.ok(!shown.includes(text), text)
  assert.deepEqual(Object.keys(dsh.rowOf(ana)).sort(), ['channelId', 'chat', 'chatId', 'counts', 'coverage', 'jobId', 'oldestReached', 'outcome', 'round', 'startedAt', 'state', 'updatedAt'])
})

test('after a restart, the stream reads each unfinished job by its route before it streams, and goes on with the events', async (t) => {
  const omni = omniO3()
  const home = homeWith()
  const first = await start(t, home)
  await first.run('propose_backfill', { chats: [ANA, BRUNO] })
  const card = first.proposals()[0]
  const { jobs } = await first.endpoint('start_backfill', { proposalId: card.id, chats: ticked(card), from: FROM, to: TO })
  const [ana, bruno] = jobs.map(job => job.jobId)
  await until(() => omni.open().length === 1)
  await first.stop()
  await until(() => omni.open().length === 0)
  // While this host was down: one job ended, the other moved on.
  omni.jobs.get(ana).status = 'completed'
  omni.jobs.get(ana).progress = { ...omni.jobs.get(ana).progress, state: 'done', stored: 12, lastProgressAt: new Date().toISOString() }
  omni.jobs.get(bruno).progress = { ...omni.jobs.get(bruno).progress, state: 'fetching', round: 3, stored: 7, lastProgressAt: new Date().toISOString() }
  const reads = omni.jobReads().length
  const second = await start(t, home)
  await until(() => second.rowOf(ana)?.outcome === 'done' && second.rowOf(bruno)?.state === 'fetching')
  assert.equal(omni.jobReads().length - reads, 2)
  // The route's live coverage is kept once a job ends.
  assert.deepEqual(second.rowOf(ana).coverage, coverage(1))
  assert.equal(second.rowOf(bruno).coverage, null)
  await until(() => omni.open().length === 1)
  omni.progress(bruno, { state: 'done', round: 4, stored: 9, coverage: coverage(2) })
  omni.complete(bruno)
  await until(() => second.rowOf(bruno).outcome === 'done')
  assert.equal(second.rowOf(bruno).counts.stored, 9)
  await until(() => omni.open().length === 0)
})

test('answer children are refused all three tools; a Bot that does not operate Omni too; the Bot follows and cancels a backfill when the user asks', async (t) => {
  const omni = omniO3()
  const thread = { id: 'thread-1', sessionId: 'child-1', chatId: ANA, chatIds: [ANA], chatJid: CHATS[ANA].externalId, chatName: 'Ana', channelId: INSTANCE, origin: OMNI, ownerBotId: 'm1', answerChild: true, self: null, title: 'Ana', status: 'idle', turnOpenAt: null, at: 1 }
  const state = teamState({
    bots: { ...teamState().bots, w1: { id: 'w1', name: 'Dev', role: '', instructions: '', createdAt: 3 } },
    omniThreads: { [thread.id]: thread },
  })
  const dsh = await start(t, homeWith(state))
  assert.equal(dsh.root.get('omniChannels').threads.bySession('child-1').answerChild, true)
  const calls = [['propose_backfill', { chats: [ANA] }], ['backfill_status', {}], ['cancel_backfill', { jobId: '9a000000-0000-4000-8000-000000000001' }]]
  // Through DSH's pipeline the child's containment denies first (this bench's stand-in Session
  // has no scoped tool registry); each tool's own refusal holds whatever a child is allowed.
  for (const [name, args] of calls) {
    assert.equal(await dsh.run(name, args, 'child-1'), 'ERROR This Session has no scoped tool registry.', name)
    assert.equal(await dsh.root.tools.get(name).execute(args, { agent: { id: 'child-1' } }), ANSWER_CHILD_REFUSAL, name)
    assert.equal(await dsh.run(name, args, 'w1'), NOT_OPERATOR, name)
  }
  assert.deepEqual(dsh.proposals(), [])
  assert.equal(omni.asked.some(call => call.path.startsWith('/chats')), false)

  assert.match(await dsh.run('backfill_status', {}), /^No backfill here yet\./)
  await dsh.run('propose_backfill', { chats: [ANA, BRUNO] })
  assert.match(await dsh.run('backfill_status', {}), /^A proposal waits for the user's Start: 5 chats on its card, 2 ticked by you\.$/)
  const card = dsh.proposals()[0]
  const { jobs } = await dsh.endpoint('start_backfill', { proposalId: card.id, chats: ticked(card), from: FROM, to: TO })
  const [ana, bruno] = jobs.map(job => job.jobId)
  await until(() => omni.open().length === 1)
  omni.progress(ana, { state: 'done', round: 1, fetched: 3, stored: 3, coverage: coverage(1) })
  omni.complete(ana)
  await until(() => dsh.rowOf(ana).outcome === 'done')
  // The status read reads unfinished jobs by their route, and names counts, never text.
  const status = await dsh.run('backfill_status', {})
  assert.match(status, /^Backfill of 2026-03-01 to 2026-11-15, started \S+: 1 done, 0 phone did not answer, 0 stopped, 0 failed, 1 running\.$/m)
  assert.match(status, new RegExp(`^- Ana \\(job ${ana}\\): done; 3 stored of 3 fetched, .*; Omni now holds 101 messages of this chat \\(2026-03-02 to 2026-11-14\\), 91 in the range\\.$`, 'm'))
  assert.match(status, new RegExp(`^- Bruno \\(job ${bruno}\\): waiting for its turn; 0 stored of 0 fetched`, 'm'))
  assert.ok(!status.includes(PREVIEW))
  assert.ok(omni.jobReads().some(call => call.path.endsWith(`/backfill/${bruno}`)))
  // The Bot's cancel, when the user asks: the same cancel route, also while a round says the
  // phone did not answer (the job still runs then).
  omni.progress(bruno, { state: 'phone-did-not-answer', round: 1 })
  await until(() => dsh.rowOf(bruno).state === 'phone-did-not-answer')
  assert.match(await dsh.run('backfill_status', { jobId: bruno }), /\(job \S+\): the phone has not answered yet; still running;/)
  assert.equal(await dsh.run('cancel_backfill', { jobId: bruno }), 'Stopped the backfill of Bruno: it ends after the round it is in.')
  assert.equal(omni.jobs.get(bruno).status, 'cancelled')
  assert.equal(await dsh.run('cancel_backfill', { jobId: ana }), 'The backfill of Ana had already ended: done.')
  assert.equal(omni.asked.filter(call => call.path.endsWith('/cancel')).length, 1)
  assert.match(await dsh.run('cancel_backfill', { jobId: '9a000000-0000-4000-8000-000000000099' }), /^No backfill job /)
  await until(() => omni.open().length === 0)
})
