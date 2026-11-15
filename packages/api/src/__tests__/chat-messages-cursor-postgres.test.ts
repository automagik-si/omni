/**
 * One chat's messages, paged by a stable cursor, and the chat's coverage read,
 * on a real PostgreSQL clone.
 *
 * Several messages share one platform time on purpose: the cursor must page
 * through them without repeating or skipping one, inside the before/after
 * window, and coverage must count exactly the rows paging returns.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Database, Message, NewMessage } from '@omni/db';
import { chats, instances, messages } from '@omni/db';
import { type ChatMessagesPageOptions, MessageService, decodeChatMessagesCursor } from '../services/messages';
import { createMigratedTestDatabase } from './fixtures/pg-clone';

const superUrl = process.env.OMNI_G4_POSTGRES_URL ?? '';
const postgresDescribe = superUrl ? describe : describe.skip;
const psqlBin = process.env.OMNI_G4_PSQL_BIN ?? 'psql';

const T0 = new Date('2026-11-01T10:00:00.000Z');
const T1 = new Date('2026-11-05T10:00:00.321Z');
const T2 = new Date('2026-11-10T10:00:00.000Z');
const T3 = new Date('2026-11-12T10:00:00.000Z');

/** Newest first, ties by id: the order the page route promises. */
function pageOrder(rows: Message[]): string[] {
  return [...rows]
    .sort((a, b) => b.platformTimestamp.getTime() - a.platformTimestamp.getTime() || (a.id < b.id ? 1 : -1))
    .map((row) => row.id);
}

