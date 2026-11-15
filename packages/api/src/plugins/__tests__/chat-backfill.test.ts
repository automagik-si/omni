import { describe, expect, test } from 'bun:test';
import type { ChannelRegistry, FetchHistoryOptions, HistorySyncMutation } from '@omni/channel-sdk';
import type { ChatCoverage } from '@omni/core/events';
import type { SyncJob, SyncJobProgress } from '@omni/db';
import type { Services } from '../../services';
import { processChatBackfill, waitForBackfillTurn } from '../chat-backfill';

const coverage: ChatCoverage = {
  oldest: null,
  newest: null,
  count: 0,
  countInWindow: 0,
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
  test('always downloads media and counts available and missing files once each', async () => {
    const f = fixture(async (_id, options) => {
      expect((options as FetchHistoryOptions & { downloadMedia: boolean }).downloadMedia).toBe(true);
      const image = {
        externalId: 'image',
        chatId: 'chat@jid',
        from: 'person',
        timestamp: new Date('2026-01-15'),
        content: { type: 'image', localPath: 'line/image.png' },
        isFromMe: false,
        rawPayload: {},
      };
      await options.onMessage?.(image);
      await options.onMessage?.(image);
      await options.onMessage?.({ ...image, externalId: 'expired', content: { type: 'image' } });
      await options.onRound?.({ round: 1, received: 3, oldestReached: image.timestamp.toISOString() });
    });
    await processChatBackfill(f.options);
    expect(f.job.progress.mediaDownloaded).toBe(1);
    expect(f.job.progress.mediaMissing).toBe(1);
    expect(f.stored).toHaveLength(2);
    expect(f.stored[1]).toMatchObject({ hasMedia: true, mediaLocalPath: undefined });
  });
  test('recovers missing media on an already stored message', async () => {
    const f = fixture(async (_id, options) => {
      await options.onMessage?.({
        externalId: 'image',
        chatId: 'chat@jid',
        from: 'person',
        timestamp: new Date('2026-01-15'),
        content: { type: 'image', localPath: 'recovered.png' },
        isFromMe: false,
        rawPayload: {},
      });
    });
    const updates: unknown[] = [];
    f.options.services.messages.getByExternalId = async () => ({ id: 'existing', mediaLocalPath: null }) as never;
    f.options.services.messages.update = async (_id, update) => {
      updates.push(update);
      return {} as never;
    };
    await processChatBackfill(f.options);
    expect(f.stored).toEqual([]);
    expect(updates).toEqual([
      { hasMedia: true, mediaLocalPath: 'recovered.png', mediaUrl: undefined, mediaMimeType: undefined },
    ]);
    expect(f.job.progress.mediaDownloaded).toBe(1);
    expect(f.job.progress.mediaMissing ?? 0).toBe(0);
  });
  test('defers out-of-order mutations, counts unmatched, and never stores them as messages', async () => {
    const changes: HistorySyncMutation[] = [];
    const f = fixture(async (_id, options) => {
      const base = { chatId: 'chat@jid', actor: 'person', at: new Date('2026-01-15'), targetExternalId: 'one' };
      await options.onMutation?.({ ...base, id: 'edit', kind: 'edit', text: 'edited' });
      await options.onMutation?.({ ...base, id: 'reaction', kind: 'reaction', emoji: '👍' });
      await options.onMutation?.({ ...base, id: 'deletion', kind: 'deletion' });
      await options.onMutation?.({
        ...base,
        id: 'unmatched',
        targetExternalId: 'absent',
        kind: 'edit',
        text: 'missing',
      });
      // Duplicate delivery is only one mutation; another chat and range are ignored.
      await options.onMutation?.({ ...base, id: 'edit', kind: 'edit', text: 'edited' });
      await options.onMutation?.({ ...base, id: 'other-chat', chatId: 'other', kind: 'deletion' });
      await options.onMutation?.({ ...base, id: 'other-range', at: new Date('2025-01-01'), kind: 'deletion' });
      expect(changes).toEqual([]);
      await options.onMessage?.({
        externalId: 'one',
        chatId: 'chat@jid',
        from: 'person',
        timestamp: new Date('2026-01-15'),
        content: { type: 'text', text: 'original' },
        isFromMe: false,
        rawPayload: {},
      });
      await options.onRound?.({ round: 1, received: 5, oldestReached: base.at.toISOString() });
    });
    f.options.services.messages.applyHistoryMutation = async (_chatId, mutation) => {
      expect(f.stored).toHaveLength(1);
      changes.push(mutation);
      return mutation.targetExternalId === 'absent' ? 'unmatched' : 'applied';
    };
    await processChatBackfill(f.options);
    expect(changes).toHaveLength(4);
    expect(f.stored).toHaveLength(1);
    expect(f.job.progress).toMatchObject({ editsApplied: 1, reactionsApplied: 1, deletionsApplied: 1, unmatched: 1 });
  });
  test('replayed mutation receipts do not increment application counters', async () => {
    const f = fixture(async (_id, options) => {
      await options.onMutation?.({
        id: 'already-applied',
        chatId: 'chat@jid',
        targetExternalId: 'target',
        actor: 'person',
        at: new Date('2026-01-15'),
        kind: 'edit',
        text: 'edited',
      });
    });
    f.options.services.messages.applyHistoryMutation = async () => 'duplicate';
    await processChatBackfill(f.options);
    expect(f.job.progress.editsApplied ?? 0).toBe(0);
    expect(f.job.progress.unmatched ?? 0).toBe(0);
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
