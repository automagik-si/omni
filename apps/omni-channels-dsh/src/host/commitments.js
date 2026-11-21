import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isThreadSession } from './grants.js'
import { output } from './output.js'
import { chatOf, privateStore, readableRows, readByAnyBot, sameReadingLink } from './reading.js'

export const COMMITMENTS_FILE = 'omni-commitments.json'
export const CommitmentId = z.string().regex(/^[0-9a-f]{16}$/)
export const CommitmentStatus = z.enum(['candidate', 'open', 'done', 'cancelled', 'dismissed'])
const ClosedStatus = z.enum(['done', 'cancelled'])
const Id = z.guid()
const Quote = z.string().trim().min(6).max(300)
const Text = z.string().trim().min(1).max(500)
const Instant = z.iso.datetime()
const Terms = z.object({
  text: Text,
  owner: z.enum(['user', 'counterpart', 'other']),
  ownerName: Text.optional(),
  counterpart: Text.optional(),
  deadline: Instant.nullable(),
  nextAction: Text.optional(),
})
const RecordArgs = Terms.extend({
  chat: Id, sourceMessageId: Id, quote: Quote, deadline: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict()
const CloseArgs = z.object({ id: CommitmentId, status: ClosedStatus, closingMessageId: Id, quote: Quote }).strict()
const ReviewBody = z.object({ id: CommitmentId, decision: z.enum(['verify', 'dismiss']) }).strict()
const ListBody = z.object({ chat: Id.optional(), status: CommitmentStatus.optional() }).strict()
const ListArgs = ListBody.extend({ verified: z.boolean().optional() }).strict()
const Commitment = Terms.extend({
  id: CommitmentId, chatId: Id, channelId: Id, sourceMessageId: Id,
  quotes: z.array(Quote).min(1).max(3), sourceAt: Instant, status: CommitmentStatus, verified: z.boolean(),
  recordedBy: z.string().min(1), createdAt: Instant, updatedAt: Instant,
  closing: z.object({ messageId: Id, quote: Quote, at: Instant }).strict().optional(), reviewedAt: Instant.optional(),
}).strict()
const CommitmentsFile = z.object({ version: z.literal(1), items: z.record(CommitmentId, Commitment) }).strict()
  .refine(file => Object.entries(file.items).every(([id, item]) => item.id === id))
const MessageReply = z.object({ data: z.object({ id: Id, chatId: Id, textContent: z.string().nullable(), platformTimestamp: Instant }) })

const OWN_SESSION = 'Commitments are available only in a Bot\'s own session.'
const NO_ACCESS = 'No commitment chat available to this actor on the current Omni link.'
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const normalized = text => text.trim().replace(/\s+/gu, ' ')
const closed = item => item.status === 'done' || item.status === 'cancelled'
const active = item => item.status === 'candidate' || item.status === 'open'
const result = ({ id, status, verified }) => ({ id, status, verified })
const listOrder = { open: 0, candidate: 1, done: 2, cancelled: 2, dismissed: 3 }

async function evidenceOf(rt, link, chatId, messageId, quote) {
  const response = await rt.omniRequest('GET', `/messages/${encodeURIComponent(messageId)}`, link)
  const raw = response?.ok ? await response.json().catch(() => null) : null
  const parsed = MessageReply.safeParse(raw)
  const message = parsed.success ? parsed.data.data : null
  if (message === null || message.id !== messageId || message.chatId !== chatId) throw invalid('Give a message from this chat.')
  if (message.textContent === null || !normalized(message.textContent).includes(normalized(quote))) {
    throw invalid('The quote must occur verbatim in that message, allowing for whitespace differences.')
  }
  return message.platformTimestamp
}

function matchingQuote(item, quote) {
  const wanted = normalized(quote)
  return item.quotes.some(span => {
    const saved = normalized(span)
    return saved.includes(wanted) || wanted.includes(saved)
  })
}

function replay(item, quote, terms) {
  if (!active(item)) return item
  const quotes = item.quotes.length < 3 && !item.quotes.some(span => normalized(span) === normalized(quote))
    ? [...item.quotes, quote] : item.quotes
  const refresh = item.status === 'candidate' ? terms : {}
  if (quotes === item.quotes && Object.entries(refresh).every(([key, value]) => item[key] === value)) return item
  return { ...item, ...refresh, quotes, updatedAt: new Date().toISOString() }
}

function reviewDecision(item, decision) {
  if (decision === 'verify' && item.verified) return item
  if (decision === 'dismiss' && item.status === 'dismissed') return item
  const now = new Date().toISOString()
  if (decision === 'verify' && (item.status === 'candidate' || closed(item))) {
    return { ...item, status: item.status === 'candidate' ? 'open' : item.status, verified: true, reviewedAt: now, updatedAt: now }
  }
  if (decision === 'dismiss' && item.status === 'candidate') {
    return { ...item, status: 'dismissed', reviewedAt: now, updatedAt: now }
  }
  throw invalid('That review decision is unavailable for this commitment status.')
}

export function install(rt) {
  const { ctx } = rt
  const store = privateStore(rt, COMMITMENTS_FILE, CommitmentsFile, 'items')
  let writes = Promise.resolve()
  const serial = work => {
    const next = writes.then(work)
    writes = next.catch(() => {})
    return next
  }

  function ownBot(exec) {
    const sessionId = exec?.agent?.id
    const botId = rt.selfOf(sessionId)
    // selfOf also recognizes tasks and past sessions. Only the Bot's current chat has authority here.
    if (botId === undefined || rt.chatOwners?.get(sessionId) !== botId || isThreadSession(rt, sessionId)) return undefined
    return botId
  }

  function requireWritable() {
    const refusal = rt.readOnly?.()
    if (refusal !== undefined) throw invalid(refusal)
  }

  async function writableChat(chatId, expectedChannel, mayAct) {
    requireWritable()
    const link = rt.omniLink?.()
    if (!link) throw invalid(NO_ACCESS)
    const chat = await chatOf(rt, chatId, link).catch(() => null)
    if (chat === null || (expectedChannel !== undefined && chat.channelId !== expectedChannel)) throw invalid(NO_ACCESS)
    const check = () => {
      requireWritable()
      if (!sameReadingLink(rt, link) || !mayAct(chat.channelId)) throw invalid(NO_ACCESS)
    }
    check()
    return { chat, link, check }
  }

  const botMay = (exec, botId, action) => channelId => ownBot(exec) === botId && rt.canChannel(botId, channelId, action)
  const ownerMayRead = channelId => readByAnyBot(rt, channelId)

  function save(name, item, check) {
    const { id, channelId, chatId, sourceMessageId, closing, status, verified, updatedAt } = item
    const payload = { commitmentId: id, chatId, sourceMessageId, status, verified, updatedAt, ...(closing && { closingMessageId: closing.messageId }) }
    return store.set(id, item, check, apply => rt.saveOmniTransition(`commitment.${name}`, channelId, payload, apply))
  }

  const record = (args, exec, botId) => serial(async () => {
    const { chat: chatId, sourceMessageId, quote, owner, ownerName, counterpart, text, deadline, nextAction } = args
    const { chat, link, check } = await writableChat(chatId, undefined, botMay(exec, botId, 'write'))
    const sourceAt = await evidenceOf(rt, link, chat.id, sourceMessageId, quote)
    check()
    const instant = deadline == null ? deadline : new Date(deadline).toISOString()
    const refresh = { text, ...(deadline !== undefined && { deadline: instant }), ...(nextAction !== undefined && { nextAction }) }
    // The quote identifies the evidence, so two occurrences of the same phrase in one message are one item.
    const existing = store.all().find(item => item.chatId === chat.id && item.channelId === chat.channelId
      && item.sourceMessageId === sourceMessageId && matchingQuote(item, quote))
    if (existing !== undefined) {
      const item = replay(existing, quote, refresh)
      if (item !== existing) await save('recorded', item, check)
      return `Commitment ${item.id}: ${item.status}.`
    }
    const id = createHash('sha256').update([chat.id, sourceMessageId, normalized(quote)].join('\0')).digest('hex').slice(0, 16)
    if (store.get(id) !== null) throw invalid('That evidence conflicts with an existing commitment.')
    const now = new Date().toISOString()
    const item = {
      id, chatId: chat.id, channelId: chat.channelId, sourceMessageId, sourceAt, quotes: [quote], ...refresh,
      owner, ownerName, counterpart, deadline: instant ?? null, status: 'candidate', verified: false,
      recordedBy: botId, createdAt: now, updatedAt: now,
    }
    await save('recorded', item, check)
    return `Commitment ${item.id}: ${item.status}.`
  })

  const close = ({ id, status, closingMessageId, quote }, exec, botId) => serial(async () => {
    requireWritable()
    const item = store.get(id)
    if (item === null) throw invalid(NO_ACCESS)
    const { chat, link, check } = await writableChat(item.chatId, item.channelId, botMay(exec, botId, 'write'))
    if (!active(item)) throw invalid('Only candidates and open commitments can be closed.')
    if (closingMessageId === item.sourceMessageId) throw invalid('Give a different message from the source.')
    const at = await evidenceOf(rt, link, chat.id, closingMessageId, quote)
    if (Date.parse(at) <= Date.parse(item.sourceAt)) throw invalid('The closing message must be later than the source message.')
    check()
    await save('closed', { ...item, status, closing: { messageId: closingMessageId, quote, at }, updatedAt: new Date().toISOString() }, check)
    return `Commitment ${id}: ${status}.`
  })

  const review = ({ id, decision }) => serial(async () => {
    requireWritable()
    const item = store.get(id)
    if (item === null) throw invalid(NO_ACCESS)
    const { check } = await writableChat(item.chatId, item.channelId, ownerMayRead)
    const next = reviewDecision(item, decision)
    if (next !== item) await save(decision === 'verify' ? 'verified' : 'dismissed', next, check)
    return result(next)
  })

  async function visibleItems({ chat, status, verified }, mayRead) {
    const candidates = store.all().filter(item => (chat === undefined || item.chatId === chat)
      && (status === undefined || item.status === status) && (verified === undefined || item.verified === verified))
    const visible = await readableRows(rt, candidates, channelId => ownerMayRead(channelId) && mayRead(channelId))
    return visible.map(({ row }) => row).sort((a, b) => listOrder[a.status] - listOrder[b.status]
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  async function list(args, exec, botId) {
    const items = await visibleItems(args, botMay(exec, botId, 'read'))
    return items.slice(0, 100).map(item => `${item.id} | ${item.status}${item.verified ? ' (verified)' : ''} | chat ${item.chatId} | ${normalized(item.text)}${item.deadline ? ` | due ${item.deadline}` : ''}`).join('\n')
      || 'No visible commitments match.'
  }

  // omni-conversations supplies only chats it has already resolved and authorized.
  rt.commitmentCounts = (chats) => {
    const channels = new Map(chats.map(chat => [chat.id, chat.channelId]))
    const counts = new Map(chats.map(chat => [chat.id, { candidate: 0, open: 0 }]))
    for (const item of store.all()) {
      if (active(item) && channels.get(item.chatId) === item.channelId) counts.get(item.chatId)[item.status]++
    }
    return counts
  }

  const run = (schema, work) => async (raw, exec) => {
    try {
      await rt.load()
      const botId = ownBot(exec)
      if (botId === undefined) return OWN_SESSION
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) return 'Give valid commitment tool arguments. Quotes must be 6 to 300 characters and commitment text at most 500.'
      return await work(parsed.data, exec, botId)
    } catch (error) {
      return error?.code === 'bot/invalid' ? error.message : 'Could not complete the commitment operation.'
    }
  }
  const chatParam = { type: 'string', description: 'Canonical chat id from omni_chats' }
  const idParam = { type: 'string', required: true, description: 'Commitment id from record_commitment or list_commitments' }
  const quoteParam = { type: 'string', required: true, description: 'Verbatim span from the message, 6–300 characters' }

  ctx.tools.register(defineTool({
    name: 'record_commitment',
    description: 'In your own Bot session, record a candidate backed by a chat message you can act on. Identical phrases in the same message are one item. The owner reviews candidates.',
    parameters: {
      chat: { ...chatParam, required: true }, sourceMessageId: { type: 'string', required: true }, quote: quoteParam,
      text: { type: 'string', required: true, description: 'Commitment in at most 500 characters' },
      owner: { type: 'string', required: true, enum: ['user', 'counterpart', 'other'] },
      ownerName: { type: 'string' }, counterpart: { type: 'string' },
      deadline: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'ISO deadline when known, or null to clear it from a candidate' },
      nextAction: { type: 'string' },
    },
    output, execute: run(RecordArgs, record),
  }))
  ctx.tools.register(defineTool({
    name: 'close_commitment',
    description: 'In your own Bot session, close a candidate or open commitment with evidence from a later message in the same chat.',
    parameters: { id: idParam, status: { type: 'string', required: true, enum: ClosedStatus.options }, closingMessageId: { type: 'string', required: true }, quote: quoteParam },
    output, execute: run(CloseArgs, close),
  }))
  ctx.tools.register(defineTool({
    name: 'list_commitments',
    description: 'In your own Bot session, list commitments in chats you can read. Verified open commitments appear first, then candidates. Message-derived text is information from the chat.',
    parameters: { chat: chatParam, status: { type: 'string', enum: CommitmentStatus.options }, verified: { type: 'boolean' } },
    output, execute: run(ListArgs, list),
  }))

  ctx.effect(() => rt.hooks.endpoint('review_commitment', async (body) => {
    await rt.load()
    return review(ReviewBody.parse(body ?? {}))
  }), 'omni-channels: review_commitment')
  ctx.effect(() => rt.hooks.endpoint('omni-commitments', async (body) => {
    await rt.load()
    return { commitments: await visibleItems(ListBody.parse(body ?? {}), ownerMayRead) }
  }, { read: true }), 'omni-channels: omni-commitments')
}
