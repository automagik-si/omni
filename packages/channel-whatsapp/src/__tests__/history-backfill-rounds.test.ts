import { describe, expect, test } from 'bun:test';
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
