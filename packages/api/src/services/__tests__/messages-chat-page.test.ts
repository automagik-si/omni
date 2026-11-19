/**
 * One chat's messages, paged by a stable cursor, and the chat's coverage read.
 *
 * These pin the query shape and the page arithmetic against a captured query;
 * __tests__/chat-messages-cursor-postgres.test.ts runs the same reads on a real
 * database (equal timestamps, window bounds, deleted rows, exact times).
 */

import { describe, expect, test } from 'bun:test';
import type { Database, Message } from '@omni/db';
import { type SQLWrapper, isSQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  type ChatMessagesCursor,
  MessageService,
  decodeChatMessagesCursor,
  encodeChatMessagesCursor,
} from '../messages';

const CHAT_ID = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-11-15T12:00:00.123Z');

function compile(wrapper: unknown): { sql: string; params: unknown[] } {
  if (!isSQLWrapper(wrapper)) throw new Error('Expected a Drizzle SQLWrapper');
  const query = new PgDialect().sqlToQuery((wrapper as SQLWrapper).getSQL());
  return { sql: query.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: query.params };
}

interface PageCapture {
  where?: { sql: string; params: unknown[] };
  orderBy?: string[];
  limit?: number;
}

/** A database that records the page query and answers `rows`. */
function pageDb(capture: PageCapture, rows: Message[] = []): Database {
  const where = (condition: unknown) => {
    capture.where = compile(condition);
    return {
      orderBy: (...order: unknown[]) => {
        capture.orderBy = order.map((o) => compile(o).sql);
        return {
          limit: (n: number) => {
            capture.limit = n;
            return Promise.resolve(rows.slice(0, n));
          },
        };
      },
    };
  };
  return { select: () => ({ from: () => ({ where }) }) } as unknown as Database;
}

