// #1742 in the answer settings: the bot's outside code check, with a secret that is written only,
// its pattern, label, tier and refusal texts, and the request row the check confirmed (host
// answer-outside-check.js). Made-up URL, secret, pattern and texts only.
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
  'export { parseRefusalTexts, refusalTextsText } from \'./outside-check.js\'',
], { globals: { console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, document: { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} } }, team: { omni: { ...omni, call: fakeCall } } })

const SITE = 'https://example.test/check'
const SECRET = 'test-secret-0001'
const PATTERN = { prefix: 'QQ-', characters: 'ABCDEFGHJK0123456789', length: 6 }
const SET = { url: SITE, secretSet: true, pattern: PATTERN, label: 'Checked', tier: 'tier-b', refusalTexts: { 404: 'Not found.' } }
const EMPTY = { url: null, secretSet: false, pattern: null, label: null, tier: null, refusalTexts: {} }

function settings(t, value = {}) {
  const view = mount(() => react.createElement(ui.AnswerSettings, { bot: { id: 'dedicated' }, value }))
  t.after(() => { view.unmount(); answer = () => ({}) })
  const open = async () => {
    nodes(view.draw()).find(node => node.type === 'button' && text(node) === 'Answer mode').props.onClick()
    view.draw()
    await settle()
  }
  const group = () => nodes(view.draw()).find(node => node.props?.['aria-label'] === 'Outside code check')
  const field = label => nodes(nodes(group()).find(node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'input' || node.type === 'textarea')
  const type = (label, value) => { field(label).props.onChange({ target: { value } }); view.draw() }
  const button = label => nodes(group()).find(node => node.type === 'button' && text(node) === label)
  const state = () => text(nodes(group()).find(node => node.props?.className?.includes('ot-outside-state')))
  return { view, open, group, field, type, button, state }
}

test('refusal texts: one 4xx status = text a line, and back', () => {
  assert.deepEqual(plain(ui.parseRefusalTexts('404 = Not found.\n# a comment\n\n409=Used = gone ')), { refusalTexts: { 404: 'Not found.', 409: 'Used = gone' } })
  assert.deepEqual(plain(ui.parseRefusalTexts('  ')), { refusalTexts: {} })
  for (const bad of ['503 = Try later.', '404 =', 'Not found.', '40 = x']) assert.match(ui.parseRefusalTexts(bad).problem, /^Refusal texts line 1: /, bad)
  assert.equal(ui.refusalTextsText({ 404: 'Not found.', 409: 'Used.' }), '404 = Not found.\n409 = Used.')
})

test('outside check section: the setting comes with the answer settings; opening them reads nothing; the secret field starts empty', async t => {
  calls.length = 0
  const s = settings(t, { outsideCheck: SET })
  await s.open()
  assert.deepEqual(calls, [])
  assert.deepEqual([s.field('Check URL').props.value, s.field('Secret').props.value, s.state()], [SITE, '', 'Set'])
  assert.deepEqual([s.field('Prefix').props.value, s.field('Characters after the prefix').props.value, s.field('Length').props.value], ['QQ-', 'ABCDEFGHJK0123456789', '6'])
  assert.deepEqual([s.field('Label on a confirmed row').props.value, s.field('Tier name').props.value, s.field('Texts on refusal').props.value], ['Checked', 'tier-b', '404 = Not found.'])
  // Nothing changed yet: Save waits; Clear is there for the secret.
  assert.deepEqual([s.button('Save').props.disabled, s.button('Clear').props.disabled], [true, false])
  const unset = settings(t, {})
  await unset.open()
  assert.deepEqual([unset.field('Check URL').props.value, unset.field('Secret').props.value, unset.state(), unset.button('Clear').props.disabled], ['', '', 'Not set', true])
  for (const key of ['Outside code check', 'Check URL', 'Secret', 'Set', 'Not set', 'Type to replace', 'Secret cleared.', 'Label on a confirmed row', 'Tier name', 'Texts on refusal']) assert.ok(Object.hasOwn(STRINGS, key), key)
})

test('outside check section: Save sends every field and a typed secret; the field is emptied and never shows the secret back; Clear sends null', async t => {
  calls.length = 0
  answer = (endpoint, body) => (endpoint === 'omni-outside-check'
    ? (body.secret === null ? { ...SET, secretSet: false } : { url: body.url, secretSet: true, pattern: body.pattern, label: body.label, tier: body.tier, refusalTexts: body.refusalTexts })
    : {})
  const s = settings(t, { outsideCheck: EMPTY })
  await s.open()
  s.type('Check URL', `  ${SITE}  `)
  s.type('Secret', SECRET)
  s.type('Prefix', 'QQ-')
  s.type('Characters after the prefix', 'ABCDEFGHJK0123456789')
  s.type('Length', '6')
  s.type('Label on a confirmed row', ' Checked ')
  s.type('Texts on refusal', '404 = Not found.')
  s.button('Save').props.onClick()
  await settle()
  assert.deepEqual(calls, [['omni-outside-check', { botId: 'dedicated', url: SITE, pattern: PATTERN, label: 'Checked', tier: null, refusalTexts: { 404: 'Not found.' }, secret: SECRET }]])
  assert.deepEqual([s.field('Secret').props.value, s.state()], ['', 'Set'])
  assert.equal(JSON.stringify(nodes(s.view.draw()).map(node => node.props)).includes(SECRET), false)
  // Without a typed secret it is left out, so the host keeps it; an emptied pattern is sent as none.
  s.type('Prefix', '')
  s.type('Characters after the prefix', '')
  s.type('Length', '')
  s.button('Save').props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), ['omni-outside-check', { botId: 'dedicated', url: SITE, pattern: null, label: 'Checked', tier: null, refusalTexts: { 404: 'Not found.' } }])
  // A pattern or refusal text the host would refuse is said here, and nothing is sent.
  s.type('Characters after the prefix', 'AB')
  s.type('Length', '2')
  s.button('Save').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /^The length is a whole number/)
  s.type('Length', '6')
  s.type('Texts on refusal', '503 = Try later.')
  s.button('Save').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /^Refusal texts line 1: /)
  assert.equal(calls.length, 2)
  s.button('Clear').props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), ['omni-outside-check', { botId: 'dedicated', secret: null }])
  assert.equal(s.state(), 'Not set')
  // A refusal is shown as the host words it.
  answer = () => Object.assign(new Error('The check URL must be an https address.'), { code: 'bot/refused' })
  s.type('Check URL', 'http://example.test/x')
  s.button('Save').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /https address/)
})

