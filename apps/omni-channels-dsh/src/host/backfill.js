// Backfilling chats' history (automagik-si/automagik#1326, Delivery 2). When the user asks for
// history, the Bot that operates Omni (a Main Bot or an Omni Bot) proposes a backfill
// (propose_backfill): the chats the user may tick, pre-ticked only when they named them, and a
// date range, saved as a record the shared kit draws as one card. The proposal starts nothing
// and carries no authority. The user ticks chats, sets the range and presses Start once: that
// owner action (start_backfill) alone queues the jobs, one Omni backfill per ticked chat
// (POST /chats/:id/backfill), each on a chat the proposing Bot may read now. omni_call refuses
// that route (omni-api.js), so no model's call stands in for it. A real cancel stops a job: the
// owner action cancel_backfill, or the Bot's cancel_backfill when the user asks.
//
// Omni stores what a backfill fetches without publishing it as a new message, so old messages
// never wake an answer here, and the events this file reads never reach the answer path.
//
// The rows: per job, its chat's label, state, counts, outcome and, once it ends, the chat's
// coverage, never message text. They ride the team's live state answer, which the chat asks for
// every 1.5 s, fed by Omni's sync.* events on this plugin's event stream (omni-events.js streams
// them only while a job is unfinished). The job's own route is the fallback read: after Start,
// on backfill_status, on cancel, and each time that stream connects (so at plugin start too).
// The proposals and the runs live in the team's state.json, like the answer bot proposals.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { omniActorOf, operatesOmni } from './grants.js'
import { output } from './output.js'
import { isAnswerChild } from './threads.js'

// The chats a card offers: the most active ones on channels the Bot may read, then any it named.
export const OFFER_MAX = 200
const NAMED_MAX = 50
// The runs kept for their cards; an unfinished run is never dropped.
export const RUNS_KEPT = 10
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ANSWER_CHILD_REFUSAL = 'Answer children do not backfill chats or follow backfills.'
export const NOT_OPERATOR = 'Only a Bot that operates Omni (a Main Bot or an Omni Bot) proposes or follows a backfill.'
export const NOT_READABLE = 'This chat is on a channel that belongs to another bot: this bot may not backfill it.'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// The job states Omni gives, and what each says on its row once the job ends. A job may read
// phone-did-not-answer, or done, while it still runs (its coverage comes after): only the end
// of the job ends its row, a terminal event (sync.completed, sync.cancelled, sync.failed) or
// the job route's status (completed, cancelled, failed).
export const STATES = ['queued', 'fetching', 'done', 'phone-did-not-answer', 'cancelled', 'failed']
const OUTCOMES = { done: 'done', 'phone-did-not-answer': 'phone-did-not-answer', cancelled: 'stopped', failed: 'failed' }
const ENDS = new Set(['completed', 'cancelled', 'failed'])
const EVENT_ENDS = { 'sync.completed': 'completed', 'sync.cancelled': 'cancelled', 'sync.failed': 'failed' }
const ended = row => row.outcome !== null
// How a job ended, from the job route's answer: its status, or null while it runs.
const endOf = data => (ENDS.has(data?.status) ? data.status : null)
// A row's counts, and the progress field each one comes from.
const COUNTS = { fetched: 'fetched', stored: 'stored', duplicates: 'duplicates', mediaDownloaded: 'mediaDownloaded', mediaMissing: 'mediaMissing', reactions: 'reactionsApplied', edits: 'editsApplied', deletions: 'deletionsApplied', unmatched: 'unmatched' }
const zeroCounts = () => Object.fromEntries(Object.keys(COUNTS).map(key => [key, 0]))

const id = z.string().trim().regex(ID)
const time = z.string().trim().min(1).max(40)
const ProposeArgs = z.object({ chats: z.array(id).max(NAMED_MAX).optional(), from: time.optional(), to: time.optional() })
const JobArgs = z.object({ jobId: id })
const StatusArgs = z.object({ jobId: id.optional() })
const StartBody = z.object({ proposalId: id, chats: z.array(id).min(1).max(OFFER_MAX), from: time, to: time }).strict()
const CancelBody = z.object({ jobId: id }).strict()

