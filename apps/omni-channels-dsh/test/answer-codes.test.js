// #1732: a person whose first message carries an open code from a staff code list is let in with
// no manual step: the code checked against its list, one allow rule, the message admitted in the
// same pass. Made-up patterns, codes and rule details only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RATE_MAX } from '../src/host/answer-codes.js'
import { CODES_MAX, codeLists } from '../src/host/code-lists.js'
import { install } from '../src/host/omni-events.js'
import { ANSWER_CHAT_TOOLS, CODE_WELCOME_MAX } from '../src/host/threads.js'
import { ANSWER_CLOCK, ANSWER_MASTER, answerBench, CHAT, CHATS, INSTANCE, saved, signal, until, use } from './thread-fixture.js'

const DAY = 24 * 60 * 60_000
// Made-up ids: a phone an allow rule names, a phone no rule names, and a lid.
const PHONE = '5500000000001'
const STRANGER = '5500000000042'
const LID = '100000000000042'
// A made-up pattern and codes of it.
const PATTERN = { prefix: 'ZZ-', characters: '0123456789', length: 6, lookAlikes: true }
const CODE = 'ZZ-482910'
const OTHER = 'ZZ-375028'
const LATE = 'ZZ-916204'
const SPARE = 'ZZ-530761'
const WELCOME = 'Welcome! You are in. Ask us anything here.'
// Rule details staff attach to a list, copied into each rule its codes write.
const DETAILS_A = { group: 'grp-a', context: 'Joined from the sign-up form.', capability: 'grp-a-tools' }
const DETAILS_B = { group: 'grp-b', seats: 3, tags: ['early'] }
const reply = data => ({ ok: true, json: async () => ({ data }) })
const now = () => Math.floor(Date.now() / 1000)
const inDays = days => new Date(ANSWER_CLOCK + days * DAY).toISOString()
// A person writing for the first time, known only by their lid.
const lidOnly = (journalSeq, text) => ({
  id: `lid-${journalSeq}`, journalSeq, externalId: `WA-lid-${journalSeq}`, eventType: 'message.received',
  direction: 'inbound', instanceId: INSTANCE, chatUuid: CHAT, chatId: `${LID}@lid`, metadata: { from: LID }, textContent: text, contentType: 'text',
  rawPayload: { upsertType: 'notify', addressingMode: 'lid', messageTimestamp: now(), key: { id: `WA-lid-${journalSeq}`, remoteJid: `${LID}@lid`, fromMe: false } },
})
// A person whose phone Omni knows, and whom no allow rule names.
const stranger = (journalSeq, text, from = STRANGER) => ({
  id: `stranger-${journalSeq}`, journalSeq, externalId: `WA-stranger-${journalSeq}`, eventType: 'message.received',
  direction: 'inbound', instanceId: INSTANCE, chatUuid: CHAT, chatId: `${from}@s.whatsapp.net`, metadata: { from }, textContent: text, contentType: 'text',
  rawPayload: { upsertType: 'notify', messageTimestamp: now(), key: { id: `WA-stranger-${journalSeq}`, remoteJid: `${from}@s.whatsapp.net`, fromMe: false } },
})

