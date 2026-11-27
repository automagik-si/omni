import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { buildInstanceConnectOptions } from '../../../plugins/instance-monitor';
import type { AppVariables } from '../../../types';
import { instancesRoutes } from '../instances';

const INSTANCE_ID = '99999999-9999-4999-8999-999999999999';

const CONNECTOR = {
  zenviaConnectorSlug: 'tenant-slug',
  zenviaConnectorIntegrationId: '42',
  zenviaConnectorAccessToken: 'persisted-access-token',
  zenviaConnectorAccessKey: 'persisted-access-key',
  zenviaConnectorEnv: 'homol',
  zenviaConnectorReopenExpirationMinutes: 1440,
} as const;

interface Captured {
  connectOptions?: Record<string, unknown>;
  created?: Record<string, unknown>;
  updated?: Record<string, unknown>;
}

function mount(captured: Captured, instanceOverrides: Record<string, unknown> = {}) {
  const app = new Hono<{ Variables: AppVariables }>();

  const instance = {
    id: INSTANCE_ID,
    name: 'zv-live-chat',
    channel: 'zenvia',
    zenviaHandoffGroupId: 'branch_default',
    ...CONNECTOR,
    ...instanceOverrides,
  };

  app.use('*', async (c, next) => {
    c.set('services', {
      instances: {
        getById: mock(async () => instance),
        create: mock(async (data: Record<string, unknown>) => {
          captured.created = data;
          return { ...instance, ...data };
        }),
        update: mock(async (_id: string, data: Record<string, unknown>) => {
          captured.updated = data;
          return { ...instance, ...data };
        }),
        updateStatus: mock(async () => instance),
      },
    } as never);

    c.set('channelRegistry', {
      get: () => ({
        id: 'zenvia',
        capabilities: {},
        connect: mock(async (_id: string, config: Record<string, unknown>) => {
          captured.connectOptions = config.options as Record<string, unknown>;
        }),
        disconnect: mock(async () => {}),
        getStatus: mock(async () => ({ state: 'connected' })),
      }),
    } as never);

    c.set('apiKey', { id: 'test', name: 'test', scopes: ['*'], instanceIds: null, expiresAt: null } as never);

    await next();
  });

  app.route('/', instancesRoutes);
  return app;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('POST /instances - Zenvia live chat fields', () => {
  test('are persisted and handed to the plugin without a Channels API token or sender', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request('/', json('POST', { name: 'zv-live-chat', channel: 'zenvia', ...CONNECTOR }));

    expect(res.status).toBe(201);
    expect(captured.created).toMatchObject(CONNECTOR);
    expect(captured.connectOptions).toMatchObject(CONNECTOR);
    expect(captured.connectOptions).not.toHaveProperty('zenviaApiToken');
  });

  test('names the live chat agent after the instance', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    await app.request('/', json('POST', { name: 'zv-live-chat', channel: 'zenvia', ...CONNECTOR }));

    expect(captured.connectOptions).toMatchObject({ zenviaConnectorAgentName: 'zv-live-chat' });
  });

  test('rejects a reopen expiration that is not a whole number of minutes in range', async () => {
    for (const minutes of [0, 1.5, 10_081, '60']) {
      const captured: Captured = {};
      const app = mount(captured);

      const res = await app.request(
        '/',
        json('POST', {
          name: 'zv-live-chat',
          channel: 'zenvia',
          ...CONNECTOR,
          zenviaConnectorReopenExpirationMinutes: minutes,
        }),
      );

      expect(res.status).toBe(400);
      expect(captured.created).toBeUndefined();
    }
  });

  test('rejects an unknown env before anything is written', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request(
      '/',
      json('POST', { name: 'zv-live-chat', channel: 'zenvia', ...CONNECTOR, zenviaConnectorEnv: 'staging' }),
    );

    expect(res.status).toBe(400);
    expect(captured.created).toBeUndefined();
  });

  test('never returns the access token or key', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request('/', json('POST', { name: 'zv-live-chat', channel: 'zenvia', ...CONNECTOR }));
    const text = await res.text();

    expect(text).not.toContain('persisted-access-token');
    expect(text).not.toContain('persisted-access-key');
    expect(text).toContain('tenant-slug');
  });
});

describe('PATCH /instances/:id - Zenvia live chat fields', () => {
  test('are forwarded to the update and null clears them', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request(
      `/${INSTANCE_ID}`,
      json('PATCH', {
        zenviaConnectorAccessKey: 'rotated-key',
        zenviaConnectorEnv: null,
        zenviaConnectorReopenExpirationMinutes: null,
      }),
    );

    expect(res.status).toBe(200);
    expect(captured.updated?.zenviaConnectorAccessKey).toBe('rotated-key');
    expect(captured.updated).toHaveProperty('zenviaConnectorEnv', null);
    expect(captured.updated).toHaveProperty('zenviaConnectorReopenExpirationMinutes', null);
  });
});

describe('POST /instances/:id/connect - the persisted live chat config reaches the plugin', () => {
  test('hydrates every connector field from the row', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request(`/${INSTANCE_ID}/connect`, json('POST', {}));

    expect(res.status).toBe(200);
    expect(captured.connectOptions).toMatchObject({ ...CONNECTOR, zenviaConnectorAgentName: 'zv-live-chat' });
    for (const field of Object.keys(CONNECTOR)) expect(captured.updated ?? {}).not.toHaveProperty(field);
  });

  test('a body value wins over the row and is persisted', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request(
      `/${INSTANCE_ID}/connect`,
      json('POST', {
        zenviaConnectorAccessToken: 'new-token',
        zenviaConnectorEnv: 'prod',
        zenviaConnectorReopenExpirationMinutes: 60,
      }),
    );

    expect(res.status).toBe(200);
    expect(captured.connectOptions).toMatchObject({
      zenviaConnectorAccessToken: 'new-token',
      zenviaConnectorEnv: 'prod',
      zenviaConnectorReopenExpirationMinutes: 60,
    });
    expect(captured.updated).toMatchObject({
      zenviaConnectorAccessToken: 'new-token',
      zenviaConnectorEnv: 'prod',
      zenviaConnectorReopenExpirationMinutes: 60,
    });
  });
});

describe('POST /instances/:id/restart - re-reads the live chat config', () => {
  test('threads the connector fields into the reconnect', async () => {
    const captured: Captured = {};
    const app = mount(captured);

    const res = await app.request(`/${INSTANCE_ID}/restart`, json('POST'));

    expect(res.status).toBe(200);
    expect(captured.connectOptions).toMatchObject({ ...CONNECTOR, zenviaConnectorAgentName: 'zv-live-chat' });
  });
});

describe('buildInstanceConnectOptions - boot reconnect', () => {
  test('carries the connector fields of a zenvia row and leaves other channels alone', () => {
    expect(buildInstanceConnectOptions({ channel: 'zenvia', name: 'zv-live-chat', ...CONNECTOR })).toMatchObject({
      ...CONNECTOR,
      zenviaConnectorAgentName: 'zv-live-chat',
    });
    expect(
      buildInstanceConnectOptions({ channel: 'zenvia', name: 'zv-channels', zenviaApiToken: 't', zenviaSenderId: 's' }),
    ).not.toHaveProperty('zenviaConnectorAgentName');
    expect(buildInstanceConnectOptions({ channel: 'gupshup', ...CONNECTOR })).not.toHaveProperty('zenviaConnectorSlug');
  });
});
