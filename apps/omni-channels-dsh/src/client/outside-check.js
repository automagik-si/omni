// #1742: the bot's outside code check (host answer-outside-check.js), in the answer settings: the
// service's HTTPS address, its secret, the code pattern (code-pattern.js), and the optional label,
// tier and refusal texts. The secret is written only: the field starts empty every time and the
// section says only whether one is set. The setting comes with the answer settings view
// (`outsideCheck`), so opening the settings reads nothing more.
import { createElement as h, useEffect, useState } from 'react'
import { call, hostText, t } from './core.js'
import { PatternFields, patternFields, patternOf } from './code-pattern.js'

/**
 * The refusal texts staff typed: one `status = text` a line, for a 4xx status. `{ refusalTexts }`,
 * or `{ problem }`. Empty is none.
 */
export function parseRefusalTexts(text) {
  const refusalTexts = {}
  for (const [index, line] of String(text ?? '').split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const match = /^\s*(4\d\d)\s*=\s*(\S.*?)\s*$/.exec(line)
    if (!match) return { problem: t('Refusal texts line {n}: write a 4xx status = text.', { n: index + 1 }) }
    refusalTexts[match[1]] = match[2]
  }
  return { refusalTexts }
}
/** The refusal texts as staff type them. */
export const refusalTextsText = (texts = {}) => Object.entries(texts).map(([status, text]) => `${status} = ${text}`).join('\n')

const emptyPattern = fields => fields.prefix.trim() === '' && fields.characters.trim() === '' && fields.length === ''
const fieldsOf = value => ({
  url: value?.url ?? '', pattern: patternFields(value?.pattern), label: value?.label ?? '', tier: value?.tier ?? '',
  texts: refusalTextsText(value?.refusalTexts ?? {}),
})

export function OutsideCheck({ botId, value }) {
  const [fields, setFields] = useState(fieldsOf(value))
  const [secretSet, setSecretSet] = useState(value?.secretSet === true)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const shown = JSON.stringify(fieldsOf(value))
  useEffect(() => { setFields(fieldsOf(value)); setSecretSet(value?.secretSet === true) }, [shown, value?.secretSet])
  const set = (key, next) => setFields(before => ({ ...before, [key]: next }))
  const send = async (body, done) => {
    setBusy(true); setResult(null)
    try {
      const reply = await call('omni-outside-check', { botId, ...body })
      setFields(fieldsOf(reply)); setSecretSet(reply?.secretSet === true); setSecret('')
      setResult({ ok: true, text: done })
    } catch (error) { setResult({ ok: false, text: hostText(error.message) }) } finally { setBusy(false) }
  }
  const changed = JSON.stringify(fields) !== shown || secret !== ''
  const save = () => {
    const pattern = emptyPattern(fields.pattern) ? { pattern: null } : patternOf(fields.pattern)
    const texts = parseRefusalTexts(fields.texts)
    const problem = pattern.problem ?? texts.problem
    if (problem) { setResult({ ok: false, text: problem }); return }
    send({
      url: fields.url.trim() || null, pattern: pattern.pattern, label: fields.label.trim() || null, tier: fields.tier.trim() || null,
      refusalTexts: texts.refusalTexts, ...(secret === '' ? {} : { secret }),
    }, t('Saved.'))
  }
  const clear = () => send({ secret: null }, t('The secret is cleared.'))
  const label = t('Outside code check')
  return h('div', { className: 'ot-outside', role: 'group', 'aria-label': label },
    h('span', { className: 'bt-field-label' }, label),
    h('p', { className: 'bt-note' }, t('A code of this pattern in the message of someone not let in is sent to this HTTPS address, and its reply goes to them. On only when the address, the secret and the pattern are all set.')),
    h('label', { className: 'ot-answer-label' },
      h('span', { className: 'bt-field-label' }, t('Check URL')),
      h('input', { className: 'bt-input ot-outside-url', type: 'url', value: fields.url, title: fields.url || undefined, spellCheck: false, autoComplete: 'off', onChange: event => set('url', event.target.value) })),
    h('label', { className: 'ot-answer-label' },
      h('span', { className: 'ot-outside-secret-head' },
        h('span', { className: 'bt-field-label' }, t('Secret')),
        h('span', { className: 'ot-picker-tag ot-outside-state', 'data-set': secretSet }, secretSet ? t('Set') : t('Not set'))),
      h('input', {
        className: 'bt-input ot-outside-secret', type: 'password', value: secret, spellCheck: false, autoComplete: 'new-password',
        placeholder: secretSet ? t('Type a new one to replace it') : '', onChange: event => setSecret(event.target.value),
      })),
    h(PatternFields, { value: fields.pattern, onChange: next => set('pattern', next) }),
    h('div', { className: 'bt-field ot-answer-field' },
      h('label', { className: 'ot-answer-label' },
        h('span', { className: 'bt-field-label' }, t('Label on a confirmed row')),
        h('input', { className: 'bt-input ot-outside-label', type: 'text', value: fields.label, maxLength: 60, onChange: event => set('label', event.target.value) })),
      h('span', { className: 'bt-note' }, t('Staff see it on a request row the service confirmed. Empty: no label.'))),
    h('div', { className: 'bt-field ot-answer-field' },
      h('label', { className: 'ot-answer-label' },
        h('span', { className: 'bt-field-label' }, t('Tier name')),
        h('input', { className: 'bt-input ot-outside-tier', type: 'text', value: fields.tier, maxLength: 60, onChange: event => set('tier', event.target.value) })),
      h('span', { className: 'bt-note' }, t('Written on a request row the service confirmed. Empty: none.'))),
    h('div', { className: 'bt-field ot-answer-field' },
      h('label', { className: 'ot-answer-label' },
        h('span', { className: 'bt-field-label' }, t('Texts on refusal')),
        h('textarea', { className: 'bt-input bt-input-area ot-outside-texts', value: fields.texts, onChange: event => set('texts', event.target.value) })),
      h('span', { className: 'bt-note' }, t('One "status = text" a line, for the service\'s 4xx answers; the person gets that text. Empty: nothing is sent.'))),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !secretSet, onClick: clear }, t('Clear')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !changed, onClick: save }, t('Save'))),
    result ? h('p', { className: result.ok ? 'ot-picker-note' : 'ot-picker-problem', role: result.ok ? 'status' : 'alert' }, result.text) : null)
}

export const OUTSIDE_CHECK_CSS = `
.ot-outside{display:grid;gap:6px;min-width:0}
.ot-outside .bt-input{box-sizing:border-box;width:100%;min-width:0}
.ot-outside-secret-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.ot-outside-state[data-set=true]{color:var(--bt-ok, #16a34a)}
.ot-outside .bt-actions{justify-content:flex-end}
`