// Omni as the answer bench needs it: an allowlist with one phone, the rules written, the ids a
// rule of their own refuses (`deny`), and the sends made.
function omniOf({ externalId = `${LID}@lid` } = {}) {
  return { externalId, rules: [], deny: {}, denyOnce: new Set(), checks: [], posts: [], sends: [], acks: [], chatReads: 0, ruleStatus: 201, sendStatus: 201 }
}
async function attach(t, run, omni) {
  await run.channels.quiesceOmniEvents()
  const request = run.channels.omniRequest
  let queue = [], wake, closed = false
  run.warned = []
  run.channels.warn = (...args) => { run.warned.push(args) }
  run.channels.omniRequest = async (method, path, args) => {
    if (path === `/instances/${INSTANCE}`) return reply({ channel: 'whatsapp-baileys', inboundMaxAgeMinutes: 10 })
    if (path === `/chats/${CHAT}` && method === 'GET') { omni.chatReads += 1; return reply({ ...CHATS[CHAT], externalId: omni.externalId, canonicalId: null }) }
    if (path === '/access/check') {
      const id = args.body.platformUserId
      omni.checks.push(id)
      const action = omni.deny[id]
      if (action) return reply({ allowed: false, rule: { id: `deny-${action}`, ruleType: 'deny', action, instanceId: INSTANCE } })
      if (omni.denyOnce.delete(id)) return reply({ allowed: false })
      const rule = omni.rules.find(rule => rule.platformUserId === id)
      if (rule) return reply({ allowed: true, rule })
      return reply({ allowed: id === PHONE })
    }
    if (path === '/access/rules' && method === 'POST') {
      omni.posts.push(args.body)
      if (omni.ruleStatus >= 300) return { ok: false, status: omni.ruleStatus, json: async () => ({}) }
      const rule = { id: `rule-${omni.rules.length + 1}`, phonePattern: null, personId: null, enabled: true, priority: 0, ...args.body }
      omni.rules.push(rule)
      return { ok: true, status: 201, json: async () => ({ data: rule }) }
    }
    if (path === `/access/rules?instanceId=${INSTANCE}&type=allow`) return { ok: true, json: async () => ({ items: [{ ruleType: 'allow', phonePattern: `+${PHONE}`, enabled: true }, ...omni.rules] }) }
    if (path === '/messages/send' && method === 'POST') {
      omni.sends.push(args.body)
      return { ok: omni.sendStatus < 300, status: omni.sendStatus, json: async () => ({ data: { messageId: 'sent-1' } }) }
    }
    if (path === '/automations?enabled=true') return { ok: true, json: async () => ({ items: [] }) }
    if (path === '/events/consumers' || method === 'DELETE' && path.startsWith('/events/consumers/')) return { ok: true }
    if (path.endsWith('/ack')) { omni.acks.push(args.body.cursor); return { ok: true } }
    if (path.endsWith('/stream')) {
      args.signal.addEventListener('abort', () => { closed = true; wake?.() }, { once: true })
      return { ok: true, body: (async function* () {
        while (!closed) {
          if (!queue.length) await new Promise(resolve => { wake = resolve })
          for (const row of queue.splice(0)) yield Buffer.from(`id: ${row.journalSeq}\ndata: ${JSON.stringify(row)}\n\n`)
        }
      })() }
    }
    return request(method, path, args)
  }
  install(run.channels)
  await run.channels.syncOmniEvents()
  t.after(() => run.channels.quiesceOmniEvents())
  let acked = 0
  run.deliver = async row => { const before = acked; queue.push(row); wake?.(); await until(() => omni.acks.length > before); acked = omni.acks.length }
  return Object.assign(run, { omniState: omni })
}
// Two lists: list-a with CODE (its own id) and LATE (expired), list-b with OTHER and SPARE.
const defaultUploads = () => [
  { list: 'list-a', pattern: PATTERN, metadata: DETAILS_A, entries: [{ code: CODE, expiresAt: inDays(7), inviteId: 'code-a' }, { code: LATE, expiresAt: inDays(-1) }] },
  { list: 'list-b', pattern: PATTERN, metadata: DETAILS_B, entries: [{ code: OTHER, expiresAt: inDays(7) }, { code: SPARE, expiresAt: inDays(7) }] },
]
// The bench with the lists uploaded; `settings` change the answer settings first.
async function bench(t, { settings = {}, omni: options, uploads = defaultUploads() } = {}) {
  const run = await answerBench(t, { clock: ANSWER_CLOCK })
  if (Object.keys(settings).length > 0) await run.call('omni-answer-settings', { ...run.settings, ...settings })
  const b = await attach(t, run, omniOf(options))
  for (const upload of uploads) await b.call('omni-code-lists-add', upload)
  return b
}
const kept = b => Object.values(b.team.state.omniAnswerKept ?? {})
const recordOf = (b, code) => b.channels.state.omniCodeLists?.codes?.[code]
const runs = b => b.team.state.subscriptionRuns?.length ?? 0
const callsOf = (b) => {
  const child = b.channels.threads.byChat(CHAT)
  return child ? b.agentOf(child.sessionId).calls : []
}
const ALL_CODES = [CODE, OTHER, LATE, SPARE]
const noCodeIn = (label, text) => { for (const code of ALL_CODES) assert.equal(String(text).toUpperCase().includes(code), false, `${label} names a code`) }
// The check as answer-codes.js makes it: a code read from a message by the lists' patterns.
const redeemer = (b) => {
  const lists = codeLists(b.channels)
  return async (text, sender) => {
    const [candidate] = lists.candidatesIn(text)
    return candidate ? lists.redeem({ ...candidate, sender }) : { ok: false, reason: 'unknown' }
  }
}

