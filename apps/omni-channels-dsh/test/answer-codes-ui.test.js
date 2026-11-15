// #1732 in the answer settings: the message when a code admits someone, and the code lists staff
// fill and read (host answer-codes.js). Made-up patterns and codes only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CODE_WELCOME_MAX } from '../src/host/threads.js'
import { bundleClient, mount, nodes, one, plain, react, settle, text } from './client-stand-in.js'
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
  'export { parseCodeLines, parseRuleDetails, ruleDetailsText, dayOf } from \'./code-lists.js\'',
  'export { patternOf, patternFields, patternSummary } from \'./code-pattern.js\'',
], { globals: { console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, document: { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} } }, team: { omni: { ...omni, call: fakeCall } } })

// A made-up pattern and codes of it.
const PATTERN = { prefix: 'ZZ-', characters: '0123456789', length: 6 }
const CODE = 'ZZ-482910'
const OTHER = 'ZZ-375028'
const endOfDay = (year, month, day) => new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()

function settings(t, value = {}) {
  const shown = { value }
  const view = mount(() => react.createElement(ui.AnswerSettings, { bot: { id: 'dedicated' }, value: shown.value }))
  t.after(() => { view.unmount(); answer = () => ({}) })
  const open = async () => {
    nodes(view.draw()).find(node => node.type === 'button' && text(node) === 'Answer mode').props.onClick()
    view.draw()
    await settle()
  }
  const save = async () => { nodes(view.draw()).find(node => node.type === 'button' && text(node) === 'Save answer settings').props.onClick(); await settle() }
  const group = () => nodes(view.draw()).find(node => node.props?.['aria-label'] === 'Code lists')
  const button = label => nodes(group()).find(node => node.type === 'button' && text(node) === label)
  const field = label => nodes(group()).find(node => node.type === 'label' && text(node).startsWith(label))
  const input = label => nodes(field(label)).find(node => node.type === 'input' || node.type === 'textarea')
  const type = (label, value) => { input(label).props.onChange({ target: { value } }); view.draw() }
  return { view, shown, open, save, group, button, field, input, type }
}

test('code lines: a code and its expiry day a line, or a JSON list; a bad line is named by its number only', () => {
  assert.deepEqual(plain(ui.parseCodeLines(`${CODE}, expires 2026-12-31\n\n# a comment\nzz-375028,2027-01-15`)), { entries: [
    { code: CODE, expiresAt: endOfDay(2026, 12, 31) },
    { code: 'zz-375028', expiresAt: endOfDay(2027, 1, 15) },
  ] })
  const json = [{ code: CODE, expiresAt: '2026-12-31T23:59:59Z', inviteId: 'code-a' }]
  assert.deepEqual(plain(ui.parseCodeLines(JSON.stringify(json))), { entries: json })
  for (const [pasted, problem] of [
    [`${CODE}, 2026-12-31\n${OTHER}, 31/12/2026`, /^Line 2: /],
    [`${CODE}, 2026-02-30`, /^Line 1: /],
    [`${CODE}, 2026-12-31, a note`, /^Line 1: /],
    [', 2026-12-31', /^Line 1: /],
    ['', /at least one code/],
    ['[', /could not be read/],
    ['{"code":"x"}', /^Line 1: /],
    ['[]', /must be a list of codes/],
  ]) {
    const parsed = ui.parseCodeLines(pasted)
    assert.match(parsed.problem, problem)
    assert.equal(parsed.problem.includes(OTHER) || parsed.problem.includes(CODE), false)
  }
  assert.equal(ui.dayOf(endOfDay(2026, 12, 31)), '2026-12-31')
})

