import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installHooks } from '@automagik/bots-dsh/src/host/extend.js'
import { install } from '../src/host/omni-channel-actions.js'
import { answerSettingsOf } from '../src/host/threads.js'
import { answerBench, answerState, ANSWER_MASTER, INSTANCE, OTHER_INSTANCE } from './thread-fixture.js'

const TOKEN = `824600000:${'a'.repeat(35)}`
const INPUT = { name: 'Telegram support', token: TOKEN }
function host({ status = { state: 'connected', profileName: 'Helper' }, createError, statusError } = {}) {
  const calls = [], logs = [], names = new Set()
  const rt = {
    ctx: { effect: run => run(), logger: { info: (...args) => logs.push(args) } },
    omniRequest: async (method, path, { body } = {}) => {
      calls.push({ method, path, body })
      if (method === 'POST' && path === '/instances') {
        if (createError) return new Response(JSON.stringify({ error: { message: createError } }), { status: 500 })
        if (names.has(body.name)) return new Response(JSON.stringify({ error: { message: 'Instance name already exists' } }), { status: 409 })
        names.add(body.name)
        return new Response(JSON.stringify({ data: { id: INSTANCE, channel: body.channel, name: body.name, token: body.token } }), { status: 201 })
      }
      assert.equal(path, `/instances/${INSTANCE}/status`)
      return new Response(JSON.stringify(statusError ? { error: { message: statusError } } : { data: status }), { status: statusError ? 500 : 200 })
    },
  }
  installHooks(rt)
  install(rt)
  return { rt, calls, logs }
}

test('Telegram attach is host-only, uses body.token once, and returns only the pairing receipt', async () => {
  const { rt, calls, logs } = host()
  assert.equal(rt.extended.endpointOf('omniTelegramAttach'), undefined)
  const receipt = await rt.omniTelegramAttach({ ...INPUT, source: 'onboarding hand-off' })
  assert.deepEqual(receipt, { channelId: INSTANCE, channelName: INPUT.name, connected: true, detail: 'Helper' })
  assert.deepEqual(calls, [
    { method: 'POST', path: '/instances', body: { name: INPUT.name, channel: 'telegram', token: TOKEN } },
    { method: 'GET', path: `/instances/${INSTANCE}/status`, body: undefined },
  ])
  assert.equal(logs.length, 1)
  assert.equal(logs[0].at(-1), 'onboarding hand-off')
  assert.equal(JSON.stringify([receipt, logs]).includes(TOKEN), false)
})

test('Telegram attach reports unconnected status and never invents a Telegram bot id or detail', async () => {
  const { rt } = host({ status: { state: 'connecting' } })
  assert.deepEqual(await rt.omniTelegramAttach(INPUT), { channelId: INSTANCE, channelName: INPUT.name, connected: false, detail: null })
  const reported = host({ status: { state: 'connected', botId: 824600000, profileName: null } })
  assert.equal((await reported.rt.omniTelegramAttach(INPUT)).botId, 824600000)
})

test('Telegram attach refuses malformed or missing tokens and extra input before calling Omni', async () => {
  const { rt, calls } = host()
  for (const body of [{ name: INPUT.name }, { ...INPUT, token: 'not-a-telegram-token' }, { ...INPUT, token: '824600000:short' }, { ...INPUT, chatId: '824600001' }]) {
    await assert.rejects(rt.omniTelegramAttach(body), { code: 'bot/invalid', message: 'Paste the bot token' })
  }
  assert.equal(calls.length, 0)
})

test('Telegram attach retry with the same unique name never creates or reconnects a second instance', async () => {
  const { rt, calls } = host()
  await rt.omniTelegramAttach(INPUT)
  await assert.rejects(rt.omniTelegramAttach(INPUT), /Instance name already exists/)
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), ['POST /instances', `GET /instances/${INSTANCE}/status`, 'POST /instances'])
})

