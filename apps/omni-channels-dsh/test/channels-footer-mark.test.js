// The Channels control in the footer (#1793): the owner asked for the Omni mark there instead of
// the connected channels' logos ("turn channels icon into omni icon"). A regression here would put
// the channel tiles back, so this test pins the mark, the class and the CSS.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleClient, mount, nodes, react } from './client-stand-in.js'
import { omni } from './omni-client.js'

// The team's OmniMark, counted: the control must draw it (at 16) and nothing else where the
// channel logos used to be.
const seen = []
const team = { omni: { ...omni, ui: { ...omni.ui, OmniMark: props => { seen.push(props); return null } } } }
const ui = await bundleClient([
  "export { ChannelsFooter, CHANNELS_CSS } from './channels.js'",
], {
  globals: { console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, document: { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} } },
  team,
})

test('the Channels control draws the Omni mark, not the channels logos', () => {
  // Effects off: the footer subscribes to the live store on mount, which is not this test's subject.
  const view = mount(() => react.createElement(ui.ChannelsFooter, { wide: true, actions: { selectPanel() {} } }), { effects: false })
  try {
    const all = nodes(view.draw())
    const button = all.find(node => node.type === 'button' && String(node.props?.className ?? '').includes('bt-channels-foot'))
    assert.ok(button, 'the footer control draws its button')
    assert.equal(seen.length, 1, 'the button draws one mark')
    assert.equal(Number(seen[0].size), 16, 'at the size the bar uses for a control icon')
    assert.equal(nodes(button).some(node => String(node.props?.className ?? '') === 'bt-channels-mark'), true, 'in the mark slot the app styles')
    // The old shape: the connected channels as overlapping tiles. It must not come back.
    const inside = nodes(button)
    assert.equal(inside.some(node => String(node.props?.className ?? '').includes('bt-channels-tiles')), false, 'no tile stack in the control')
    assert.equal(inside.some(node => String(node.props?.className ?? '').includes('oc-tile')), false, 'no channel tile in the control')
    assert.equal(/bt-channels-tiles/.test(ui.CHANNELS_CSS), false, 'the tile stack CSS is gone')
    assert.match(ui.CHANNELS_CSS, /\.bt-channels-mark\{/)
  } finally {
    view.unmount()
  }
})
