// #1732: the code lists staff upload (host answer-codes.js, code-lists.js), in the answer
// settings. A list has a name, its code pattern (code-pattern.js) and rule details, a key/value
// map copied into each allow rule its codes write. Staff paste codes into a list, then read the
// lists and each code's list, expiry and state. The lists are the whole install's; they are read
// only when staff show them.
import { createElement as h, useEffect, useState } from 'react'
import { call, hostText, t } from './core.js'
import { CODE_PATTERN_CSS, PatternFields, patternFields, patternOf, patternSummary } from './code-pattern.js'

const pad = value => String(value).padStart(2, '0')
// The end of that day where staff are, as an ISO time.
const endOfDay = (year, month, day) => {
  const at = new Date(year, month - 1, day, 23, 59, 59, 999)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day ? at.toISOString() : undefined
}
// A code's expiry as staff read it: the day, where they are.
export const dayOf = (iso) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * What staff pasted, as the upload's entries: a JSON array as it is, or one code a line,
 * `code, expires YYYY-MM-DD` (the word "expires" may be left out). `{ entries }`, or `{ problem }`
 * naming the line, never its code.
 */
export function parseCodeLines(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { problem: t('Paste at least one code.') }
  if (trimmed.startsWith('[')) {
    let entries
    try { entries = JSON.parse(trimmed) } catch { return { problem: t('The JSON could not be read.') } }
    return Array.isArray(entries) && entries.length > 0 ? { entries } : { problem: t('The JSON must be a list of codes.') }
  }
  const entries = []
  for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const parts = line.split(',').map(part => part.trim())
    const date = /^(?:expires\s+)?(\d{4})-(\d{2})-(\d{2})$/i.exec(parts[1] ?? '')
    const expiresAt = date ? endOfDay(Number(date[1]), Number(date[2]), Number(date[3])) : undefined
    if (parts.length !== 2 || parts[0] === '' || expiresAt === undefined) return { problem: t('Line {n}: write code, expires YYYY-MM-DD.', { n: index + 1 }) }
    entries.push({ code: parts[0], expiresAt })
  }
  return entries.length > 0 ? { entries } : { problem: t('Paste at least one code.') }
}

/**
 * The rule details staff typed: one `key = value` a line (the value as text), or a JSON object.
 * `{ metadata }`, or `{ problem }`. Empty is no details.
 */
export function parseRuleDetails(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { metadata: {} }
  if (trimmed.startsWith('{')) {
    let metadata
    try { metadata = JSON.parse(trimmed) } catch { return { problem: t('The rule details JSON could not be read.') } }
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { metadata } : { problem: t('The rule details JSON must be an object.') }
  }
  const metadata = {}
  for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const at = line.indexOf('=')
    const key = at === -1 ? '' : line.slice(0, at).trim()
    if (key === '') return { problem: t('Rule details line {n}: write key = value.', { n: index + 1 }) }
    metadata[key] = line.slice(at + 1).trim()
  }
  return { metadata }
}

/** A list's rule details as staff type them: lines when every value is one line of text, else JSON. */
export const ruleDetailsText = (metadata = {}) => (Object.values(metadata).every(value => typeof value === 'string' && !value.includes('\n'))
  ? Object.entries(metadata).map(([key, value]) => `${key} = ${value}`).join('\n')
  : JSON.stringify(metadata, null, 2))

