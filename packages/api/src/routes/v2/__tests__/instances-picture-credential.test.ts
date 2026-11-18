import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { instancesRoutes } from '../instances';

const id = '33333333-3333-4333-8333-333333333333';
const token = '123456:made-up-channel-credential';
const oldPicture = `https://api.telegram.org/file/bot${token}/photos/picture.jpg`;
const safePicture = 'https://example.com/picture.jpg';

function setup(channel: string, picture: string, newPicture?: string) {
  const row: Record<string, unknown> = { id, channel, profilePicUrl: picture };
  const update = mock(async (_id: string, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) row[key] = value;
    }
    return { ...row };
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('services', { instances: { getById: async () => row, update } } as never);
    c.set('channelRegistry', {
      get: () => ({ getProfile: async () => ({ name: 'Test', avatarUrl: newPicture, platformMetadata: {} }) }),
    } as never);
    c.set('apiKey', { id: 'test', name: 'test', scopes: ['*'], instanceIds: null, expiresAt: null } as never);
    await next();
  });
  app.route('/', instancesRoutes);
  return { app, row, update };
}

describe('Profile pictures protect the channel credential', () => {
  for (const path of ['sync/profile', 'sync']) {
    const sync = (app: ReturnType<typeof setup>['app']) =>
      app.request(`/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'profile' }),
      });

    test('a Telegram refresh clears an existing unsafe picture', async () => {
      const { app, row, update } = setup('telegram', oldPicture);
      const response = await sync(app);
      expect(response.status).toBe(200);
      expect(row.profilePicUrl).toBeNull();
      expect(update.mock.calls[0]?.[1].profilePicUrl).toBeNull();
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(JSON.parse(body).data.profile.avatarUrl).toBeNull();
      const read = await app.request(`/${id}`);
      expect(read.status).toBe(200);
      expect(await read.text()).not.toContain(token);
    });

    test('a Telegram refresh cannot save another unsafe picture', async () => {
      const { app, row } = setup('telegram', safePicture, oldPicture);
      const response = await sync(app);
      expect(response.status).toBe(200);
      expect(row.profilePicUrl).toBeNull();
      expect(await response.text()).not.toContain(token);
    });

    test('a missing picture from another channel preserves its saved picture', async () => {
      const { app, row } = setup('whatsapp-baileys', safePicture);
      const response = await sync(app);
      expect(response.status).toBe(200);
      expect(row.profilePicUrl).toBe(safePicture);
      const body = (await response.json()) as { data: { profile: { avatarUrl: string } } };
      expect(body.data.profile.avatarUrl).toBe(safePicture);
    });
  }
});
