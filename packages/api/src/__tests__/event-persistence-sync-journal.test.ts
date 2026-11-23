/**
 * The sync job journal — DB-free.
 *
 * A chat backfill's `sync.*` events are journaled as internal rows, so a durable
 * consumer can follow the job instead of polling it. The event here is the one
 * SyncJobService.updateProgress publishes for a backfill round, captured from a
 * mock bus and fed to the `sync.>` journal subscriber: the row keeps its instance,
 * and its payload is ids, counts, states and coverage times, never message text.
 *
 * Driven through a captured mock bus and a chainable mock db — no module mocks
 * (they leak across files in the single-process sweep).
 */

import { describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EventBus } from '@omni/core';
import type { Database, SyncJob } from '@omni/db';
import { setupEventPersistence } from '../plugins/event-persistence';
import { SyncJobService } from '../services/sync-jobs';

const INSTANCE_ID = '00000000-0000-4000-8000-0000000000aa';
const CHAT_ID = '00000000-0000-4000-8000-0000000000bb';
const JOB_ID = '00000000-0000-4000-8000-0000000000cc';

type Handler = (event: unknown) => Promise<void>;

/** A thenable that accepts any builder method and resolves to `rows`. */
function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return () => proxy;
    },
  });
  return proxy;
}

/** The event SyncJobService publishes for one backfill round. */
async function publishedRound() {
  const job = {
    id: JOB_ID,
    instanceId: INSTANCE_ID,
    tenantId: null,
    status: 'running',
    channel: 'whatsapp-baileys',
    type: 'messages',
    // The job's own config names the chat on the phone; it never leaves in the event.
    config: {
      backfill: {
        chatId: CHAT_ID,
        chatJid: '5500000000000@s.whatsapp.net',
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-11-15T00:00:00.000Z',
      },
    },
    progress: { fetched: 0, stored: 0, duplicates: 0, mediaDownloaded: 0, state: 'queued' },
  } as unknown as SyncJob;
  const published: { type: string; payload: Record<string, unknown>; metadata: Record<string, unknown> }[] = [];
  const db = {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [job] }) }) }),
  } as unknown as Database;
  const bus = {
    publish: async (type: string, payload: Record<string, unknown>, metadata: Record<string, unknown>) => {
      published.push({ type, payload, metadata });
    },
  } as unknown as EventBus;
  const service = new SyncJobService(db, bus);
  service.getById = async () => job;
  await service.updateProgress(JOB_ID, {
    state: 'fetching',
    round: 2,
    fetched: 40,
    stored: 31,
    duplicates: 9,
    mediaDownloaded: 6,
    mediaMissing: 1,
    reactionsApplied: 3,
    editsApplied: 2,
    deletionsApplied: 1,
    unmatched: 0,
    oldestReached: '2026-04-02T10:00:00.000Z',
  });
  expect(published).toHaveLength(1);
  const [event] = published;
  return {
    id: randomUUID(),
    type: event?.type,
    timestamp: Date.now(),
    payload: event?.payload,
    metadata: { correlationId: randomUUID(), ...event?.metadata },
  };
}

function journal() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: mock(() => ({ from: () => chain([]) })),
    insert: mock(() => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { onConflictDoNothing: () => Promise.resolve(), onConflictDoUpdate: () => Promise.resolve() };
      },
    })),
    update: mock(() => chain([])),
  } as unknown as Database;
  const patterns = new Map<string, { handler: Handler; options: Record<string, unknown> }>();
  const eventBus = {
    subscribe: mock(async () => {}),
    subscribePattern: mock(async (pattern: string, handler: Handler, options: Record<string, unknown>) => {
      patterns.set(pattern, { handler, options });
    }),
    publish: mock(async () => {}),
    publishGeneric: mock(async () => {}),
  } as unknown as EventBus;
  return { db, eventBus, patterns, inserted };
}

/** Every leaf of a value, with its path. */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => leaves(inner, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

describe('sync job journal', () => {
  test('sync.> is journaled forward-only by its own durable', async () => {
    const s = journal();
    await setupEventPersistence(s.eventBus, s.db);
    const entry = s.patterns.get('sync.>');
    expect(entry).toBeDefined();
    expect(entry?.options.durable).toBe('event-persistence-sync');
    expect(entry?.options.startFrom).toBe('new');
  });

  test("a backfill round's sync.progress is journaled with its instance, ids and counts, never message text", async () => {
    const event = await publishedRound();
    expect(event.type).toBe('sync.progress');
    const s = journal();
    await setupEventPersistence(s.eventBus, s.db);
    await s.patterns.get('sync.>')?.handler(event);

    expect(s.inserted).toHaveLength(1);
    const row = s.inserted[0] as Record<string, unknown>;
    expect(row.eventType).toBe('sync.progress');
    expect(row.instanceId).toBe(INSTANCE_ID);
    expect(row.channel).toBe('internal');
    const payload = row.rawPayload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['chatId', 'instanceId', 'jobId', 'progress', 'type']);
    expect(payload).toMatchObject({ jobId: JOB_ID, chatId: CHAT_ID, instanceId: INSTANCE_ID, type: 'messages' });

    // Counts are numbers; the only strings are the state and times.
    const progress = leaves(payload.progress);
    for (const [path, value] of progress) {
      if (path === 'state') expect(value).toBe('fetching');
      else if (path === 'oldestReached' || path === 'lastProgressAt')
        expect(Number.isNaN(Date.parse(String(value)))).toBe(false);
      else expect(typeof value).toBe('number');
    }
    expect(Object.fromEntries(progress)).toMatchObject({
      fetched: 40,
      stored: 31,
      mediaDownloaded: 6,
      mediaMissing: 1,
      reactionsApplied: 3,
      editsApplied: 2,
      deletionsApplied: 1,
    });
    // The job's config (the chat's address on the phone) stays out.
    expect(JSON.stringify(row)).not.toContain('s.whatsapp.net');
  });
});
