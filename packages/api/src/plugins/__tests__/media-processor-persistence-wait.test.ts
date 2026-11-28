import { describe, expect, it } from 'bun:test';
import type { EventBus, MessageReceivedPayload } from '@omni/core';
import type { Database } from '@omni/db';
import type { MediaProcessingService } from '@omni/media-processing';
import type { Services } from '../../services';
import type { MediaStorageService } from '../../services/media-storage';
import { type MediaProcessorContext, __test__ } from '../media-processor';

const { processMessageMedia, waitForPersistedRow } = __test__;

const SHORT_WAIT = { maxWaitMs: 400, initialDelayMs: 5, maxDelayMs: 20 };

type Published = Array<{ type: string; payload: Record<string, unknown> }>;

function makeMockDb(): Database {
  return {
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Database;
}

function makeMediaService(processed: string[]): MediaProcessingService {
  return {
    canProcess: () => true,
    process: async (path: string) => {
      processed.push(path);
      return {
        success: true,
        content: 'a photo of a receipt',
        contentFormat: 'text',
        processingType: 'description',
        provider: 'fake',
        model: 'fake-model',
        processingTimeMs: 1,
        costCents: 0,
      };
    },
  } as unknown as MediaProcessingService;
}

function makeMediaStorage(): MediaStorageService {
  return {
    materializeForProcessing: async (reference: string) => ({ path: reference, cleanup: async () => {} }),
  } as unknown as MediaStorageService;
}

function makeServices(opts: { chatVisibleAfter: number; messageVisibleAfter: number }) {
  const calls = { chat: 0, message: 0 };
  const services = {
    chats: {
      findByExternalIdSmart: async () => {
        calls.chat++;
        return calls.chat > opts.chatVisibleAfter ? { id: 'chat-uuid' } : null;
      },
    },
    messages: {
      getByExternalId: async () => {
        calls.message++;
        return calls.message > opts.messageVisibleAfter
          ? { id: 'msg-uuid', mediaLocalPath: 'inst-1/image.jpg', platformTimestamp: null }
          : null;
      },
    },
  } as unknown as Services;
  return { services, calls };
}

function makeContext(
  services: Services,
  published: Published,
  processed: string[],
  persistedRowWait = SHORT_WAIT,
): MediaProcessorContext {
  const eventBus = {
    publish: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  } as unknown as EventBus;
  return {
    db: makeMockDb(),
    eventBus,
    services,
    mediaService: makeMediaService(processed),
    mediaStorage: makeMediaStorage(),
    defaultLanguage: 'pt',
    promptOverrides: {},
    persistedRowWait,
  };
}

const imagePayload = {
  externalId: 'ext-image-1',
  chatId: 'chat-1',
  content: { type: 'image', mimeType: 'image/jpeg' },
} as unknown as MessageReceivedPayload;

async function run(ctx: MediaProcessorContext) {
  await processMessageMedia(ctx, imagePayload, { instanceId: 'inst-1' }, { metadata: { correlationId: 'legacy' } });
}

describe('media-processor waits for message persistence', () => {
  it('processes the media when the message row is persisted after several lookups', async () => {
    const published: Published = [];
    const processed: string[] = [];
    const { services, calls } = makeServices({ chatVisibleAfter: 0, messageVisibleAfter: 6 });

    await run(makeContext(services, published, processed));

    expect(calls.message).toBe(7);
    expect(processed).toEqual(['inst-1/image.jpg']);
    const done = published.filter((e) => e.type === 'media.processed');
    expect(done).toHaveLength(1);
    expect(done[0]?.payload.mediaId).toBe('msg-uuid');
    expect(done[0]?.payload.content).toBe('a photo of a receipt');
  });

  it('waits for a chat persisted late before looking the message up', async () => {
    const published: Published = [];
    const processed: string[] = [];
    const { services, calls } = makeServices({ chatVisibleAfter: 4, messageVisibleAfter: 2 });

    await run(makeContext(services, published, processed));

    expect(calls.chat).toBe(5);
    expect(calls.message).toBe(3);
    expect(published.filter((e) => e.type === 'media.processed')).toHaveLength(1);
  });

  it('gives up after the configured wait when the message row never appears', async () => {
    const published: Published = [];
    const processed: string[] = [];
    const { services } = makeServices({ chatVisibleAfter: 0, messageVisibleAfter: Number.POSITIVE_INFINITY });

    const startedAt = Date.now();
    await run(makeContext(services, published, processed));
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(SHORT_WAIT.maxWaitMs - 5);
    expect(elapsed).toBeLessThan(SHORT_WAIT.maxWaitMs + 1_000);
    expect(processed).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('gives up after the configured wait when the chat row never appears', async () => {
    const published: Published = [];
    const processed: string[] = [];
    const { services, calls } = makeServices({
      chatVisibleAfter: Number.POSITIVE_INFINITY,
      messageVisibleAfter: 0,
    });

    const startedAt = Date.now();
    await run(makeContext(services, published, processed));

    expect(Date.now() - startedAt).toBeLessThan(SHORT_WAIT.maxWaitMs + 1_000);
    expect(calls.message).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('shares one deadline between the chat and the message lookups', async () => {
    const published: Published = [];
    const processed: string[] = [];
    const wait = { maxWaitMs: 600, initialDelayMs: 5, maxDelayMs: 20 };
    const { services, calls } = makeServices({
      chatVisibleAfter: 25,
      messageVisibleAfter: Number.POSITIVE_INFINITY,
    });

    await run(makeContext(services, published, processed, wait));

    expect(calls.chat).toBe(26);
    expect(calls.message).toBeGreaterThanOrEqual(1);
    expect(calls.message).toBeLessThanOrEqual(15);
    expect(published).toHaveLength(0);
  });
});

describe('waitForPersistedRow', () => {
  it('returns the first lookup result without sleeping', async () => {
    let lookups = 0;
    const row = await waitForPersistedRow(
      async () => {
        lookups++;
        return { id: 'row' };
      },
      Date.now() + 10_000,
      SHORT_WAIT,
    );

    expect(row).toEqual({ id: 'row' });
    expect(lookups).toBe(1);
  });

  it('backs off between lookups instead of polling at a fixed interval', async () => {
    let lookups = 0;
    const wait = { maxWaitMs: 300, initialDelayMs: 10, maxDelayMs: 40 };

    const row = await waitForPersistedRow(
      async () => {
        lookups++;
        return null;
      },
      Date.now() + wait.maxWaitMs,
      wait,
    );

    expect(row).toBeNull();
    expect(lookups).toBeGreaterThanOrEqual(3);
    expect(lookups).toBeLessThanOrEqual(13);
  });
});
