// The Channels control in the footer (#1793): the owner chose the brand's Omni mark — the tentacle
// vortex — for it, and his word was "sim!". The triskle is Automagik's alone (brand rule 1) and a pet
// is never a mark (rule 3), so this pins the vortex and refuses both the old channel logos and the
// triskle coming back through the team's OmniMark.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleClient, mount, nodes, react } from './client-stand-in.js'
import { omni } from './omni-client.js'

// The team's OmniMark draws the triskle; if the control draws it, this records it.
const trisklе = []
const team = { omni: { ...omni, ui: { ...omni.ui, OmniMark: props => { trisklе.push(props); return react.createElement('svg', {}, []) } } } }
const ui = await bundleClient([
  "export { ChannelsFooter, CHANNELS_CSS } from './channels.js'",
], {
  globals: { console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, document: { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} } },
  team,
})

test('the Channels control draws the brand vortex, never the triskle or the channel logos', () => {
  // Effects off: the footer subscribes to the live store on mount, which is not this test's subject.
  const view = mount(() => react.createElement(ui.ChannelsFooter, { wide: true, actions: { selectPanel() {} } }), { effects: false })
  try {
    const all = nodes(view.draw())
    const button = all.find(node => node.type === 'button' && String(node.props?.className ?? '').includes('bt-channels-foot'))
    assert.ok(button, 'the footer control draws its button')
    // The triskle (the team's OmniMark) must not appear in this control.
    assert.equal(trisklе.length, 0, 'the control does not draw the team OmniMark (the triskle)')
    const inside = nodes(button)
    // The old shape: the connected channels as overlapping tiles.
    assert.equal(inside.some(node => String(node.props?.className ?? '').includes('bt-channels-tiles')), false, 'no tile stack in the control')
    assert.equal(inside.some(node => String(node.props?.className ?? '').includes('oc-tile')), false, 'no channel tile in the control')
    // The mark slot carries the two official drawings, one per ground.
    const slot = inside.find(node => String(node.props?.className ?? '') === 'bt-channels-mark')
    assert.ok(slot, 'the button draws the mark slot the app styles')
    const images = nodes(slot).filter(node => node.type === 'img')
    assert.equal(images.length, 2, 'the ink and the cream drawing')
    const src = image => String(image.props?.src ?? '')
    assert.equal(images.some(image => src(image).startsWith('data:image/svg+xml')), true, 'both are the brand files, inlined')
    assert.deepEqual(images.map(image => String(image.props?.className)).sort(), ['oc-vortex oc-vortex-cream', 'oc-vortex oc-vortex-ink'])
    assert.equal(images.every(image => image.props?.width === 24 && image.props?.height === 24), true, 'the 32px drawing, drawn at 24px')
    // And the stylesheet switches them by ground, at that size, over the control's own row height.
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-mark[^}]*width:24px;height:24px/)
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-mark \.oc-vortex\{display:block;width:24px;height:24px\}/)
    assert.match(ui.CHANNELS_CSS, /body\[data-ds-dark-theme\] \.bt-channels-mark \.oc-vortex-cream\{display:block\}/)
    // A flex row as wide as its cell (a button does not stretch on its own), so the count sits at the right;
    // the mark's centre 18px in and the label 46px in: the centre of the Account row's icon, below, and the start
    // of its name.
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-foot\{display:flex;align-items:center;box-sizing:border-box;width:100%;min-height:36px;gap:16px\}/)
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-foot\{[^}]*padding:0 12px 0 6px\}/)
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-count\{margin-left:auto/)
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-foot \.oc-warn-dot\{margin-left:auto\}/)
    assert.equal(/bt-channels-tiles/.test(ui.CHANNELS_CSS), false, 'the tile stack CSS is gone')
  } finally {
    view.unmount()
  }
})
