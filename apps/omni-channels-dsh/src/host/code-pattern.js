// #1732: a code pattern, the shape staff give the codes a message may carry, so a feature that
// reads codes from text is off until staff set one. It is { prefix?, characters, length,
// lookAlikes? }: an optional prefix, the letters and digits allowed after it, and how many of
// them. Case never matters. With lookAlikes on, a character outside the set that looks like one
// inside it (O and 0; I, L and 1) is read as that one, after the prefix only, never in it.
//
// No regular expression is built from what staff type: a scanner reads the text once. A code
// stands alone: the character before it and the one after are not letters, digits or "_", so a
// longer run of the same characters is never a code. Codes come back as the pattern normalises
// them: upper case, the look-alikes read as their twins.
import { z } from 'zod'

export const PREFIX_MAX = 16
export const CHARACTERS_MAX = 36
export const LENGTH_MIN = 4
export const LENGTH_MAX = 64
// The look-alike groups: a character outside the set is read as the one member of its group
// inside the set, when there is exactly one.
const LOOK_ALIKES = ['O0', 'IL1']

const isWord = ch => ch !== undefined && /[0-9A-Z_]/.test(ch)
const isAlnum = ch => /[0-9A-Z]/.test(ch)

export const CodePattern = z.object({
  prefix: z.string().trim().max(PREFIX_MAX).regex(/^[\x21-\x7e]*$/, 'the prefix is letters, digits or symbols, with no spaces').optional(),
  characters: z.string().trim().min(2).max(CHARACTERS_MAX * 2).regex(/^[0-9A-Za-z]+$/, 'the characters are letters and digits'),
  length: z.number().int().min(LENGTH_MIN).max(LENGTH_MAX),
  lookAlikes: z.boolean().optional(),
}).strict().transform(({ prefix, characters, length, lookAlikes }) => ({
  ...(prefix ? { prefix: prefix.toUpperCase() } : {}),
  characters: [...new Set(characters.toUpperCase())].join(''),
  length,
  ...(lookAlikes === true ? { lookAlikes: true } : {}),
})).refine(pattern => pattern.characters.length >= 2 && pattern.characters.length <= CHARACTERS_MAX, { message: `the characters are 2 to ${CHARACTERS_MAX} different letters or digits`, path: ['characters'] })

/** True when two normalised patterns read the same codes. */
export const samePattern = (a, b) => (a?.prefix ?? '') === (b?.prefix ?? '') && a?.characters === b?.characters && a?.length === b?.length && (a?.lookAlikes === true) === (b?.lookAlikes === true)

// The part after the prefix, with look-alikes read as their twins when the pattern says so;
// undefined when a character is still outside the set.
function tailOf(loose, pattern) {
  let tail = ''
  for (const ch of loose) {
    let read = ch
    if (!pattern.characters.includes(ch) && pattern.lookAlikes === true) {
      const twins = [...(LOOK_ALIKES.find(group => group.includes(ch)) ?? '')].filter(other => pattern.characters.includes(other))
      if (twins.length === 1) read = twins[0]
    }
    if (!pattern.characters.includes(read)) return undefined
    tail += read
  }
  return tail
}

// The code that starts at `at` of the upper-cased text, or undefined.
function codeAt(text, at, pattern) {
  const prefix = pattern.prefix ?? ''
  const end = at + prefix.length + pattern.length
  if (end > text.length || isWord(text[at - 1]) || isWord(text[end])) return undefined
  if (!text.startsWith(prefix, at)) return undefined
  const loose = text.slice(at + prefix.length, end)
  if (![...loose].every(isAlnum)) return undefined
  const tail = tailOf(loose, pattern)
  return tail === undefined ? undefined : `${prefix}${tail}`
}

/**
 * The codes of `pattern` in `text`, as `{ at, code }` in their order, each code once. `at` is
 * the place in the upper-cased text, so codes of several patterns in one text can be ordered.
 */
export function findCodes(text, pattern) {
  if (typeof text !== 'string' || text === '' || !pattern) return []
  const upper = text.toUpperCase()
  const found = [], seen = new Set()
  const push = (at) => {
    const code = codeAt(upper, at, pattern)
    if (code !== undefined && !seen.has(code)) { seen.add(code); found.push({ at, code }) }
  }
  if (pattern.prefix) {
    for (let at = upper.indexOf(pattern.prefix); at !== -1; at = upper.indexOf(pattern.prefix, at + 1)) push(at)
  } else {
    // With no prefix, a code is a whole run of word characters of the pattern's length.
    for (const run of upper.matchAll(/[0-9A-Z_]+/g)) if (run[0].length === pattern.length) push(run.index)
  }
  return found
}

/** The codes of `pattern` in `text`, normalised, in their order, at most `max`. */
export const codesIn = (text, pattern, max = Infinity) => findCodes(text, pattern).slice(0, max).map(found => found.code)

/** The code `value` stands for under `pattern`, normalised, or undefined when it is none. */
export function normalizeCode(value, pattern) {
  if (typeof value !== 'string' || !pattern) return undefined
  const upper = value.trim().toUpperCase()
  return upper.length === (pattern.prefix ?? '').length + pattern.length ? codeAt(upper, 0, pattern) : undefined
}
