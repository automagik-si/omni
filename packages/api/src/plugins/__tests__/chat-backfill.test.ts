import { describe, expect, test } from 'bun:test';
import type { ChannelRegistry, FetchHistoryOptions } from '@omni/channel-sdk';
import type { ChatCoverage } from '@omni/core/events';
import type { SyncJob, SyncJobProgress } from '@omni/db';
import type { Services } from '../../services';
import { processChatBackfill, waitForBackfillTurn } from '../chat-backfill';

const coverage: ChatCoverage = {
  oldest: null,
  newest: null,
  count: 0,
  countInWindow: 0,
  deletedCount: 0,
  mediaMissing: 0,
  lastInbound: null,
  lastOutbound: null,
};
function fixture(fetchHistory: (id: string, options: FetchHistoryOptions) => Promise<unknown>) {
  const job = {
    id: 'job',
    instanceId: 'line',
    status: 'pending',
    channel: 'whatsapp-baileys',
    config: {
      backfill: { chatId: 'chat', chatJid: 'chat@jid', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
    },
    progress: { fetched: 0, stored: 0, duplicates: 0, mediaDownloaded: 0 },
  } as SyncJob;
  const progress: Partial<SyncJobProgress>[] = [];
  const stored: unknown[] = [];
  const services = {
    syncJobs: {
      getById: async () => job,
      isHistoryPushBlocking: async () => false,
      claimBackfill: async () => {
        job.status = 'running';
        return job;
      },
      updateProgress: async (_id: string, update: Partial<SyncJobProgress>) => {
        progress.push({ ...update });
        job.progress = { ...job.progress, ...update };
        return job;
      },
      complete: async () => {
        if (job.status !== 'cancelled') job.status = 'completed';
      },
    },
    messages: {
      getChatMessages: async () => [],
      getChatCoverage: async () => coverage,
      getByExternalId: async () => null,
      create: async (message: unknown) => {
        stored.push(message);
      },
    },
  } as unknown as Services;
  const options = {
    jobId: job.id,
    tenantId: null,
    services,
    registry: { get: () => ({ fetchHistory }) } as unknown as ChannelRegistry,
    scope: async <T>(fn: () => Promise<T>) => fn(),
    assertAdmissible: async () => {},
  };
  return { job, progress, stored, options };
}

describe('chat backfill worker', () => {
  test('unanswered phone has its own terminal state and coverage', async () => {
    const f = fixture(async (_id, options) => {
      await options.onRound?.({ round: 1, received: 0, oldestReached: null });
    });
    await processChatBackfill(f.options);
    expect(f.job.progress.state).toBe('phone-did-not-answer');
    expect(f.job.progress.coverage).toEqual(coverage);
    expect(f.job.status).toBe('completed');
  });
  test('stores only selected chat and time window as sync and publishes per round', async () => {
    const f = fixture(async (_id, options) => {
      const message = {
        externalId: 'one',
        chatId: 'chat@jid',
        from: 'person',
        timestamp: new Date('2026-01-15'),
        content: { type: 'text', text: 'history' },
        isFromMe: false,
        rawPayload: {},
      };
      await options.onMessage?.({ ...message, chatId: 'other' });
      await options.onMessage?.({ ...message, timestamp: new Date('2025-01-01') });
      await options.onMessage?.(message);
      await options.onRound?.({ round: 1, received: 1, oldestReached: message.timestamp.toISOString() });
      await options.onRound?.({ round: 2, received: 0, oldestReached: null });
    });
    await processChatBackfill(f.options);
    expect(f.stored).toHaveLength(1);
    expect(f.stored[0]).toMatchObject({ source: 'sync', chatId: 'chat' });
    expect(f.progress.filter((p) => p.round === 1)).toHaveLength(1);
    expect(f.job.progress.state).toBe('done');
  });
  test('cancel during fetch drops messages and cannot complete the job', async () => {
    const f = fixture(async (_id, options) => {
      f.job.status = 'cancelled';
      expect(await options.shouldCancel?.()).toBe(true);
      await options.onMessage?.({
        externalId: 'late',
        chatId: 'chat@jid',
        from: 'person',
        timestamp: new Date('2026-01-15'),
        content: { type: 'text' },
        isFromMe: false,
        rawPayload: {},
      });
    });
    await processChatBackfill(f.options);
    expect(f.job.status).toBe('cancelled');
    expect(f.stored).toHaveLength(0);
  });
  test('a channel without history ends immediately with a plain outcome', async () => {
    const f = fixture(async () => {
      throw new Error('must not fetch');
    });
    f.job.channel = 'telegram';
    await processChatBackfill(f.options);
    expect(f.job.progress.state).toBe('done');
    expect(f.job.progress.outcome).toContain('does not provide');
  });
  test('a queued job waits for its claim and history push while other lines can claim', async () => {
    let olderDone = false;
    const pending = { status: 'pending' } as SyncJob;
    const order: string[] = [];
    await Promise.all([
      waitForBackfillTurn({
        get: async () => pending,
        historyPushBlocking: async () => !olderDone,
        claim: async () => {
          order.push('second');
          return pending;
        },
        sleep: async () => {
          olderDone = true;
          await Promise.resolve();
        },
      }),
      waitForBackfillTurn({
        get: async () => pending,
        historyPushBlocking: async () => false,
        claim: async () => {
          order.push('other-line');
          return pending;
        },
      }),
    ]);
    expect(order).toEqual(['other-line', 'second']);
  });
});
