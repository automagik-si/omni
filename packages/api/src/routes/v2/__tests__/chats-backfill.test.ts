import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { chatsRoutes } from '../chats';

const chatId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
function appFixture() {
  const created: unknown[] = [];
  const job = {
    id: jobId,
    instanceId: 'line',
    config: { backfill: { chatId, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' } },
    progress: { state: 'queued' },
  };
  let cancels = 0;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('services', {
      chats: { getById: async () => ({ id: chatId, instanceId: 'line', externalId: 'chat@jid' }) },
      instances: { getById: async () => ({ channel: 'whatsapp-baileys' }) },
      syncJobs: {
        create: async (input: unknown) => {
          created.push(input);
          return job;
        },
        getById: async () => job,
        updateProgress: async () => job,
        cancel: async () => {
          cancels++;
          return job;
        },
      },
      messages: { getChatCoverage: async () => ({ count: 0 }) },
    } as never);
    await next();
  });
  app.route('/chats', chatsRoutes);
  return { app, job, created, cancels: () => cancels };
}

describe('chat backfill routes', () => {
  test('queues exactly the resolved chat and range', async () => {
    const f = appFixture();
    const window = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
    const response = await f.app.request(`/chats/${chatId}/backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(window),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId });
    expect(f.created[0]).toMatchObject({ config: { backfill: { ...window, chatId, chatJid: 'chat@jid' } } });
  });
  test('rejects inverted ranges and an option to disable media', async () => {
    const f = appFixture();
    for (const body of [
      { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', downloadMedia: false },
    ]) {
      const response = await f.app.request(`/chats/${chatId}/backfill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(f.created).toEqual([]);
  });
  test('a job belonging to another chat cannot be read or cancelled through this chat', async () => {
    const f = appFixture();
    f.job.config.backfill.chatId = 'another-chat';
    expect((await f.app.request(`/chats/${chatId}/backfill/${jobId}`)).status).toBe(404);
    expect((await f.app.request(`/chats/${chatId}/backfill/${jobId}/cancel`, { method: 'POST' })).status).toBe(404);
    expect(f.cancels()).toBe(0);
  });
});
