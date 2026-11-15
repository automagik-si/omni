// #1731: the bot's waitlist site (host answer-waitlist.js), in the answer settings: its URL and
// its secret. The secret is written only: the field starts empty every time and the section
// says only whether one is set. The setting comes with the answer settings view
// (`waitlist: { url, secretSet }`), so opening the settings reads nothing more.
import { createElement as h, useEffect, useState } from 'react'
import { call, hostText, t } from './core.js'

export function WaitlistConfirm({ botId, value }) {
  const [url, setUrl] = useState(value?.url ?? '')
  const [secretSet, setSecretSet] = useState(value?.secretSet === true)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => { setUrl(value?.url ?? ''); setSecretSet(value?.secretSet === true) }, [value?.url, value?.secretSet])
  const send = async (body, done) => {
    setBusy(true); setResult(null)
    try {
      const reply = await call('omni-waitlist-confirm', { botId, ...body })
      setUrl(reply?.url ?? ''); setSecretSet(reply?.secretSet === true); setSecret('')
      setResult({ ok: true, text: t(done) })
    } catch (error) { setResult({ ok: false, text: hostText(error.message) }) } finally { setBusy(false) }
  }
  const changed = url.trim() !== (value?.url ?? '') || secret !== ''
  const save = () => send({ url: url.trim() || null, ...(secret === '' ? {} : { secret }) }, 'Saved.')
  const clear = () => send({ secret: null }, 'Secret cleared.')
  return h('div', { className: 'ot-waitlist', role: 'group', 'aria-label': t('Waitlist confirmation') },
    h('span', { className: 'bt-field-label' }, t('Waitlist confirmation')),
    h('p', { className: 'bt-note' }, t('A code in the message of someone not let in is checked with this site, and the site\'s reply is sent to them. On only when the URL and the secret are both set.')),
    h('label', { className: 'ot-answer-label' },
      h('span', { className: 'bt-field-label' }, t('Site URL')),
      h('input', { className: 'bt-input ot-waitlist-url', type: 'url', value: url, title: url || undefined, placeholder: 'https://…', spellCheck: false, autoComplete: 'off', onChange: event => setUrl(event.target.value) })),
    h('label', { className: 'ot-answer-label' },
      h('span', { className: 'ot-waitlist-secret-head' },
        h('span', { className: 'bt-field-label' }, t('Secret')),
        h('span', { className: 'ot-picker-tag ot-waitlist-state', 'data-set': secretSet }, secretSet ? t('Set') : t('Not set'))),
      h('input', {
        className: 'bt-input ot-waitlist-secret', type: 'password', value: secret, spellCheck: false, autoComplete: 'new-password',
        placeholder: secretSet ? t('Type to replace') : '', onChange: event => setSecret(event.target.value),
      })),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !secretSet, onClick: clear }, t('Clear')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !changed, onClick: save }, t('Save'))),
    result ? h('p', { className: result.ok ? 'ot-picker-note' : 'ot-picker-problem', role: result.ok ? 'status' : 'alert' }, result.text) : null)
}

export const WAITLIST_CONFIRM_CSS = `
.ot-waitlist{display:grid;gap:6px;min-width:0}
.ot-waitlist .ot-waitlist-url,.ot-waitlist .ot-waitlist-secret{box-sizing:border-box;width:100%;min-width:0}
.ot-waitlist-secret-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.ot-waitlist-state[data-set=true]{color:var(--bt-ok, #16a34a)}
.ot-waitlist .bt-actions{justify-content:flex-end}
`
