/** Chat routes treat a chat outside a restricted key's instances as not found. */
import { describe, expect, test } from 'bun:test';
import { NotFoundError } from '@omni/core';
import { Hono } from 'hono';
import { errorHandler } from '../../../middleware/error';
import { scopeEnforcerMiddleware } from '../../../middleware/scope-enforcer';
import type { ApiKeyData, AppVariables } from '../../../types';
import { chatsRoutes } from '../chats';

const INSTANCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const MISSING_CHAT = '33333333-3333-4333-8333-333333333333';
const NATIVE_ID = 'example-chat';

interface RouteCase {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  explicitInstance?: boolean;
  status?: number;
  reads: number;
}

const ROUTES: RouteCase[] = [
  { method: 'GET', path: '', reads: 1 },
  { method: 'PATCH', path: '', body: { name: 'Updated chat' }, reads: 0 },
  { method: 'DELETE', path: '', reads: 0 },
  { method: 'POST', path: '/hide', reads: 1 },
  { method: 'POST', path: '/unhide', reads: 1 },
  { method: 'POST', path: '/label', body: { label: 'example' }, reads: 1 },
  { method: 'DELETE', path: '/label', body: { label: 'example' }, reads: 1 },
  { method: 'POST', path: '/archive', body: {}, reads: 0 },
  { method: 'POST', path: '/unarchive', body: {}, reads: 0 },
  { method: 'POST', path: '/archive', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/unarchive', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/pin', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/unpin', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/mute', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/unmute', explicitInstance: true, reads: 1 },
  { method: 'GET', path: '/participants', reads: 0 },
  { method: 'POST', path: '/participants', body: { platformUserId: 'example-user' }, reads: 0, status: 201 },
  { method: 'DELETE', path: '/participants/example-user', reads: 0 },
  { method: 'PATCH', path: '/participants/example-user/role', body: { role: 'admin' }, reads: 0 },
  { method: 'POST', path: '/read', explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/disappearing', body: { duration: '24h' }, explicitInstance: true, reads: 1 },
  { method: 'POST', path: '/reopen-contact', reads: 1 },
];

function key(instanceIds: string[] | null): ApiKeyData {
  return {
    id: 'legacy',
    name: 'legacy',
    scopes: ['chats:read', 'chats:write'],
    instanceIds,
    profile: null,
    expiresAt: null,
  };
}

function row(id: string) {
  if (id !== CHAT_A && id !== CHAT_B) throw new NotFoundError('Chat', id);
  return { id, instanceId: id === CHAT_A ? INSTANCE_A : INSTANCE_B, externalId: NATIVE_ID, settings: {} };
}

function mount(apiKey: ApiKeyData) {
  const effects: string[] = [];
  const reads: string[] = [];
  const nativeReads: string[] = [];
  const effect = (name: string) => async (id: string) => {
    effects.push(name);
    return row(id);
  };
  const pluginEffect = async () => {
    effects.push('plugin');
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    c.set('services', {
      chats: {
        getById: async (id: string) => {
          reads.push(id);
          return row(id);
        },
        findByExternalIdSmart: async (instanceId: string) => {
          nativeReads.push(instanceId);
          return row(instanceId === INSTANCE_A ? CHAT_A : CHAT_B);
        },
        nameForRead: async <T>(items: T[]) => {
          effects.push('nameForRead');
          return items;
        },
        update: effect('update'),
        delete: effect('delete'),
        archive: effect('archive'),
        unarchive: effect('unarchive'),
        hide: effect('hide'),
        unhide: effect('unhide'),
        addLabel: effect('addLabel'),
        removeLabel: effect('removeLabel'),
        getParticipants: effect('getParticipants'),
        addParticipant: async ({ chatId }: { chatId: string }) => effect('addParticipant')(chatId),
        removeParticipant: effect('removeParticipant'),
        updateParticipantRole: effect('updateParticipantRole'),
        resetUnreadCount: effect('resetUnreadCount'),
      },
      messages: {
        list: async () => {
          effects.push('messages.list');
          return { items: [] };
        },
      },
      instances: { getById: async (id: string) => ({ id, channel: 'example' }) },
    } as never);
    c.set('channelRegistry', {
      get: () => ({
        capabilities: { canReceiveReadReceipts: true },
        chatModifyAction: pluginEffect,
        markChatAsRead: pluginEffect,
        setDisappearing: pluginEffect,
      }),
    } as never);
    await next();
  });
  app.use('*', scopeEnforcerMiddleware);
  app.route('/chats', chatsRoutes);
  return { app, effects, reads, nativeReads };
}

function request(app: ReturnType<typeof mount>['app'], route: RouteCase, chatId: string, instanceId = INSTANCE_A) {
  const body = route.explicitInstance ? { ...route.body, instanceId } : route.body;
  return app.request(`/chats/${chatId}${route.path}`, {
    method: route.method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

describe.each(ROUTES)('$method /chats/:id$path (explicit instance: $explicitInstance)', (route) => {
  test('another instance and a missing chat answer the same 404 before any effect', async () => {
    const { app, effects } = mount(key([INSTANCE_A]));
    const elsewhere = await request(app, route, CHAT_B);
    const missing = await request(app, route, MISSING_CHAT);

    expect(elsewhere.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await elsewhere.json()).replaceAll(CHAT_B, '<id>')).toBe(
      JSON.stringify(await missing.json()).replaceAll(MISSING_CHAT, '<id>'),
    );
    expect(effects).toEqual([]);
  });

  test('a chat on the key instance works', async () => {
    const { app, effects } = mount(key([INSTANCE_A]));
    expect((await request(app, route, CHAT_A)).status).toBe(route.status ?? 200);
    expect(effects.length).toBeGreaterThan(0);
  });

  test('an unrestricted key keeps the route behavior and read count', async () => {
    const { app, effects, reads } = mount(key(null));
    expect((await request(app, route, CHAT_B, INSTANCE_B)).status).toBe(route.status ?? 200);
    expect(effects.length).toBeGreaterThan(0);
    expect(reads).toHaveLength(route.reads);
  });

  if (route.explicitInstance) {
    test.each([{ instanceIds: null }, { instanceIds: [INSTANCE_A, INSTANCE_B] }])(
      'body instance must match the chat ($instanceIds)',
      async ({ instanceIds }) => {
        const { app, effects } = mount(key(instanceIds ? [...instanceIds] : null));
        expect((await request(app, route, CHAT_B, INSTANCE_A)).status).toBe(404);
        expect(effects).toEqual([]);
      },
    );

    test('a native id still resolves on the body instance', async () => {
      const { app, effects, nativeReads } = mount(key([INSTANCE_A]));
      expect((await request(app, route, NATIVE_ID)).status).toBe(200);
      expect(nativeReads).toEqual([INSTANCE_A]);
      expect(effects.length).toBeGreaterThan(0);
    });
  }

  test('an instance allowlist keeps the existing lock response', async () => {
    const apiKey = { ...key([INSTANCE_A]), instanceAllowlist: [INSTANCE_A] };
    const { app, effects } = mount(apiKey);
    expect((await request(app, route, CHAT_A)).status).toBe(route.status ?? 200);
    effects.length = 0;
    expect((await request(app, route, CHAT_B)).status).toBe(403);
    expect(effects).toEqual([]);
  });
});
