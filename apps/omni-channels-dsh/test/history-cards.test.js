import assert from 'node:assert/strict'
import { test } from 'node:test'
import { all, bundleClient, byLabel, mount, ofType, plain, react, settle, text } from './client-stand-in.js'
import { loadTeamClient } from './omni-client.js'

const team = loadTeamClient().omni
const omni = { ...team }
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
const link = 'https://omni.example.com'
const readOnlyNote = 'This window only reads the team; open the team where it runs to act.'
const readOnlyRefusal = 'The Bot team in /tmp/private-team is open in another dsh (Web or Desktop, pid 12345). This window shows the team but cannot change it; close the other one and reload.'

function register(t, module, extra = {}) {
  const disposers = []
  module.apply({
    effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
    ...extra,
  })
  t.after(() => { for (const dispose of disposers.reverse()) dispose() })
}

const proposalText = id => `Proposed a backfill (proposal ${id}): a card lists 1 chats, 0 ticked, range not set to not set.`
const statusText = id => `Review backfill run ${id}:\nBackfill of 2026-03-01 to 2026-11-15.`

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
  assert.equal(text(render('propose_backfill')(proposalText(runId))), proposalText(runId))
  BackfillCard.binds = true
  const proposal = render('propose_backfill')(proposalText(runId))
  assert.equal(proposal.type, BackfillCard)
  assert.equal(proposal.props.proposalId, runId)
  assert.equal(proposal.props.roster, roster)
  const view = mount(() => proposal)
  t.after(view.unmount)
  assert.match(text(view.draw()), /First chat/)
  assert.doesNotMatch(text(view.draw()), /Unrelated chat/)
  const status = render('backfill_status')(statusText(runId))
  assert.equal(status.type, module.ConversationsCard)
  assert.equal(status.props.runId, runId)
  const saved = [
    'Backfill of 2026-03-01 to 2026-11-15, started 2026-11-15T23:00:00.000Z: 1 done, 0 phone did not answer, 0 stopped, 0 failed, 0 running.',
    '- Chat label',
    `Review backfill ${otherRun}, from ${from} to ${to}:`,
    `Review backfill run ${otherRun}:`,
    ` (job none): done; 3 stored.`,
    `Review backfill ${runId}, from ${from} to ${to}:`,
  ].join('\n')
  assert.equal(text(render('backfill_status')(saved)), saved)
  assert.equal(render('propose_backfill')('from must be before to.').children[0], 'from must be before to.')
  assert.equal(render('backfill_status')('This bot may not follow that job.').children[0], 'This bot may not follow that job.')
  for (const name of ['propose_backfill', 'backfill_status', 'list_commitments']) {
    assert.equal(text(render(name)(readOnlyRefusal)), readOnlyNote)
  }
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
  run: { id, from, to, startedAt: 1000 }, chats, link,
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

test('the local stylesheet and coverage row are used only without the kit', async (t) => {
  const CoverageRow = ({ coverage }) => h('div', { className: 'bt-genui-what' }, `Kit coverage: ${coverage.count}`)
  for (const genui of [undefined, { CoverageRow }]) {
    await t.test(genui ? 'with kit' : 'without kit', async (t) => {
      const installed = []
      const onShell = install => {
        const effects = install({
          installCompiledStyles: (_css, id) => installed.push(id),
          shadow: () => {},
        })
        for (const effect of effects) effect()
      }
      const module = await bundleClient(exportsUnderTest, { globals, team: { omni: { ...omni, genui, onShell } } })
      register(t, module, { inject: () => ({ dispose() {} }) })
      assert.deepEqual(installed, genui ? ['channels'] : ['channels', 'omni-history-cards'])
      const { view } = card(t, module.ConversationsCard, { runId }, () => conversations([conversation(1)]))
      await settle()
      const coverage = text(all(view.draw(), 'bt-genui-what')[0])
      assert.match(coverage, genui ? /^Kit coverage: 10$/ : /^10 messages/)
    })
  }
})

test('history windows show UTC dates and activity, deadlines and sources use local short dates', async (t) => {
  const originalZone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  t.after(() => {
    if (originalZone === undefined) delete process.env.TZ
    else process.env.TZ = originalZone
  })
  const { view: conversationsView } = card(t, ui.ConversationsCard, { runId }, () => conversations([
    { ...conversation(1), coverage: null, lastActivity: from },
    { ...conversation(2), coverage: null, lastActivity: null },
  ]))
  const { view: commitmentsView } = card(t, ui.CommitmentsCard, {}, () => list([commitment(1)]))
  await settle()
  assert.equal(text(all(conversationsView.draw(), 'bt-genui-run-range')[0]), 'Mar 1, 2026 – Nov 15, 2026')
  const [active, quiet] = all(conversationsView.draw(), 'bt-genui-pick')
  assert.match(text(active), /Last activity Feb 28, 2026/)
  assert.doesNotMatch(text(quiet), /Last activity/)
  assert.match(text(commitmentsView.draw()), /Due Nov 15, 2026Source on Nov 11, 2026/)

  const kit = team.genui?.model
  const model = {
    backfillRange: (start, end) => kit ? kit.backfillRange(start, end) : `Kit range ${start} to ${end}`,
    shortDate: value => kit ? kit.shortDate(value) : `Kit short date ${value}`,
  }
  const module = await bundleClient(exportsUnderTest, { globals, team: { omni: { ...omni, genui: { model } } } })
  const reply = conversations([{ ...conversation(1), coverage: null, lastActivity: from }])
  reply.run.to = '2026-02-28T17:00:00-08:00'
  const { view: kitConversations } = card(t, module.ConversationsCard, { runId }, () => reply)
  const { view: kitCommitments } = card(t, module.CommitmentsCard, {}, () => list([commitment(1)]))
  await settle()
  assert.equal(text(all(kitConversations.draw(), 'bt-genui-run-range')[0]), model.backfillRange(from, reply.run.to))
  assert.ok(text(kitConversations.draw()).includes(`Last activity ${model.shortDate(from)}`))
  assert.ok(text(kitCommitments.draw()).includes(`Source on ${model.shortDate(commitment(1).sourceAt)}`))
})

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
    ['select_conversation_training', { chats: Array.from({ length: 50 }, (_, index) => uuid(index + 1)), selected: true, link }],
    ['select_conversation_training', { chats: [uuid(51)], selected: true, link }],
    ['select_conversation_training', { chats: [uuid(52), uuid(53)], selected: false, link }],
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

