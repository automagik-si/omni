// #1732: the code lists staff upload (answer-codes.js reads codes from messages against them).
// Install-wide, kept in the team's saved state (omniCodeLists): `lists`, each named by staff with
// its code pattern (code-pattern.js) and a free key/value map, and `codes`, the newest
// CODES_MAX of all lists. Each code belongs to one list, is used once, before its expiry, and has
// its own id; an allow rule written from it gets the list's map, the source and that id.
//
// A list's pattern is set when it is first uploaded; a list whose codes all go, goes with them.
// No list, no pattern: nothing in a message is read as a code. Codes never appear in a log or
// warning: every message here names a code by its place.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CodePattern, findCodes, normalizeCode, samePattern } from './code-pattern.js'

export const CODES_MAX = 5_000
export const LISTS_MAX = 50
// At most this many codes are read from one message, over all lists.
export const CODES_PER_MESSAGE = 2
// Omni's own cap on a rule's metadata (routes/v2/access.ts RULE_METADATA_MAX_BYTES).
export const RULE_METADATA_MAX_BYTES = 16 * 1024
export const METADATA_KEYS_MAX = 20
// The keys an allow rule written from a code always has; a list's map cannot set them.
// Reporting counts these rules by metadata.source; keep the value as it is.
export const RULE_SOURCE = 'invite'
export const RESERVED_KEYS = Object.freeze(['source', 'inviteId'])

const Name = z.string().trim().min(1).max(200)
const ListName = z.string().trim().min(1).max(60)
const Metadata = z.record(z.string().trim().min(1).max(64), z.json()).refine(map => Object.keys(map).length <= METADATA_KEYS_MAX, `at most ${METADATA_KEYS_MAX} keys`)
const Entry = z.object({
  code: z.string().max(128),
  expiresAt: z.iso.datetime({ offset: true }),
  inviteId: Name.optional(),
}).strict()
export const Upload = z.object({
  list: ListName,
  pattern: CodePattern,
  // Left out keeps the list's map; given, it is the list's map from now on.
  metadata: Metadata.optional(),
  entries: z.array(z.unknown()).min(1).max(CODES_MAX),
}).strict()
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const bytesOf = value => new TextEncoder().encode(JSON.stringify(value)).length

/** The allow rule's metadata for a code of `list`: the list's map, then the source and the code's id. */
export const ruleMetadataOf = (list, inviteId) => ({ ...list?.metadata, source: RULE_SOURCE, inviteId })

/** The list's state of a code record: `open`, `used` or `expired`. */
export const stateOf = (record, now = Date.now()) => (record.used ? 'used' : Date.parse(record.expiresAt) <= now ? 'expired' : 'open')

