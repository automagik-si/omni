// Each Bot's channels for the team's left bar, and one Bot's chats when the bar opens it
// (#1781). The bar's source (src/client/bot-channels.js) draws them; it reads Omni only
// through these two.
//
// - The channels ride every state answer (a live hook, as the threads' offer does): their
//   status changes in Omni without a new team revision, which is all a view hook is sent with.
//   They come from the last read of Omni's channels and their states: every overview read
//   (the Channels page and the Omni tree poll it every 15 s while shown), every chats read
//   below, and, when the state is pulled and that read is older than CHANNELS_FRESH_MS, one
//   read of its own (one at a time). No timer: nothing is read while nobody pulls the state.
// - A Bot's chats only through the endpoint, read when the bar opens that Bot: labels, counts,
//   who and a photo, never a message's text.
// Each channel is its owner's (subscriptions.js channelOwner), shown only when that Bot may
// read it (canChannel).
import { z } from 'zod'
import { isAnswerChild } from './threads.js'

/** How old the channels' statuses get, while the state is pulled, before they are read again. */
export const CHANNELS_FRESH_MS = 30_000
export const CHATS_DEFAULT = 20
export const CHATS_MAX = 100
/** New chats whose person is looked up for a photo, per chats read; the rest on later reads. */
export const PEOPLE_READS = 8
const PERSON_TTL_MS = 10 * 60_000
const PERSON_CACHE_MAX = 2_000
const PHOTO_URL = /^https?:\/\//i

export const UNKNOWN_BOT = 'There is no such bot.'
export const NOT_OWNED = 'That channel is not this bot\'s.'
export const NOT_READABLE = 'This bot may not read that channel.'
export const NO_CHANNEL = 'Omni has no such channel.'
export const NOT_CONNECTED = 'Omni is not connected here.'

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const time = value => (value ? Date.parse(value) || null : null)
// A platform id's user part: a WhatsApp JID without its device and domain.
const userOf = id => (typeof id === 'string' ? id.replace(/[:@].*$/, '') : '')
const numberOf = id => userOf(id).replace(/^(\d{6,})$/, '+$1')

const BotChats = z.object({
  botId: z.string().min(1),
  channelId: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
})
const ChatRow = z.object({
  id: z.string(),
  instanceId: z.string(),
  externalId: z.string().nullish(),
  canonicalId: z.string().nullish(),
  chatType: z.string().nullish(),
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  unreadCount: z.number().nullish(),
  lastMessageAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
}).passthrough()
const ChatList = z.object({ items: z.array(ChatRow) }).passthrough()
const Participants = z.object({ items: z.array(z.object({ platformUserId: z.string().nullish(), personId: z.string().nullish() }).passthrough()) }).passthrough()

/**
 * A channel's status as the bar draws it, from Omni's instance and its status read (null when
 * that read failed): connected, needs-pairing (a QR code waits), error, else disconnected
 * (turned off, logged out, or still connecting).
 */
export function barStatusOf(instance, live) {
  if (instance?.isActive === false) return 'disconnected'
  if (live === null || live === undefined) return 'error'
  if (live.state === 'connected') return 'connected'
  if (live.state === 'qr') return 'needs-pairing'
  if (live.state === 'error') return 'error'
  return 'disconnected'
}

/**
 * A chat's status in the bar, from the threads that hold it (threads.js): one that asks for
 * someone (an answer child's needs-staff, or a card waiting on the person) wins, then a paused
 * answer child, then a turn running now; else idle.
 */
export function chatStatusOf(threads, running) {
  let status = 'idle'
  const rank = { idle: 0, answering: 1, paused: 2, 'needs-someone': 3 }
  for (const thread of threads) {
    const now = running(thread) ? thread.status ?? 'idle' : 'idle'
    const own = (isAnswerChild(thread) && thread.needsStaff) || now === 'waiting'
      ? 'needs-someone'
      : isAnswerChild(thread) && thread.paused === true ? 'paused' : now === 'working' ? 'answering' : 'idle'
    if (rank[own] > rank[status]) status = own
  }
  return status
}

