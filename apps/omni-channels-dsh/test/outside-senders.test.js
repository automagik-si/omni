import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { postsToRoom } from '../src/host/omni-api.js'
import { install, sendsOutside } from '../src/host/outside-senders.js'

const send = '/messages/send'
const presence = '/messages/send/presence'
const group = { to: '123@g.us' }
const loadingMessages = ['Checking context', 'Preparing reply']
const typing = { type: 'typing', status: 'Checking context', loadingMessages }

test('postsToRoom classifies room posts and visible presence text', async (t) => {
  for (const [name, method, path, body, expected] of [
    ['group send', 'POST', send, group, true],
    ['channel media send', 'POST', send + '/media', { to: '123@newsletter' }, true],
    ['person send', 'POST', send, { to: '123@s.whatsapp.net' }, false],
    ['self send', 'POST', '/messages/send-self', group, false],
    ['reaction', 'POST', send + '/reaction', group, false],
    ['typing with status', 'POST', presence, { type: 'typing', status: typing.status }, true],
    ['recording with loading messages', 'POST', presence, { type: 'recording', loadingMessages }, true],
    ['typing without custom text', 'POST', presence, { type: 'typing' }, false],
    ['typing with empty status and loading list', 'POST', presence, { type: 'typing', status: '', loadingMessages: [] }, false],
    ['typing with an empty loading message', 'POST', presence, { type: 'typing', loadingMessages: ['Checking context', ''] }, false],
    ['typing with a non-string loading message', 'POST', presence, { type: 'typing', loadingMessages: [42] }, false],
    ['typing with a string instead of a loading list', 'POST', presence, { type: 'typing', loadingMessages: 'Checking context' }, false],
    ['held typing ignores text', 'POST', presence, { ...typing, hold: true }, false],
    ['unknown presence type', 'POST', presence, { ...typing, type: 'hold' }, false],
    ['paused clears text', 'POST', presence, { ...typing, type: 'paused' }, false],
    ['GET', 'GET', send, group, false],
    ['DELETE', 'DELETE', send, group, false],
    ['unrelated POST', 'POST', '/messages/read', group, false],
  ]) {
    await t.test(name, () => assert.equal(postsToRoom(method, path, body), expected))
  }
})

const step = { tool: 'omni_call', args: { method: 'POST', path: send, body: group } }
const chatSession = 'chat-session'
const eventSession = 'event-session'
const threadSession = 'thread-session'

test('sendsOutside classifies eligible Sessions and normalizes omni_call', async (t) => {
  const rt = {
    chatOwners: new Map([[chatSession, 'bot']]),
    state: { subscriptionRuns: [{ sessionId: eventSession }, { sessionId: chatSession }] },
    threads: { bySession: sessionId => (sessionId === threadSession ? {} : undefined) },
  }
  const call = { ...step, sessionId: chatSession }
  for (const [name, input, expected] of [
    ['no Session', step, false],
    ['non-string Session', { ...step, sessionId: 42 }, false],
    ['thread Session', { ...step, sessionId: threadSession }, false],
    ['automation event run', { ...step, sessionId: eventSession }, false],
    ['chat owner with a past automation run and object body', call, true],
    ['JSON body without the API prefix', { ...call, args: { ...step.args, body: JSON.stringify(group) } }, true],
    ['JSON body with lowercase method and padded API-prefixed path', {
      ...call, args: { method: 'post', path: ' /api/v2/messages/send ', body: JSON.stringify(group) },
    }, true],
    ['presence with custom text', { ...call, args: { method: 'POST', path: presence, body: typing } }, true],
    ['unparsable POST send body', { ...call, args: { ...step.args, body: '{' } }, true],
    ['unparsable GET send body', { ...call, args: { ...step.args, method: 'GET', body: '{' } }, false],
    ['unparsable reaction body', { ...call, args: { ...step.args, path: send + '/reaction', body: '{' } }, false],
    ['missing method defaults to GET', { ...call, args: { path: send, body: group } }, false],
    ['prefixed omni_call', { ...call, tool: 'mcp__dsh__omni_call' }, true],
    ['omni_send', { ...call, tool: 'omni_send' }, false],
    ['omni_react', { ...call, tool: 'omni_react' }, false],
    ['omni_delete', { ...call, tool: 'omni_delete' }, false],
    ['thread_say', { ...call, tool: 'thread_say' }, false],
    ['absent step', undefined, false],
    ['null step', null, false],
    ['failed path normalization', { ...call, args: { ...step.args, path: { toString() { throw new Error('invalid path') } } } }, false],
  ]) {
    await t.test(name, () => assert.equal(sendsOutside(rt, input), expected))
  }
})

test('install registers one classifier and passes its disposer through the effect', () => {
  const effects = []
  const classifiers = []
  const dispose = () => {}
  const rt = {
    ctx: { effect: (run, label) => effects.push({ run, label }) },
    stepHooks: { sendsOutside: classify => { classifiers.push(classify); return dispose } },
  }

  install(rt)
  assert.equal(effects.length, 1)
  assert.equal(classifiers.length, 0)
  assert.equal(effects[0].label, 'omni-channels: outside senders')
  assert.equal(effects[0].run(), dispose)
  assert.equal(classifiers.length, 1)
  assert.equal(classifiers[0]({ ...step, sessionId: chatSession }), true)
})

test('install skips teams without a sendsOutside registrar', () => {
  const effects = []
  const ctx = { effect: (...args) => effects.push(args) }

  install({ ctx })
  install({ ctx, stepHooks: {} })
  assert.deepEqual(effects, [])
})

const botsDsh = process.env.AUTOMAGIK_BOTS_DSH
test('the Bot team registrar passes the Session to the Omni classifier', {
  skip: botsDsh ? false : 'AUTOMAGIK_BOTS_DSH is unset',
}, async () => {
  const { install: installTeam } = await import(pathToFileURL(resolve(botsDsh, 'src/host/extend.js')).href)
  const rt = {
    ctx: { effect: run => run() },
    state: { subscriptionRuns: [{ sessionId: eventSession }] },
  }
  installTeam(rt)
  const inputs = []
  rt.stepHooks.sendsOutside(input => {
    inputs.push(input)
    return false
  })
  install(rt)

  assert.equal(rt.sendsOutside(step, chatSession), true)
  assert.equal(rt.sendsOutside(step, eventSession), false)
  assert.equal(rt.sendsOutside(step), false)
  assert.deepEqual(inputs, [
    { ...step, sessionId: chatSession },
    { ...step, sessionId: eventSession },
    { ...step, sessionId: undefined },
  ])
})