test('code lists: with no list, and so no pattern, nothing is read as a code and the message goes on as refused', async t => {
  const b = await bench(t, { uploads: [] })
  await b.deliver(lidOnly(1, `my code: ${CODE}`))
  b.omniState.externalId = `${STRANGER}@s.whatsapp.net`
  await b.deliver(stranger(2, `${OTHER} and 123456`))
  assert.deepEqual([b.omniState.posts, b.omniState.sends], [[], []])
  assert.deepEqual(kept(b).map(entry => entry.row.id), ['lid-1'])
  assert.deepEqual(codeLists(b.channels).candidatesIn(CODE), [])
  // An upload names its pattern; one with none is refused.
  await assert.rejects(b.call('omni-code-lists-add', { list: 'list-a', entries: [{ code: CODE, expiresAt: inDays(7) }] }), /pattern/)
  assert.equal(b.channels.state.omniCodeLists?.lists?.['list-a'], undefined)
  await signal(t, b)
  assert.equal(runs(b), 0)
})

test('code lists: a code is used once, before its expiry, and a retry from the same sender answers the same ok', async t => {
  const b = await bench(t, { uploads: [] })
  for (const upload of defaultUploads()) await b.call('omni-code-lists-add', upload)
  const redeem = redeemer(b)
  const first = await redeem('zz-48291o', { lid: LID })
  assert.deepEqual(first, { ok: true, list: 'list-a', inviteId: 'code-a', metadata: { ...DETAILS_A, source: 'invite', inviteId: 'code-a' } })
  // Saved before ok was answered.
  assert.deepEqual(saved(b.home).omniCodeLists.codes[CODE].used, { by: { lid: LID }, at: Date.now() })
  // The same sender again, by any id they share: the same ok. Another sender: used.
  assert.deepEqual(await redeem(CODE, { lid: LID }), first)
  assert.deepEqual(await redeem(CODE, { lid: LID, phone: STRANGER }), first)
  assert.deepEqual(await redeem(CODE, { phone: STRANGER }), { ok: false, reason: 'used' })
  assert.deepEqual(await redeem(LATE, { lid: LID }), { ok: false, reason: 'expired' })
  assert.deepEqual(await redeem('ZZ-222222', { lid: LID }), { ok: false, reason: 'unknown' })
  // A phone-only sender uses another code; the same phone again is the same ok.
  const other = await redeem(OTHER, { phone: STRANGER })
  assert.equal(other.ok, true)
  assert.deepEqual(await redeem(OTHER, { lid: LID, phone: STRANGER }), other)
  // An open code passes its expiry and is expired from then on.
  t.mock.timers.setTime(Date.parse(inDays(7)))
  assert.deepEqual(await redeem(SPARE, { lid: LID }), { ok: false, reason: 'expired' })
  assert.deepEqual((await b.call('omni-code-lists', {})).codes.map(row => [row.code, row.list, row.state]),
    [[SPARE, 'list-b', 'expired'], [OTHER, 'list-b', 'used'], [LATE, 'list-a', 'expired'], [CODE, 'list-a', 'used']])
})

test('code lists: a check whose save fails answers no ok and leaves the code open', async t => {
  const b = await bench(t)
  const redeem = redeemer(b)
  const save = b.channels.save
  b.channels.save = () => Promise.reject(new Error('disk full'))
  await assert.rejects(redeem(CODE, { lid: LID }), /not saved: disk full/)
  assert.equal(recordOf(b, CODE).used, undefined)
  b.channels.save = save
  // Still open: another sender can have it.
  assert.equal((await redeem(CODE, { phone: STRANGER })).ok, true)
})

test('code lists: a code counts only in the list whose pattern read it', async t => {
  // list-c reads 6 digits with no prefix and no look-alikes; list-a reads its prefix and twins.
  const b = await bench(t, { uploads: [
    { list: 'list-c', pattern: { characters: '0123456789', length: 6 }, entries: [{ code: '771100', expiresAt: inDays(7) }] },
    { list: 'list-a', pattern: PATTERN, entries: [{ code: CODE, expiresAt: inDays(7) }] },
  ] })
  const lists = codeLists(b.channels)
  // Each list reads its own codes; at most 2 a message, over all lists, the ones a list holds
  // first, then in their order.
  assert.deepEqual(lists.candidatesIn('77110O, then 771100 and zz-48291o and ZZ-111111').map(found => [found.code, [...found.lists]]),
    [['771100', ['list-c']], [CODE, ['list-a']]])
  // Each pattern reads the text on its own: after list-a's prefix ("-" is no letter or digit),
  // list-c still reads its 6 digits, a code it holds, so it comes first. list-a's reading is no
  // code of list-a's.
  assert.deepEqual(lists.candidatesIn('ZZ-771100').map(found => [found.code, [...found.lists]]), [['771100', ['list-c']], ['ZZ-771100', ['list-a']]])
  const prefixed = lists.candidatesIn('ZZ-771100').find(found => found.code === 'ZZ-771100')
  assert.deepEqual(await lists.redeem({ ...prefixed, sender: { lid: LID } }), { ok: false, reason: 'unknown' })
  // A code stored in list-c, asked for as read by list-a only, is unknown there.
  assert.deepEqual(await lists.redeem({ code: '771100', lists: new Set(['list-a']), sender: { lid: LID } }), { ok: false, reason: 'unknown' })
  assert.equal(recordOf(b, '771100').used, undefined)
})

