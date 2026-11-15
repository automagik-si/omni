// #1732: a code pattern as staff type it (host code-pattern.js reads codes by it): an optional
// prefix, the letters and digits a code may have after it, how many, and whether look-alike
// characters read as one. One set of fields for every feature that reads codes from messages.
import { createElement as h } from 'react'
import { t } from './core.js'

// The host's LENGTH_MIN and LENGTH_MAX (src/host/code-pattern.js).
export const PATTERN_LENGTH_MIN = 4
export const PATTERN_LENGTH_MAX = 64

/** The fields for a pattern the host keeps, or empty ones. */
export const patternFields = pattern => ({
  prefix: pattern?.prefix ?? '', characters: pattern?.characters ?? '',
  length: Number.isInteger(pattern?.length) ? String(pattern.length) : '', lookAlikes: pattern?.lookAlikes === true,
})

/** The pattern the fields stand for, as the host takes it: `{ pattern }` or `{ problem }`. */
export function patternOf(fields) {
  const characters = fields.characters.trim()
  const length = Number(fields.length)
  if (!/^[0-9A-Za-z]{2,}$/.test(characters)) return { problem: t('Type the characters a code may have: letters and digits.') }
  if (fields.length === '' || !Number.isInteger(length) || length < PATTERN_LENGTH_MIN || length > PATTERN_LENGTH_MAX) {
    return { problem: t('The length is a whole number from {min} to {max}.', { min: PATTERN_LENGTH_MIN, max: PATTERN_LENGTH_MAX }) }
  }
  const prefix = fields.prefix.trim()
  return { pattern: { ...(prefix ? { prefix } : {}), characters, length, ...(fields.lookAlikes ? { lookAlikes: true } : {}) } }
}

/** A pattern in a few words. */
export function patternSummary(pattern) {
  const shape = pattern.prefix
    ? t('{prefix} then {length} of {characters}', { prefix: pattern.prefix, length: pattern.length, characters: pattern.characters })
    : t('{length} of {characters}', { length: pattern.length, characters: pattern.characters })
  return pattern.lookAlikes ? `${shape} · ${t('look-alikes read as one')}` : shape
}

/** The fields; `locked` shows a pattern that can no longer change. */
export function PatternFields({ value, onChange, locked = false }) {
  const set = (key, next) => onChange({ ...value, [key]: next })
  const lookAlikes = t('Read look-alike characters as one (O and 0; I, L and 1)')
  return h('fieldset', { className: 'ot-pattern', disabled: locked, 'aria-label': t('Code pattern') },
    h('div', { className: 'ot-pattern-row' },
      h('label', { className: 'ot-answer-label ot-pattern-prefix' },
        h('span', { className: 'bt-field-label' }, t('Prefix (optional)')),
        h('input', { className: 'bt-input', type: 'text', value: value.prefix, maxLength: 16, spellCheck: false, autoComplete: 'off', onChange: event => set('prefix', event.target.value) })),
      h('label', { className: 'ot-answer-label ot-pattern-length' },
        h('span', { className: 'bt-field-label' }, t('Length')),
        h('input', { className: 'bt-input', type: 'number', min: PATTERN_LENGTH_MIN, max: PATTERN_LENGTH_MAX, step: 1, inputMode: 'numeric', value: value.length, onChange: event => set('length', event.target.value) }))),
    h('label', { className: 'ot-answer-label' },
      h('span', { className: 'bt-field-label' }, t('Characters after the prefix')),
      h('input', { className: 'bt-input ot-pattern-characters', type: 'text', value: value.characters, maxLength: 72, spellCheck: false, autoComplete: 'off', onChange: event => set('characters', event.target.value) })),
    // The Bot team's switch, as the answer settings draw it.
    h('div', { className: 'ot-answer-switch' },
      h('span', null, lookAlikes),
      h('button', { type: 'button', role: 'switch', className: 'bt-switch', disabled: locked, 'aria-checked': value.lookAlikes, 'aria-label': lookAlikes, onClick: () => set('lookAlikes', !value.lookAlikes) },
        h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))),
    h('span', { className: 'bt-note' }, locked ? t('This list\'s pattern is set; new codes must fit it.') : t('Case never matters. A code stands alone in the message, not inside a longer word or number.')))
}

export const CODE_PATTERN_CSS = `
.ot-pattern{display:grid;gap:6px;min-width:0;margin:0;padding:0;border:0}
.ot-pattern-row{display:flex;flex-wrap:wrap;gap:6px 8px;min-width:0}
.ot-pattern-prefix{flex:1 1 96px;min-width:0}
.ot-pattern-length{flex:0 0 72px;min-width:0}
.ot-pattern .bt-input{box-sizing:border-box;width:100%;min-width:0}
.ot-pattern-characters{font-family:var(--bt-mono, ui-monospace, monospace);font-size:12px}
.ot-pattern:disabled .bt-input{opacity:.7}
`
