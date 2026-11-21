import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call, dateLocale, hostText, t } from './core.js'

const invalid = Symbol('invalid history reply')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const checked = test => value => test(value) ? value : invalid
const nullable = read => value => value === null ? null : read(value)
const optional = read => value => value === undefined ? undefined : read(value)
const readText = checked(value => typeof value === 'string')
const nullableText = nullable(readText)
const bool = checked(value => typeof value === 'boolean')
const count = checked(value => Number.isSafeInteger(value) && value >= 0)
const guid = checked(value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value))
const choice = (...values) => checked(value => values.includes(value))

const day = checked(value => {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-(\d{2}))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  // Check the calendar date before applying the offset. Date parsing can normalize invalid days.
  return match !== null && new Date(match[1] + 'T00:00:00Z').getUTCDate() === Number(match[2])
})

// Copy only the checked fields so reply extras cannot leak into card state or a decision update.
function readObject(fields) {
  const entries = Object.entries(fields)
  return value => {
    if (!isObject(value)) return invalid
    const result = {}
    for (const [key, read] of entries) {
      const field = read(value[key])
      if (field === invalid) return invalid
      if (field !== undefined || key in value) result[key] = field
    }
    return result
  }
}

const readArray = read => value => {
  if (!Array.isArray(value)) return invalid
  const result = []
  for (let index = 0; index < value.length; index++) {
    const item = read(value[index])
    if (item === invalid) return invalid
    result.push(item)
  }
  return result
}

const readCoverage = readObject({
  oldest: nullableText, newest: nullableText, count, countInWindow: count, deletedCount: count,
  mediaMissing: count, lastInbound: nullableText, lastOutbound: nullableText,
})
const trainingFields = {
  selected: bool, threadId: nullableText, sendingMode: nullable(choice('training', 'sending')),
}
const readRunConversations = readObject({
  run: readObject({ id: readText, from: day, to: day, startedAt: checked(Number.isFinite) }),
  chats: readArray(readObject({
    id: guid, name: readText, channelId: readText, state: readText, outcome: nullableText,
    coverage: nullable(readCoverage), inWindow: nullable(count), stored: count, lastActivity: nullableText,
    summary: nullableText, noted: bool, training: readObject(trainingFields), commitments: readObject({ candidate: count, open: count }),
  })),
  summary: readObject({ total: count, running: count, done: count, phoneDidNotAnswer: count, stopped: count, failed: count, notStarted: count }),
})
function readConversations(value) {
  if (isObject(value) && value.run === null) {
    const { chats } = value
    return Array.isArray(chats) && chats.length === 0 ? { run: null, chats: [] } : invalid
  }
  return readRunConversations(value)
}
const readTrainingReply = readObject({ results: readArray(readObject({ ...trainingFields, chatId: guid, refusal: nullableText })) })
const decisionFields = { id: readText, status: choice('candidate', 'open', 'done', 'cancelled', 'dismissed'), verified: bool }
const readDecisionReply = readObject(decisionFields)
const readCommitments = readObject({
  commitments: readArray(readObject({
    ...decisionFields,
    chatId: guid, channelId: guid, text: readText, owner: choice('user', 'counterpart', 'other'),
    ownerName: optional(readText), counterpart: optional(readText), deadline: nullable(day),
    nextAction: optional(readText), sourceAt: day, createdAt: day, updatedAt: day,
    closing: optional(readObject({ at: day })),
  })),
})

// A changed link or query blanks the card immediately. Revisions and explicit retries
// refresh the same scope without dropping its draft or the results of the last action.
function useHistoryRead(endpoint, readReply, request, roster, query) {
  const key = JSON.stringify([roster?.omniHistoryLink ?? null, query])
  const scope = useMemo(() => ({ query: JSON.parse(key)[1] }), [key])
  const active = useRef(null)
  const writable = useRef(false)
  const readOnly = Boolean(roster?.readOnly)
  const [answer, setAnswer] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const revision = roster?.revision
  useLayoutEffect(() => {
    active.current = scope
    return () => { active.current = null }
  }, [scope])
  useLayoutEffect(() => { writable.current = !readOnly }, [readOnly])
  const current = () => active.current === scope
  useEffect(() => {
    const abort = new AbortController()
    const waiting = { scope, loading: true, failed: false }
    setAnswer(previous => previous?.scope === scope ? { ...previous, ...waiting } : waiting)
    const finish = next => {
      if (!abort.signal.aborted && active.current === scope) setAnswer({ scope, loading: false, ...next })
    }
    Promise.resolve().then(async () => {
      if (abort.signal.aborted || active.current !== scope) return
      const data = readReply(await request(endpoint, scope.query, abort.signal))
      finish(data === invalid ? { failed: true } : { data })
    }).catch(() => finish({ failed: true }))
    return () => abort.abort()
  }, [endpoint, revision, scope, attempt, request, readReply])
  return {
    ...(answer?.scope === scope ? answer : { loading: true }),
    scope, current, canWrite: () => current() && writable.current,
    reload: () => { if (current()) setAttempt(value => value + 1) },
    update: change => setAnswer(answer => answer?.scope === scope && answer.data
      ? { ...answer, data: change(answer.data) } : answer),
  }
}