test('code lists: the upload sets a list\'s pattern and rule details, normalises codes, gives each an id, keeps the newest 5000 and leaves a used code as it is', async t => {
  const b = await bench(t, { uploads: [] })
  const added = await b.call('omni-code-lists-add', { list: 'list-a', pattern: { ...PATTERN, prefix: 'zz-' }, metadata: DETAILS_A, entries: [{ code: 'zz-48291o', expiresAt: inDays(7) }, { code: OTHER, expiresAt: inDays(3) }] })
  assert.deepEqual(added, { added: 2, updated: 0, used: 0, count: 2 })
  assert.match(recordOf(b, CODE).inviteId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(saved(b.home).omniCodeLists.lists['list-a'], { pattern: PATTERN, metadata: DETAILS_A })
  // Left out, the rule details stay; given, they are the list's from now on.
  await b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, entries: [{ code: SPARE, expiresAt: inDays(7) }] })
  assert.deepEqual(b.channels.state.omniCodeLists.lists['list-a'].metadata, DETAILS_A)
  await b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, metadata: { group: 'grp-z' }, entries: [{ code: SPARE, expiresAt: inDays(7) }] })
  assert.deepEqual(b.channels.state.omniCodeLists.lists['list-a'].metadata, { group: 'grp-z' })
  // A list's pattern is set: another one is refused, and nothing changes.
  const before = structuredClone(b.channels.state.omniCodeLists)
  await assert.rejects(b.call('omni-code-lists-add', { list: 'list-a', pattern: { ...PATTERN, length: 7 }, entries: [{ code: 'ZZ-1234567', expiresAt: inDays(7) }] }), /already has its code pattern/)
  // The rule details cannot set what the rule takes from the code.
  for (const key of ['source', 'inviteId']) await assert.rejects(b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, metadata: { [key]: 'x' }, entries: [{ code: SPARE, expiresAt: inDays(7) }] }), /cannot set/)
  await assert.rejects(b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, metadata: { note: 'x'.repeat(17_000) }, entries: [{ code: SPARE, expiresAt: inDays(7) }] }), /16 KB/)
  assert.deepEqual(b.channels.state.omniCodeLists, before)
  // An open code uploaded again (here into another list) moves there, takes the new expiry and keeps its id.
  const otherId = recordOf(b, OTHER).inviteId
  assert.deepEqual(await b.call('omni-code-lists-add', { list: 'list-b', pattern: PATTERN, entries: [{ code: OTHER, expiresAt: inDays(30) }] }), { added: 0, updated: 1, used: 0, count: 3 })
  assert.deepEqual([recordOf(b, OTHER).list, recordOf(b, OTHER).expiresAt, recordOf(b, OTHER).inviteId], ['list-b', inDays(30), otherId])
  // A used code uploaded again is left as it is: its person's retry gets the same ok.
  const redeem = redeemer(b)
  const first = await redeem(CODE, { lid: LID })
  const record = structuredClone(recordOf(b, CODE))
  assert.deepEqual(await b.call('omni-code-lists-add', { list: 'list-b', pattern: PATTERN, entries: [{ code: CODE, expiresAt: inDays(30) }] }), { added: 0, updated: 0, used: 1, count: 3 })
  assert.deepEqual(recordOf(b, CODE), record)
  assert.deepEqual(await redeem(CODE, { lid: LID }), first)
  // One bad entry changes nothing, and the refusal names it by its place, never the code.
  const bad = 'ZZ-48291U'
  const refusal = await b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, entries: [{ code: LATE, expiresAt: inDays(7) }, { code: bad, expiresAt: inDays(7) }] }).then(() => null, error => error.message)
  assert.match(refusal, /^Entry 2: the code does not fit the list's pattern/)
  assert.equal(refusal.includes(bad), false)
  assert.equal(recordOf(b, LATE), undefined)
  await assert.rejects(b.call('omni-code-lists-add', { list: 'list-a', pattern: PATTERN, entries: [{ code: LATE, expiresAt: '2026-11-30' }] }), /Entry 1: expiresAt/)
  // A save that fails puts the lists back.
  const save = b.channels.save
  b.channels.save = () => Promise.reject(new Error('disk full'))
  const kept = structuredClone(b.channels.state.omniCodeLists)
  await assert.rejects(b.call('omni-code-lists-add', { list: 'list-n', pattern: PATTERN, entries: [{ code: LATE, expiresAt: inDays(7) }] }), /disk full/)
  assert.deepEqual(b.channels.state.omniCodeLists, kept)
  b.channels.save = save
  // The newest CODES_MAX of all lists stay: the oldest go first, and a list left with none goes.
  const many = Array.from({ length: CODES_MAX }, (_, index) => ({ code: `ZZ-${String(index).padStart(6, '0')}`, expiresAt: inDays(7) }))
  assert.deepEqual(await b.call('omni-code-lists-add', { list: 'list-d', pattern: PATTERN, entries: many }), { added: CODES_MAX, updated: 0, used: 0, count: CODES_MAX })
  assert.deepEqual([recordOf(b, OTHER), recordOf(b, CODE)], [undefined, undefined])
  const view = await b.call('omni-code-lists', {})
  assert.deepEqual([view.codes[0].code, view.lists.map(list => [list.name, list.count, list.open])], [`ZZ-${String(CODES_MAX - 1).padStart(6, '0')}`, [['list-d', CODES_MAX, CODES_MAX]]])
})