test('an ownership refusal clears the old selection and sending mode while reload is pending', async (t) => {
  const reload = pendingReply()
  const refusal = 'This chat needs a channel with the same explicit Bot owner.'
  let reads = 0
  const chat = conversation(1, true)
  chat.training.sendingMode = 'sending'
  const { view } = card(t, ui.ConversationsCard, { runId }, (endpoint) => {
    if (endpoint === 'omni-conversations') return ++reads === 1 ? conversations([chat]) : reload.promise
    return { results: [{ chatId: chat.id, selected: false, threadId: null, sendingMode: null, refusal }] }
  })
  await settle()
  assert.equal(check(view, 1).props.checked, true)
  assert.match(text(view.draw()), /Sending/)
  toggle(view, 1, false)
  await button(view, 'Apply').props.onClick()
  view.draw()
  await settle()
  assert.equal(reads, 2)
  assert.equal(check(view, 1).props.checked, false)
  assert.doesNotMatch(text(view.draw()), /Sending/)
  assert.equal(text(all(view.draw(), 'bt-genui-error')[0]), refusal)
  reload.resolve(conversations([conversation(1)]))
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
    ['select_conversation_training', { chats: [uuid(1)], selected: true, link }],
    ['omni-conversations', { runId }],
  ])
  assert.match(text(view.draw()), /Could not finish applying the training selection/)
  assert.equal(check(view, 1).props.checked, false)
  assert.equal(check(view, 2).props.checked, true)
  toggle(view, 1, true)
  props.roster = { ...props.roster, readOnly: readOnlyRefusal }
  assert.equal(button(view, 'Apply').props.disabled, true)
  assert.equal(check(view, 1).props.disabled, true)
  const rendered = text(view.draw())
  assert.ok(rendered.includes('Summary 1'))
  assert.ok(rendered.includes(readOnlyNote))
  assert.doesNotMatch(rendered, /private-team|12345/)
  await button(view, 'Apply').props.onClick()
  assert.equal(calls.length, 3)
})

test('training replaces the host read-only refusal in a batch result and keeps other refusals', async (t) => {
  const chats = [conversation(1), conversation(2)]
  const other = 'The owning Bot may not write to this channel.'
  const { view } = card(t, ui.ConversationsCard, { runId }, (endpoint) => {
    if (endpoint === 'omni-conversations') return conversations(chats)
    return { results: chats.map((chat, index) => ({
      chatId: chat.id, ...training(false), refusal: index === 0 ? readOnlyRefusal : other,
    })) }
  })
  await settle()
  toggle(view, 1, true)
  toggle(view, 2, true)
  await button(view, 'Apply').props.onClick()
  assert.deepEqual(all(view.draw(), 'bt-genui-error').map(text), [readOnlyNote, other])
})

test('old run and link replies are dropped and roster revisions refresh the active scope', async (t) => {
  const first = pendingReply()
  const second = pendingReply()
  const props = { roster: { revision: 1, omniHistoryLink: 'first link' }, runId }
  const answers = [first.promise, second.promise, { run: null, chats: [], link }]
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
  id: token(n), chatId: uuid(3), chatName: 'Project chat', channelId, text: `Commitment ${n}`, owner: 'user', ownerName: 'Sender',
  counterpart: 'Recipient', deadline: '2026-11-15T23:59:00-03:00', nextAction: 'Send the draft',
  sourceAt: '2026-11-12T01:00:00Z', status, verified, createdAt: from, updatedAt: to,
  quotes: ['private quote'], sourceMessageId: 'private message id', origin: 'private link origin',
  ...(status === 'done' && { closing: { at: to, messageId: 'private closing message', quote: 'private closing quote' } }),
})
const rows = view => all(view.draw(), 'bt-genui-row')
const rowButton = (view, name, label) => ofType(rows(view).find(row => text(row).includes(name)), 'button').find(node => text(node) === label)

test('commitments display only review details and verify candidates and closed items, dismiss candidates, then reload', async (t) => {
  const items = [commitment(1), commitment(2, 'done'), commitment(3), commitment(4, 'open', true)]
  delete items[3].chatName
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
  assert.match(rendered, /Chat: Project chat.*Owner: Sender.*Counterpart: Recipient.*Next action: Send the draft/s)
  assert.doesNotMatch(text(rows(view)[3]), /Chat: /)
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
  const { view, calls } = card(t, ui.CommitmentsCard, props, (endpoint, body) => {
    if (endpoint === 'omni-commitments') return list([commitment(1), commitment(2)])
    if (body.id === token(2)) throw Object.assign(new Error('Private host lock details.'), { code: 'bot/read-only' })
    throw Object.assign(new Error('Host refused this candidate.'), { code: 'bot/invalid' })
  })
  await settle()
  assert.ok(text(view.draw()).includes(readOnlyNote))
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
  await rowButton(view, 'Commitment 2', 'Verify').props.onClick()
  assert.ok(text(rows(view)[1]).includes(readOnlyNote))
  assert.doesNotMatch(text(view.draw()), /Private host lock details/)
})