const stateText = state => (state === 'open' ? t('Open') : state === 'used' ? t('Used') : state === 'expired' ? t('Expired') : state)
const detailsLine = metadata => Object.entries(metadata ?? {}).map(([key, value]) => `${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ')

export function CodeLists() {
  const [shown, setShown] = useState(false)
  const [view, setView] = useState(null)
  const [read, setRead] = useState(0)
  const [name, setName] = useState('')
  const [fields, setFields] = useState(patternFields())
  const [details, setDetails] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!shown) return undefined
    let alive = true
    call('omni-code-lists', {}).then(
      reply => { if (alive) setView({ lists: Array.isArray(reply?.lists) ? reply.lists : [], codes: Array.isArray(reply?.codes) ? reply.codes : [] }) },
      (error) => { if (alive) setResult({ ok: false, text: hostText(error.message) }) },
    )
    return () => { alive = false }
  }, [shown, read])
  // A list staff name again keeps its pattern: the fields show it, locked, with its details.
  const known = view?.lists.find(list => list.name === name.trim())
  useEffect(() => {
    if (!known) return
    setFields(patternFields(known.pattern))
    setDetails(ruleDetailsText(known.metadata))
  }, [known?.name, read])
  const add = async () => {
    const pattern = patternOf(fields)
    const metadata = parseRuleDetails(details)
    const parsed = parseCodeLines(text)
    const problem = name.trim() === '' ? t('Name the list.') : pattern.problem ?? metadata.problem ?? parsed.problem
    if (problem) { setResult({ ok: false, text: problem }); return }
    setBusy(true); setResult(null)
    try {
      const reply = await call('omni-code-lists-add', { list: name.trim(), pattern: pattern.pattern, metadata: metadata.metadata, entries: parsed.entries })
      setText('')
      const counts = t('Added {added}, updated {updated}.', { added: reply?.added ?? 0, updated: reply?.updated ?? 0 })
      setResult({ ok: true, text: reply?.used ? `${counts} ${t('{n} already used, left as they were.', { n: reply.used })}` : counts })
      setRead(before => before + 1)
    } catch (error) { setResult({ ok: false, text: hostText(error.message) }) } finally { setBusy(false) }
  }
  const label = t('Code lists')
  return h('div', { className: 'ot-codes', role: 'group', 'aria-label': label },
    h('div', { className: 'ot-codes-head' },
      h('span', { className: 'bt-field-label' }, shown && view !== null ? t('Code lists ({n})', { n: view.lists.length }) : label),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': shown, onClick: () => setShown(before => !before) }, shown ? t('Hide') : t('Show'))),
    shown ? h('span', { className: 'bt-note' }, t('A person whose first message carries an open code from a list is let in, once. Each code admits one person.')) : null,
    shown ? h('label', { className: 'ot-answer-label' },
      h('span', { className: 'bt-field-label' }, t('List name')),
      h('input', { className: 'bt-input', type: 'text', value: name, maxLength: 60, list: 'ot-code-list-names', spellCheck: false, autoComplete: 'off', onChange: event => setName(event.target.value) }),
      h('datalist', { id: 'ot-code-list-names' }, (view?.lists ?? []).map(list => h('option', { key: list.name, value: list.name })))) : null,
    shown ? h(PatternFields, { value: fields, onChange: setFields, locked: known !== undefined }) : null,
    shown ? h('div', { className: 'bt-field ot-answer-field' },
      h('label', { className: 'ot-answer-label' },
        h('span', { className: 'bt-field-label' }, t('Rule details')),
        h('textarea', { className: 'bt-input bt-input-area ot-codes-details', value: details, spellCheck: false, autoComplete: 'off', onChange: event => setDetails(event.target.value) })),
      h('span', { className: 'bt-note' }, t('Copied into the allow rule of each person a code from this list admits. One "key = value" a line, or a JSON object.'))) : null,
    shown ? h('div', { className: 'bt-field ot-answer-field' },
      h('label', { className: 'ot-answer-label' },
        h('span', { className: 'bt-field-label' }, t('Codes to add')),
        h('textarea', { className: 'bt-input bt-input-area ot-codes-paste', value: text, spellCheck: false, autoComplete: 'off', onChange: event => setText(event.target.value) })),
      h('span', { className: 'bt-note' }, t('One code a line: code, expires YYYY-MM-DD. Or paste a JSON list.'))) : null,
    shown ? h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || text.trim() === '', onClick: add }, t('Add codes'))) : null,
    shown && result ? h('p', { className: result.ok ? 'ot-picker-note' : 'ot-picker-problem', role: result.ok ? 'status' : 'alert' }, result.text) : null,
    !shown || view === null ? null
      : view.codes.length === 0 ? h('span', { className: 'bt-note' }, t('No codes yet.'))
      : h('div', { className: 'ot-codes-view' },
        h('ul', { className: 'ot-code-lists' }, view.lists.map(list => h('li', { key: list.name, className: 'ot-code-list' },
          h('span', { className: 'ot-code-list-name' }, list.name),
          h('span', { className: 'ot-code-list-count' }, t('{open} open of {count}', { open: list.open, count: list.count })),
          h('span', { className: 'ot-code-list-meta' }, patternSummary(list.pattern)),
          Object.keys(list.metadata ?? {}).length > 0 ? h('span', { className: 'ot-code-list-meta' }, detailsLine(list.metadata)) : null))),
        h('ul', { className: 'ot-code-items' }, view.codes.map(code => h('li', { key: code.code, className: 'ot-code', 'data-state': code.state },
          h('span', { className: 'ot-code-text' }, code.code),
          h('span', { className: 'ot-code-state' }, stateText(code.state)),
          h('span', { className: 'ot-code-meta' }, t('{list} · expires {day}', { list: code.list, day: dayOf(code.expiresAt) })))))))
}

export const CODE_LISTS_CSS = `${CODE_PATTERN_CSS}
.ot-codes{display:grid;gap:6px;min-width:0}
.ot-codes-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.ot-codes .bt-input-area{box-sizing:border-box;width:100%;min-width:0;font-family:var(--bt-mono, ui-monospace, monospace);font-size:12px}
.ot-codes .bt-actions{justify-content:flex-end}
.ot-codes-view{display:grid;gap:6px;min-width:0}
.ot-code-lists,.ot-code-items{display:grid;gap:6px;margin:0;padding:0;list-style:none;min-width:0}
.ot-code-items{max-height:220px;overflow-y:auto}
.ot-code-list,.ot-code{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:1px 8px;min-width:0;padding:6px 8px;border:1px solid var(--bt-line, rgba(127,127,127,.2));border-radius:8px}
.ot-code-list-name{flex:1 0 auto;max-width:100%;overflow-wrap:anywhere;font-size:12px;line-height:17px;font-weight:600;color:var(--bt-ink)}
.ot-code-text{flex:1 0 auto;max-width:100%;overflow-wrap:anywhere;font-family:var(--bt-mono, ui-monospace, monospace);font-size:12px;line-height:17px;color:var(--bt-ink)}
.ot-code-list-count,.ot-code-state{flex:none;font-size:11px;line-height:17px;color:var(--bt-ink-2)}
.ot-code[data-state=open] .ot-code-state{color:var(--bt-ok, #16a34a)}
.ot-code-list-meta,.ot-code-meta{flex-basis:100%;min-width:0;overflow-wrap:anywhere;font-size:12px;line-height:17px;color:var(--bt-ink-3)}
`