function action(label, onClick, disabled, className = 'bt-genui-cancel') {
  return h('button', { type: 'button', className, onClick, disabled }, label)
}

const utcDay = value => new Date(value).toISOString().slice(0, 10)
const errorLine = text => text ? h('span', { className: 'bt-genui-error', role: 'status' }, text) : null
const muted = text => h('span', { className: 'bt-genui-muted' }, text)

function HistoryCard({ title, read, readOnly, loadError, children, foot, busy = false }) {
  return h('section', { className: 'bt-q bt-genui-backfill-runs omni-history-card', 'aria-busy': read.loading || busy || undefined },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, title))),
    children,
    h('div', { className: 'bt-genui-foot' },
      read.loading ? muted(t('Loading…')) : null,
      read.failed ? errorLine(loadError) : null,
      read.failed ? action(t('Refresh'), read.reload, read.loading, 'bt-genui-retry') : null,
      readOnly ? muted(typeof readOnly === 'string'
        ? hostText(readOnly) : t('Make changes from the host that owns this team.')) : null,
      foot))
}

const conversationStates = new Map([
  ['queued', ['work', () => t('Waiting')]],
  ['reading', ['work', () => t('Reading')]],
  ['fetching', ['work', () => t('Fetching')]],
  ['done', ['done', () => t('Done')]],
  ['phone-did-not-answer', ['phone', () => t('Phone did not answer')]],
  ['cancelled', ['stopped', () => t('Stopped')]],
  ['stopped', ['stopped', () => t('Stopped')]],
  ['not-started', ['stopped', () => t('Not started')]],
  ['failed', ['failed', () => t('Failed')]],
])

function coverageSpan({ oldest, newest }, locale) {
  const dates = [oldest, newest].map(Date.parse).filter(Number.isFinite).map(value => new Date(value))
  if (dates.length === 0) return ''
  const options = { month: 'short' }
  if (dates.length === 1) options.day = 'numeric'
  const sameYear = dates.length === 2 && dates[0].getFullYear() === dates[1].getFullYear()
  if (!sameYear) options.year = 'numeric'
  const format = new Intl.DateTimeFormat(locale, options)
  return dates.map(date => format.format(date)).join(sameYear ? '–' : ' – ')
}

function coverageText(coverage, locale) {
  const { count, deletedCount, mediaMissing } = coverage
  return [
    t('{count} messages', { count: count.toLocaleString(locale) }),
    coverageSpan(coverage, locale),
    deletedCount > 0 ? t('{count} deleted', { count: deletedCount.toLocaleString(locale) }) : null,
    mediaMissing > 0 ? t('{count} missing media', { count: mediaMissing.toLocaleString(locale) }) : null,
  ].filter(Boolean).join(' · ')
}

