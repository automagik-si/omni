import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, bundleClient, byLabel, mount, ofType, plain, react, settle, text } from './client-stand-in.js'
import { loadTeamClient } from './omni-client.js'

const omni = { ...loadTeamClient().omni }
delete omni.genui
const viewer = { version: 1, role: 'owner' }
const globals = {
  AbortController, __AUTOMAGIK_VIEW__: viewer,
  document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
}
const exportsUnderTest = [
  'export { apply } from "./index.js"',
  'export { ConversationsCard, CommitmentsCard } from "./history-cards.js"',
]
const ui = await bundleClient(exportsUnderTest, { globals, team: { omni } })
const h = react.createElement
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const runId = uuid(900)
const otherRun = uuid(901)
const channelId = uuid(902)
const from = '2026-03-01T00:00:00.000Z'
const to = '2026-11-15T23:59:59.999Z'

function register(t, module) {
  const disposers = []
  module.apply({
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
  })
  t.after(() => { for (const dispose of disposers.reverse()) dispose() })
}

const proposalText = id => `Proposed a backfill (proposal ${id}): a card lists 1 chats, 0 ticked, range not set to not set.`
const statusText = (...ids) => ids.map(id => `Review backfill ${id}, from ${from} to ${to}:`).join('\n')

test('the registry binds the proposal and newest reviewed run to the result and preserves refusals', async (t) => {
  const BackfillCard = ({ roster, proposalId }) => {
    const proposal = roster.omniBackfillProposals.find(item => item.id === proposalId)
    return h('div', null, proposal?.chats.map(chat => h('span', { key: chat.id }, chat.name)))
  }
  const module = await bundleClient(exportsUnderTest, { globals, team: { omni: { ...omni, genui: { BackfillCard } } } })
  register(t, module)
  const roster = {
    omniBackfillProposals: [
      { id: runId, chats: [{ id: uuid(1), name: 'First chat' }] },
      { id: otherRun, chats: [{ id: uuid(2), name: 'Unrelated chat' }] },
    ],
  }
  const render = name => content => omni.toolCards.renderer(name)({ done: true, content, roster })
  const proposal = render('propose_backfill')(proposalText(runId))
  assert.equal(proposal.type, BackfillCard)
  assert.equal(proposal.props.proposalId, runId)
  assert.equal(proposal.props.roster, roster)
  const view = mount(() => proposal)
  t.after(view.unmount)
  assert.match(text(view.draw()), /First chat/)
  assert.doesNotMatch(text(view.draw()), /Unrelated chat/)
  const status = render('backfill_status')(statusText(runId, otherRun))
  assert.equal(status.type, module.ConversationsCard)
  assert.equal(status.props.runId, runId)
  assert.equal(render('propose_backfill')('from must be before to.').children[0], 'from must be before to.')
  assert.equal(render('backfill_status')('This bot may not follow that job.').children[0], 'This bot may not follow that job.')
  assert.equal(omni.toolCards.renderer('propose_backfill')({ done: false, roster }), null)
})

test('commitment cards use the text and typed argument accessors and preserve the plain result for members and guests', (t) => {
  register(t, ui)
  t.after(() => { viewer.role = 'owner' })
  const reads = []
  const roster = { readOnly: 'This window can only read the team.' }
  const props = {
    done: true, content: 'No visible commitments match.', roster,
    arg: key => { reads.push(['arg', key]); return { chat: uuid(1), status: 'dismissed' }[key] },
    argValue: key => { reads.push(['argValue', key]); return false },
  }
  const render = omni.toolCards.renderer('list_commitments')
  const card = render(props)
  assert.equal(card.type, ui.CommitmentsCard)
  assert.deepEqual(plain(card.props), { roster, chat: uuid(1), status: 'dismissed', verified: false })
  assert.deepEqual(reads, [['arg', 'chat'], ['arg', 'status'], ['argValue', 'verified']])
  const refusal = 'Commitments are available only in a Bot\'s own session.'
  assert.equal(text(render({ ...props, content: refusal })), refusal)
  for (const role of ['member', 'guest', 'none']) {
    viewer.role = role
    assert.equal(text(render(props)), props.content)
    assert.equal(text(omni.toolCards.renderer('propose_backfill')({ ...props, content: proposalText(runId) })), proposalText(runId))
    assert.equal(text(omni.toolCards.renderer('backfill_status')({ ...props, content: statusText(runId) })), statusText(runId))
  }
  assert.equal(reads.length, 3)
})