postgresDescribe('a chat’s messages by cursor, and its coverage (real PostgreSQL)', () => {
  const clone = createMigratedTestDatabase({ superUrl, psqlBin });
  afterAll(() => clone.teardown());
  let db: Database;
  let service: MessageService;
  let chatId: string;
  let emptyChatId: string;
  let stored: Message[];

  /** Every page from the first to the last, following meta.cursor. */
  async function walk(options: Omit<ChatMessagesPageOptions, 'cursor'>) {
    const ids: string[] = [];
    const pages: Array<{ size: number; hasMore: boolean; cursor: string | null }> = [];
    let cursor: ChatMessagesPageOptions['cursor'];
    for (let guard = 0; guard < 50; guard++) {
      const page = await service.pageChatMessages(chatId, { ...options, cursor });
      ids.push(...page.items.map((m) => m.id));
      pages.push({ size: page.items.length, hasMore: page.hasMore, cursor: page.cursor });
      if (!page.cursor) return { ids, pages };
      cursor = decodeChatMessagesCursor(page.cursor) ?? undefined;
      expect(cursor).toBeDefined();
    }
    throw new Error('paging did not end');
  }

  beforeAll(async () => {
    db = clone.setup();
    service = new MessageService(db, null);

    const [instance] = await db
      .insert(instances)
      .values({ name: `chat-cursor-${Date.now()}`, channel: 'whatsapp-baileys' })
      .returning();
    if (!instance) throw new Error('no instance');
    const created = await db
      .insert(chats)
      .values([
        {
          instanceId: instance.id,
          externalId: 'cursor-chat@s.whatsapp.net',
          chatType: 'dm',
          channel: 'whatsapp-baileys',
        },
        {
          instanceId: instance.id,
          externalId: 'empty-chat@s.whatsapp.net',
          chatType: 'dm',
          channel: 'whatsapp-baileys',
        },
      ])
      .returning();
    chatId = created[0]?.id ?? '';
    emptyChatId = created[1]?.id ?? '';

    const row = (externalId: string, at: Date, extra: Partial<NewMessage> = {}): NewMessage => ({
      chatId,
      externalId,
      source: 'realtime',
      messageType: 'text',
      textContent: externalId,
      platformTimestamp: at,
      ...extra,
    });
    const deleted = { status: 'deleted' as const, deletedAt: new Date('2026-11-13T00:00:00.000Z') };
    stored = await db
      .insert(messages)
      .values([
        row('oldest-from-history', T0, { source: 'sync' }),
        // Six messages at one platform time, one of them deleted.
        row('tie-in-1', T1),
        row('tie-in-2', T1),
        row('tie-out', T1, { isFromMe: true }),
        row('tie-media-missing', T1, { messageType: 'image', hasMedia: true }),
        row('tie-media-stored', T1, { messageType: 'image', hasMedia: true, mediaLocalPath: 'media/x.jpg' }),
        row('tie-media-deleted', T1, { messageType: 'image', hasMedia: true, ...deleted }),
        row('newest-kept-out', T2, { isFromMe: true }),
        row('newest-deleted-in', T3, deleted),
      ])
      .returning();
  });

  const kept = () => stored.filter((m) => m.deletedAt === null);

  test('pages through equal timestamps without repeating or skipping one, whatever the page size', async () => {
    const expected = pageOrder(kept());
    expect(expected).toHaveLength(7);

    for (const limit of [1, 2, 3, 4, 7, 50]) {
      const { ids, pages } = await walk({ limit });
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      const last = pages[pages.length - 1];
      expect(last?.hasMore).toBe(false);
      expect(last?.cursor).toBeNull();
      for (const page of pages.slice(0, -1)) {
        expect(page.size).toBe(limit);
        expect(page.hasMore).toBe(true);
      }
    }
  });

  test('before and after still bound the window, both inclusive, across pages', async () => {
    const atT1 = pageOrder(kept().filter((m) => m.platformTimestamp.getTime() === T1.getTime()));
    expect(atT1).toHaveLength(5);
    expect((await walk({ limit: 2, after: T1, before: T1 })).ids).toEqual(atT1);

    const upToT1 = pageOrder(kept().filter((m) => m.platformTimestamp.getTime() <= T1.getTime()));
    expect((await walk({ limit: 3, before: T1 })).ids).toEqual(upToT1);

    const media = pageOrder(kept().filter((m) => m.hasMedia));
    expect((await walk({ limit: 1, mediaOnly: true })).ids).toEqual(media);
  });

  test('the old read is unchanged: newest first, up to limit, deleted rows hidden', async () => {
    const items = await service.getChatMessages(chatId, { limit: 2 });
    expect(items.map((m) => m.id)).toEqual(pageOrder(kept()).slice(0, 2));

    const all = await service.getChatMessages(chatId);
    expect(all.map((m) => m.id)).toEqual(pageOrder(kept()));
    expect(all.find((m) => m.platformTimestamp.getTime() === T0.getTime())?.source).toBe('sync');
  });

  test('includeDeleted lists deleted rows with their deletedAt and status', async () => {
    const { ids } = await walk({ limit: 2, includeDeleted: true });
    expect(ids).toEqual(pageOrder(stored));

    const page = await service.pageChatMessages(chatId, { limit: 50, includeDeleted: true });
    const shown = page.items.filter((m) => m.deletedAt !== null);
    expect(shown.map((m) => m.externalId).sort()).toEqual(['newest-deleted-in', 'tie-media-deleted']);
    for (const m of shown) expect(m.status).toBe('deleted');
  });

  test('coverage reads exact times and counts, with deleted rows left out', async () => {
    const coverage = await service.getChatCoverage(chatId, { from: T1, to: T1 });

    expect(coverage.oldest?.toISOString()).toBe(T0.toISOString());
    expect(coverage.newest?.toISOString()).toBe(T2.toISOString());
    expect(coverage.count).toBe(7);
    expect(coverage.countInWindow).toBe(5);
    expect(coverage.mediaMissing).toBe(1);
    expect(coverage.deletedCount).toBe(2);
    expect(coverage.lastInbound?.toISOString()).toBe(T1.toISOString());
    expect(coverage.lastOutbound?.toISOString()).toBe(T2.toISOString());
    expect(coverage.count).toBe((await walk({ limit: 3 })).ids.length);
  });

  test('coverage with includeDeleted counts deleted rows with the same filter as paging', async () => {
    const coverage = await service.getChatCoverage(chatId, { from: T1, to: T1, includeDeleted: true });

    expect(coverage.newest?.toISOString()).toBe(T3.toISOString());
    expect(coverage.count).toBe(9);
    expect(coverage.countInWindow).toBe(6);
    expect(coverage.mediaMissing).toBe(2);
    expect(coverage.deletedCount).toBe(2);
    expect(coverage.lastInbound?.toISOString()).toBe(T3.toISOString());
    expect(coverage.lastOutbound?.toISOString()).toBe(T2.toISOString());
    expect(coverage.count).toBe((await walk({ limit: 4, includeDeleted: true })).ids.length);
  });

  test('a window counts only what falls inside it; no window counts everything', async () => {
    expect((await service.getChatCoverage(chatId, { from: T2 })).countInWindow).toBe(1);
    expect((await service.getChatCoverage(chatId, { to: T0 })).countInWindow).toBe(1);
    expect((await service.getChatCoverage(chatId)).countInWindow).toBe(7);
  });

  test('a chat with no messages answers nulls and zeros', async () => {
    expect(await service.getChatCoverage(emptyChatId)).toEqual({
      oldest: null,
      newest: null,
      count: 0,
      countInWindow: 0,
      mediaMissing: 0,
      deletedCount: 0,
      lastInbound: null,
      lastOutbound: null,
    });
    expect(await service.pageChatMessages(emptyChatId)).toEqual({ items: [], hasMore: false, cursor: null });
  });
});
