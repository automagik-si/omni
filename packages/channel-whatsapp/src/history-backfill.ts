import { type HistorySyncMutation, HistorySyncMutationSchema } from '@omni/channel-sdk';
import type { WAMessage } from 'baileys';
import { unwrapEnvelopes } from './utils/message';

/** Extract only state mutations. They never become HistorySyncMessage rows. */
export function extractHistoryMutation(msg: WAMessage, at: Date, actor: string): HistorySyncMutation | null {
  if (!msg.message) return null;
  const content = unwrapEnvelopes(msg.message);
  const operationTimestamp = Number(content.reactionMessage?.senderTimestampMs ?? content.protocolMessage?.timestampMs);
  const operationAt = Number.isFinite(operationTimestamp) && operationTimestamp > 0 ? new Date(operationTimestamp) : at;
  const base = { id: msg.key.id, chatId: msg.key.remoteJid, at: operationAt, actor };
  const reaction = content.reactionMessage;
  if (reaction) {
    const parsed = HistorySyncMutationSchema.safeParse({
      ...base,
      kind: 'reaction',
      targetExternalId: reaction.key?.id,
      emoji: reaction.text ?? '',
    });
    return parsed.success ? parsed.data : null;
  }
  const protocol = content.protocolMessage;
  if (!protocol) return null;
  if (protocol.type === 0) {
    const parsed = HistorySyncMutationSchema.safeParse({
      ...base,
      kind: 'deletion',
      targetExternalId: protocol.key?.id,
    });
    return parsed.success ? parsed.data : null;
  }
  if (protocol.type !== 14 && !protocol.editedMessage) return null;
  const edited = protocol.editedMessage ? unwrapEnvelopes(protocol.editedMessage) : undefined;
  const text =
    edited?.conversation ??
    edited?.extendedTextMessage?.text ??
    edited?.imageMessage?.caption ??
    edited?.videoMessage?.caption ??
    edited?.documentMessage?.caption;
  const parsed = HistorySyncMutationSchema.safeParse({
    ...base,
    kind: 'edit',
    targetExternalId: protocol.key?.id,
    text,
  });
  return parsed.success ? parsed.data : null;
}

/** Round driver for explicit chat backfills; passive and legacy sync paths do not use it. */
export interface BackfillAnchor {
  chatJid: string;
  messageKey: { remoteJid: string; id: string; fromMe: boolean };
  timestamp: number;
}

export interface BackfillRoundTracker {
  received: number;
  oldest?: BackfillAnchor;
  lastActivity: number;
}

async function drainBackfillRound(
  drain: () => Promise<void>,
  shouldCancel: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let settled = false;
  const pending = drain();
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    if (await shouldCancel()) return false;
    await sleep(250);
  }
  await pending;
  return !(await shouldCancel());
}

export async function fetchChatBackfillRounds(options: {
  anchor: BackfillAnchor;
  since: Date;
  request: (anchor: BackfillAnchor) => Promise<void>;
  tracker: BackfillRoundTracker;
  drain: () => Promise<void>;
  shouldCancel: () => Promise<boolean>;
  onRound: (round: { round: number; received: number; oldestReached: string | null }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  quietMs?: number;
  maxWaitMs?: number;
}): Promise<void> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let anchor = options.anchor;
  for (let round = 1; round <= 50; round++) {
    if (await options.shouldCancel()) return;
    options.tracker.received = 0;
    options.tracker.oldest = undefined;
    options.tracker.lastActivity = now();
    await options.request(anchor);
    const started = now();
    while (
      now() - options.tracker.lastActivity < (options.quietMs ?? 15_000) &&
      now() - started < (options.maxWaitMs ?? 120_000)
    ) {
      if (await options.shouldCancel()) return;
      await sleep(250);
    }
    if (!(await drainBackfillRound(options.drain, options.shouldCancel, sleep))) return;
    const oldest: BackfillAnchor | undefined = (options.tracker as BackfillRoundTracker).oldest;
    await options.onRound({
      round,
      received: options.tracker.received,
      oldestReached: oldest ? new Date(oldest.timestamp).toISOString() : null,
    });
    if (!oldest || oldest.timestamp >= anchor.timestamp || oldest.timestamp <= options.since.getTime()) return;
    anchor = oldest;
  }
}