// What this file reads of Omni's answers; anything else they carry is dropped here.
const optionalText = z.string().nullish()
const ChatRow = z.object({ id: z.string().regex(ID), name: optionalText, instanceId: z.string().min(1), chatType: optionalText })
const ChatList = z.object({ items: z.array(z.unknown()) })
const ChatReply = z.object({ data: ChatRow })
const InstanceList = z.object({ items: z.array(z.object({ id: z.string(), name: optionalText })) })
const Queued = z.object({ jobId: z.string().regex(ID) })
const count = z.number().int().nonnegative()
const instant = z.string().max(40).nullable()
const Coverage = z.object({ oldest: instant, newest: instant, count, countInWindow: count, deletedCount: count, mediaMissing: count, lastInbound: instant, lastOutbound: instant })
// A job's progress: in a sync.* event's payload, or spread over the job route's answer.
const Progress = z.object({
  state: z.enum(STATES).optional().catch(undefined),
  lastProgressAt: z.string().max(40).optional(),
  ...Object.fromEntries(Object.values(COUNTS).map(field => [field, count.optional()])),
  round: count.optional(),
  oldestReached: instant.optional(),
  coverage: Coverage.optional(),
})
const EventPayload = z.object({ jobId: z.string().regex(ID), progress: z.unknown().optional() })

// An ISO time; a bare date is that whole day (its start for `from`, its end for `to`).
export function instantOf(value, end = false) {
  if (value === undefined) return null
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const ms = Date.parse(day ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value)
  if (!Number.isFinite(ms)) throw invalid(`"${value}" is not a date or an ISO time`)
  return new Date(ms).toISOString()
}
const dayOf = value => (value ? String(value).slice(0, 10) : '?')

// A row as the kit sees it: labels and counts, never message text.
const publicRow = row => ({
  chatId: row.chatId, chat: row.chat, channelId: row.channelId, jobId: row.jobId,
  state: row.state, outcome: row.outcome, counts: { ...row.counts }, round: row.round,
  oldestReached: row.oldestReached, coverage: row.coverage, startedAt: row.startedAt, updatedAt: row.updatedAt,
})
export function summaryOf(rows) {
  const by = outcome => rows.filter(row => row.outcome === outcome).length
  return { total: rows.length, running: rows.filter(row => !ended(row)).length, done: by('done'), phoneDidNotAnswer: by('phone-did-not-answer'), stopped: by('stopped'), failed: by('failed') + by('not-started') }
}

/**
 * Takes a job's progress into its row: from a sync.* event or the job route, whichever comes
 * first. `end` is how the job ended (completed, cancelled, failed), or null while it runs. An
 * ended row stays as it ended; progress older than the row's is left out, though an end still
 * ends the row. Returns whether the row changed.
 */
export function applyProgress(row, progress, end = null) {
  if (ended(row)) return false
  const parsed = Progress.safeParse(progress ?? {})
  const next = parsed.success ? parsed.data : {}
  const at = Date.parse(next.lastProgressAt ?? '')
  const fresh = parsed.success && !(Number.isFinite(at) && Number.isFinite(row.progressAt) && at < row.progressAt)
  if (!fresh && end === null) return false
  if (fresh) {
    if (next.state !== undefined) row.state = next.state
    for (const [key, field] of Object.entries(COUNTS)) if (next[field] !== undefined) row.counts[key] = next[field]
    if (next.round !== undefined) row.round = next.round
    if (next.oldestReached !== undefined) row.oldestReached = next.oldestReached
    if (Number.isFinite(at)) row.progressAt = at
  }
  if (end !== null) {
    // The label is the job's own last state; the end only decides when it holds.
    if (end !== 'completed') row.state = end
    else if (row.state !== 'done' && row.state !== 'phone-did-not-answer') row.state = 'done'
    row.outcome = OUTCOMES[row.state]
    row.coverage = row.state !== 'failed' && next.coverage ? next.coverage : null
  }
  row.updatedAt = Date.now()
  return true
}

