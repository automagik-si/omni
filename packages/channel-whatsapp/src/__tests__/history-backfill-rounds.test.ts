import { describe, expect, test } from 'bun:test';
import type { WAMessage } from 'baileys';
import { extractHistoryMutation } from '../history-backfill';
import { type BackfillAnchor, type BackfillRoundTracker, fetchChatBackfillRounds } from '../history-backfill';

const anchor: BackfillAnchor = {
  chatJid: 'chat',
  messageKey: { remoteJid: 'chat', id: 'a', fromMe: false },
  timestamp: 100_000,
};
function setup() {
  let time = 0;
  const tracker: BackfillRoundTracker = { received: 0, lastActivity: 0 };
  return {
    anchor,
    tracker,
    since: new Date(10_000),
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    quietMs: 500,
    maxWaitMs: 2000,
    shouldCancel: async () => false,
    drain: async () => {},
  };
}

describe('chat backfill round driver', () => {
  test('awaits storage and reports every round before requesting the next', async () => {
    const options = setup();
    const sequence: string[] = [];
    await fetchChatBackfillRounds({
      ...options,
      request: async (next) => {
        sequence.push('request');
        options.tracker.received = 1;
        options.tracker.oldest = { ...next, timestamp: next.timestamp - 50_000 };
      },
      drain: async () => {
        sequence.push('stored');
      },
      onRound: async () => {
        sequence.push('progress');
      },
    });
    expect(sequence).toEqual(['request', 'stored', 'progress', 'request', 'stored', 'progress']);
  });

  test('cancel during a round stops before another request', async () => {
    const options = setup();
    let cancel = false;
    let requests = 0;
    await fetchChatBackfillRounds({
      ...options,
      request: async () => {
        requests++;
        cancel = true;
      },
      shouldCancel: async () => cancel,
      onRound: async () => {
        throw new Error('cancelled round must not publish completion');
      },
    });
    expect(requests).toBe(1);
  });

  test('cancel stops while an in-flight media download is still draining', async () => {
    const options = setup();
    let draining = false;
    await fetchChatBackfillRounds({
      ...options,
      request: async () => {},
      drain: () => {
        draining = true;
        return new Promise<void>(() => {});
      },
      shouldCancel: async () => draining,
      onRound: async () => {
        throw new Error('cancelled download cannot complete the round');
      },
    });
    expect(draining).toBe(true);
  });

  test('an unanswered round reports zero replies and ends', async () => {
    const rounds: number[] = [];
    await fetchChatBackfillRounds({
      ...setup(),
      request: async () => {},
      onRound: async (round) => {
        rounds.push(round.received);
      },
    });
    expect(rounds).toEqual([0]);
  });
});

describe('historical state extraction', () => {
  const at = new Date('2026-01-15');
  const base = { key: { id: 'operation', remoteJid: 'chat@jid' }, messageTimestamp: at.getTime() / 1000 };
  test('reaction, empty removal, edit (including empty text) and deletion have target identities', () => {
    const messages = [
      { reactionMessage: { key: { id: 'target' }, text: '👍' } },
      { reactionMessage: { key: { id: 'target' }, text: '' } },
      { protocolMessage: { type: 14, key: { id: 'target' }, editedMessage: { conversation: '' } } },
      { protocolMessage: { type: 0, key: { id: 'target' } } },
    ];
    const mutations = messages.map((message) =>
      extractHistoryMutation({ ...base, message } as WAMessage, at, 'person'),
    );
    expect(mutations.map((m) => m?.kind)).toEqual(['reaction', 'reaction', 'edit', 'deletion']);
    expect(mutations.map((m) => m?.targetExternalId)).toEqual(['target', 'target', 'target', 'target']);
    expect(mutations[2]).toMatchObject({ text: '' });
  });
  test('unwraps own-device protocol edits and uses the operation timestamp', () => {
    const message = {
      deviceSentMessage: {
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'target' },
            timestampMs: at.getTime(),
            editedMessage: { extendedTextMessage: { text: 'edited' } },
          },
        },
      },
    };
    expect(extractHistoryMutation({ ...base, message } as WAMessage, new Date(), 'person')).toMatchObject({
      kind: 'edit',
      text: 'edited',
      at,
    });
  });
  test('malformed targets and normal messages are not mutations', () => {
    expect(
      extractHistoryMutation({ ...base, message: { reactionMessage: { text: '👍' } } } as WAMessage, at, 'person'),
    ).toBeNull();
    expect(
      extractHistoryMutation({ ...base, message: { conversation: 'text' } } as WAMessage, at, 'person'),
    ).toBeNull();
  });
});