test('code admission: a lid-only sender with a valid code is let in at once, by one rule on the lid with the list\'s details, and the person is bound', async t => {
  const b = await bench(t, { settings: { personBinding: true } })
  // Typed by hand: lower case, and the letter O for the last zero.
  await b.deliver(lidOnly(1, 'Hi! My code is zz-48291o'))
  // One rule, keyed on the lid, with the list's details, the source and the code's id; nothing
  // kept, nothing sent.
  // Reporting counts rules by metadata.source === "invite" and reason "invite"; changing either breaks that count, tell the orchestrator first.
  assert.deepEqual(b.omniState.posts, [{
    instanceId: INSTANCE, ruleType: 'allow', action: 'allow', platformUserId: LID, reason: 'invite',
    metadata: { group: 'grp-a', context: 'Joined from the sign-up form.', capability: 'grp-a-tools', source: 'invite', inviteId: 'code-a' },
  }])
  assert.deepEqual(kept(b), [])
  assert.deepEqual(b.omniState.sends, [])
  assert.deepEqual(saved(b.home).omniCodeLists.codes[CODE].used.by, { lid: LID })
  // The child takes the code message, bound to the person by that rule; no re-check was waited for.
  await signal(t, b)
  await until(() => callsOf(b).length === 1)
  assert.match(JSON.stringify(callsOf(b)[0]), /My code is zz-48291o/)
  assert.equal(b.channels.threads.byChat(CHAT).personRuleId, 'rule-1')
  noCodeIn('a warning', JSON.stringify(b.warned))
})