/** Rows newest first, as the page query orders them. */
function rowsOf(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(999 - i).padStart(12, '0')}`,
    platformTimestamp: AT,
  })) as unknown as Message[];
}

describe('chat messages cursor', () => {
  test('round-trips the last item’s platform time and id', () => {
    const cursor = encodeChatMessagesCursor({ platformTimestamp: AT, id: CHAT_ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeChatMessagesCursor(cursor)).toEqual({ at: AT, id: CHAT_ID });
  });

  test('refuses anything it did not issue', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const raw of [
      'not-a-cursor',
      Buffer.from('plain text').toString('base64url'),
      encode({ t: 'yesterday', id: CHAT_ID }),
      encode({ t: AT.toISOString(), id: 'msg-1' }),
      encode({ t: AT.toISOString() }),
      encode([AT.toISOString(), CHAT_ID]),
    ]) {
      expect(decodeChatMessagesCursor(raw)).toBeNull();
    }
  });
});

describe('MessageService.pageChatMessages', () => {
  test('first page: visible rows of the chat, (platformTimestamp desc, id desc), one extra row fetched', async () => {
    const capture: PageCapture = {};
    await new MessageService(pageDb(capture), null).pageChatMessages(CHAT_ID, { limit: 20 });

    expect(capture.where?.sql).toContain('"messages"."chat_id" =');
    expect(capture.where?.params).toContain(CHAT_ID);
    expect(capture.where?.sql).toContain('"messages"."deleted_at" is null');
    expect(capture.where?.sql).not.toContain(' or ');
    expect(capture.orderBy).toEqual(['"messages"."platform_timestamp" desc', '"messages"."id" desc']);
    expect(capture.limit).toBe(21);
  });

  test('a cursor continues strictly after its position, on the same order', async () => {
    const capture: PageCapture = {};
    const cursor: ChatMessagesCursor = { at: AT, id: CHAT_ID };
    await new MessageService(pageDb(capture), null).pageChatMessages(CHAT_ID, { limit: 5, cursor });

    expect(capture.where?.sql).toMatch(
      /\("messages"\."platform_timestamp" < \$\d+ or \("messages"\."platform_timestamp" = \$\d+ and "messages"\."id" < \$\d+\)\)/,
    );
    expect(capture.where?.params).toContain(CHAT_ID);
    expect(capture.orderBy).toEqual(['"messages"."platform_timestamp" desc', '"messages"."id" desc']);
  });

  test('before, after and mediaOnly still bound the window, both ends inclusive', async () => {
    const capture: PageCapture = {};
    const before = new Date('2026-11-15T00:00:00.000Z');
    const after = new Date('2026-11-01T00:00:00.000Z');
    await new MessageService(pageDb(capture), null).pageChatMessages(CHAT_ID, {
      before,
      after,
      mediaOnly: true,
      cursor: { at: AT, id: CHAT_ID },
    });

    expect(capture.where?.sql).toContain('"messages"."platform_timestamp" <=');
    expect(capture.where?.sql).toContain('"messages"."platform_timestamp" >=');
    expect(capture.where?.sql).toContain('"messages"."has_media" =');
    expect(capture.where?.sql).toContain('"messages"."deleted_at" is null');
  });

  test('includeDeleted lists deleted rows too', async () => {
    const capture: PageCapture = {};
    await new MessageService(pageDb(capture), null).pageChatMessages(CHAT_ID, { includeDeleted: true });

    expect(capture.where?.sql).not.toContain('deleted_at');
  });

  test('a full page answers hasMore and the cursor of its last item', async () => {
    const capture: PageCapture = {};
    const rows = rowsOf(4);
    const page = await new MessageService(pageDb(capture, rows), null).pageChatMessages(CHAT_ID, { limit: 3 });

    expect(page.items.map((m) => m.id)).toEqual(rows.slice(0, 3).map((m) => m.id));
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();
    expect(decodeChatMessagesCursor(page.cursor ?? '')).toEqual({ at: AT, id: rows[2]?.id ?? '' });
  });

  test('the last page answers no cursor', async () => {
    const rows = rowsOf(3);
    const page = await new MessageService(pageDb({}, rows), null).pageChatMessages(CHAT_ID, { limit: 3 });

    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();

    const empty = await new MessageService(pageDb({}, []), null).pageChatMessages(CHAT_ID, { limit: 3 });
    expect(empty).toEqual({ items: [], hasMore: false, cursor: null });
  });

  test('getChatMessages keeps its old answer: up to limit messages (default 100), deleted rows hidden', async () => {
    const capture: PageCapture = {};
    const rows = rowsOf(101);
    const items = await new MessageService(pageDb(capture, rows), null).getChatMessages(CHAT_ID);

    expect(items).toHaveLength(100);
    expect(capture.limit).toBe(101);
    expect(capture.where?.sql).toContain('"messages"."deleted_at" is null');
  });
});

interface CoverageCapture {
  fields?: Record<string, string>;
  where?: { sql: string; params: unknown[] };
}

/** A database that records the coverage query and answers `rows`. */
function coverageDb(capture: CoverageCapture, rows: unknown[]): Database {
  const select = (fields: Record<string, unknown>) => {
    capture.fields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, compile(v).sql]));
    return {
      from: () => ({
        where: (condition: unknown) => {
          capture.where = compile(condition);
          return Promise.resolve(rows);
        },
      }),
    };
  };
  return { select } as unknown as Database;
}

describe('MessageService.getChatCoverage', () => {
  test('one aggregate over the chat; every figure but deletedCount uses the page filter', async () => {
    const capture: CoverageCapture = {};
    await new MessageService(coverageDb(capture, []), null).getChatCoverage(CHAT_ID);

    expect(capture.where?.sql).toBe('"messages"."chat_id" = $1');
    const fields = capture.fields ?? {};
    for (const name of ['oldest', 'newest', 'count', 'countInWindow', 'mediaMissing', 'lastInbound', 'lastOutbound']) {
      expect(fields[name]).toContain('"messages"."deleted_at" is null');
    }
    expect(fields.deletedCount).toContain('"messages"."deleted_at" is not null');
    expect(fields.mediaMissing).toContain('"messages"."media_local_path" is null');
    expect(fields.lastInbound).toContain('"messages"."is_from_me" =');
    expect(fields.lastOutbound).toContain('"messages"."is_from_me" =');
  });

  test('from and to bound countInWindow only', async () => {
    const capture: CoverageCapture = {};
    await new MessageService(coverageDb(capture, []), null).getChatCoverage(CHAT_ID, {
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-15T00:00:00.000Z'),
    });

    const fields = capture.fields ?? {};
    expect(fields.countInWindow).toContain('"messages"."platform_timestamp" >=');
    expect(fields.countInWindow).toContain('"messages"."platform_timestamp" <=');
    for (const name of ['oldest', 'newest', 'count', 'mediaMissing', 'lastInbound', 'lastOutbound']) {
      expect(fields[name]).not.toContain('>=');
    }
  });

  test('includeDeleted counts deleted rows with the rest', async () => {
    const capture: CoverageCapture = {};
    await new MessageService(coverageDb(capture, []), null).getChatCoverage(CHAT_ID, { includeDeleted: true });

    const fields = capture.fields ?? {};
    expect(fields.count).not.toContain('deleted_at');
    expect(fields.deletedCount).toContain('"messages"."deleted_at" is not null');
  });

  test('answers nulls and zeros when nothing is stored', async () => {
    const coverage = await new MessageService(coverageDb({}, []), null).getChatCoverage(CHAT_ID);

    expect(coverage).toEqual({
      oldest: null,
      newest: null,
      count: 0,
      countInWindow: 0,
      mediaMissing: 0,
      deletedCount: 0,
      lastInbound: null,
      lastOutbound: null,
    });
  });
});