test('Telegram attach respects a read-only host before sending the token', async () => {
  const { rt, calls } = host()
  rt.readOnly = () => 'This host is read-only.'
  await assert.rejects(rt.omniTelegramAttach(INPUT), /This host is read-only/)
  assert.equal(calls.length, 0)
})

for (const phase of ['createError', 'statusError']) test(`Telegram attach redacts token-bearing ${phase} before leaving the host`, async () => {
  const { rt, logs } = host({ [phase]: `Refused ${TOKEN}` })
  await assert.rejects(rt.omniTelegramAttach(INPUT), error => {
    assert.equal(error.message, 'Refused [REDACTED]')
    assert.equal(String(error.stack).includes(TOKEN), false)
    return true
  })
  assert.deepEqual(logs, [])
})

test('Telegram attach redacts the token from source logs and receipt text', async () => {
  const { rt, logs } = host({ status: { state: 'connected', profileName: TOKEN, botId: TOKEN } })
  const receipt = await rt.omniTelegramAttach({ ...INPUT, name: TOKEN, source: TOKEN })
  assert.equal(JSON.stringify([receipt, logs]).includes(TOKEN), false)
  assert.equal(receipt.channelName, '[REDACTED]')
  assert.equal(receipt.detail, '[REDACTED]')
  assert.equal(receipt.botId, undefined)
})

for (const [label, enabled, ownsOther, answering] of [
  ['no other channel', false, false, true],
  ['already answering', true, true, true],
  ['off with other channels', false, true, false],
]) test(`Telegram attach answerBot: ${label} preserves defaults and other channels`, async t => {
  const state = answerState()
  if (!ownsOther) state.omniOwnership.channels = {}
  const b = await answerBench(t, { state, enabled })
  await b.channels.quiesceOmniEvents()
  const request = b.channels.omniRequest
  b.channels.omniRequest = async (method, path, args) => {
    if (method === 'POST' && path === '/instances') return new Response(JSON.stringify({ data: { id: OTHER_INSTANCE, channel: 'telegram', name: INPUT.name } }), { status: 201 })
    if (path === `/instances/${OTHER_INSTANCE}/status`) return new Response(JSON.stringify({ data: { state: 'connected', profileName: 'Helper', botId: '824600000' } }))
    return request(method, path, args)
  }
  const before = answerSettingsOf(b.channels.botOf(ANSWER_MASTER))
  const receipt = await b.channels.omniTelegramAttach({ ...INPUT, answerBot: ANSWER_MASTER })
  assert.equal(receipt.botId, '824600000', 'Telegram identity keeps its original meaning')
  assert.equal(receipt.answerBot, ANSWER_MASTER)
  assert.equal(receipt.answering, answering)
  assert.equal(receipt.reason, answering ? undefined : 'other-channels')
  assert.deepEqual(answerSettingsOf(b.channels.botOf(ANSWER_MASTER)), { ...before, enabled: answering })
  assert.equal(b.channels.state.omniOwnership.channels[OTHER_INSTANCE], ANSWER_MASTER)
  assert.equal(b.channels.state.omniOwnership.channels[INSTANCE], ownsOther ? ANSWER_MASTER : undefined)
  b.channels.syncAnswerSubscriptions()
  const subscription = b.channels.state.subscriptions[`answer:${ANSWER_MASTER}`]
  assert.equal(subscription?.on ?? false, answering)
  if (answering) assert.equal(subscription.sources.some(source => source.id === OTHER_INSTANCE), true)
})

test('Telegram attach refuses an unknown answerBot before creating a channel', async t => {
  const b = await answerBench(t, { enabled: false })
  const request = b.channels.omniRequest
  let creates = 0
  b.channels.omniRequest = async (method, path, args) => {
    if (method === 'POST' && path === '/instances') creates += 1
    return request(method, path, args)
  }
  await assert.rejects(b.channels.omniTelegramAttach({ ...INPUT, answerBot: 'unknown-bot' }), /Answer mode needs a channel bot/)
  assert.equal(creates, 0)
})