test('a team client without genui shows the proposal text and still binds the conversation card', (t) => {
  register(t, ui)
  const content = proposalText(runId)
  assert.equal(text(omni.toolCards.renderer('propose_backfill')({ done: true, content })), content)
  const status = omni.toolCards.renderer('backfill_status')({ done: true, content: statusText(runId) })
  assert.equal(status.type, ui.ConversationsCard)
  assert.equal(status.props.runId, runId)
})

const training = selected => ({ selected, threadId: selected ? uuid(990) : null, sendingMode: selected ? 'training' : null })
function conversation(number, selected = false) {
  const coverage = { oldest: from, newest: to, count: 10, countInWindow: 6, deletedCount: 0, mediaMissing: 0, lastInbound: to, lastOutbound: null }
  return {
    id: uuid(number), name: `Chat ${number}`, channelId, outcome: 'done', state: 'done', coverage,
    inWindow: coverage.countInWindow, stored: 3, lastActivity: to, summary: `Summary ${number}`,
    noted: true, training: training(selected), commitments: { candidate: 1, open: 0 },
  }
}
const conversations = (chats, id = runId) => ({
  run: { id, from, to, startedAt: 1000 }, chats,
  summary: { total: chats.length, running: 0, done: chats.length - 1, failed: 0, notStarted: 1, stopped: 0, phoneDidNotAnswer: 0 },
})
const list = commitments => ({ commitments })
const lookup = (view, label) => byLabel(view.draw(), label)
const button = (view, label) => ofType(view.draw(), 'button').find(node => text(node) === label)
const check = (view, number) => lookup(view, `Select Chat ${number} for Answer Mode training`)
const toggle = (view, number, checked) => check(view, number).props.onChange({ target: { checked } })
const pendingReply = () => Promise.withResolvers()
function card(t, Component, props, reply) {
  const calls = []
  props.request = async (endpoint, body) => {
    calls.push([endpoint, plain(body)])
    return reply(endpoint, body)
  }
  const view = mount(() => h(Component, props))
  t.after(view.unmount)
  view.draw()
  return { view, calls }
}

test('Apply changes only edited chats, selects before deselecting, reconciles by chat id and reloads', async (t) => {
  let chats = Array.from({ length: 53 }, (_, index) => conversation(index + 1, index >= 51))
  Object.assign(chats[0].coverage, { deletedCount: 2, mediaMissing: 1 })
  const refreshed = pendingReply()
  let reads = 0
  const { view, calls } = card(t, ui.ConversationsCard, { runId, roster: { revision: 1 } }, (endpoint, body) => {
    if (endpoint === 'omni-conversations') return ++reads === 1 ? conversations(chats) : refreshed.promise
    const { chats: ids, selected } = body
    chats = chats.map(chat => ids.includes(chat.id) && chat.id !== uuid(2)
      ? { ...chat, training: training(selected) } : chat)
    return { results: [...ids].reverse().map(chatId => ({ chatId, ...training(chatId !== uuid(2) && selected),
      refusal: chatId === uuid(2) ? 'This chat already belongs to another thread.' : null })) }
  })
  await settle()
  assert.deepEqual(calls, [['omni-conversations', { runId }]])
  assert.match(text(view.draw()), /1 not started/)
  assert.match(text(view.draw()), /Summary 1/)
  assert.match(text(view.draw()), /6 messages in this window/)
  const firstRow = all(view.draw(), 'bt-genui-row')[0]
  assert.equal(firstRow.props['data-state'], 'done')
  assert.equal(text(all(firstRow, 'bt-genui-name')[0]), 'Chat 1')
  assert.equal(text(all(firstRow, 'bt-genui-word')[0]), 'Done')
  assert.equal(text(all(firstRow, 'bt-genui-num')[0]), '3 stored')
  assert.match(text(all(view.draw(), 'bt-genui-what')[0]), /10 messages.*2 deleted.*1 missing media/)
  assert.equal(button(view, 'Apply').props.disabled, true)
  assert.equal(check(view, 53).props.checked, true)
  button(view, 'Select all').props.onClick()
  assert.equal(check(view, 1).props.checked, true)
  button(view, 'Clear').props.onClick()
  assert.equal(check(view, 53).props.checked, false)
  for (let number = 1; number <= 51; number++) toggle(view, number, true)
  await button(view, 'Apply').props.onClick()
  view.draw()
  await settle()
  assert.deepEqual(calls, [
    ['omni-conversations', { runId }],
    ['select_conversation_training', { chats: Array.from({ length: 50 }, (_, index) => uuid(index + 1)), selected: true }],
    ['select_conversation_training', { chats: [uuid(51)], selected: true }],
    ['select_conversation_training', { chats: [uuid(52), uuid(53)], selected: false }],
    ['omni-conversations', { runId }],
  ])
  assert.equal(check(view, 1).props.checked, true)
  assert.equal(check(view, 2).props.checked, false)
  assert.equal(check(view, 53).props.checked, false)
  assert.deepEqual(all(view.draw(), 'bt-genui-error').map(text), ['This chat already belongs to another thread.'])
  // The reload is authoritative even when its answer differs from a successful action reply.
  chats[0] = conversation(1)
  refreshed.resolve(conversations(chats))
  await settle()
  assert.equal(check(view, 1).props.checked, false)
  assert.equal(check(view, 51).props.checked, true)
  assert.equal(button(view, 'Apply').props.disabled, true)
})

