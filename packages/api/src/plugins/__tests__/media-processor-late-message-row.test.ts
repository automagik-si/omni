import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import type { EventBus, OmniEvent } from '@omni/core';
import type { Database } from '@omni/db';
import type { MediaProcessingService } from '@omni/media-processing';
import type { Services } from '../../services';
import type { MediaStorageService } from '../../services/media-storage';
import { type MediaProcessorContext, __test__ } from '../media-processor';

const { handleMessageReceived } = __test__;

const START = new Date('2026-11-20T20:06:00.000Z').getTime();

function makeHarness(rowVisibleAfterMs: number) {
  let now = START;
  setSystemTime(new Date(now));
  const processed: string[] = [];
  const published: string[] = [];
  const dbSets: Array<Record<string, unknown>> = [];

  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        dbSets.push(values);
        return { where: async () => {} };
      },
    }),
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Database;

  const services = {
    chats: { findByExternalIdSmart: async () => ({ id: 'chat-uuid' }) },
    messages: {
      getByExternalId: async () => {
        if (now - START < rowVisibleAfterMs) {
          now += 4_000;
          setSystemTime(new Date(now));
          return null;
        }
        setSystemTime();
        return { id: 'msg-uuid', mediaLocalPath: 'inst-1/audio/late.ogg', platformTimestamp: null };
      },
    },
  } as unknown as Services;

  const mediaService = {
    canProcess: () => true,
    process: async (path: string) => {
      processed.push(path);
      return {
        success: true,
        content: 'transcribed text',
        contentFormat: 'text',
        processingType: 'transcription',
        provider: 'fake',
        model: 'fake',
        processingTimeMs: 1,
        costCents: 0,
      };
    },
  } as unknown as MediaProcessingService;

  const mediaStorage = {
    materializeForProcessing: async (path: string) => ({ path, cleanup: async () => {} }),
  } as unknown as MediaStorageService;

  const ctx: MediaProcessorContext = {
    db,
    eventBus: {
      publish: async (type: string) => {
        published.push(type);
      },
    } as unknown as EventBus,
    services,
    mediaService,
    mediaStorage,
    defaultLanguage: 'pt',
    promptOverrides: {},
  };
  return { ctx, processed, published, dbSets };
}

function audioEvent(timestamp = START): OmniEvent {
  return {
    id: '00000000-0000-4000-8000-000000002111',
    type: 'message.received',
    timestamp,
    payload: {
      externalId: 'ext-late-row-1',
      chatId: 'chat-ext-1',
      content: { type: 'audio', mimeType: 'audio/ogg; codecs=opus', mediaUrl: 'https://media.example.test/a.ogg' },
    },
    metadata: { correlationId: 'legacy', instanceId: 'inst-1', channelType: 'gupshup' },
  } as unknown as OmniEvent;
}

afterEach(() => {
  setSystemTime();
  __test__.resetAudioTranscriptionModeCache();
});

describe('media-processor when message persistence is slower than five seconds', () => {
  it('still transcribes the audio once its message row shows up eight seconds after the event', async () => {
    const h = makeHarness(8_000);

    await handleMessageReceived(h.ctx, audioEvent());

    expect(h.processed).toEqual(['inst-1/audio/late.ogg']);
    expect(h.dbSets.some((s) => s.transcription === 'transcribed text')).toBe(true);
    expect(h.published).toContain('media.processed');
  });

  it('still drops the media when the row never shows up inside the wait window', async () => {
    const h = makeHarness(60_000);

    await handleMessageReceived(h.ctx, audioEvent());

    expect(h.processed).toEqual([]);
    expect(h.dbSets).toEqual([]);
  });

  it('keeps the five second wait for a delivery that starts fifteen seconds or more after its event', async () => {
    const h = makeHarness(8_000);

    await handleMessageReceived(h.ctx, audioEvent(START - 20_000));

    expect(h.processed).toEqual([]);
    expect(h.dbSets).toEqual([]);
  });
});
