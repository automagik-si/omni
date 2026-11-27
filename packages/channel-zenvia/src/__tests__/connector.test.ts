import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signConnectorToken, verifyConnectorToken } from '../connector/jwt';
import { connectorPhone, userTextsAfterLastBot } from '../connector/mapping';
import { ZenviaPlugin } from '../plugin';
import { MockEventBus, createContext, instanceId, jsonResponse, publicHostResolver } from './helpers';

const SLUG = 'tenant-slug';
const INTEGRATION_ID = '42';
const ACCESS_TOKEN = 'connector-access-token';
const ACCESS_KEY = 'connector-access-key';
const CREDENTIALS = { accessToken: ACCESS_TOKEN, accessKey: ACCESS_KEY };
const CONVERSATION_ID = '1be5e1d3-d949-44ab-86a7-6d032b0cd17e';
const OTHER_CONVERSATION_ID = '2be5e1d3-d949-44ab-86a7-6d032b0cd17e';
const IDENTIFIER = '6422fa06-dce1-11ea-87d0-0242ac130003';
const LOCAL_PHONE = '11900000001';
const CHAT_ID = '5511900000001';
const WEBHOOK_URL = `http://localhost/api/v2/channels/zenvia/${instanceId}/webhook`;
const ENDPOINT = `https://agent.altubots.com/altu-connector/${SLUG}/${INTEGRATION_ID}`;

type FetchSpy = ReturnType<typeof spyOn>;
type Published = { type: string; payload: unknown };

function connectorOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zenviaConnectorSlug: SLUG,
    zenviaConnectorIntegrationId: INTEGRATION_ID,
    zenviaConnectorAccessToken: ACCESS_TOKEN,
    zenviaConnectorAccessKey: ACCESS_KEY,
    zenviaHandoffRouting: { field: 'queue', groups: { 'queue-a': 'branch_a', 'queue-b': 'branch_b' } },
    zenviaHandoffGroupId: 'branch_default',
    ...extra,
  };
}

async function connect(plugin: ZenviaPlugin, extra: Record<string, unknown> = {}): Promise<void> {
  plugin.hostResolver = publicHostResolver;
  await plugin.connect(instanceId, { instanceId, credentials: {}, options: connectorOptions(extra) });
}

function bearer(nowMs = Date.now()): Record<string, string> {
  return { authorization: `Bearer ${signConnectorToken(CREDENTIALS, nowMs)}` };
}

function post(payload: unknown, headers: Record<string, string> = bearer()): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function openEvent(history?: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'OPEN_CONVERSATION',
    conversationId: CONVERSATION_ID,
    requestId: 'req-open-1',
    identifier: IDENTIFIER,
    parameters: {
      contact: {
        id: 'contact-1',
        name: 'Test Lead',
        phone: LOCAL_PHONE,
        channel: 'whatsapp',
        extra: { contact_info: { source: 'bot' } },
        ...(history ? { history } : {}),
      },
      extraInfo: { step: 'sales' },
    },
    timestamp: 1_797_000_000_000,
    ...overrides,
  };
}

function messageEvent(requestId: string, messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    action: 'SEND_MESSAGE',
    conversationID: CONVERSATION_ID,
    requestId,
    identifier: IDENTIFIER,
    parameters: { contact: { phone: LOCAL_PHONE, channel: 'whatsapp' }, messages },
    timestamp: 1_797_000_001_000,
    ...overrides,
  };
}

function received(eventBus: MockEventBus): Array<Record<string, unknown>> {
  return (eventBus.published as Published[])
    .filter((e) => e.type === 'message.received')
    .map((e) => e.payload as Record<string, unknown>);
}

function sentBodies(fetchSpy: FetchSpy): Array<Record<string, unknown>> {
  return fetchSpy.mock.calls
    .filter((args: unknown[]) => String(args[0]).startsWith(ENDPOINT))
    .map((args: unknown[]) => JSON.parse(String((args[1] as RequestInit).body)) as Record<string, unknown>);
}

function okFetch(extra: (body: Record<string, unknown>) => Record<string, unknown> = () => ({})): FetchSpy {
  return spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse({ requestId: `altu-${String(body.action)}`, message: 'OK', ...extra(body) });
  }) as unknown as typeof fetch);
}