function ConversationRow({ chat, checked, disabled, change, refusal }) {
  const locale = dateLocale()
  const [state, word] = conversationStates.get(chat.outcome) ?? conversationStates.get(chat.state) ?? []
  const checkbox = h('label', { className: 'bt-genui-pick-label' },
    h('input', { type: 'checkbox', checked, disabled, onChange: event => change(event.target.checked),
      'aria-label': t('Select {chat} for Answer Mode training', { chat: chat.name }) }))
  return h('li', { className: 'bt-genui-pick' },
    h('ul', { className: 'bt-genui-rows' },
      h('li', { className: 'bt-genui-row', 'data-state': state },
        h('span', { className: 'bt-genui-dot', 'aria-hidden': true }),
        h('div', { className: 'bt-genui-body' },
          h('div', { className: 'bt-genui-line' },
            h('span', { className: 'bt-genui-name' }, chat.name),
            word ? h('span', { className: 'bt-genui-word' }, word()) : null,
            h('span', { className: 'bt-genui-num' }, t('{count} stored', { count: chat.stored.toLocaleString(locale) })))),
        h('div', { className: 'bt-genui-action' }, checkbox))),
    chat.summary ? h('p', { className: 'bt-genui-text' }, chat.summary) : null,
    chat.coverage ? h('div', { className: 'bt-genui-what' }, coverageText(chat.coverage, locale)) : null,
    h('div', { className: 'bt-genui-line bt-genui-sub' },
      chat.inWindow === null ? null : muted(t('{count} messages in this window', { count: chat.inWindow })),
      chat.training.sendingMode === null ? null : muted(chat.training.sendingMode === 'training' ? t('Training') : t('Sending')),
      chat.commitments.candidate > 0 || chat.commitments.open > 0
        ? muted(t('{candidate} candidate and {open} open commitments', chat.commitments)) : null),
    errorLine(refusal ? hostText(refusal) : null))
}

const TRAINING_BATCH = 50
const noSelection = { draft: new Map(), refusals: new Map(), failed: false, busy: false }

async function applyTraining(changes, read, request, results, refusals) {
  for (const selected of [true, false]) {
    const ids = changes.filter(chat => chat.selected === selected).map(chat => chat.id)
    for (let start = 0; start < ids.length; start += TRAINING_BATCH) {
      if (!read.canWrite()) return true
      const chats = ids.slice(start, start + TRAINING_BATCH)
      const reply = readTrainingReply(await request('select_conversation_training', { chats, selected }))
      if (reply === invalid) return false
      const byChat = new Map(reply.results.map(result => [result.chatId, result]))
      for (const chatId of chats) {
        const result = byChat.get(chatId)
        if (!result) refusals.set(chatId, t('No training decision came back for this chat.'))
        else if (result.refusal !== null) refusals.set(chatId, result.refusal)
        else results.set(chatId, { selected: result.selected, threadId: result.threadId, sendingMode: result.sendingMode })
      }
    }
  }
  return true
}

export function ConversationsCard({ roster, runId, request = call }) {
  const read = useHistoryRead('omni-conversations', readConversations, request, roster, { runId })
  const [selection, setSelection] = useState(noSelection)
  const pending = useRef(null)
  const shown = selection.scope === read.scope ? selection : noSelection
  const chats = read.data?.chats ?? []
  const checked = chat => shown.draft.get(chat.id) ?? chat.training.selected
  const changes = chats.flatMap(chat => checked(chat) === chat.training.selected ? [] : [{ id: chat.id, selected: checked(chat) }])
  const blocked = Boolean(roster?.readOnly) || shown.busy || read.loading
  const edit = change => setSelection(previous => {
    const before = previous.scope === read.scope ? previous : noSelection
    const draft = new Map(before.draft)
    change(draft)
    return { ...before, scope: read.scope, draft }
  })
  const apply = async () => {
    if (blocked || !read.canWrite() || pending.current === read.scope || changes.length === 0) return
    pending.current = read.scope
    setSelection({ ...shown, scope: read.scope, busy: true, failed: false, refusals: new Map() })
    const results = new Map()
    const refusals = new Map()
    let failed = false
    try {
      failed = !await applyTraining(changes, read, request, results, refusals)
    } catch {
      failed = true
    } finally {
      if (pending.current === read.scope) pending.current = null
      if (read.current()) {
        read.update(data => ({ ...data, chats: data.chats.map(chat =>
          results.has(chat.id) ? { ...chat, training: results.get(chat.id) } : chat) }))
        setSelection({ ...noSelection, scope: read.scope, refusals, failed })
        read.reload()
      }
    }
  }
  const run = read.data?.run
  const summary = read.data?.summary
  const setAll = selected => edit(draft => { for (const chat of chats) draft.set(chat.id, selected) })
  const foot = chats.length === 0 ? null : [
    h('span', { key: 'apply' }, action(t('Apply'), apply, blocked || changes.length === 0, 'bt-genui-start')),
    h('span', { key: 'select' }, action(t('Select all'), () => setAll(true), blocked || chats.every(checked))),
    h('span', { key: 'clear' }, action(t('Clear'), () => setAll(false), blocked || !chats.some(checked))),
    h('span', { key: 'error' }, errorLine(shown.failed ? t('Could not finish applying the training selection.') : null)),
  ]
  return h(HistoryCard, { title: t('Review conversations'), read, readOnly: roster?.readOnly, busy: shown.busy,
    loadError: t('Could not load conversations for this run.'), foot },
    run === null ? h('p', { className: 'bt-genui-muted' }, t('This run is no longer listed.')) : null,
    run ? h('div', { className: 'bt-genui-run-head' },
      h('span', { className: 'bt-genui-run-range' }, `${utcDay(run.from)} – ${utcDay(run.to)}`),
      muted(t('{count} chats', { count: summary.total })),
      summary.notStarted ? muted(t('{count} not started', { count: summary.notStarted })) : null) : null,
    run && chats.length === 0 ? h('p', { className: 'bt-genui-muted' }, t('There are no chats to review in this run.')) : null,
    chats.length ? h('ul', { className: 'bt-genui-picks' }, chats.map(chat => h(ConversationRow, {
      key: chat.id, chat, checked: checked(chat), disabled: blocked, refusal: shown.refusals.get(chat.id),
      change: selected => edit(draft => draft.set(chat.id, selected)),
    }))) : null)
}

