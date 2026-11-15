// #1732: the code pattern staff set (src/host/code-pattern.js), shared by every feature that reads
// codes from a message. Made-up patterns only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodePattern, codesIn, findCodes, normalizeCode, samePattern } from '../src/host/code-pattern.js'

const DIGITS = CodePattern.parse({ prefix: 'ZZ-', characters: '0123456789', length: 6 })
const TWINS = CodePattern.parse({ prefix: 'zz-', characters: '0123456789', length: 6, lookAlikes: true })
const BARE = CodePattern.parse({ characters: 'ABCDEFGHJK', length: 5 })

test('code pattern: staff type a prefix, the characters and a length; case is ignored and no free expression is taken', () => {
  assert.deepEqual(TWINS, { prefix: 'ZZ-', characters: '0123456789', length: 6, lookAlikes: true })
  // The characters are kept once each, upper case; an empty prefix is none; look-alikes off is left out.
  assert.deepEqual(CodePattern.parse({ prefix: '  ', characters: 'abcABCd1', length: 4, lookAlikes: false }), { characters: 'ABCD1', length: 4 })
  for (const bad of [
    { characters: '[0-9]+', length: 6 },
    { characters: 'A', length: 6 },
    { characters: 'aA', length: 6 },
    { characters: '0123456789', length: 3 },
    { characters: '0123456789', length: 65 },
    { characters: '0123456789', length: 6.5 },
    { prefix: 'Z Z', characters: '0123456789', length: 6 },
    { prefix: 'Z'.repeat(17), characters: '0123456789', length: 6 },
    { characters: '0123456789', length: 6, regex: '.*' },
    {},
  ]) assert.equal(CodePattern.safeParse(bad).success, false, JSON.stringify(bad))
  assert.equal(samePattern(DIGITS, CodePattern.parse({ prefix: 'zz-', characters: '9876543210', length: 6 })), false)
  assert.equal(samePattern(DIGITS, CodePattern.parse({ prefix: 'zz-', characters: '01234567890', length: 6 })), true)
  assert.equal(samePattern(DIGITS, TWINS), false)
})

test('code pattern: the prefix is optional; without one a code is a whole word of the length', () => {
  assert.deepEqual(codesIn('my code is bcdea, thanks', BARE), ['BCDEA'])
  // Longer or shorter runs, and runs with other characters, are no code.
  assert.deepEqual(codesIn('ABCDEF ABCD ABCDX AB_CD XABCDE', BARE), [])
  assert.deepEqual(codesIn('ZZ-123456', BARE), [])
})

test('code pattern: the length and the characters are enforced, and a code stands alone', () => {
  assert.deepEqual(codesIn('ZZ-123456', DIGITS), ['ZZ-123456'])
  for (const text of ['ZZ-12345', 'ZZ-1234567', 'ZZ-12345A', 'XZZ-123456', 'ZZ-123456X', 'ZZ_123456', '_ZZ-123456', 'ZZ123456', 'ZZ-123456_'])
    assert.deepEqual(codesIn(text, DIGITS), [], text)
  // Punctuation and other scripts around a code are no letters or digits.
  assert.deepEqual(codesIn('(ZZ-123456). ¿zz-654321?', DIGITS), ['ZZ-123456', 'ZZ-654321'])
  // Ordinary words, order numbers and phones never trigger.
  assert.deepEqual(codesIn('Order 123456 and #A1B2C3, call 5500000000001, ref ZZ-1234, see zz-tops', DIGITS), [])
})

test('code pattern: case is ignored; look-alikes are read as one only when the pattern says so, and never in the prefix', () => {
  assert.deepEqual(codesIn('hi zz-12345o', DIGITS), [])
  assert.deepEqual(codesIn('hi zz-12345o', TWINS), ['ZZ-123450'])
  assert.deepEqual(codesIn('ZZ-IL0O12', TWINS), ['ZZ-110012'])
  // A character with no twin in the set stays outside it; the prefix is read as typed.
  assert.deepEqual(codesIn('ZZ-12345U Z2-123456 22-123456', TWINS), [])
  // A twin inside the set is read as itself.
  const letters = CodePattern.parse({ characters: 'ABCDOI', length: 4, lookAlikes: true })
  assert.deepEqual(codesIn('ab01 abcd', letters), ['ABOI', 'ABCD'])
  assert.equal(normalizeCode(' zz-12345o ', TWINS), 'ZZ-123450')
  assert.equal(normalizeCode('zz-12345o', DIGITS), undefined)
  assert.equal(normalizeCode('ZZ-12345', DIGITS), undefined)
  assert.equal(normalizeCode('ZZ-123456 ZZ-123456', DIGITS), undefined)
})

test('code pattern: codes come back once each, in their order, as many as asked', () => {
  assert.deepEqual(codesIn('ZZ-222222 zz-111111 ZZ-222222 ZZ-333333', DIGITS, 2), ['ZZ-222222', 'ZZ-111111'])
  assert.deepEqual(findCodes('a ZZ-111111 b', DIGITS), [{ at: 2, code: 'ZZ-111111' }])
  assert.deepEqual([codesIn(undefined, DIGITS), codesIn('', DIGITS), codesIn('ZZ-123456', undefined)], [[], [], []])
})