test('code admission: with no prefix, ordinary words of the length never crowd out a code the list holds', async t => {
  const b = await bench(t, { omni: { externalId: `${STRANGER}@s.whatsapp.net` }, uploads: [
    { list: 'list-w', pattern: { characters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', length: 5 }, metadata: { group: 'grp-w' }, entries: [{ code: 'k7m2q', expiresAt: inDays(7) }] },
  ] })
  // "Hello" and "there" read as codes too; the one the list holds is checked first.
  await b.deliver(stranger(1, 'Hello there, my code is K7M2Q'))
  assert.deepEqual(b.omniState.posts.map(post => [post.platformUserId, post.metadata.group]), [[STRANGER, 'grp-w']])
  assert.deepEqual(recordOf(b, 'K7M2Q').used.by, { phone: STRANGER })
})

test('code admission: the list\'s rule details, any JSON values, are copied into the rule a code of it writes', async t => {
  const b = await bench(t, { omni: { externalId: `${STRANGER}@s.whatsapp.net` } })
  await b.deliver(stranger(1, `here: ${SPARE}`))
  const [post] = b.omniState.posts
  assert.deepEqual([post.platformUserId, post.reason, post.metadata], [STRANGER, 'invite', { group: 'grp-b', seats: 3, tags: ['early'], source: 'invite', inviteId: recordOf(b, SPARE).inviteId }])
  assert.match(post.metadata.inviteId, /^[0-9a-f-]{36}$/)
})

test('code admission: a replay writes no second rule, and an id Omni already lets in gets none', async t => {
  const b = await bench(t)
  const row = lidOnly(1, `code ${CODE}`)
  await b.deliver(row)
  assert.equal(b.omniState.rules.length, 1)
  // The same row again (a restart before its ack), and the code again: the rule admits them.
  await b.deliver({ ...row, journalSeq: 2 })
  await b.deliver(lidOnly(3, `code ${CODE} again`))
  assert.equal(b.omniState.posts.length, 1)
  // A sender refused a moment ago whom Omni lets in by now: the code is used, and no rule written.
  b.omniState.rules.push({ id: 'rule-staff', ruleType: 'allow', instanceId: INSTANCE, platformUserId: STRANGER, phonePattern: null, metadata: {} })
  b.omniState.denyOnce.add(STRANGER)
  b.omniState.externalId = `${STRANGER}@s.whatsapp.net`
  await b.deliver(stranger(4, `here: ${OTHER}`))
  assert.equal(b.omniState.posts.length, 1)
  assert.deepEqual(recordOf(b, OTHER).used.by, { phone: STRANGER })
  // Their message is admitted as any other.
  await signal(t, b)
  const answered = () => b.team.state.subscriptionRuns.map(run => run.answerIdentity ?? run.event?.externalId)
  await until(() => answered().includes('WA-stranger-4'))
  assert.ok(answered().includes('WA-lid-3'))
})

test('code admission: with a welcome set, the welcome goes to the chat and the child gets nothing; the next message reaches the child', async t => {
  const b = await bench(t, { settings: { codeWelcome: `  ${WELCOME}  `, personBinding: true } })
  assert.equal(b.view().omniAnswers[ANSWER_MASTER].codeWelcome, WELCOME)
  await b.deliver(lidOnly(1, CODE))
  // Sent at once, through Omni's send for the chat: no card, no training wait.
  assert.deepEqual(b.omniState.sends, [{ instanceId: INSTANCE, to: `${LID}@lid`, text: WELCOME }])
  assert.equal(b.omniState.rules.length, 1)
  await signal(t, b)
  assert.equal(runs(b), 0)
  assert.equal(b.channels.threads.byChat(CHAT), undefined)
  // Their next message: the rule admits it, and the child is bound to them.
  await b.deliver(lidOnly(2, 'Thanks, what can you do?'))
  await signal(t, b)
  await until(() => callsOf(b).length === 1)
  assert.match(JSON.stringify(callsOf(b)[0]), /what can you do/)
  assert.equal(b.channels.threads.byChat(CHAT).personRuleId, 'rule-1')
  assert.equal(b.omniState.sends.length, 1)
})

test('code admission: a failed welcome is warned once and the person stays let in', async t => {
  const b = await bench(t, { settings: { codeWelcome: WELCOME } })
  b.omniState.sendStatus = 503
  await b.deliver(lidOnly(1, CODE))
  assert.equal(b.omniState.rules.length, 1)
  assert.equal(b.warned.filter(args => /welcome after a code was not sent/.test(args[0])).length, 1)
  noCodeIn('a warning', JSON.stringify(b.warned))
  await signal(t, b)
  assert.equal(runs(b), 0)
})

test('code refusal: an unknown, used or expired code sends nothing, writes no rule, and the message goes on as refused', async t => {
  const b = await bench(t, { settings: { codeWelcome: WELCOME } })
  await redeemer(b)(OTHER, { phone: '5500000000099' })
  // A lid-only sender: kept as #1706 keeps them, for the re-checks.
  await b.deliver(lidOnly(1, `${SPARE.slice(0, 8)}X, ${OTHER} and ${LATE}`))
  assert.deepEqual([b.omniState.posts, b.omniState.sends], [[], []])
  assert.deepEqual(kept(b).map(entry => entry.row.id), ['lid-1'])
  // A sender refused by the allowlist's default: refused in silence, no child.
  b.omniState.externalId = `${STRANGER}@s.whatsapp.net`
  await b.deliver(stranger(2, `${OTHER} ${LATE}`))
  assert.deepEqual([b.omniState.posts, b.omniState.sends], [[], []])
  await signal(t, b)
  assert.equal(runs(b), 0)
  assert.equal(b.channels.threads.byChat(CHAT), undefined)
  assert.equal(recordOf(b, LATE).used, undefined)
})

test('code refusal: a sender a rule blocks and an admitted sender are never checked', async t => {
  const b = await bench(t)
  // An allowed phone's message with a code: admitted as before, the code untouched.
  await b.deliver(stranger(1, `my friend's code: ${CODE}`, PHONE))
  b.omniState.deny[LID] = 'block'
  await b.deliver(lidOnly(2, CODE))
  b.omniState.deny[STRANGER] = 'silent_block'
  await b.deliver(stranger(3, CODE))
  assert.equal(recordOf(b, CODE).used, undefined)
  assert.deepEqual(b.omniState.posts, [])
  await signal(t, b)
  await until(() => runs(b) === 1)
})

test('code limits: at most 5 code checks per chat per hour; past that the message goes on as refused', async t => {
  const b = await bench(t)
  const used = () => Object.values(b.channels.state.omniCodeLists.codes).filter(record => record.used).length
  b.omniState.externalId = `${STRANGER}@s.whatsapp.net`
  // Two unknown codes per message: 2 + 2 checks, then the fifth check is the first of the third
  // message's codes, and its second is past the limit.
  await b.deliver(stranger(1, 'ZZ-000001 ZZ-000002 ZZ-000003'))
  await b.deliver(stranger(2, 'ZZ-000004 ZZ-000005'))
  await b.deliver(stranger(3, 'ZZ-000006 ZZ-000007'))
  assert.equal(RATE_MAX, 5)
  assert.equal(used(), 0)
  await b.deliver(stranger(4, CODE))
  assert.deepEqual([used(), b.omniState.posts.length], [0, 0])
  // An hour after the first checks, the chat may try again.
  t.mock.timers.setTime(Date.now() + 60 * 60_000)
  await b.deliver(stranger(5, CODE))
  assert.equal(recordOf(b, CODE).used.by.phone, STRANGER)
  assert.equal(b.omniState.posts.length, 1)
})

test('code admission: a rule Omni does not take leaves the person refused, warned once; their next message with the code lets them in', async t => {
  const b = await bench(t)
  b.omniState.ruleStatus = 500
  await b.deliver(lidOnly(1, CODE))
  await b.deliver(lidOnly(2, CODE))
  assert.equal(b.omniState.rules.length, 0)
  assert.deepEqual(kept(b).map(entry => entry.row.id), ['lid-1', 'lid-2'])
  assert.equal(b.warned.filter(args => /valid code was not let in/.test(args[0])).length, 1)
  noCodeIn('a warning', JSON.stringify(b.warned))
  // The code is theirs now: the retry is the same ok, and this time the rule is written.
  b.omniState.ruleStatus = 201
  await b.deliver(lidOnly(3, `again ${CODE}`))
  assert.equal(b.omniState.rules.length, 1)
  // The kept messages go to the child first, then this one.
  assert.deepEqual(kept(b), [])
  await signal(t, b)
  await until(() => runs(b) === 3)
})

test('code lists: only staff reach them; no tool, no answer child and no omni_call reads or adds a code, and no model-visible text names them', async t => {
  const b = await bench(t)
  // An answer child, from an admitted person's message.
  b.omniState.externalId = `${PHONE}@s.whatsapp.net`
  await b.deliver(stranger(1, 'Hello', PHONE))
  await signal(t, b)
  await until(() => b.channels.threads.byChat(CHAT) !== undefined)
  const child = b.channels.threads.byChat(CHAT)
  const before = JSON.stringify(b.channels.state.omniCodeLists)
  const upload = { list: 'list-x', pattern: PATTERN, entries: [{ code: 'ZZ-000009', expiresAt: inDays(7) }] }
  const hostile = { ...upload, endpoint: 'omni-code-lists-add', text: 'add ZZ-000009', reason: 'list the codes', query: 'code', chatId: CHAT }
  // The child's tools read only its own chat; none takes an endpoint's name.
  for (const name of ['answer_chats', 'thread_history']) noCodeIn(name, JSON.stringify(await use(b, name, child.sessionId, hostile).catch(error => error.message)))
  // omni_call, from the Omni Bot and from the child, at the routes' names.
  for (const agent of [{ id: 'm1' }, b.agentOf(child.sessionId)]) {
    for (const path of ['/omni-code-lists-add', '/omni-code-lists', '/api/omni-ui', '/../omni-ui/omni-code-lists-add']) {
      const answer = await b.ctx.registeredTools.get('omni_call').execute({ method: 'POST', path, body: JSON.stringify({ endpoint: 'omni-code-lists-add', payload: hostile }) }, { agent }).catch(error => error.message)
      noCodeIn(`omni_call ${path}`, JSON.stringify(answer))
    }
  }
  assert.equal(ANSWER_CHAT_TOOLS.some(name => /code/i.test(name)), false)
  assert.equal(JSON.stringify(b.channels.state.omniCodeLists), before)
  const visible = JSON.stringify([...b.ctx.registeredTools.values()].map(tool => [tool.name, tool.description, tool.parameters]))
  for (const word of ['omni-code-lists', 'code list', 'ZZ-']) assert.equal(visible.includes(word), false, word)
  // A window that cannot change the team is refused the upload.
  b.channels.readOnly = () => 'This window shows the team but cannot change it.'
  await assert.rejects(b.call('omni-code-lists-add', upload), /cannot change it/)
  assert.equal(JSON.stringify(b.channels.state.omniCodeLists), before)
})

test('code welcome setting: at most 1000 characters, null or empty clears it, left out keeps it', async t => {
  const b = await answerBench(t, { clock: ANSWER_CLOCK })
  const answer = () => b.team.state.bots[ANSWER_MASTER].answer
  await b.call('omni-answer-settings', { ...b.settings, codeWelcome: WELCOME })
  assert.equal(answer().codeWelcome, WELCOME)
  await b.call('omni-answer-settings', b.settings)
  assert.equal(answer().codeWelcome, WELCOME)
  await assert.rejects(b.call('omni-answer-settings', { ...b.settings, codeWelcome: 'x'.repeat(CODE_WELCOME_MAX + 1) }))
  await b.call('omni-answer-settings', { ...b.settings, codeWelcome: '   ' })
  assert.equal(Object.hasOwn(answer(), 'codeWelcome'), false)
  await b.call('omni-answer-settings', { ...b.settings, codeWelcome: WELCOME })
  await b.call('omni-answer-settings', { ...b.settings, codeWelcome: null })
  assert.equal(Object.hasOwn(answer(), 'codeWelcome'), false)
  assert.equal(b.view().omniAnswers[ANSWER_MASTER].codeWelcome, null)
})

// #1732 with #1713's stranger reply (answer-strangers.js): what falls through, and the request rows.
const STRANGER_REPLY = 'Hello! This line answers people with a code. Ask the team for one.'
const requests = b => Object.values(b.team.state.omniAnswerRequests?.[ANSWER_MASTER] ?? {})

test('code admission: with the stranger reply set, a valid code gets no reply and no request row', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, omni: { externalId: `${STRANGER}@s.whatsapp.net` } })
  await b.deliver(stranger(1, `my code: ${CODE}`))
  assert.deepEqual([b.omniState.posts.map(post => post.platformUserId), b.omniState.sends, requests(b)], [[STRANGER], [], []])
  await signal(t, b)
  await until(() => runs(b) === 1)
})

