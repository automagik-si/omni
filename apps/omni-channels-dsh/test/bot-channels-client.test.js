// The left bar's source of each Bot's channels (src/client/bot-channels.js, #1781), bundled
// as DSH bundles the client, with the stand-in React of client-stand-in.js, a stand-in of the
// bar's registry and of the team's face (its roster and actions), and a host stand-in for
// `call`: nothing leaves the test.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleClient, mount, plain, react, settle } from './client-stand-in.js'
import { omni } from './omni-client.js'

const calls = []
const logged = []
let answer = () => ({})
const fakeCall = async (endpoint, body) => {
  calls.push([endpoint, plain(body)])
  const reply = await answer(endpoint, body)
  if (reply instanceof Error) throw reply
  return reply
}
const intervals = new Map()
let nextTimer = 0
const timers = {
  setInterval: (run, ms) => { nextTimer += 1; intervals.set(nextTimer, { run, ms }); return nextTimer },
  clearInterval: id => intervals.delete(id),
  setTimeout: () => 0,
  clearTimeout: () => {},
}
// The bar's registry as bots-dsh has it (extend.js botChannels): register gives the disposer.
const entries = []
const registry = { register: (entry) => { entries.push(entry); return () => entries.splice(entries.indexOf(entry), 1) } }
// The team's face: its roster (a source the state answers fill) and its actions.
let roster = {}
const listeners = new Set()
const setRoster = (next) => { roster = next; for (const listener of listeners) listener() }
const panels = []
const face = () => ({ actions: { selectPanel: id => panels.push(id) }, hooks: { roster: { getSnapshot: () => roster, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } } } })

const load = team => bundleClient([
  'export { registerBotChannels, ownsBot, useBotChannels, readChats, openBotChat, chatsStore, SOURCE_ID, CHATS_FRESH_MS, CHATS_POLL_MS, BOT_CHANNELS_CSS } from \'./bot-channels.js\'',
  'export { omniStore, CHAT_PANEL } from \'./omni-store.js\'',
], { globals: { console: { ...console, warn: (...args) => logged.push(args) }, URL, URLSearchParams, document: { hidden: false }, ...timers }, team })
const ui = await load({ omni: { ...omni, call: fakeCall, botChannels: registry, face } })

const SALES = { id: '11111111-1111-4111-8111-111111111111', name: 'Sales', kind: 'whatsapp-baileys', status: 'connected' }
const SUPPORT = { id: '22222222-2222-4222-8222-222222222222', name: 'Support', kind: 'telegram', status: 'needs-pairing' }
const chat = (n, extra = {}) => ({ id: `c${n}`, name: `Chat ${n}`, status: 'idle', unread: 0, lastAt: n, who: { name: `Chat ${n}`, photo: null, self: false }, ...extra })

// The bar's one hook call, as its BotChannels component makes it.
function drawn(botId, open) {
  const out = []
  function BotChannels() {
    out.push(source().useChannels(botId, { open }))
    return null
  }
  const view = mount(() => react.createElement(BotChannels, {}))
  view.draw()
  return { last: () => out.at(-1), draw: () => { view.draw(); return out.at(-1) }, unmount: view.unmount }
}
const source = () => entries.find(entry => entry.id === ui.SOURCE_ID)

test('a team client without the bar\'s registry gets nothing; one with it gets one source, with its disposer', () => {
  assert.equal(ui.registerBotChannels(undefined), undefined)
  assert.equal(ui.registerBotChannels({}), undefined)
  const dispose = ui.registerBotChannels(registry)
  assert.equal(entries.length, 1)
  assert.deepEqual(Object.keys(source()).sort(), ['id', 'open', 'owns', 'useChannels'])
  assert.equal(source().id, 'omni-channels')
  dispose()
  assert.equal(entries.length, 0)
  ui.registerBotChannels(registry)
})

test('it serves only the Bots that own a channel, and draws their channels from the state answer, without chats while closed', async () => {
  calls.length = 0
  setRoster({ omniBotChannels: { omni: [SALES, SUPPORT], service: [SUPPORT] } })
  assert.equal(source().owns({ id: 'omni' }), true)
  assert.equal(source().owns({ id: 'service' }), true)
  assert.equal(source().owns({ id: 'writer' }), false)
  assert.equal(source().owns(undefined), false)
  const closed = drawn('omni', false)
  assert.deepEqual(plain(closed.last()), [SALES, SUPPORT])
  assert.ok(closed.last().every(channel => !('chats' in channel)))
  assert.equal(drawn('writer', false).last(), undefined)
  await settle()
  // No chat is read for a closed Bot, nor any interval set.
  assert.deepEqual(calls, [])
  assert.equal(intervals.size, 0)
  // A channel moved to another Bot moves in what the hook gives.
  setRoster({ omniBotChannels: { omni: [SALES], service: [SUPPORT] } })
  assert.deepEqual(plain(closed.draw()), [SALES])
})

