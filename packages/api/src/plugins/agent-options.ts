/**
 * Agent reply options → channel buttons (GH #1818).
 *
 * The agent reply contract carries text only, so an option list produced by a
 * flow can only survive as prose ("Escolha uma das opções acima…") while the
 * customer sees no options at all. Until the contract grows a structured field,
 * the dispatcher recognises a marker the agent may put inside its reply:
 *
 *   [[opções: Presencial | EAD | Semipresencial]]      (pt-BR)
 *   [[options: On campus | Online | Blended]]          (en)
 *
 * The marker is removed from the sent text and its items become
 * `content.buttons`, which every channel already maps through the shared
 * planner (`planInteractive`): ≤3 inline buttons, 4-10 a single list.
 *
 * Rules, in order:
 * - a channel that does not declare `canSendButtons` is untouched (`text`
 *   comes back exactly as received);
 * - no marker, an unterminated marker, fewer than 2 items, or a marker that
 *   would leave an empty body ⇒ the text is returned unchanged, never broken;
 * - more than 10 items ⇒ the first 10 become the list and the remainder is
 *   appended to the body as plain lines, so no option is lost;
 * - only the first marker in a reply is consumed.
 *
 * Pure: no I/O, no channel, no logger — the caller owns the send.
 */

import type { OutgoingContent } from '@omni/channel-sdk';

/** `[[opções: …]]` / `[[options: …]]`, case-insensitive, no nested brackets inside. */
const OPTIONS_BLOCK = /\[\[\s*(?:op[cç][õo]es|options)\s*:\s*([^[\]]*?)\s*\]\]/iu;

const MIN_OPTIONS = 2;
const MAX_INLINE_BUTTONS = 3;
const MAX_LIST_ROWS = 10;

/** What the dispatcher sends instead of the raw text. */
export interface AgentOptionsParse {
  /** Text with the marker removed (the input, unchanged, when nothing parsed). */
  text: string;
  /** Inline buttons, when the marker parsed. */
  buttons?: OutgoingContent['buttons'];
  /** List presentation, when the option count makes a list the right shape. */
  list?: OutgoingContent['list'];
}

/** Trim an option and drop a leading list bullet the model may add. */
function cleanOption(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s*/, '')
    .trim();
}

/**
 * Parse an agent reply into text plus (optional) buttons/list.
 *
 * @param text the reply as the model produced it, already sanitized by the caller
 * @param options `buttonsSupported` mirrors the channel's `canSendButtons`
 */
export function extractAgentOptions(
  text: string,
  { buttonsSupported = false }: { buttonsSupported?: boolean } = {},
): AgentOptionsParse {
  const unchanged: AgentOptionsParse = { text };
  if (!buttonsSupported || !text) return unchanged;

  const match = OPTIONS_BLOCK.exec(text);
  if (!match) return unchanged;

  const options = (match[1] ?? '').split('|').map(cleanOption).filter(Boolean);
  if (options.length < MIN_OPTIONS) return unchanged;

  const body = text
    .replace(match[0], '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Meta's interactive body is the message itself: without it the buttons would
  // arrive with nothing to read, so keep the original reply instead.
  if (!body) return unchanged;

  const inline = options.slice(0, MAX_LIST_ROWS);
  const overflow = options.slice(MAX_LIST_ROWS);
  const finalText = overflow.length ? `${body}\n\n${overflow.map((option) => `• ${option}`).join('\n')}` : body;

  return {
    text: finalText,
    buttons: inline.map((option) => ({ text: option })),
    // Above the inline limit the planner already chooses a list; asking for one
    // keeps the intent explicit if that threshold ever moves.
    ...(options.length > MAX_INLINE_BUTTONS ? { list: { forceList: true } } : {}),
  };
}