const commitmentStatus = {
  candidate: () => t('Candidate'), open: () => t('Open commitment'), done: () => t('Done'),
  cancelled: () => t('Cancelled'), dismissed: () => t('Dismissed'),
}
const commitmentOwner = {
  user: () => t('You'), counterpart: () => t('Counterpart'), other: () => t('Other'),
}
const matches = (item, { status, verified }) => (status === undefined ? item.status !== 'dismissed' : item.status === status)
  && (verified === undefined || item.verified === verified)

function CommitmentRow({ item, busy, readOnly, error, decide }) {
  const disabled = busy || readOnly
  return h('li', { className: 'bt-genui-row', 'aria-busy': busy || undefined },
    h('div', { className: 'bt-genui-body' },
      h('p', { className: 'bt-genui-text' }, item.text),
      h('div', { className: 'bt-genui-line' },
        h('span', { className: 'bt-genui-word' }, commitmentStatus[item.status]()), item.verified ? muted(t('Verified')) : null),
      h('div', { className: 'bt-genui-line bt-genui-sub' },
        h('span', null, t('Owner: {name}', { name: item.ownerName ?? commitmentOwner[item.owner]() })),
        item.counterpart ? h('span', null, t('Counterpart: {name}', { name: item.counterpart })) : null,
        item.deadline ? h('span', null, t('Due {date}', { date: utcDay(item.deadline) })) : null,
        h('span', null, t('Source on {date}', { date: utcDay(item.sourceAt) }))),
      item.nextAction ? h('p', { className: 'bt-genui-note' }, t('Next action: {action}', { action: item.nextAction })) : null,
      h('div', { className: 'bt-genui-line' },
        !item.verified && item.status !== 'dismissed' ? action(t('Verify'), () => decide('verify'), disabled, 'bt-genui-start') : null,
        item.status === 'candidate' ? action(t('Dismiss'), () => decide('dismiss'), disabled) : null,
        errorLine(error))))
}

const noDecisions = new Map()

export function CommitmentsCard({ roster, chat, status, verified, request = call }) {
  const filters = { chat, status, verified }
  const read = useHistoryRead('omni-commitments', readCommitments, request, roster, filters)
  const [decisions, setDecisions] = useState(null)
  const pending = useRef({ scope: null, ids: new Set() })
  const shown = decisions?.scope === read.scope ? decisions.items : noDecisions
  const items = read.data?.commitments ?? []
  const update = (id, entry) => setDecisions(previous => {
    const items = new Map(previous?.scope === read.scope ? previous.items : [])
    items.set(id, entry)
    return { scope: read.scope, items }
  })
  const decide = async (id, decision) => {
    if (!read.canWrite()) return
    if (pending.current.scope !== read.scope) pending.current = { scope: read.scope, ids: new Set() }
    const { ids } = pending.current
    if (ids.has(id)) return
    ids.add(id)
    update(id, { busy: true })
    const saveError = () => t('Could not save this commitment decision.')
    let error
    try {
      const result = readDecisionReply(await request('review_commitment', { id, decision }))
      if (result === invalid || result.id !== id) error = saveError()
      else if (read.current()) read.update(data => ({
        commitments: data.commitments.map(item => item.id === id ? { ...item, ...result } : item)
          .filter(item => matches(item, filters)),
      }))
    } catch (failure) {
      error = failure?.code?.startsWith('bot/') && failure.message
        ? hostText(failure.message) : saveError()
    } finally {
      ids.delete(id)
      if (read.current()) {
        update(id, { error })
        read.reload()
      }
    }
  }
  return h(HistoryCard, { title: t('Commitments'), read, readOnly: roster?.readOnly,
    loadError: t('Could not load commitments.') },
    read.data && items.length === 0 ? h('p', { className: 'bt-genui-muted' }, t('No commitments match this filter.')) : null,
    items.length ? h('ul', { className: 'bt-genui-rows' }, items.map(item => h(CommitmentRow, {
      key: item.id, item, readOnly: Boolean(roster?.readOnly), ...shown.get(item.id), decide: decision => decide(item.id, decision),
    }))) : null)
}