// One line per chat, for the Bot.
function lineOf(row) {
  const c = row.counts
  const counts = `${c.stored} stored of ${c.fetched} fetched, ${c.mediaDownloaded} media downloaded, ${c.mediaMissing} media missing, ${c.reactions} reactions, ${c.edits} edits and ${c.deletions} deletions applied`
  const state = {
    queued: 'waiting for its turn', fetching: `fetching (round ${row.round})`, done: ended(row) ? 'done' : 'finishing',
    'phone-did-not-answer': ended(row) ? 'the phone did not answer' : 'the phone has not answered yet; still running',
    cancelled: 'stopped', failed: row.outcome === 'not-started' ? 'not started: Omni refused it' : 'failed',
  }[row.state] ?? row.state
  const holds = row.coverage ? `; Omni now holds ${row.coverage.count} messages of this chat${row.coverage.oldest ? ` (${dayOf(row.coverage.oldest)} to ${dayOf(row.coverage.newest)})` : ''}, ${row.coverage.countInWindow} in the range` : ''
  return `- ${row.chat} (job ${row.jobId ?? 'none'}): ${state}; ${counts}${holds}.`
}

export function install(rt) {
  const { ctx, state } = rt
  const proposals = () => (state.omniBackfillProposals ??= {})
  const runs = () => (state.omniBackfillRuns ??= [])
  const rowOfJob = jobId => runs().flatMap(run => run.rows).find(row => row.jobId === jobId)
  const unfinished = () => runs().flatMap(run => run.rows).filter(row => row.jobId !== null && !ended(row))

  // One request, its method named where it is called, so the plugin-compat check sees each route.
  async function omni(method, path, body) {
    const response = await rt.omniRequest(method, path, body === undefined ? {} : { body })
    if (response === null) throw invalid('Omni is not connected here: connect one on the Channels page.')
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, json }
  }
  async function chatOf(chatId) {
    const reply = await omni('GET', `/chats/${encodeURIComponent(chatId)}`)
    if (reply.status === 404) return null
    const parsed = ChatReply.safeParse(reply.json)
    if (!reply.ok || !parsed.success) throw invalid(`omni answered ${reply.status} for chat ${chatId}`)
    return labelOf(parsed.data.data)
  }
  const labelOf = chat => ({ id: chat.id, name: (chat.name ?? '').trim().slice(0, 80) || 'Chat', kind: chat.chatType ?? null, channelId: chat.instanceId })

  // Who acts: the Bot a Session works on Omni as, when it operates Omni; never an answer child.
  function actorOf(exec) {
    const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
    if (isAnswerChild(rt.threads?.bySession(sessionId))) return { refusal: ANSWER_CHILD_REFUSAL }
    const bot = omniActorOf(rt, sessionId)
    if (!operatesOmni(rt, bot)) return { refusal: NOT_OPERATOR }
    return { bot }
  }

  // The job route: the fallback read of one row. A job Omni no longer has ends the row.
  async function readJob(row) {
    const reply = await omni('GET', `/chats/${encodeURIComponent(row.chatId)}/backfill/${encodeURIComponent(row.jobId)}`)
    if (reply.status === 404) return applyProgress(row, {}, 'failed')
    if (!reply.ok) return false
    const data = reply.json?.data
    return applyProgress(row, data, endOf(data))
  }
  // Every unfinished row read again; one that fails to read waits for its events.
  async function refresh(rows = unfinished()) {
    let changed = false
    for (const row of rows) {
      if (row.jobId === null || ended(row)) continue
      changed = (await readJob(row).catch(() => false)) || changed
    }
    if (changed) await rt.save()
    if (!rt.backfillsUnfinished()) rt.syncOmniEvents?.()
  }

  // omni-events.js: whether its sync.* stream is wanted, one row of it, and the read on connect.
  rt.backfillsUnfinished = () => unfinished().length > 0
  rt.backfillRefresh = () => refresh()
  rt.backfillEvent = async (event) => {
    const parsed = EventPayload.safeParse(event.rawPayload)
    const row = parsed.success ? rowOfJob(parsed.data.jobId) : undefined
    // Another sync of this Omni, or a job no Start here queued.
    if (row === undefined) return 'ignored'
    const changed = applyProgress(row, parsed.data.progress, EVENT_ENDS[event.eventType] ?? null)
    // The ack that follows saves the state with it.
    if (changed && !rt.backfillsUnfinished()) rt.syncOmniEvents?.()
    return changed ? 'applied' : 'ignored'
  }

  async function propose(raw, exec) {
    const actor = actorOf(exec)
    if (actor.refusal) return actor.refusal
    if (rt.readOnly?.() !== undefined) return rt.readOnly()
    const parsed = ProposeArgs.safeParse(raw ?? {})
    if (!parsed.success) return `Give optionally chats (up to ${NAMED_MAX} chat ids from omni_chats, only the ones the user named), from and to (ISO times or dates).`
    const from = instantOf(parsed.data.from)
    const to = instantOf(parsed.data.to, true)
    if (from !== null && to !== null && from >= to) return 'from must be before to.'
    const listed = await omni('GET', `/chats?limit=${OFFER_MAX}&sort=activity`)
    const items = ChatList.safeParse(listed.json)
    if (!listed.ok || !items.success) return `omni answered ${listed.status} listing chats`
    const offered = new Map()
    for (const item of items.data.items) {
      const chat = ChatRow.safeParse(item)
      if (chat.success && rt.canChannel(actor.bot, chat.data.instanceId, 'read')) offered.set(chat.data.id, labelOf(chat.data))
    }
    const named = [...new Set(parsed.data.chats ?? [])]
    for (const chatId of named) {
      if (offered.has(chatId)) continue
      const chat = await chatOf(chatId)
      if (chat === null) return `No chat ${chatId}: use the ids omni_chats gives.`
      if (!rt.canChannel(actor.bot, chat.channelId, 'read')) return NOT_READABLE
      offered.set(chat.id, chat)
    }
    if (offered.size === 0) return 'There is no chat this bot may read to backfill.'
    const instances = await omni('GET', '/instances?limit=100').catch(() => null)
    const channels = InstanceList.safeParse(instances?.json)
    const channelName = new Map(channels.success ? channels.data.items.map(item => [item.id, item.name ?? null]) : [])
    const ticked = new Set(named)
    // The chats named first, then the others by activity.
    const chats = [...offered.values()].sort((a, b) => Number(ticked.has(b.id)) - Number(ticked.has(a.id)))
    const proposal = {
      id: randomUUID(), botId: actor.bot, from, to, createdAt: Date.now(),
      chats: chats.map(chat => ({ id: chat.id, name: chat.name, kind: chat.kind, channelId: chat.channelId, channel: channelName.get(chat.channelId) ?? null, ticked: ticked.has(chat.id) })),
    }
    // A new proposal from this Bot replaces its open one: each card starts from what the user names now.
    for (const open of Object.values(proposals())) if (open.botId === actor.bot) delete proposals()[open.id]
    proposals()[proposal.id] = proposal
    await rt.save()
    return [
      `Proposed a backfill (proposal ${proposal.id}): a card lists ${chats.length} chats, ${ticked.size} ticked, range ${from ? dayOf(from) : 'not set'} to ${to ? dayOf(to) : 'not set'}.`,
      'Nothing starts until the user ticks the chats, sets the range and presses Start on the card. You cannot start it: tell the user it is ready for them.',
    ].join(' ')
  }

  // The one approval: the user's Start on the card.
  let serial = Promise.resolve()
  const inTurn = run => {
    const next = serial.then(run)
    serial = next.catch(() => {})
    return next
  }
  async function start(body) {
    const parsed = StartBody.parse(body ?? {})
    const from = instantOf(parsed.from)
    const to = instantOf(parsed.to, true)
    if (from >= to) throw invalid('from must be before to.')
    if (Date.parse(from) > Date.now()) throw invalid('from is in the future.')
    if (rt.readOnly?.() !== undefined) throw invalid(rt.readOnly())
    const proposal = proposals()[parsed.proposalId]
    if (!proposal) throw invalid('This proposal is no longer open: ask the Bot again.')
    if (!operatesOmni(rt, proposal.botId)) throw invalid('The Bot that proposed this no longer operates Omni.')
    const offered = new Set(proposal.chats.map(chat => chat.id))
    const ids = [...new Set(parsed.chats)]
    if (ids.some(chatId => !offered.has(chatId))) throw invalid('A ticked chat is not on this card.')
    // Each chat as Omni has it now, on a channel the proposing Bot may read now.
    const chats = []
    for (const chatId of ids) {
      const chat = await chatOf(chatId)
      if (chat === null) throw invalid(`Chat ${chatId} is no longer in Omni.`)
      if (!rt.canChannel(proposal.botId, chat.channelId, 'read')) throw invalid(`${chat.name}: ${NOT_READABLE}`)
      chats.push(chat)
    }
    // Single use: the proposal is gone before the first job is queued.
    if (proposals()[proposal.id] !== proposal) throw invalid('This proposal is no longer open: ask the Bot again.')
    delete proposals()[proposal.id]
    const now = Date.now()
    const run = {
      id: proposal.id, botId: proposal.botId, from, to, startedAt: now,
      rows: chats.map(chat => ({ chatId: chat.id, chat: chat.name, channelId: chat.channelId, jobId: null, state: 'queued', outcome: null, counts: zeroCounts(), round: 0, oldestReached: null, coverage: null, startedAt: now, updatedAt: now })),
    }
    const kept = runs()
    kept.unshift(run)
    // The oldest ended runs go; an unfinished one stays.
    while (kept.length > RUNS_KEPT) {
      const at = kept.findLastIndex(old => old.rows.every(row => row.jobId === null || ended(row)))
      if (at <= 0) break
      kept.splice(at, 1)
    }
    await rt.save()
    // Recorded and saved one by one, so a job that started always has its row and its cancel.
    for (const row of run.rows) {
      const reply = await omni('POST', `/chats/${encodeURIComponent(row.chatId)}/backfill`, { from, to }).catch(() => null)
      const queued = Queued.safeParse(reply?.json)
      if (reply?.ok && queued.success) row.jobId = queued.data.jobId
      else Object.assign(row, { state: 'failed', outcome: 'not-started', updatedAt: Date.now() })
      await rt.save()
    }
    rt.syncOmniEvents?.()
    await refresh(run.rows)
    return { runId: run.id, jobs: run.rows.map(row => ({ chatId: row.chatId, jobId: row.jobId, state: row.state })) }
  }

  // A real cancel: Omni marks the job cancelled and its worker stops at its next check.
  async function cancel(jobId, botId) {
    const row = rowOfJob(jobId)
    if (row === undefined) throw invalid(`No backfill job ${jobId} here: backfill_status lists them.`)
    if (botId !== undefined && !rt.canChannel(botId, row.channelId, 'read')) throw invalid(NOT_READABLE)
    if (ended(row)) return row
    const reply = await omni('POST', `/chats/${encodeURIComponent(row.chatId)}/backfill/${encodeURIComponent(jobId)}/cancel`)
    if (!reply.ok) throw invalid(`omni answered ${reply.status} cancelling that backfill`)
    // The answer is the job as it is now: cancelled, or ended already.
    applyProgress(row, reply.json?.data, endOf(reply.json?.data))
    if (!ended(row)) await readJob(row).catch(() => false)
    await rt.save()
    if (!rt.backfillsUnfinished()) rt.syncOmniEvents?.()
    return row
  }

  async function status(raw, exec) {
    const actor = actorOf(exec)
    if (actor.refusal) return actor.refusal
    const parsed = StatusArgs.safeParse(raw ?? {})
    if (!parsed.success) return 'Give optionally a jobId that backfill_status gave.'
    const mine = runs().map(run => ({ ...run, rows: run.rows.filter(row => rt.canChannel(actor.bot, row.channelId, 'read')) })).filter(run => run.rows.length > 0)
    const wanted = parsed.data.jobId
    if (wanted !== undefined && !mine.some(run => run.rows.some(row => row.jobId === wanted))) return `No backfill job ${wanted} this bot may follow.`
    await refresh(mine.flatMap(run => run.rows).filter(row => wanted === undefined || row.jobId === wanted))
    const open = Object.values(proposals()).filter(proposal => proposal.botId === actor.bot)
    const lines = open.map(proposal => `A proposal waits for the user's Start: ${proposal.chats.length} chats on its card, ${proposal.chats.filter(chat => chat.ticked).length} ticked by you.`)
    for (const run of mine) {
      const rows = run.rows.filter(row => wanted === undefined || row.jobId === wanted)
      if (rows.length === 0) continue
      const s = summaryOf(run.rows)
      lines.push(`Backfill of ${dayOf(run.from)} to ${dayOf(run.to)}, started ${new Date(run.startedAt).toISOString()}: ${s.done} done, ${s.phoneDidNotAnswer} phone did not answer, ${s.stopped} stopped, ${s.failed} failed, ${s.running} running.`)
      lines.push(...rows.map(lineOf))
    }
    return lines.length > 0 ? lines.join('\n') : 'No backfill here yet. propose_backfill puts one on a card when the user asks for history.'
  }

  async function cancelTool(raw, exec) {
    const actor = actorOf(exec)
    if (actor.refusal) return actor.refusal
    if (rt.readOnly?.() !== undefined) return rt.readOnly()
    const parsed = JobArgs.safeParse(raw ?? {})
    if (!parsed.success) return 'Give the jobId of the backfill to stop (backfill_status lists them).'
    const row = await cancel(parsed.data.jobId, actor.bot)
    return row.state === 'cancelled' ? `Stopped the backfill of ${row.chat}: it ends after the round it is in.` : `The backfill of ${row.chat} had already ended: ${row.outcome}.`
  }

  const run = work => async (raw, exec) => {
    try {
      await rt.load()
      return await work(raw, exec)
    } catch (error) {
      return error?.code === 'bot/invalid' ? error.message : `Backfill failed: ${error?.message ?? error}`
    }
  }
  ctx.tools.register(defineTool({
    name: 'propose_backfill',
    description: [
      'Bots that operate Omni only, never answer children. When the user asks for a chat history backfill, puts one card before them:',
      'the chats they may tick (pre-ticked only the ones they named) and the date range (only if they gave one).',
      'It starts nothing: the user ticks, sets the range and presses Start on the card. You cannot start a backfill. One card at a time; a new one replaces your open one.',
    ].join(' '),
    parameters: {
      chats: { type: 'array', items: { type: 'string' }, description: 'Chat ids from omni_chats, only the chats the user named; leave out otherwise' },
      from: { type: 'string', description: 'Start of the range the user gave: an ISO time, or a date for that whole day' },
      to: { type: 'string', description: 'End of the range the user gave: an ISO time, or a date for that whole day' },
    },
    output,
    execute: run(propose),
  }))
  ctx.tools.register(defineTool({
    name: 'cancel_backfill',
    description: 'Bots that operate Omni only, never answer children. Stops one chat\'s backfill, only when the user asks you to stop it. It ends after the round it is in; what it stored stays.',
    parameters: { jobId: { type: 'string', required: true, description: 'The job id backfill_status gives' } },
    output,
    execute: run(cancelTool),
  }))
  ctx.tools.register(defineTool({
    name: 'backfill_status',
    description: 'Bots that operate Omni only, never answer children. Where the backfills stand: per chat its state, what it fetched, stored and applied, its outcome (done, the phone did not answer, stopped), and what Omni holds of the chat once it ends. Counts only, never message text.',
    parameters: { jobId: { type: 'string', description: 'One job; all of them when left out' } },
    output,
    execute: run(status),
  }))

  // The kit's cards: the open proposals (the team view), and the runs' rows on every state answer.
  ctx.effect(() => rt.hooks.view(() => ({ omniBackfillProposals: Object.values(proposals()) })), 'omni-channels: backfill proposals view')
  ctx.effect(() => rt.hooks.live(() => ({ omniBackfills: runs().map(item => ({ id: item.id, botId: item.botId, from: item.from, to: item.to, startedAt: item.startedAt, summary: summaryOf(item.rows), rows: item.rows.map(publicRow) })) })), 'omni-channels: backfill rows')
  const ownerActions = {
    start_backfill: body => inTurn(() => start(body)),
    cancel_backfill: body => inTurn(async () => {
      const row = await cancel(CancelBody.parse(body ?? {}).jobId)
      return { jobId: row.jobId, state: row.state, outcome: row.outcome }
    }),
  }
  for (const [name, action] of Object.entries(ownerActions)) ctx.effect(() => rt.hooks.endpoint(name, async body => { await rt.load(); return action(body) }), `omni-channels: ${name}`)
}