test('an open Bot reads its chats once, keeps them briefly, reads again while open, and stops when closed', async () => {
  calls.length = 0
  ui.chatsStore.set({})
  setRoster({ omniBotChannels: { omni: [SALES, SUPPORT] } })
  answer = endpoint => (endpoint === 'omni-bot-chats' ? { botId: 'omni', channels: [{ channelId: SALES.id, chats: [chat(2), chat(1)] }, { channelId: SUPPORT.id, chats: [] }] } : {})
  const open = drawn('omni', true)
  // Until the read answers, the channels carry no chats yet.
  assert.deepEqual(open.last().map(channel => channel.chats), [undefined, undefined])
  await settle()
  assert.deepEqual(calls, [['omni-bot-chats', { botId: 'omni' }]])
  assert.deepEqual(plain(open.draw()), [{ ...SALES, chats: [chat(2), chat(1)] }, { ...SUPPORT, chats: [] }])
  // A second draw, or a second Bot view of the same Bot, within CHATS_FRESH_MS reads nothing.
  drawn('omni', true)
  await settle()
  assert.equal(calls.length, 1)
  // One interval while open, at CHATS_POLL_MS; it reads again once the kept read is old.
  const polls = [...intervals.values()]
  assert.ok(polls.length >= 1 && polls.every(poll => poll.ms === ui.CHATS_POLL_MS))
  ui.chatsStore.set(all => ({ ...all, omni: { ...all.omni, at: 0 } }))
  polls[0].run()
  await settle()
  assert.equal(calls.length, 2)
  // Closed: the intervals go, and the channels drop their chats.
  open.unmount()
  intervals.clear()
  assert.ok(drawn('omni', false).last().every(channel => !('chats' in channel)))
  // A failed read keeps the channels; their chats stay as they were.
  answer = () => new Error('Omni is not connected here.')
  ui.chatsStore.set(all => ({ ...all, omni: { ...all.omni, at: 0 } }))
  await ui.readChats('omni')
  assert.match(String(logged.at(-1)?.[0]), /Could not read this Bot's chats/)
  assert.deepEqual(plain(ui.chatsStore.getSnapshot().omni.byChannel[SALES.id]), [chat(2), chat(1)])
})

test('a press on a chat opens it as Omni\'s own chat list does: the chat panel, the chat selected and its messages read', async () => {
  calls.length = 0
  panels.length = 0
  answer = (endpoint) => {
    if (endpoint === 'omni-overview') return { configured: true, origin: 'omni.example.com', channels: [{ id: SALES.id, type: SALES.kind, name: 'Sales', status: 'connected' }], chats: [{ id: 'c2', channelId: SALES.id, name: 'Chat 2', at: 2, unread: 3 }] }
    if (endpoint === 'omni-channel-abilities') return { changeChannels: false, send: true }
    if (endpoint === 'omni-messages') return { messages: [] }
    return {}
  }
  source().open('c2')
  await settle()
  await settle()
  const state = ui.omniStore.getSnapshot()
  assert.equal(state.preview, false)
  assert.equal(state.chatId, 'c2')
  assert.equal(state.chats.find(row => row.id === 'c2').unread, 0)
  assert.deepEqual(panels, [ui.CHAT_PANEL])
  assert.ok(calls.some(([endpoint, body]) => endpoint === 'omni-messages' && body.chatId === 'c2'))
})

test('a chat the overview\'s newest chats do not hold is named in a read, opens, and stays listed; an opened chat reads as read in the bar', async () => {
  calls.length = 0
  panels.length = 0
  const quiet = { id: 'c9', channelId: SALES.id, name: 'Chat 9', at: 9, unread: 2 }
  answer = (endpoint, body) => {
    if (endpoint === 'omni-overview') return { configured: true, origin: 'omni.example.com', channels: [{ id: SALES.id, type: SALES.kind, name: 'Sales', status: 'connected' }], chats: [{ id: 'c2', channelId: SALES.id, name: 'Chat 2', at: 2, unread: 0 }, ...(body?.chatId === 'c9' ? [quiet] : [])] }
    if (endpoint === 'omni-messages') return { messages: [] }
    if (endpoint === 'omni-bot-chats') return { botId: 'omni', channels: [{ channelId: SALES.id, chats: [chat(9, { unread: 2, lastAt: 9 }), chat(2)] }] }
    return {}
  }
  await source().open('c9')
  await settle()
  const state = ui.omniStore.getSnapshot()
  assert.equal(state.chatId, 'c9')
  assert.ok(state.chats.some(row => row.id === 'c9'))
  assert.deepEqual(panels, [ui.CHAT_PANEL])
  assert.ok(calls.some(([endpoint, body]) => endpoint === 'omni-overview' && body?.chatId === 'c9'))
  assert.ok(calls.some(([endpoint, body]) => endpoint === 'omni-messages' && body.chatId === 'c9'))
  // The bar shows it read, as Omni's list does once it was opened.
  ui.chatsStore.set({})
  setRoster({ omniBotChannels: { omni: [SALES] } })
  const open = drawn('omni', true)
  await settle()
  assert.deepEqual(plain(open.draw())[0].chats.map(row => [row.id, row.unread]), [['c9', 0], ['c2', 0]])
  open.unmount()
  intervals.clear()
})

test('the bar reads Omni\'s two tones from the team\'s tokens, light and dark', () => {
  assert.match(ui.BOT_CHANNELS_CSS, /body\{--oc-in:color-mix\(in srgb,var\(--bt-magic-pink\) 16%,var\(--bt-card\)\);--oc-out:color-mix\(in srgb,var\(--bt-accent\) 20%,var\(--bt-card\)\)\}/)
  assert.match(ui.BOT_CHANNELS_CSS, /body\[data-ds-dark-theme\]\{--oc-in:color-mix\(in srgb,var\(--bt-magic-pink\) 26%,var\(--bt-bubble\)\);--oc-out:color-mix\(in srgb,var\(--bt-accent\) 34%,var\(--bt-bubble\)\)\}/)
})