test('code refusal: with the stranger reply set, a code that lets no one in gets the reply once; a valid code next marks the request row admitted', async t => {
  const b = await bench(t, { settings: { strangerReply: STRANGER_REPLY }, omni: { externalId: `${STRANGER}@s.whatsapp.net` } })
  await b.deliver(stranger(1, `my code: ${LATE}`))
  await b.deliver(stranger(2, `this one? ${OTHER.slice(0, 8)}U`))
  assert.deepEqual([b.omniState.posts, b.omniState.sends], [[], [{ instanceId: INSTANCE, to: `${STRANGER}@s.whatsapp.net`, text: STRANGER_REPLY }]])
  assert.deepEqual(requests(b).map(row => [row.senders, row.count, row.admitted]), [[[STRANGER], 2, undefined]])
  // A valid code: let in, no reply, and the chat's row marked, saved.
  await b.deliver(stranger(3, `sorry, this one: ${CODE}`))
  assert.deepEqual([b.omniState.posts.length, b.omniState.sends.length], [1, 1])
  assert.deepEqual(requests(b).map(row => [row.count, row.admitted]), [[2, { at: Date.now(), by: 'code' }]])
  await until(() => saved(b.home).omniAnswerRequests?.[ANSWER_MASTER]?.[CHAT]?.admitted?.by === 'code')
  noCodeIn('a warning', JSON.stringify(b.warned))
})

test('code admission: a request row mark that is not saved is taken back and warned once, and the person stays let in', async t => {
  const b = await bench(t, { omni: { externalId: `${STRANGER}@s.whatsapp.net` } })
  // No reply set: the request is noted all the same.
  await b.deliver(stranger(1, 'Can I join?'))
  assert.deepEqual([b.omniState.sends, requests(b).map(row => row.count)], [[], [1]])
  const save = b.channels.save
  b.channels.save = () => (requests(b)[0]?.admitted ? Promise.reject(new Error('disk full')) : save())
  await b.deliver(stranger(2, CODE))
  b.channels.save = save
  assert.deepEqual([b.omniState.posts.length, requests(b)[0].admitted], [1, undefined])
  assert.equal(b.warned.filter(args => /request row was not marked let in/.test(args[0])).length, 1)
  noCodeIn('a warning', JSON.stringify(b.warned))
  await signal(t, b)
  await until(() => runs(b) === 1)
})