test('a failed training chunk still reloads and a read-only window shows data without permitting Apply', async (t) => {
  const props = { roster: { revision: 1 }, runId }
  const { view, calls } = card(t, ui.ConversationsCard, props, (endpoint) => {
    if (endpoint === 'omni-conversations') return conversations([conversation(1), conversation(2, true)])
    throw new Error('endpoint interrupted')
  })
  await settle()
  toggle(view, 1, true)
  toggle(view, 2, false)
  await button(view, 'Apply').props.onClick()
  view.draw()
  await settle()
  assert.deepEqual(calls, [
    ['omni-conversations', { runId }],
    ['select_conversation_training', { chats: [uuid(1)], selected: true }],
    ['omni-conversations', { runId }],
  ])
  assert.match(text(view.draw()), /Could not finish applying the training selection/)
  assert.equal(check(view, 1).props.checked, false)
  assert.equal(check(view, 2).props.checked, true)
  toggle(view, 1, true)
  props.roster = { ...props.roster, readOnly: 'This window can only read the team.' }
  assert.equal(button(view, 'Apply').props.disabled, true)
  assert.equal(check(view, 1).props.disabled, true)
  assert.match(text(view.draw()), /Summary 1.*This window can only read the team/s)
  await button(view, 'Apply').props.onClick()
  assert.equal(calls.length, 3)
})

test('old run and link replies are dropped and roster revisions refresh the active scope', async (t) => {
  const first = pendingReply()
  const second = pendingReply()
  const props = { roster: { revision: 1, omniHistoryLink: 'first link' }, runId }
  const answers = [first.promise, second.promise, { run: null, chats: [] }]
  const { view, calls } = card(t, ui.ConversationsCard, props, () => answers.shift())
  await settle()
  props.runId = otherRun
  view.draw()
  await settle()
  props.roster = { revision: 1, omniHistoryLink: 'second link' }
  view.draw()
  await settle()
  first.resolve(conversations([conversation(1)]))
  second.resolve(conversations([conversation(2)], otherRun))
  await settle()
  assert.doesNotMatch(text(view.draw()), /Summary [12]/)
  assert.match(text(view.draw()), /This run is no longer listed/)
  answers.push(new Error('bad answer'))
  props.roster = { ...props.roster, revision: 2 }
  view.draw()
  await settle()
  assert.match(text(view.draw()), /Could not load conversations for this run/)
  assert.doesNotMatch(text(view.draw()), /no longer listed/)
  answers.push(conversations([conversation(3)], otherRun))
  button(view, 'Refresh').props.onClick()
  view.draw()
  await settle()
  assert.match(text(view.draw()), /Summary 3/)
  assert.deepEqual(calls, [
    ['omni-conversations', { runId }],
    ...Array.from({ length: 4 }, () => ['omni-conversations', { runId: otherRun }]),
  ])
})

const token = n => String(n).padStart(16, '0')
const commitment = (n, status = 'candidate', verified = false) => ({
  id: token(n), chatId: uuid(3), channelId, text: `Commitment ${n}`, owner: 'user', ownerName: 'Sender',
  counterpart: 'Recipient', deadline: '2026-11-15T23:59:00-03:00', nextAction: 'Send the draft',
  sourceAt: '2026-11-12T01:00:00Z', status, verified, createdAt: from, updatedAt: to,
  quotes: ['private quote'], sourceMessageId: 'private message id', origin: 'private link origin',
  ...(status === 'done' && { closing: { at: to, messageId: 'private closing message', quote: 'private closing quote' } }),
})
const rows = view => all(view.draw(), 'bt-genui-row')
const rowButton = (view, name, label) => ofType(rows(view).find(row => text(row).includes(name)), 'button').find(node => text(node) === label)

