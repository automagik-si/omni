// #1731 in the answer settings: the bot's waitlist site, with a secret that is written only, and
// the request row whose waitlist code the site confirmed (host answer-waitlist.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STRINGS } from '../src/client/strings.js'
import { bundleClient, mount, nodes, plain, react, settle, text } from './client-stand-in.js'
import { omni } from './omni-client.js'

const calls = []
let answer = () => ({})
const fakeCall = async (endpoint, body) => {
  calls.push([endpoint, plain(body)])
  const reply = await answer(endpoint, body)
  if (reply instanceof Error) throw reply
  return reply
}
const ui = await bundleClient([
  'export { AnswerSettings } from \'./omni-tree.js\'',
], { globals: { console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, document: { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} } }, team: { omni: { ...omni, call: fakeCall } } })

// A made-up URL and secret.
const SITE = 'https://example.test/waitlist/confirm'
const SECRET = 'test-secret-0001'

function settings(t, value = {}) {
  const view = mount(() => react.createElement(ui.AnswerSettings, { bot: { id: 'dedicated' }, value }))
  t.after(() => { view.unmount(); answer = () => ({}) })
  const open = async () => {
    nodes(view.draw()).find(node => node.type === 'button' && text(node) === 'Answer mode').props.onClick()
    view.draw()
    await settle()
  }
  const group = () => nodes(view.draw()).find(node => node.props?.['aria-label'] === 'Waitlist confirmation')
  const input = type => nodes(group()).find(node => node.type === 'input' && node.props.type === type)
  const button = label => nodes(group()).find(node => node.type === 'button' && text(node) === label)
  const state = () => text(nodes(group()).find(node => node.props?.className?.includes('ot-waitlist-state')))
  return { view, open, group, input, button, state }
}

test('waitlist section: the URL and whether a secret is set come with the settings; opening them reads nothing; the secret field starts empty', async t => {
  calls.length = 0
  const s = settings(t, { waitlist: { url: SITE, secretSet: true } })
  await s.open()
  assert.deepEqual(calls, [])
  assert.deepEqual([s.input('url').props.value, s.input('password').props.value, s.state()], [SITE, '', 'Set'])
  // Nothing changed yet: Save waits; Clear is there for the secret.
  assert.deepEqual([s.button('Save').props.disabled, s.button('Clear').props.disabled], [true, false])
  const unset = settings(t, {})
  await unset.open()
  assert.deepEqual([unset.input('url').props.value, unset.input('password').props.value, unset.state(), unset.button('Clear').props.disabled], ['', '', 'Not set', true])
  for (const key of ['Waitlist confirmation', 'Site URL', 'Secret', 'Type to replace', 'Secret cleared.']) assert.ok(Object.hasOwn(STRINGS, key), key)
})

test('waitlist section: Save sends the URL and a typed secret; the field is emptied and never shows the secret back; Clear sends null', async t => {
  calls.length = 0
  answer = (endpoint, body) => (endpoint === 'omni-waitlist-confirm' ? { url: body.url === undefined ? SITE : body.url, secretSet: body.secret !== null } : {})
  const s = settings(t, {})
  await s.open()
  s.input('url').props.onChange({ target: { value: `  ${SITE}  ` } })
  s.input('password').props.onChange({ target: { value: SECRET } })
  s.view.draw()
  s.button('Save').props.onClick()
  await settle()
  assert.deepEqual(calls, [['omni-waitlist-confirm', { botId: 'dedicated', url: SITE, secret: SECRET }]])
  assert.deepEqual([s.input('password').props.value, s.state()], ['', 'Set'])
  assert.equal(JSON.stringify(nodes(s.view.draw()).map(node => node.props)).includes(SECRET), false)
  // The URL alone: the secret is left out, so the host keeps it.
  s.input('url').props.onChange({ target: { value: 'https://example.test/other' } })
  s.view.draw()
  s.button('Save').props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), ['omni-waitlist-confirm', { botId: 'dedicated', url: 'https://example.test/other' }])
  s.button('Clear').props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), ['omni-waitlist-confirm', { botId: 'dedicated', secret: null }])
  assert.equal(s.state(), 'Not set')
  // A refusal is shown as the host words it.
  answer = () => Object.assign(new Error('The waitlist URL must be an https address.'), { code: 'bot/refused' })
  s.input('url').props.onChange({ target: { value: 'http://example.test/x' } })
  s.view.draw()
  s.button('Save').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /https address/)
})

test('a request row whose waitlist code the site confirmed reads "Waitlist confirmed"; the others do not', async t => {
  calls.length = 0
  const requests = [
    { instanceId: 'i', chatUuid: 'c7', senders: ['5500000000044'], text: 'My code is AMG-7K2QX9', firstAt: 2_000, lastAt: 3_000, count: 1, waitlist: { at: 3_000 } },
    { instanceId: 'i', chatUuid: 'c8', senders: ['5500000000042'], text: 'Can I join?', firstAt: 1_000, lastAt: 2_000, count: 1, admitted: { at: 2_500, by: 'invite' } },
    { instanceId: 'i', chatUuid: 'c9', senders: ['5500000000043'], text: 'Hello', firstAt: 1_000, lastAt: 1_000, count: 1 },
  ]
  answer = endpoint => (endpoint === 'omni-answer-requests' ? { count: requests.length, requests } : {})
  const s = settings(t, {})
  await s.open()
  const group = () => nodes(s.view.draw()).find(node => node.props?.['aria-label'] === 'Requests')
  nodes(group()).find(node => node.type === 'button' && text(node) === 'Show').props.onClick()
  s.view.draw()
  await settle()
  const rows = nodes(group()).filter(node => node.type === 'li')
  assert.deepEqual(rows.map(row => nodes(row).filter(node => node.props?.className === 'ot-picker-tag').map(text)), [['Waitlist confirmed'], ['Let in by code'], []])
  assert.ok(Object.hasOwn(STRINGS, 'Waitlist confirmed'))
})