// The team release can supply the base question card without the genui kit styles.
export const HISTORY_CARD_CSS = `
.omni-history-card{max-width:560px}
.omni-history-card .bt-genui-rows,.omni-history-card .bt-genui-picks{display:flex;flex-direction:column;gap:1px;min-width:0;margin:0 -8px;padding:0;list-style:none}
.omni-history-card .bt-genui-picks{max-height:220px;overflow:auto}
.omni-history-card .bt-genui-pick{min-width:0;padding:0 8px 8px}
.omni-history-card .bt-genui-row{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:8px;border-radius:10px}
.omni-history-card .bt-genui-row+.bt-genui-row{box-shadow:inset 0 1px 0 var(--bt-q-rule-2,var(--bt-line-weak))}
.omni-history-card .bt-genui-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--bt-ink-3)}
.omni-history-card [data-state=done] .bt-genui-dot{background:var(--bt-green)}
.omni-history-card [data-state=failed] .bt-genui-dot{background:var(--bt-danger)}
.omni-history-card [data-state=phone] .bt-genui-dot{background:var(--bt-gold)}
.omni-history-card [data-state=work] .bt-genui-dot{background:var(--bt-accent)}
.omni-history-card .bt-genui-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.omni-history-card .bt-genui-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;min-width:0;font-size:13.5px;line-height:19px}
.omni-history-card .bt-genui-name,.omni-history-card .bt-genui-run-range{font-weight:600;color:var(--bt-ink);overflow-wrap:anywhere}
.omni-history-card .bt-genui-word,.omni-history-card .bt-genui-num{color:var(--bt-ink-2)}
.omni-history-card .bt-genui-num{font-variant-numeric:tabular-nums}
.omni-history-card .bt-genui-sub,.omni-history-card .bt-genui-muted{color:var(--bt-ink-3)}
.omni-history-card .bt-genui-what,.omni-history-card .bt-genui-sub{font-size:12.5px;line-height:17px}
.omni-history-card .bt-genui-what,.omni-history-card .bt-genui-note{color:var(--bt-ink-2)}
.omni-history-card .bt-genui-text{margin:2px 0 0;font-size:13.5px;line-height:19px;color:var(--bt-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.omni-history-card .bt-genui-foot,.omni-history-card .bt-genui-run-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:12.5px;line-height:17px}
.omni-history-card .bt-genui-foot{padding-top:10px;border-top:1px solid var(--bt-q-rule,var(--bt-line-2))}
.omni-history-card .bt-genui-note{margin:0;font-size:13px;line-height:18px;overflow-wrap:anywhere}
.omni-history-card .bt-genui-pick-label{display:flex;align-items:center;padding:3px 8px;cursor:pointer}
.omni-history-card .bt-genui-pick-label input{width:15px;height:15px;margin:0;accent-color:var(--bt-accent)}
.omni-history-card .bt-genui-start,.omni-history-card .bt-genui-cancel,.omni-history-card .bt-genui-retry{flex:none;height:26px;padding:0 10px;border:1px solid var(--bt-line-2);border-radius:999px;background:none;color:var(--bt-ink);font:inherit;font-weight:600;cursor:pointer}
.omni-history-card .bt-genui-start{border-color:transparent;background:var(--bt-accent);color:var(--bt-accent-ink)}
.omni-history-card button:disabled{opacity:.5;cursor:default}
.omni-history-card button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.omni-history-card .bt-genui-error{color:var(--st-bad-strong,var(--bt-danger))}
`