test('commitments display only review details and verify candidates and closed items, dismiss candidates, then reload', async (t) => {
  let items = [commitment(1), commitment(2, 'done'), commitment(3), commitment(4, 'open', true)]
  const decision = pendingReply()
  const props = { chat: uuid(3), roster: { revision: 1 } }
  const { view, calls } = card(t, ui.CommitmentsCard, props, async (endpoint, body) => {
    if (endpoint === 'omni-commitments') return list(items.filter(item =>
      (body.status ? item.status === body.status : item.status !== 'dismissed') && (body.verified === undefined || item.verified === body.verified)))
    if (body.id === token(1)) await decision.promise
    const item = items.find(item => item.id === body.id)
    if (body.decision === 'dismiss') item.status = 'dismissed'
    else { item.verified = true; if (item.status === 'candidate') item.status = 'open' }
    return { id: item.id, verified: item.verified, status: item.status }
  })
  await settle()
  assert.deepEqual(calls, [['omni-commitments', { chat: uuid(3) }]])
  const rendered = text(view.draw())
  assert.match(rendered, /Owner: Sender.*Counterpart: Recipient.*Due 2026-11-16.*Source on 2026-11-12.*Next action: Send the draft/s)
  assert.doesNotMatch(rendered, /private/)
  assert.equal(rowButton(view, 'Commitment 4', 'Verify'), undefined)
  assert.equal(rowButton(view, 'Commitment 2', 'Dismiss'), undefined)
  const verify = rowButton(view, 'Commitment 1', 'Verify').props.onClick()
  assert.equal(rowButton(view, 'Commitment 1', 'Dismiss').props.disabled, true)
  assert.equal(rowButton(view, 'Commitment 2', 'Verify').props.disabled, false)
  decision.resolve()
  await verify
  view.draw()
  await settle()
  assert.equal(rowButton(view, 'Commitment 1', 'Verify'), undefined)
  await rowButton(view, 'Commitment 2', 'Verify').props.onClick()
  view.draw()
  await settle()
  assert.match(text(rows(view)[1]), /Done.*Verified/)
  await rowButton(view, 'Commitment 3', 'Dismiss').props.onClick()
  view.draw()
  await settle()
  assert.doesNotMatch(text(view.draw()), /Commitment 3/)
  props.status = 'dismissed'
  props.verified = false
  view.draw()
  await settle()
  assert.match(text(view.draw()), /Commitment 3.*Dismissed/s)
  assert.equal(rowButton(view, 'Commitment 3', 'Verify'), undefined)
  assert.equal(rowButton(view, 'Commitment 3', 'Dismiss'), undefined)
  assert.deepEqual(calls, [
    ['omni-commitments', { chat: uuid(3) }],
    ['review_commitment', { id: token(1), decision: 'verify' }],
    ['omni-commitments', { chat: uuid(3) }],
    ['review_commitment', { id: token(2), decision: 'verify' }],
    ['omni-commitments', { chat: uuid(3) }],
    ['review_commitment', { id: token(3), decision: 'dismiss' }],
    ['omni-commitments', { chat: uuid(3) }],
    ['omni-commitments', { chat: uuid(3), status: 'dismissed', verified: false }],
  ])
})

test('commitment read-only and error states keep decisions scoped to the item', async (t) => {
  const props = { roster: { readOnly: true } }
  const { view, calls } = card(t, ui.CommitmentsCard, props, (endpoint) => {
    if (endpoint === 'omni-commitments') return list([commitment(1), commitment(2)])
    throw Object.assign(new Error('Host refused this candidate.'), { code: 'bot/invalid' })
  })
  await settle()
  assert.match(text(view.draw()), /Make changes from the host that owns this team/)
  for (const label of ['Verify', 'Dismiss']) {
    const action = rowButton(view, 'Commitment 1', label)
    assert.equal(action.props.disabled, true)
    await action.props.onClick()
  }
  assert.equal(calls.length, 1)
  props.roster = {}
  await rowButton(view, 'Commitment 1', 'Dismiss').props.onClick()
  view.draw()
  await settle()
  assert.deepEqual(calls.slice(1), [['review_commitment', { id: token(1), decision: 'dismiss' }], ['omni-commitments', {}]])
  assert.match(text(rows(view)[0]), /Host refused this candidate/)
  assert.doesNotMatch(text(rows(view)[1]), /Host refused this candidate/)
})