test('rule details: one key = value a line as text, or a JSON object; and back', () => {
  assert.deepEqual(plain(ui.parseRuleDetails('group = grp-a\n# a comment\n\nnote = a = b ')), { metadata: { group: 'grp-a', note: 'a = b' } })
  assert.deepEqual(plain(ui.parseRuleDetails('{"group":"grp-a","seats":3}')), { metadata: { group: 'grp-a', seats: 3 } })
  assert.deepEqual(plain(ui.parseRuleDetails('  ')), { metadata: {} })
  assert.match(ui.parseRuleDetails('group grp-a').problem, /^Rule details line 1: /)
  assert.match(ui.parseRuleDetails('= x').problem, /^Rule details line 1: /)
  assert.match(ui.parseRuleDetails('{').problem, /could not be read/)
  assert.match(ui.parseRuleDetails('{"a":1').problem, /could not be read/)
  assert.equal(ui.ruleDetailsText({ group: 'grp-a', note: 'x' }), 'group = grp-a\nnote = x')
  assert.equal(ui.ruleDetailsText({ group: 'grp-a', seats: 3 }), '{\n  "group": "grp-a",\n  "seats": 3\n}')
})

test('pattern fields: the pattern as the host takes it, or a problem; and its summary', () => {
  assert.deepEqual(plain(ui.patternOf({ prefix: ' ZZ- ', characters: '0123456789', length: '6', lookAlikes: true })), { pattern: { ...PATTERN, lookAlikes: true } })
  // The prefix is optional.
  assert.deepEqual(plain(ui.patternOf({ prefix: '', characters: 'ABC', length: '4', lookAlikes: false })), { pattern: { characters: 'ABC', length: 4 } })
  for (const fields of [
    { prefix: '', characters: '', length: '6', lookAlikes: false },
    { prefix: '', characters: '0-9', length: '6', lookAlikes: false },
    { prefix: '', characters: '01', length: '', lookAlikes: false },
    { prefix: '', characters: '01', length: '3', lookAlikes: false },
    { prefix: '', characters: '01', length: '6.5', lookAlikes: false },
  ]) assert.ok(ui.patternOf(fields).problem, JSON.stringify(fields))
  assert.deepEqual(plain(ui.patternFields(PATTERN)), { prefix: 'ZZ-', characters: '0123456789', length: '6', lookAlikes: false })
  assert.equal(ui.patternSummary(PATTERN), 'ZZ- then 6 of 0123456789')
  assert.equal(ui.patternSummary({ characters: 'AB', length: 4, lookAlikes: true }), '4 of AB · look-alikes read as one')
})

test('answer settings take the message when a code admits someone, and send it only while set or cleared', async t => {
  calls.length = 0
  const s = settings(t)
  await s.open()
  // Nothing is read when the settings open: the lists wait for Show.
  assert.deepEqual(calls, [])
  const field = () => one(s.view.draw(), 'ot-answer-welcome')
  assert.ok(nodes(s.view.draw()).find(node => node.type === 'label' && text(node).startsWith('Message when a code admits someone')))
  assert.deepEqual([field().props.value, field().props.maxLength, CODE_WELCOME_MAX], ['', 1000, 1000])
  await s.save()
  assert.equal('codeWelcome' in calls.at(-1)[1], false)
  await s.open()
  field().props.onChange({ target: { value: '  Welcome in!  ' } })
  await s.save()
  assert.equal(calls.at(-1)[1].codeWelcome, 'Welcome in!')
  s.shown.value = { codeWelcome: 'Welcome in!' }
  await s.open()
  assert.equal(field().props.value, 'Welcome in!')
  field().props.onChange({ target: { value: '' } })
  await s.save()
  assert.equal(calls.at(-1)[1].codeWelcome, null)
})