test('a request row the outside check confirmed shows the label staff set; with no label set it shows none', async t => {
  calls.length = 0
  const requests = [
    { instanceId: 'i', chatUuid: 'c7', senders: ['5500000000044'], text: 'My code is QQ-7K2A90', firstAt: 2_000, lastAt: 3_000, count: 1, confirmed: { at: 3_000, tier: 'tier-b' } },
    { instanceId: 'i', chatUuid: 'c8', senders: ['5500000000042'], text: 'Can I join?', firstAt: 1_000, lastAt: 2_000, count: 1, admitted: { at: 2_500, by: 'code' } },
    { instanceId: 'i', chatUuid: 'c9', senders: ['5500000000043'], text: 'Hello', firstAt: 1_000, lastAt: 1_000, count: 1 },
  ]
  answer = endpoint => (endpoint === 'omni-answer-requests' ? { count: requests.length, requests } : {})
  const tags = async (value) => {
    const s = settings(t, value)
    await s.open()
    const group = () => nodes(s.view.draw()).find(node => node.props?.['aria-label'] === 'Requests')
    nodes(group()).find(node => node.type === 'button' && text(node) === 'Show').props.onClick()
    s.view.draw()
    await settle()
    return nodes(group()).filter(node => node.type === 'li').map(row => nodes(row).filter(node => node.props?.className === 'ot-picker-tag').map(text))
  }
  assert.deepEqual(await tags({ outsideCheck: SET }), [['Checked'], ['Admitted by code'], []])
  assert.deepEqual(await tags({ outsideCheck: { ...SET, label: null } }), [[], ['Admitted by code'], []])
})