export function install(rt) {
  const { ctx } = rt
  // The last read of Omni's channels: { url, at, channels: [{ id, name, kind, status, owner }] }.
  let seen = null
  let reading = null
  // The last read started, by Omni: a read that fails waits CHANNELS_FRESH_MS too.
  let tried = null
  const keep = (read) => {
    seen = {
      url: read.url,
      at: read.at,
      channels: read.instances.map((instance, index) => ({ id: instance.id, name: instance.name, kind: instance.channel, status: barStatusOf(instance, read.statuses[index]), owner: instance.ownerIdentifier ?? null })),
    }
  }
  rt.omniInstancesSeen = keep
  // One read at a time. A read that fails marks the channels it had as error, so they do not
  // stay "connected" while Omni cannot be reached, and waits its CHANNELS_FRESH_MS like any read.
  const refresh = () => {
    if (reading === null) tried = { url: rt.omniBaseUrl?.() ?? null, at: Date.now() }
    reading ??= rt.omniInstances()
      .catch((error) => {
        rt.warn?.('omni-channels: the channels for the bar were not read: %s', error?.message ?? error)
        if (seen !== null) seen = { ...seen, at: Date.now(), channels: seen.channels.map(channel => ({ ...channel, status: 'error' })) }
        return null
      })
      .finally(() => { reading = null })
    return reading
  }
  const current = () => {
    const url = rt.omniBaseUrl?.() ?? null
    return url !== null && seen?.url === url ? seen : null
  }
  const readable = (botId, channelId) => rt.channelOwner(channelId) === botId && rt.canChannel(botId, channelId, 'read')

  // { [botId]: [{ id, name, kind, status }] }: only Bots that own a channel they may read.
  rt.botChannelsView = () => {
    if ((rt.omniBaseUrl?.() ?? null) === null) return { omniBotChannels: {} }
    const kept = current()
    const last = Math.max(kept?.at ?? 0, tried?.url === rt.omniBaseUrl() ? tried.at : 0)
    if (Date.now() - last >= CHANNELS_FRESH_MS) void refresh()
    const byBot = {}
    for (const channel of kept?.channels ?? []) {
      const owner = rt.channelOwner(channel.id)
      if (!owner || !rt.canChannel(owner, channel.id, 'read')) continue
      ;(byBot[owner] ??= []).push({ id: channel.id, name: channel.name, kind: channel.kind, status: channel.status })
    }
    return { omniBotChannels: byBot }
  }

  const read = async (path) => {
    const response = await rt.omniRequest('GET', path)
    if (response === null) throw refused(NOT_CONNECTED)
    if (!response.ok) throw refused(`omni answered ${response.status} for ${path.split('?')[0]}`)
    return response.json()
  }

  // A direct chat's person, by chat (its participants, other than the channel's owner), kept
  // PERSON_TTL_MS; at most PEOPLE_READS new chats looked up per read.
  const persons = new Map()
  const personOf = async (url, chats, owners) => {
    const fresh = chat => { const kept = persons.get(`${url}|${chat.id}`); return kept !== undefined && Date.now() - kept.at < PERSON_TTL_MS ? kept : undefined }
    const direct = chats.filter(chat => chat.chatType === 'dm')
    await Promise.all(direct.filter(chat => fresh(chat) === undefined).slice(0, PEOPLE_READS).map(async (chat) => {
      const answer = Participants.safeParse(await read(`/chats/${encodeURIComponent(chat.id)}/participants`).catch(() => null))
      const owner = owners.get(chat.instanceId)
      const other = answer.success ? answer.data.items.find(item => typeof item.personId === 'string' && (owner === '' || userOf(item.platformUserId) !== owner)) : undefined
      persons.delete(`${url}|${chat.id}`)
      persons.set(`${url}|${chat.id}`, { at: Date.now(), person: other?.personId ?? null, user: other?.platformUserId ?? null })
      if (persons.size > PERSON_CACHE_MAX) persons.delete(persons.keys().next().value)
    }))
    return new Map(direct.map(chat => [chat.id, fresh(chat)]).filter(([, kept]) => kept?.person))
  }

  async function botChats(body) {
    const parsed = BotChats.safeParse(body ?? {})
    if (!parsed.success) throw invalid('Name a bot (botId), and optionally one of its channels (channelId) and how many chats (limit).')
    const { botId, channelId } = parsed.data
    const limit = Math.min(parsed.data.limit ?? CHATS_DEFAULT, CHATS_MAX)
    await rt.load()
    if (!rt.botOf(botId)) throw refused(UNKNOWN_BOT)
    if (channelId !== undefined && rt.channelOwner(channelId) !== botId) throw refused(NOT_OWNED)
    if (channelId !== undefined && !rt.canChannel(botId, channelId, 'read')) throw refused(NOT_READABLE)
    const fresh = current()
    const kept = fresh !== null && Date.now() - fresh.at < CHANNELS_FRESH_MS ? fresh : (await rt.omniInstances(), current())
    if (kept === null) throw refused(NOT_CONNECTED)
    const channels = kept.channels.filter(channel => (channelId === undefined || channel.id === channelId) && readable(botId, channel.id))
    if (channelId !== undefined && channels.length === 0) throw refused(NO_CHANNEL)
    const lists = await Promise.all(channels.map(async (channel) => {
      const query = new URLSearchParams({ instanceId: channel.id, limit: String(limit), sort: 'activity' })
      const answer = ChatList.safeParse(await read(`/chats?${query}`))
      if (!answer.success) throw refused('Omni answered something else for its chats.')
      return answer.data.items.filter(chat => chat.instanceId === channel.id).slice(0, limit)
    }))
    const owners = new Map(channels.map(channel => [channel.id, userOf(channel.owner)]))
    const people = await personOf(kept.url, lists.flat(), owners)
    const photos = await rt.omniPeoplePhotos([...people.values()].map(found => found.person))
    const photoOf = (chat) => {
      const known = people.get(chat.id)
      const own = known ? photos.get(known.person) ?? [] : []
      // Else the chat's own picture, as Omni's chat list shows it.
      return (own.find(photo => photo.user === known?.user) ?? own[0])?.url ?? (typeof chat.avatarUrl === 'string' && PHOTO_URL.test(chat.avatarUrl) ? chat.avatarUrl : null)
    }
    const threads = rt.threads?.list() ?? []
    const live = rt.readOnly?.() === undefined
    const running = thread => !live || rt.teamResume?.running?.(thread.sessionId) === true
    return {
      botId,
      channels: channels.map((channel, index) => ({
        channelId: channel.id,
        chats: lists[index].map((chat) => {
          // A chat Omni has no name for is its number: the phone's, where the chat id is another kind.
          const name = chat.name || numberOf(chat.canonicalId) || numberOf(chat.externalId) || 'Chat'
          const self = chat.chatType === 'dm' && owners.get(channel.id) !== '' && [chat.externalId, chat.canonicalId].some(id => userOf(id) === owners.get(channel.id))
          return {
            id: chat.id,
            name,
            status: chatStatusOf(threads.filter(thread => thread.chatIds?.includes(chat.id) ?? thread.chatId === chat.id), running),
            unread: Math.max(0, Math.floor(chat.unreadCount ?? 0)),
            lastAt: time(chat.lastMessageAt) ?? time(chat.updatedAt) ?? 0,
            who: { name, photo: photoOf(chat), self },
          }
        }).sort((a, b) => b.lastAt - a.lastAt),
      })),
    }
  }

  ctx.effect(() => rt.hooks.live(() => rt.botChannelsView()), 'omni-channels: bot channels')
  ctx.effect(() => rt.hooks.endpoint('omni-bot-chats', botChats, { read: true }), 'omni-channels: omni-bot-chats')
}