export function codeLists(rt) {
  const store = () => {
    const saved = (rt.state.omniCodeLists ??= {})
    saved.lists ??= {}
    saved.codes ??= {}
    return saved
  }

  // Staff's upload: every entry is checked first, so one bad entry changes nothing. An open code
  // already listed (in this list or another) moves here, takes the new expiry and keeps its id
  // unless one is given. A used code is left as it is, so its person's retry still gets the same ok.
  async function add(body) {
    const { list: name, pattern, metadata, entries } = Upload.parse(body ?? {})
    const known = store().lists[name]
    if (known && !samePattern(known.pattern, pattern)) throw refused(`The list "${name}" already has its code pattern; upload these codes to a new list.`)
    if (!known && Object.keys(store().lists).length >= LISTS_MAX) throw refused(`There are already ${LISTS_MAX} code lists.`)
    const reserved = Object.keys(metadata ?? {}).filter(key => RESERVED_KEYS.includes(key))
    if (reserved.length > 0) throw refused(`The rule details cannot set ${reserved.join(' or ')}: the rule gets it from the code.`)
    const map = metadata ?? known?.metadata ?? {}
    const checked = entries.map((raw, index) => {
      const entry = Entry.safeParse(raw)
      const where = `Entry ${index + 1}`
      if (!entry.success) throw refused(`${where}: ${entry.error.issues[0]?.path.join('.') || 'entry'} is not valid (${entry.error.issues[0]?.message ?? 'unreadable'}).`)
      const code = normalizeCode(entry.data.code, pattern)
      if (code === undefined) throw refused(`${where}: the code does not fit the list's pattern.`)
      return { code, expiresAt: entry.data.expiresAt, inviteId: entry.data.inviteId ?? store().codes[code]?.inviteId ?? randomUUID() }
    })
    const longest = checked.reduce((max, record) => Math.max(max, record.inviteId.length), 0)
    if (bytesOf(ruleMetadataOf({ metadata: map }, 'x'.repeat(longest))) > RULE_METADATA_MAX_BYTES) throw refused('The rule details are more than an access rule holds (16 KB).')
    const before = structuredClone(store())
    let added = 0, updated = 0, used = 0
    store().lists[name] = { pattern, metadata: map }
    for (const record of checked) {
      const was = store().codes[record.code]
      if (was?.used) { used += 1; continue }
      if (was) updated += 1
      else added += 1
      // Re-inserted, so it counts as the newest.
      delete store().codes[record.code]
      store().codes[record.code] = { list: name, ...record, addedAt: Date.now() }
    }
    const codes = Object.keys(store().codes)
    for (const code of codes.slice(0, Math.max(0, codes.length - CODES_MAX))) delete store().codes[code]
    const holding = new Set(Object.values(store().codes).map(record => record.list))
    for (const list of Object.keys(store().lists)) if (!holding.has(list)) delete store().lists[list]
    try { await rt.save() } catch (error) {
      rt.state.omniCodeLists = before
      throw error
    }
    return { added, updated, used, count: Object.keys(store().codes).length }
  }

  // Newest first: the lists with their counts, and the codes with each one's state.
  function view(now = Date.now()) {
    const codes = Object.entries(store().codes).reverse().map(([code, record]) => ({
      code, list: record.list, expiresAt: record.expiresAt, inviteId: record.inviteId,
      state: stateOf(record, now), ...(record.used ? { usedAt: record.used.at } : {}),
    }))
    const lists = Object.entries(store().lists).map(([name, list]) => ({
      name, pattern: list.pattern, metadata: list.metadata,
      count: codes.filter(code => code.list === name).length, open: codes.filter(code => code.list === name && code.state === 'open').length,
    }))
    return { lists, codes }
  }

  /**
   * The codes a message's text carries, over every list's pattern, at most CODES_PER_MESSAGE:
   * `{ code, lists }`, where `lists` names the lists whose pattern read it. A code one of those
   * lists holds comes first, then the rest in their order, so ordinary words a pattern with no
   * prefix reads never crowd out the code itself. Each one checked still counts toward the
   * chat's limit (answer-codes.js).
   */
  function candidatesIn(text) {
    const codes = rt.state.omniCodeLists?.codes ?? {}
    const held = ([code, { lists }]) => (lists.has(codes[code]?.list) ? 1 : 0)
    const found = new Map()
    for (const [name, list] of Object.entries(rt.state.omniCodeLists?.lists ?? {})) {
      for (const { at, code } of findCodes(text, list.pattern)) {
        const seen = found.get(code) ?? { at, lists: new Set() }
        seen.at = Math.min(seen.at, at)
        seen.lists.add(name)
        found.set(code, seen)
      }
    }
    return [...found].sort((a, b) => held(b) - held(a) || a[1].at - b[1].at).slice(0, CODES_PER_MESSAGE).map(([code, { lists }]) => ({ code, lists }))
  }

  // One code, for one sender: `{ ok: true, list, inviteId, metadata }`, the rule metadata built
  // from the list as it is now, or `{ ok: false, reason: 'unknown' | 'used' | 'expired' }`. A
  // code counts only in a list whose pattern read it. The same code again from the same sender
  // (any id they share) answers the same ok; from another sender it is `used`. The used mark is
  // saved before ok is answered; a failed save takes it back and throws, so the code stays open.
  async function redeem({ code, lists, sender }) {
    const record = store().codes[code]
    const list = record && lists.has(record.list) ? store().lists[record.list] : undefined
    if (!list) return { ok: false, reason: 'unknown' }
    const ids = [sender.lid, sender.phone].filter(Boolean)
    const ok = () => ({ ok: true, list: record.list, inviteId: record.inviteId, metadata: ruleMetadataOf(list, record.inviteId) })
    if (record.used) {
      const by = [record.used.by?.lid, record.used.by?.phone].filter(Boolean)
      return ids.some(id => by.includes(id)) ? ok() : { ok: false, reason: 'used' }
    }
    if (stateOf(record) === 'expired') return { ok: false, reason: 'expired' }
    // Marked with no wait before it, so a second redeem at once finds it used.
    const used = { by: { ...(sender.lid ? { lid: sender.lid } : {}), ...(sender.phone ? { phone: sender.phone } : {}) }, at: Date.now() }
    record.used = used
    try { await rt.save() } catch (error) {
      if (record.used === used) delete record.used
      throw new Error(`the code list was not saved: ${error?.message ?? error}`)
    }
    return ok()
  }

  return { add, view, candidatesIn, redeem }
}
