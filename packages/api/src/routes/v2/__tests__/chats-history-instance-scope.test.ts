/**
 * GET /chats/:id/messages and GET /chats/:id/coverage honour a key's legacy
 * `instanceIds` for a chat named by UUID.
 *
 * A native id is looked up only on an instance the key reaches, but a UUID was
 * returned as is, and the scope lock resolves the chat only when the separate
 * `instanceAllowlist` is on. So a key with `chats:read` and `instanceIds: [A]`
 * could read a chat on instance B by its UUID. It now gets the 404 a missing
 * chat gets, so the answer never tells that the chat exists elsewhere. A key
 * without `instanceIds` is unchanged and costs no extra read.
 */

import { describe, expect, mock, test } from 'bun:test';
import { NotFoundError } from '@omni/core';
import { Hono } from 'hono';
import { errorHandler } from '../../../middleware/error';
import { scopeEnforcerMiddleware } from '../../../middleware/scope-enforcer';
import type { ApiKeyData, AppVariables } from '../../../types';
import { chatsRoutes } from '../chats';

const INSTANCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAT_ON_A = '11111111-1111-4111-8111-111111111111';
const CHAT_ON_B = '22222222-2222-4222-8222-222222222222';
const MISSING_CHAT = '33333333-3333-4333-8333-333333333333';
const ROWS: Record<string, { id: string; instanceId: string }> = {
  [CHAT_ON_A]: { id: CHAT_ON_A, instanceId: INSTANCE_A },
  [CHAT_ON_B]: { id: CHAT_ON_B, instanceId: INSTANCE_B },
};

/** A legacy key: no profile, no allowlist locks, only `instanceIds`. */
function legacyKey(instanceIds: string[] | null): ApiKeyData {
  return { id: 'legacy', name: 'legacy', scopes: ['chats:read'], instanceIds, expiresAt: null, profile: null };
}

function mount(key: ApiKeyData) {
  const calls = { read: [] as string[], getById: [] as string[] };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('apiKey', key);
    c.set('services', {
      messages: {
        pageChatMessages: mock(async (chatId: string) => {
          calls.read.push(chatId);
          return { items: [{ id: 'msg-1', chatId }], hasMore: false, cursor: null };
        }),
        getChatCoverage: mock(async (chatId: string) => {
          calls.read.push(chatId);
          return { count: 7 };
        }),
      },
      chats: {
        getById: mock(async (id: string) => {
          calls.getById.push(id);
          const row = ROWS[id];
          if (!row) throw new NotFoundError('Chat', id);
          return row;
        }),
      },
    } as never);
    await next();
  });
  app.use('*', scopeEnforcerMiddleware);
  app.route('/chats', chatsRoutes);
  return { app, calls };
}

describe.each(['messages', 'coverage'])('GET /chats/:id/%s and a key restricted by instanceIds', (route) => {
  test('a chat on another instance answers 404, and nothing is read', async () => {
    const { app, calls } = mount(legacyKey([INSTANCE_A]));

    const res = await app.request(`/chats/${CHAT_ON_B}/${route}`);

    expect(res.status).toBe(404);
    expect(calls.read).toHaveLength(0);
  });

  test('the 404 is the one a missing chat gets', async () => {
    const { app } = mount(legacyKey([INSTANCE_A]));

    const elsewhere = (await (await app.request(`/chats/${CHAT_ON_B}/${route}`)).json()) as {
      error: { code: string; message: string };
    };
    const missing = await app.request(`/chats/${MISSING_CHAT}/${route}`);
    const body = (await missing.json()) as { error: { code: string; message: string } };

    expect(missing.status).toBe(404);
    expect(body.error.code).toBe(elsewhere.error.code);
    expect(body.error.message.replace(MISSING_CHAT, '<id>')).toBe(elsewhere.error.message.replace(CHAT_ON_B, '<id>'));
  });

  test('a chat on its own instance answers 200', async () => {
    const { app, calls } = mount(legacyKey([INSTANCE_A]));

    const res = await app.request(`/chats/${CHAT_ON_A}/${route}`);

    expect(res.status).toBe(200);
    expect(calls.read).toEqual([CHAT_ON_A]);
  });

  test('a key without instanceIds is unchanged: any chat, no extra read', async () => {
    const { app, calls } = mount(legacyKey(null));

    const res = await app.request(`/chats/${CHAT_ON_B}/${route}`);

    expect(res.status).toBe(200);
    expect(calls.read).toEqual([CHAT_ON_B]);
    expect(calls.getById).toHaveLength(0);
  });
});
