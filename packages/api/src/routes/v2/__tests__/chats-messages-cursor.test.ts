/**
 * GET /chats/:id/messages pages by an opaque cursor and answers meta; GET
 * /chats/:id/coverage reads what Omni holds for the chat. Existing callers
 * (limit, before, after, mediaOnly, `{ items }` newest first) see no change.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { encodeChatMessagesCursor } from '../../../services/messages';
import type { AppVariables } from '../../../types';
import { chatsRoutes } from '../chats';

const CHAT_ID = '11111111-1111-4111-8111-111111111111';
const LAST_ID = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-11-15T12:00:00.123Z');

interface Calls {
  page: Array<{ chatId: string; options: Record<string, unknown> }>;
  coverage: Array<{ chatId: string; options: Record<string, unknown> }>;
}

function mount(calls: Calls, page = { items: [] as unknown[], hasMore: false, cursor: null as string | null }) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('services', {
      messages: {
        pageChatMessages: mock(async (chatId: string, options: Record<string, unknown>) => {
          calls.page.push({ chatId, options });
          return page;
        }),
        getChatCoverage: mock(async (chatId: string, options: Record<string, unknown>) => {
          calls.coverage.push({ chatId, options });
          return {
            oldest: AT,
            newest: AT,
            count: 3,
            countInWindow: 2,
            mediaMissing: 1,
            deletedCount: 0,
            lastInbound: AT,
            lastOutbound: null,
          };
        }),
      },
    } as never);
    c.set('apiKey', { id: 'test', name: 'test', scopes: ['*'], instanceIds: null, expiresAt: null } as never);
    await next();
  });
  app.route('/chats', chatsRoutes);
  return app;
}

const freshCalls = (): Calls => ({ page: [], coverage: [] });

describe('GET /chats/:id/messages — cursor and meta', () => {
  test('without a cursor: the old query, the old items, plus meta', async () => {
    const calls = freshCalls();
    const cursor = encodeChatMessagesCursor({ platformTimestamp: AT, id: LAST_ID });
    const app = mount(calls, { items: [{ id: LAST_ID }], hasMore: true, cursor });

    const res = await app.request(`/chats/${CHAT_ID}/messages?limit=1&mediaOnly=true`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: LAST_ID }], meta: { hasMore: true, cursor } });
    expect(calls.page[0]?.options).toEqual({
      limit: 1,
      before: undefined,
      after: undefined,
      mediaOnly: true,
      includeDeleted: false,
      cursor: undefined,
    });
  });

  test('the last page answers cursor null', async () => {
    const calls = freshCalls();
    const res = await mount(calls).request(`/chats/${CHAT_ID}/messages`);

    expect(await res.json()).toEqual({ items: [], meta: { hasMore: false, cursor: null } });
    expect(calls.page[0]?.options.limit).toBe(100);
  });

  test('a cursor reaches the service as its position, with the window kept', async () => {
    const calls = freshCalls();
    const cursor = encodeChatMessagesCursor({ platformTimestamp: AT, id: LAST_ID });

    const res = await mount(calls).request(
      `/chats/${CHAT_ID}/messages?cursor=${cursor}&after=2026-11-01T00:00:00.000Z&before=2026-11-16T00:00:00.000Z`,
    );

    expect(res.status).toBe(200);
    expect(calls.page[0]?.options.cursor).toEqual({ at: AT, id: LAST_ID });
    expect((calls.page[0]?.options.after as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect((calls.page[0]?.options.before as Date).toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  test('a cursor the route did not issue answers 400, never a first page', async () => {
    const calls = freshCalls();
    const app = mount(calls);
    const forged = Buffer.from(JSON.stringify({ t: AT.toISOString(), id: 'not-a-uuid' })).toString('base64url');

    for (const cursor of ['garbage', AT.toISOString(), forged]) {
      const res = await app.request(`/chats/${CHAT_ID}/messages?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
    }
    expect(calls.page).toHaveLength(0);
  });

  test('includeDeleted=true reaches the service', async () => {
    const calls = freshCalls();
    await mount(calls).request(`/chats/${CHAT_ID}/messages?includeDeleted=true`);

    expect(calls.page[0]?.options.includeDeleted).toBe(true);
  });
});

describe('GET /chats/:id/coverage', () => {
  test('answers { data } with ISO times, deleted rows left out by default', async () => {
    const calls = freshCalls();
    const res = await mount(calls).request(`/chats/${CHAT_ID}/coverage`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        oldest: AT.toISOString(),
        newest: AT.toISOString(),
        count: 3,
        countInWindow: 2,
        mediaMissing: 1,
        deletedCount: 0,
        lastInbound: AT.toISOString(),
        lastOutbound: null,
      },
    });
    expect(calls.coverage[0]).toEqual({
      chatId: CHAT_ID,
      options: { from: undefined, to: undefined, includeDeleted: false },
    });
  });

  test('from, to and includeDeleted reach the service', async () => {
    const calls = freshCalls();
    await mount(calls).request(
      `/chats/${CHAT_ID}/coverage?from=2026-11-01T00:00:00.000Z&to=2026-11-15T00:00:00.000Z&includeDeleted=true`,
    );

    const options = calls.coverage[0]?.options ?? {};
    expect((options.from as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect((options.to as Date).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(options.includeDeleted).toBe(true);
  });

  test('an unparseable date answers 400', async () => {
    const calls = freshCalls();
    const res = await mount(calls).request(`/chats/${CHAT_ID}/coverage?from=not-a-date`);

    expect(res.status).toBe(400);
    expect(calls.coverage).toHaveLength(0);
  });
});