test('the code lists section shows the lists and codes when shown, and adds pasted codes to a list', async t => {
  calls.length = 0
  let lists = [{ name: 'list-a', pattern: { ...PATTERN, lookAlikes: true }, metadata: { group: 'grp-a' }, count: 2, open: 1 }]
  let codes = [
    { code: OTHER, list: 'list-a', expiresAt: endOfDay(2026, 12, 1), inviteId: 'i2', state: 'used', usedAt: 1 },
    { code: CODE, list: 'list-a', expiresAt: endOfDay(2026, 12, 31), inviteId: 'i1', state: 'open' },
  ]
  answer = (endpoint, body) => {
    if (endpoint === 'omni-code-lists') return { count: codes.length, lists, codes }
    if (endpoint === 'omni-code-lists-add') {
      if (body.list === 'list-z') return new Error('Entry 1: the code does not fit the list\'s pattern.')
      lists = [...lists, { name: body.list, pattern: body.pattern, metadata: body.metadata, count: 1, open: 1 }]
      codes = [{ code: 'ZZ-530761', list: body.list, expiresAt: body.entries[0].expiresAt, inviteId: 'i3', state: 'open' }, ...codes]
      return { added: 1, updated: 0, used: 2, count: codes.length }
    }
    return {}
  }
  const s = settings(t)
  await s.open()
  assert.equal(text(nodes(s.group()).find(node => node.props?.className === 'bt-field-label')), 'Code lists')
  s.button('Show').props.onClick()
  s.view.draw()
  await settle()
  assert.deepEqual(calls, [['omni-code-lists', {}]])
  assert.equal(text(nodes(s.group()).find(node => node.props?.className === 'bt-field-label')), 'Code lists (1)')
  const listRows = () => nodes(s.group()).filter(node => node.props?.className === 'ot-code-list').map(row => nodes(row).filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('ot-code-list-')).map(text))
  assert.deepEqual(listRows(), [['list-a', '1 open of 2', 'ZZ- then 6 of 0123456789 · look-alikes read as one', 'group = grp-a']])
  const rows = () => nodes(s.group()).filter(node => node.type === 'li' && node.props.className === 'ot-code').map(row => [text(one(row, 'ot-code-text')), text(one(row, 'ot-code-state')), text(one(row, 'ot-code-meta'))])
  assert.deepEqual(rows(), [[OTHER, 'Used', 'list-a · expires 2026-12-01'], [CODE, 'Open', 'list-a · expires 2026-12-31']])
  // Naming a list it has shows that list's pattern, locked, and its rule details.
  s.type('List name', 'list-a')
  await settle()
  const fieldset = () => nodes(s.group()).find(node => node.type === 'fieldset')
  assert.equal(fieldset().props.disabled, true)
  assert.deepEqual([s.input('Prefix').props.value, s.input('Characters after the prefix').props.value, s.input('Length').props.value], ['ZZ-', '0123456789', '6'])
  assert.equal(s.input('Rule details').props.value, 'group = grp-a')
  // A new name unlocks the fields; Add is off until codes are pasted; a problem is said and nothing is sent.
  s.type('List name', 'list-b')
  assert.equal(fieldset().props.disabled, false)
  assert.equal(s.button('Add codes').props.disabled, true)
  s.type('Codes to add', 'ZZ-530761, 2027-01-31')
  s.type('Length', '3')
  s.button('Add codes').props.onClick()
  await settle()
  assert.equal(calls.length, 1)
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /^The length is a whole number from 4 to 64/)
  s.type('Length', '6')
  s.type('Rule details', 'group = grp-b')
  s.button('Add codes').props.onClick()
  await settle()
  s.view.draw()
  await settle()
  assert.deepEqual(calls.slice(1), [
    ['omni-code-lists-add', { list: 'list-b', pattern: { ...PATTERN, lookAlikes: true }, metadata: { group: 'grp-b' }, entries: [{ code: 'ZZ-530761', expiresAt: endOfDay(2027, 1, 31) }] }],
    ['omni-code-lists', {}],
  ])
  assert.equal(text(nodes(s.group()).find(node => node.props?.role === 'status')), 'Added 1, updated 0. 2 already used, left as they were.')
  assert.equal(s.input('Codes to add').props.value, '')
  assert.equal(rows().length, 3)
  // The host's refusal is shown as it says it.
  s.type('List name', 'list-z')
  s.type('Codes to add', 'ZZ-53076U, 2027-01-31')
  s.button('Add codes').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /^Entry 1: the code does not fit/)
  // A list needs a name.
  s.type('List name', ' ')
  s.button('Add codes').props.onClick()
  await settle()
  assert.match(text(nodes(s.group()).find(node => node.props?.role === 'alert')), /^Name the list/)
})
