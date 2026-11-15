/** Backfill routes treat a chat outside a restricted key's instances as not found. */
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
const MISSING = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const window = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
const rows: Record<string, { id: string; instanceId: string; externalId: string }> = {
  [CHAT_A]: { id: CHAT_A, instanceId: INSTANCE_A, externalId: 'chat-a@jid' },
  [CHAT_B]: { id: CHAT_B, instanceId: INSTANCE_B, externalId: 'chat-b@jid' },
};

function mount(instanceIds: string[] | null, jobChatId = CHAT_A) {
  const calls = { chats: [] as string[], jobs: [] as string[] };
  const job = {
    id: JOB,
    instanceId: rows[jobChatId]?.instanceId,
    config: { backfill: { ...window, chatId: jobChatId } },
    progress: { state: 'queued' },
  };
  const key: ApiKeyData = {
    id: 'legacy',
    name: 'legacy',
    scopes: ['chats:read', 'chats:write'],
    instanceIds,
    profile: null,
    expiresAt: null,
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('apiKey', key);
    c.set('services', {
      chats: {
        getById: async (id: string) => {
          calls.chats.push(id);
          const row = rows[id];
          if (!row) throw new NotFoundError('Chat', id);
          return row;
        },
      },
      instances: { getById: async () => ({ channel: 'whatsapp-baileys' }) },
      syncJobs: {
        create: async () => {
          calls.jobs.push('create');
          return job;
        },
        getById: async () => {
          calls.jobs.push('read');
          return job;
        },
        updateProgress: async () => {
          calls.jobs.push('progress');
          return job;
        },
        cancel: async () => {
          calls.jobs.push('cancel');
          return job;
        },
      },
      messages: {
        getChatCoverage: async () => ({
          oldest: null,
          newest: null,
          count: 0,
          countInWindow: 0,
          mediaMissing: 0,
          deletedCount: 0,
          lastInbound: null,
          lastOutbound: null,
        }),
      },
    } as never);
    await next();
  });
  app.use('*', scopeEnforcerMiddleware);
  app.route('/chats', chatsRoutes);
  return { app, calls };
}

const routes = [
  { method: 'POST', suffix: 'backfill', status: 202, calls: ['create'] },
  { method: 'GET', suffix: `backfill/${JOB}`, status: 200, calls: ['read'] },
  { method: 'POST', suffix: `backfill/${JOB}/cancel`, status: 200, calls: ['read', 'progress', 'cancel'] },
];
for (const route of routes) {
  const request = (app: ReturnType<typeof mount>['app'], chatId: string) =>
    app.request(
      `/chats/${chatId}/${route.suffix}`,
      route.suffix === 'backfill'
        ? { method: route.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(window) }
        : { method: route.method },
    );
  describe(`${route.method} /chats/:id/${route.suffix}`, () => {
    test('a chat outside the restricted key answers the same not-found body as a missing chat', async () => {
      const f = mount([INSTANCE_A]);
      const elsewhere = await request(f.app, CHAT_B);
      const missing = await request(f.app, MISSING);
      expect(elsewhere.status).toBe(404);
      expect(missing.status).toBe(404);
      const elsewhereBody = JSON.stringify(await elsewhere.json()).replaceAll(CHAT_B, '<chat>');
      const missingBody = JSON.stringify(await missing.json()).replaceAll(MISSING, '<chat>');
      expect(elsewhereBody).toBe(missingBody);
      expect(f.calls.jobs).toEqual([]);
    });
    test('a chat inside the restricted key works', async () => {
      const f = mount([INSTANCE_A]);
      expect((await request(f.app, CHAT_A)).status).toBe(route.status);
      expect(f.calls.jobs).toEqual(route.calls);
    });
    test('an unrestricted key keeps its existing behavior and one chat read', async () => {
      const f = mount(null, CHAT_B);
      expect((await request(f.app, CHAT_B)).status).toBe(route.status);
      expect(f.calls.chats).toEqual([CHAT_B]);
      expect(f.calls.jobs).toEqual(route.calls);
    });
  });
}
