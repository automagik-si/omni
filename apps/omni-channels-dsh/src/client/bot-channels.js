import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { call, createSource, face } from './core.js'
import { omniActions, omniStore, refreshLive, startLive } from './omni-store.js'

// The team's left bar draws each Bot's channels, and an open Bot's chats, from one source per
// Bot (@automagik/bots-dsh/client `omni.botChannels`, #1781). This plugin's source serves the
// Bots that own a channel of the linked Omni: their channels ride every state answer
// (roster.omniBotChannels, host bot-channels.js), and a Bot's chats are read from the host
// (omni-bot-chats) only while the bar has that Bot open, kept CHATS_FRESH_MS and read again
// every CHATS_POLL_MS while it stays open and the window is shown. Labels, counts and photos
// only: no message text reaches the bar.

export const SOURCE_ID = 'omni-channels'
export const CHATS_FRESH_MS = 10_000
export const CHATS_POLL_MS = 15_000

// The tones of the two sides of Omni's chat view, where the bar can read them: the incoming
// side's pink mix and the outgoing side's blue mix, from the team's tokens (body, the
// selectors bots-dsh declares them on). The chat view keeps its own copy (channels.js).
export const BOT_CHANNELS_CSS = `
body{--oc-in:color-mix(in srgb,var(--bt-magic-pink) 16%,var(--bt-card));--oc-out:color-mix(in srgb,var(--bt-accent) 20%,var(--bt-card))}
body[data-ds-dark-theme]{--oc-in:color-mix(in srgb,var(--bt-magic-pink) 26%,var(--bt-bubble));--oc-out:color-mix(in srgb,var(--bt-accent) 34%,var(--bt-bubble))}
`

const NONE = Object.freeze({})
const noSubscribe = () => () => {}
const rosterOf = () => face?.()?.hooks?.roster ?? null
const channelsNow = () => rosterOf()?.getSnapshot?.()?.omniBotChannels ?? NONE

/** Whether this source serves a Bot (its roster record): it owns a channel it may read. */
export const ownsBot = bot => typeof bot?.id === 'string' && Object.hasOwn(channelsNow(), bot.id)

// The chats read per Bot: { [botId]: { at, byChannel: { [channelId]: chats } } }.
export const chatsStore = createSource({})
const reading = new Map()

/** A Bot's chats from the host, unless a read younger than CHATS_FRESH_MS has them. */
export function readChats(botId, { now = Date.now() } = {}) {
  const kept = chatsStore.getSnapshot()[botId]
  if (kept !== undefined && now - kept.at < CHATS_FRESH_MS) return Promise.resolve(kept)
  if (reading.has(botId)) return reading.get(botId)
  const read = call('omni-bot-chats', { botId })
    .then((answer) => {
      const byChannel = Object.fromEntries((Array.isArray(answer?.channels) ? answer.channels : []).map(channel => [channel.channelId, Array.isArray(channel.chats) ? channel.chats : []]))
      const next = { at: Date.now(), byChannel }
      chatsStore.set(all => ({ ...all, [botId]: next }))
      return next
    }, (error) => {
      // The channels stay drawn; their chats wait for the next read.
      console.warn('Could not read this Bot\'s chats:', error)
      return kept ?? null
    })
    .finally(() => { reading.delete(botId) })
  reading.set(botId, read)
  return read
}

const readOf = (chats, seen = {}) => chats?.map(chat => (chat.unread > 0 && (seen[chat.id] ?? -1) >= chat.lastAt ? { ...chat, unread: 0 } : chat))

/**
 * The bar's hook: this Bot's channels `[{ id, name, kind, status }]`, or undefined for a Bot
 * this source does not serve. While `open`, each channel also carries `chats` (undefined until
 * the first read answers, then a list, empty when it has none).
 */
export function useBotChannels(botId, { open = false } = {}) {
  const roster = rosterOf()
  const channels = useSyncExternalStore(roster?.subscribe ?? noSubscribe, () => roster?.getSnapshot?.()?.omniBotChannels?.[botId])
  const loads = open === true && channels !== undefined
  const chats = useSyncExternalStore(chatsStore.subscribe, () => chatsStore.getSnapshot()[botId])
  // A chat opened in Omni's chat view since is read, as Omni's own list shows it (omni-store.js seen).
  const seen = useSyncExternalStore(omniStore.subscribe, () => omniStore.getSnapshot().seen)
  useEffect(() => {
    if (!loads) return undefined
    void readChats(botId)
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void readChats(botId)
    }, CHATS_POLL_MS)
    return () => clearInterval(timer)
  }, [botId, loads])
  return useMemo(() => (channels === undefined ? undefined : channels.map(channel => (loads ? { ...channel, chats: readOf(chats?.byChannel?.[channel.id], seen) } : channel))), [channels, chats, loads, seen])
}

/**
 * Opens a chat as Omni's own chat list does (omni-store.js openChat), in the chat panel. A
 * window that has not read Omni yet reads it first: the first live read starts a fresh store.
 * A chat the overview's newest chats do not hold (the bar lists each channel's own) is named in
 * one more read, which lists it, as every read does while it is open.
 */
export async function openBotChat(chatId) {
  const actions = face?.()?.actions
  if (typeof chatId !== 'string' || typeof actions?.selectPanel !== 'function') return
  const warn = error => console.warn('Could not read Omni:', error)
  if (omniStore.getSnapshot().preview) await refreshLive(call).catch(warn)
  if (!omniStore.getSnapshot().preview && !omniStore.getSnapshot().chats.some(chat => chat.id === chatId)) {
    omniStore.set(state => ({ ...state, chatId }))
    await refreshLive(call).catch(warn)
  }
  startLive(call)
  omniActions(id => actions.selectPanel(id), call).openChat(chatId)
}

/**
 * Registers the source with the bar's registry (core.js botChannels); an older team client has
 * none, and keeps the channels under the Omni Bot's row (omni-tree.js). Gives the disposer, or
 * nothing when there is no registry.
 */
export function registerBotChannels(registry) {
  if (typeof registry?.register !== 'function') return undefined
  return registry.register({ id: SOURCE_ID, owns: ownsBot, useChannels: useBotChannels, open: chatId => void openBotChat(chatId) })
}