function forgedToken(header: Record<string, unknown>, claims: Record<string, unknown>, key = ACCESS_KEY): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

describe('connector JWT', () => {
  const now = 1_797_000_000_000;
  const iat = Math.floor(now / 1000);

  it('signs HS256 tokens that live 60 seconds and verify with the same key', () => {
    const token = signConnectorToken(CREDENTIALS, now);
    const [header, payload] = token.split('.');
    expect(JSON.parse(Buffer.from(String(header), 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(String(payload), 'base64url').toString())).toEqual({
      access_token: ACCESS_TOKEN,
      iat,
      exp: iat + 60,
    });
    expect(verifyConnectorToken(`Bearer ${token}`, CREDENTIALS, now)).toEqual({ ok: true });
    expect(verifyConnectorToken(token, CREDENTIALS, now)).toEqual({ ok: true });
  });

  it('verifies HS256 whatever alg the token header claims', () => {
    const token = forgedToken({ alg: 'RS256', typ: 'JWT' }, { access_token: ACCESS_TOKEN, iat, exp: iat + 60 });
    expect(verifyConnectorToken(`Bearer ${token}`, CREDENTIALS, now)).toEqual({ ok: true });
  });

  it('rejects a missing, malformed, mis-signed, foreign, expired or long-lived token', () => {
    const claims = { access_token: ACCESS_TOKEN, iat, exp: iat + 60 };
    const cases: Array<[string | null, string]> = [
      [null, 'missing'],
      ['Basic abc', 'malformed'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, claims, 'other-key')}`, 'bad-signature'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, { ...claims, access_token: 'other' })}`, 'wrong-access-token'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, { ...claims, iat: iat - 200, exp: iat - 140 })}`, 'expired'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, { ...claims, exp: iat + 3600 })}`, 'lifetime-too-long'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, { ...claims, iat: iat + 300, exp: iat + 360 })}`, 'issued-in-future'],
      [`Bearer ${forgedToken({ alg: 'HS256' }, { access_token: ACCESS_TOKEN })}`, 'malformed'],
    ];
    for (const [header, reason] of cases) {
      const result = verifyConnectorToken(header, CREDENTIALS, now);
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.reason).toBe(reason as never);
    }
  });

  it('tolerates 30 seconds of clock skew past exp', () => {
    const token = signConnectorToken(CREDENTIALS, now);
    expect(verifyConnectorToken(token, CREDENTIALS, now + 85_000).ok).toBe(true);
    expect(verifyConnectorToken(token, CREDENTIALS, now + 95_000).ok).toBe(false);
  });
});

describe('connector mapping', () => {
  it('prefixes the country code to a local phone and keeps a full one', () => {
    expect(connectorPhone('11900000001')).toBe('5511900000001');
    expect(connectorPhone('1140000001')).toBe('551140000001');
    expect(connectorPhone('+55 (11) 90000-0001')).toBe('5511900000001');
    expect(connectorPhone('5511900000001')).toBe('5511900000001');
    expect(connectorPhone('')).toBeUndefined();
    expect(connectorPhone(undefined)).toBeUndefined();
  });

  it('keeps only the user lines after the last bot line', () => {
    const history = [
      { sender: 'user', message: 'first' },
      { sender: 'bot', message: [{ default: { text: 'menu', type: 'text' } }] },
      { sender: 'user', message: 'second' },
      { sender: 'user', message: 'third' },
    ];
    expect(userTextsAfterLastBot(history)).toBe('second\nthird');
    expect(userTextsAfterLastBot(history.slice(0, 2))).toBe('');
    expect(userTextsAfterLastBot([{ sender: 'user', message: 'only' }])).toBe('only');
    expect(userTextsAfterLastBot(undefined)).toBe('');
  });
});

describe('connector mode', () => {
  let plugin: ZenviaPlugin;
  let eventBus: MockEventBus;
  let fetchSpy: FetchSpy | undefined;

  beforeEach(async () => {
    plugin = new ZenviaPlugin();
    eventBus = new MockEventBus();
    await plugin.initialize(createContext(eventBus));
  });

  afterEach(async () => {
    await plugin.getInstanceState(instanceId)?.connector?.settle();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  describe('connect', () => {
    it('connects without a Channels API token or sender and calls nothing at Zenvia', async () => {
      fetchSpy = okFetch();
      await connect(plugin);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(plugin.getInstanceState(instanceId)?.connector).toBeDefined();
      const health = await plugin.getHealth(instanceId);
      expect(health.status).toBe('healthy');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a slug without the integration credentials', async () => {
      await expect(
        plugin.connect(instanceId, {
          instanceId,
          credentials: {},
          options: { zenviaConnectorSlug: SLUG, zenviaConnectorIntegrationId: INTEGRATION_ID },
        }),
      ).rejects.toThrow('zenviaConnectorAccessToken, zenviaConnectorAccessKey');
    });

    it('refuses an unknown env', async () => {
      await expect(connect(plugin, { zenviaConnectorEnv: 'staging' })).rejects.toThrow('zenviaConnectorEnv');
    });
  });

  describe('webhook auth', () => {
    it('answers 401 JSON to a request without a valid token and publishes nothing', async () => {
      await connect(plugin);
      const attempts: Array<Record<string, string>> = [{}, { authorization: 'Bearer nope.nope.nope' }];
      for (const headers of attempts) {
        const res = await plugin.handleWebhook(post(messageEvent('req-x', ['hi']), headers));
        expect(res.status).toBe(401);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.message).toBe('Unauthorized');
        expect(typeof body.requestId).toBe('string');
      }
      expect(received(eventBus)).toEqual([]);
    });

    it('does not let the Channels API verify token authorize a connector event', async () => {
      await connect(plugin, { webhookVerifyToken: 'channels-secret' });

      const viaToken = await plugin.handleWebhook(
        post(messageEvent('req-t', ['hi']), { 'x-webhook-token': 'channels-secret' }),
      );
      expect(viaToken.status).toBe(401);

      const channelsEvent = await plugin.handleWebhook(
        post({ type: 'MESSAGE_STATUS', messageStatus: { code: 'SENT' } }, { 'x-webhook-token': 'channels-secret' }),
      );
      expect(channelsEvent.status).toBe(200);
      expect(received(eventBus)).toEqual([]);
    });

    it('answers 400 to a body that is not an event', async () => {
      await connect(plugin);
      const res = await plugin.handleWebhook(post({ hello: 'world' }));
      expect(res.status).toBe(400);
    });

    it('refuses a declared body above the connector limit before reading it', async () => {
      await connect(plugin);
      const request = new Request(WEBHOOK_URL, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024), ...bearer() },
      });
      expect((await plugin.handleWebhook(request)).status).toBe(400);
    });
  });

  describe('OPEN_CONVERSATION', () => {
    it('stores the session, accepts it and publishes the lead lines after the last bot line once', async () => {
      fetchSpy = okFetch();
      await connect(plugin);

      const history = [
        { sender: 'user', message: 'oi' },
        { sender: 'bot', message: [{ default: { text: 'menu', type: 'text' } }] },
        { sender: 'user', message: 'quero um plano' },
        { sender: 'user', message: 'para duas pessoas' },
      ];
      const res = await plugin.handleWebhook(post(openEvent(history)));
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).message).toBe('OK');
      await plugin.getInstanceState(instanceId)?.connector?.settle();

      const [accept] = sentBodies(fetchSpy);
      expect(accept).toMatchObject({
        action: 'ACCEPT_CONVERSATION',
        conversationId: CONVERSATION_ID,
        parameters: { agent: { id: instanceId, name: 'Omni' } },
      });
      expect(typeof accept?.timestamp).toBe('number');
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(ENDPOINT);
      const auth = (init.headers as Record<string, string>).Authorization ?? '';
      expect(verifyConnectorToken(auth, CREDENTIALS).ok).toBe(true);

      const [message] = received(eventBus);
      expect(message).toMatchObject({
        externalId: 'req-open-1',
        chatId: CHAT_ID,
        from: CHAT_ID,
        senderName: 'Test Lead',
        sessionStart: true,
        content: { type: 'text', text: 'quero um plano\npara duas pessoas' },
      });
      const raw = message?.rawPayload as Record<string, unknown>;
      expect(raw.extraInfo).toEqual({ step: 'sales' });
      expect(raw.contactInfo).toEqual({ source: 'bot' });
      expect((raw.zenviaConnector as Record<string, unknown>).action).toBe('OPEN_CONVERSATION');

      const session = await plugin.getInstanceState(instanceId)?.connector?.sessions.get(CHAT_ID);
      expect(session).toMatchObject({ conversationId: CONVERSATION_ID, identifier: IDENTIFIER, started: true });

      await plugin.handleWebhook(post(messageEvent('req-2', ['tem desconto?'])));
      const [, next] = received(eventBus);
      expect(next).toMatchObject({ externalId: 'req-2', content: { text: 'tem desconto?' } });
      expect(next).not.toHaveProperty('sessionStart');
    });

    it('publishes nothing when the history ends on a bot line, then marks the first SEND_MESSAGE', async () => {
      fetchSpy = okFetch();
      await connect(plugin);

      await plugin.handleWebhook(post(openEvent([{ sender: 'bot', message: [] }])));
      expect(received(eventBus)).toEqual([]);

      await plugin.handleWebhook(post(messageEvent('req-1', ['oi', 'tudo bem?'])));
      await plugin.handleWebhook(post(messageEvent('req-2', ['?'])));
      await plugin.handleWebhook(post(messageEvent('req-2', ['?'])));

      const messages = received(eventBus);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        externalId: 'req-1',
        sessionStart: true,
        content: { text: 'oi\ntudo bem?' },
      });
      expect(messages[1]).not.toHaveProperty('sessionStart');
    });

    it('uses the identifier when the contact has no phone', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      const event = openEvent([{ sender: 'user', message: 'oi' }]);
      (event.parameters as { contact: Record<string, unknown> }).contact.phone = undefined;

      await plugin.handleWebhook(post(event));

      expect(received(eventBus)[0]?.chatId).toBe(IDENTIFIER);
    });

    it('a new OPEN for the same contact replaces the session and starts it again', async () => {
      fetchSpy = okFetch();
      await connect(plugin);

      await plugin.handleWebhook(post(openEvent([{ sender: 'user', message: 'a' }])));
      await plugin.handleWebhook(
        post(openEvent([{ sender: 'user', message: 'b' }], { conversationId: OTHER_CONVERSATION_ID, requestId: 'r2' })),
      );

      const messages = received(eventBus);
      expect(messages.map((m) => m.sessionStart)).toEqual([true, true]);
      const runtime = plugin.getInstanceState(instanceId)?.connector;
      expect((await runtime?.sessions.get(CHAT_ID))?.conversationId).toBe(OTHER_CONVERSATION_ID);
      expect(await runtime?.sessions.chatOf(CONVERSATION_ID)).toBeUndefined();
    });

    it('ignores a delayed message of a replaced conversation and keeps the new session', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.handleWebhook(
        post(openEvent(undefined, { conversationId: OTHER_CONVERSATION_ID, requestId: 'r2' })),
      );

      const res = await plugin.handleWebhook(post(messageEvent('late-a', ['old'])));

      expect(res.status).toBe(200);
      expect(received(eventBus)).toEqual([]);
      const runtime = plugin.getInstanceState(instanceId)?.connector;
      expect((await runtime?.sessions.get(CHAT_ID))?.conversationId).toBe(OTHER_CONVERSATION_ID);
    });

    it('adopts a message of an unknown conversation when the open was missed', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      await plugin.handleWebhook(post(messageEvent('new-b', ['hi'], { conversationID: OTHER_CONVERSATION_ID })));

      expect(received(eventBus)[0]).toMatchObject({ externalId: 'new-b', sessionStart: true });
      const runtime = plugin.getInstanceState(instanceId)?.connector;
      expect((await runtime?.sessions.get(CHAT_ID))?.conversationId).toBe(OTHER_CONVERSATION_ID);
    });

    it('does not publish human takeover events in live chat mode', async () => {
      await connect(plugin, { webhookVerifyToken: 'channels-secret', zenviaSenderId: '551140000000' });

      await plugin.handleWebhook(
        post(
          {
            type: 'CONVERSATION_STATUS',
            conversation: {
              id: 'c1',
              status: 'CLAIMED',
              userId: 'u1',
              channel: 'whatsapp',
              from: '551140000000',
              to: CHAT_ID,
            },
          },
          { 'x-webhook-token': 'channels-secret' },
        ),
      );

      expect((eventBus.published as Published[]).some((e) => e.type === 'chat.human_takeover')).toBe(false);
    });

    it('retries a failed ACCEPT_CONVERSATION once without holding the 200', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
        jsonResponse({ message: 'Unexpected error' }, 500)) as unknown as typeof fetch);
      await connect(plugin);

      const res = await plugin.handleWebhook(post(openEvent()));
      expect(res.status).toBe(200);
      await plugin.getInstanceState(instanceId)?.connector?.settle();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('SEND_MESSAGE', () => {
    it('publishes a location and rejects an event without conversation id', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      await plugin.handleWebhook(
        post({
          ...messageEvent('req-loc', []),
          parameters: { contact: { phone: LOCAL_PHONE }, location: { latitude: -22.42, longitude: -45.46 } },
        }),
      );
      expect(received(eventBus)[0]).toMatchObject({ content: { type: 'location', text: '-22.42,-45.46' } });

      const res = await plugin.handleWebhook(post({ action: 'SEND_MESSAGE', parameters: { messages: ['x'] } }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).message).toBe('missing conversationId');
    });
  });

  describe('files', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    it('stores an UPLOAD_FILE sent as a Node Buffer and turns SEND_FILE into a media message', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      const upload = await plugin.handleWebhook(
        post({
          action: 'UPLOAD_FILE',
          conversationID: CONVERSATION_ID,
          file: { contentType: 'image/png', buffer: png.toJSON() },
          timestamp: 1,
        }),
      );
      expect(upload.status).toBe(200);
      const uploaded = (await upload.json()) as { fileId: string; message: string; requestId: string };
      expect(uploaded.message).toBe('OK');
      expect(uploaded.fileId).toBeTruthy();

      await plugin.handleWebhook(
        post({
          action: 'SEND_FILE',
          conversationID: CONVERSATION_ID,
          requestId: 'req-file',
          parameters: {
            contact: { phone: LOCAL_PHONE },
            file: { id: uploaded.fileId, name: 'photo.png', contentType: 'image/png', caption: 'my card' },
          },
        }),
      );
      const [message] = received(eventBus);
      expect(message).toMatchObject({
        externalId: 'req-file',
        sessionStart: true,
        content: { type: 'image', mimeType: 'image/png', text: 'my card' },
      });
      const mediaId = String((message?.content as Record<string, unknown>).mediaId);

      const downloaded = await plugin.downloadInboundMedia(instanceId, mediaId);
      expect(downloaded.mimeType).toBe('image/png');
      expect(Buffer.compare(downloaded.buffer, png)).toBe(0);

      const got = await plugin.handleWebhook(post({ action: 'GET_FILE', fileId: uploaded.fileId, requestId: 'g' }));
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({
        message: 'OK',
        file: { contentLength: png.length, contentType: 'image/png', type: 'png', buffer: png.toJSON() },
      });
    });

    it('accepts a base64 buffer and answers 404 to an unknown GET_FILE', async () => {
      await connect(plugin);

      const upload = await plugin.handleWebhook(
        post({ action: 'UPLOAD_FILE', file: { contentType: 'application/pdf', buffer: png.toString('base64') } }),
      );
      expect(upload.status).toBe(200);

      const missing = await plugin.handleWebhook(post({ action: 'GET_FILE', fileId: 'nope' }));
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as Record<string, unknown>).message).toBe('not found');

      const bad = await plugin.handleWebhook(
        post({ action: 'UPLOAD_FILE', file: { buffer: { type: 'Buffer', data: [999] } } }),
      );
      expect(bad.status).toBe(400);
    });
  });

  describe('CLOSE_CONVERSATION', () => {
    it('drops the session so the agent can no longer write to the contact', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      const res = await plugin.handleWebhook(
        post({ action: 'CLOSE_CONVERSATION', conversationId: CONVERSATION_ID, identifier: IDENTIFIER, requestId: 'c' }),
      );
      expect(res.status).toBe(200);

      const result = await plugin.sendMessage(instanceId, { to: CHAT_ID, content: { type: 'text', text: 'hi' } });
      expect(result).toMatchObject({ success: false, retryable: false, rejected: true });
      expect(result.error).toBe('no open Zenvia live chat for this contact');
    });
  });

  describe('outbound', () => {
    it('sends text as SEND_MESSAGE with the WhatsApp formatting', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();
      fetchSpy.mockClear();

      const result = await plugin.sendMessage(instanceId, {
        to: CHAT_ID,
        content: { type: 'text', text: '**Olá**' },
      });

      expect(result).toMatchObject({ success: true, messageId: 'altu-SEND_MESSAGE' });
      expect(sentBodies(fetchSpy)).toEqual([
        {
          action: 'SEND_MESSAGE',
          conversationId: CONVERSATION_ID,
          parameters: { agent: { id: instanceId, name: 'Omni' }, messages: ['*Olá*'] },
          timestamp: expect.any(Number),
        },
      ]);
      expect((eventBus.published as Published[]).some((e) => e.type === 'message.sent')).toBe(true);
    });

    it('signs every call with the bare JWT, without a Bearer scheme', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();

      const headers = fetchSpy.mock.calls.map(
        (args: unknown[]) => ((args[1] as RequestInit).headers as Record<string, string>).Authorization,
      );
      expect(headers.length).toBeGreaterThan(0);
      for (const header of headers) {
        expect(header).not.toStartWith('Bearer');
        expect(header?.split('.')).toHaveLength(3);
        expect(verifyConnectorToken(header ?? null, CREDENTIALS)).toEqual({ ok: true });
      }
    });

    it('appends the env to the endpoint', async () => {
      fetchSpy = okFetch();
      await connect(plugin, { zenviaConnectorEnv: 'homol' });
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();

      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`${ENDPOINT}?env=homol`);
    });

    it('maps a 5xx to a retryable failure and a 400 to a definitive refusal', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();

      fetchSpy.mockImplementation((async () => jsonResponse({ message: 'boom' }, 500)) as unknown as typeof fetch);
      const upstream = await plugin.sendMessage(instanceId, { to: CHAT_ID, content: { type: 'text', text: 'a' } });
      expect(upstream).toMatchObject({ success: false, retryable: true, errorCode: 'ZENVIA_UPSTREAM_ERROR' });

      fetchSpy.mockImplementation((async () =>
        jsonResponse({ message: 'missing conversationId' }, 400)) as unknown as typeof fetch);
      const invalid = await plugin.sendMessage(instanceId, { to: CHAT_ID, content: { type: 'text', text: 'a' } });
      expect(invalid).toMatchObject({ success: false, retryable: false, rejected: true });

      fetchSpy.mockImplementation((async () => jsonResponse({ message: 'nope' }, 200)) as unknown as typeof fetch);
      const notOk = await plugin.sendMessage(instanceId, { to: CHAT_ID, content: { type: 'text', text: 'a' } });
      expect(notOk).toMatchObject({ success: false, retryable: false, rejected: true });
    });

    it('reports a delivered file as sent even when the caption after it fails', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zenvia-connector-'));
      const path = join(dir, 'card.png');
      await writeFile(path, Buffer.from([1, 2, 3]));
      try {
        fetchSpy = okFetch();
        await connect(plugin);
        await plugin.handleWebhook(post(openEvent()));
        await plugin.getInstanceState(instanceId)?.connector?.settle();
        fetchSpy.mockImplementation((async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (body.action === 'SEND_MESSAGE') return jsonResponse({ message: 'down' }, 503);
          return jsonResponse({ requestId: 'r', message: 'OK', fileId: 'altu-file-2' });
        }) as unknown as typeof fetch);

        const result = await plugin.sendMessage(instanceId, {
          to: CHAT_ID,
          content: { type: 'image', localPath: path, mimeType: 'image/png', caption: 'your card' },
        });

        expect(result.success).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('uploads a local file and sends it, then the caption', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zenvia-connector-'));
      const path = join(dir, 'card.png');
      await writeFile(path, Buffer.from([1, 2, 3]));
      try {
        fetchSpy = okFetch((body) => (body.action === 'UPLOAD_FILE' ? { fileId: 'altu-file-1' } : {}));
        await connect(plugin);
        await plugin.handleWebhook(post(openEvent()));
        await plugin.getInstanceState(instanceId)?.connector?.settle();
        fetchSpy.mockClear();

        const result = await plugin.sendMessage(instanceId, {
          to: CHAT_ID,
          content: { type: 'image', localPath: path, mimeType: 'image/png', caption: 'your card' },
        });

        expect(result.success).toBe(true);
        const bodies = sentBodies(fetchSpy);
        expect(bodies.map((b) => b.action)).toEqual(['UPLOAD_FILE', 'SEND_FILE', 'SEND_MESSAGE']);
        expect(bodies[0]).toMatchObject({
          conversationId: CONVERSATION_ID,
          file: { contentType: 'image/png', buffer: { type: 'Buffer', data: [1, 2, 3] } },
        });
        expect(bodies[1]).toMatchObject({ parameters: { file: { id: 'altu-file-1' } } });
        expect(bodies[2]).toMatchObject({ parameters: { messages: ['your card'] } });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses a template in a live chat', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      const result = await plugin.sendMessage(instanceId, {
        to: CHAT_ID,
        content: { type: 'template' },
        metadata: { template: { id: 't' } },
      });
      expect(result).toMatchObject({ success: false, rejected: true });
    });
  });

  describe('handoff', () => {
    const handoff = (queue?: string) => ({
      to: CHAT_ID,
      content: { type: 'text' as const, text: 'A person will take it from here.' },
      metadata: { isHandoff: true, motivoHandoff: 'asked for a person', handoffFields: queue ? { queue } : {} },
    });

    it('sends the farewell, closes with the mapped queue, drops the session and does not pause the agent', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();
      fetchSpy.mockClear();

      const result = await plugin.sendMessage(instanceId, handoff('Queue-B'));

      expect(result).toMatchObject({ success: true, pauseAgent: false });
      expect(sentBodies(fetchSpy)).toEqual([
        {
          action: 'SEND_MESSAGE',
          conversationId: CONVERSATION_ID,
          parameters: { agent: { id: instanceId, name: 'Omni' }, messages: ['A person will take it from here.'] },
          timestamp: expect.any(Number),
        },
        {
          action: 'CLOSE_CONVERSATION',
          conversationId: CONVERSATION_ID,
          reason: 'branch_b',
          timestamp: expect.any(Number),
        },
      ]);
      expect(await plugin.getInstanceState(instanceId)?.connector?.sessions.get(CHAT_ID)).toBeUndefined();
    });

    it('closes with the default queue when the value is not mapped', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));

      await plugin.sendMessage(instanceId, handoff('unknown'));

      expect(sentBodies(fetchSpy).at(-1)).toMatchObject({ action: 'CLOSE_CONVERSATION', reason: 'branch_default' });
    });

    it('refuses before sending anything when no queue is configured', async () => {
      fetchSpy = okFetch();
      await connect(plugin, { zenviaHandoffRouting: undefined, zenviaHandoffGroupId: undefined });
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();
      fetchSpy.mockClear();

      const result = await plugin.sendMessage(instanceId, handoff('queue-a'));

      expect(result).toMatchObject({ success: false, rejected: true, retryable: false });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await plugin.getInstanceState(instanceId)?.connector?.sessions.get(CHAT_ID)).toBeDefined();
    });

    it('keeps the session and reports the failure when the close keeps failing', async () => {
      fetchSpy = okFetch();
      await connect(plugin);
      await plugin.handleWebhook(post(openEvent()));
      await plugin.getInstanceState(instanceId)?.connector?.settle();
      fetchSpy.mockImplementation((async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return body.action === 'CLOSE_CONVERSATION'
          ? jsonResponse({ message: 'down' }, 503)
          : jsonResponse({ requestId: 'r', message: 'OK' });
      }) as unknown as typeof fetch);

      const result = await plugin.sendMessage(instanceId, handoff('queue-a'));

      expect(result).toMatchObject({ success: false, retryable: true });
      expect(sentBodies(fetchSpy).filter((b) => b.action === 'CLOSE_CONVERSATION')).toHaveLength(2);
      expect(await plugin.getInstanceState(instanceId)?.connector?.sessions.get(CHAT_ID)).toBeDefined();
    });
  });
});
