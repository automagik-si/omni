/**
 * GupshupClient — unit tests
 *
 * Mocks fetch to verify:
 * - Correct request format (method, headers, body fields)
 * - Error classification (retryable vs non-retryable by HTTP status)
 * - Happy path response parsing
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { GupshupClient } from '../client';
import { GupshupError, isRetryable, mapGupshupError } from '../utils/errors';

const CALLBACK_URL = 'https://callbacks.gupshup.io/custom/abc123';
const AUTH_TOKEN = 'Bearer test-auth-token';
const EVENT_ID = 'nx_omni_agent_reply';

function makeClient(): GupshupClient {
  return new GupshupClient(CALLBACK_URL, AUTH_TOKEN, EVENT_ID);
}

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeErrorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GupshupClient — send TEXT', () => {
  it('sends correct request format', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));

    const client = makeClient();
    await client.send('5511888880000', { type: 'TEXT', text: 'Hello!' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CALLBACK_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(AUTH_TOKEN);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.customer_id).toBe('5511888880000');
    expect(body.event_id).toBe(EVENT_ID);
    expect(body.msg_type).toBe('TEXT');
    expect(body.message_text).toBe('Hello!');

    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — send IMAGE', () => {
  it('sends image with media_url and caption', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));

    const client = makeClient();
    await client.send('5511888880000', {
      type: 'IMAGE',
      url: 'https://cdn.example.com/photo.jpg',
      caption: 'Look at this',
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.msg_type).toBe('IMAGE');
    expect(body.media_url).toBe('https://cdn.example.com/photo.jpg');
    expect(body.caption).toBe('Look at this');

    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — send LOCATION', () => {
  it('sends location with lat/lng as strings', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));

    const client = makeClient();
    await client.send('5511888880000', {
      type: 'LOCATION',
      latitude: -23.5505,
      longitude: -46.6333,
      name: 'São Paulo',
      address: 'Av. Paulista',
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.msg_type).toBe('LOCATION');
    expect(body.latitude).toBe('-23.5505');
    expect(body.longitude).toBe('-46.6333');
    expect(body.name).toBe('São Paulo');
    expect(body.address).toBe('Av. Paulista');

    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — error classification', () => {
  it('throws GupshupError on non-ok response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeErrorResponse(403, { status: 'error', message: 'Forbidden' }),
    );

    const client = makeClient();
    let caught: unknown;
    try {
      await client.send('5511888880000', { type: 'TEXT', text: 'hi' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(GupshupError);

    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — validateCredentials', () => {
  it('returns true on 200', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

    const client = makeClient();
    expect(await client.validateCredentials()).toBe(true);
    fetchSpy.mockRestore();
  });

  it('returns false on 401', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = makeClient();
    expect(await client.validateCredentials()).toBe(false);
    fetchSpy.mockRestore();
  });

  it('returns false on 403', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const client = makeClient();
    expect(await client.validateCredentials()).toBe(false);
    fetchSpy.mockRestore();
  });

  it('returns false on fetch error', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const client = makeClient();
    expect(await client.validateCredentials()).toBe(false);
    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — send CLOSING close fields', () => {
  function postedBody(fetchSpy: ReturnType<typeof spyOn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  it('forwards close_reason, close_outcome and close_fields on CLOSING', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      makeOkResponse({ status: 'ok' })) as unknown as typeof fetch);
    const client = makeClient();

    await client.send('15550001111', {
      type: 'CLOSING',
      text: 'Goodbye',
      close_reason: 'customer already served elsewhere',
      close_outcome: 'redirected_sac',
      close_fields: { plan: 'basic', value: 99.9 },
    });

    const body = postedBody(fetchSpy);
    expect(body.msg_type).toBe('CLOSING');
    expect(body.message_text).toBe('Goodbye');
    expect(body.close_reason).toBe('customer already served elsewhere');
    expect(body.close_outcome).toBe('redirected_sac');
    expect(body.close_fields).toEqual({ plan: 'basic', value: 99.9 });
    fetchSpy.mockRestore();
  });

  it('sends an empty message_text for a close without farewell', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      makeOkResponse({ status: 'ok' })) as unknown as typeof fetch);
    const client = makeClient();

    await client.send('15550001111', { type: 'CLOSING', text: '', close_outcome: 'no_response' });

    const body = postedBody(fetchSpy);
    expect(body.message_text).toBe('');
    expect(body.close_outcome).toBe('no_response');
    expect(body).not.toHaveProperty('close_reason');
    expect(body).not.toHaveProperty('close_fields');
    fetchSpy.mockRestore();
  });

  it('drops close keys set on a non-CLOSING message', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      makeOkResponse({ status: 'ok' })) as unknown as typeof fetch);
    const client = makeClient();

    await client.send('15550001111', {
      type: 'TEXT',
      text: 'Hello!',
      close_reason: 'r',
      close_outcome: 'o',
      close_fields: { a: 1 },
    });

    const body = postedBody(fetchSpy);
    expect(body).not.toHaveProperty('close_reason');
    expect(body).not.toHaveProperty('close_outcome');
    expect(body).not.toHaveProperty('close_fields');
    fetchSpy.mockRestore();
  });

  it('does not add close keys to a regular TEXT message', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      makeOkResponse({ status: 'ok' })) as unknown as typeof fetch);
    const client = makeClient();

    await client.send('15550001111', { type: 'TEXT', text: 'Hello!' });

    const body = postedBody(fetchSpy);
    expect(body).not.toHaveProperty('close_reason');
    expect(body).not.toHaveProperty('close_outcome');
    expect(body).not.toHaveProperty('close_fields');
    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — send HANDOFF customerFields', () => {
  function postedBody(fetchSpy: ReturnType<typeof spyOn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  it('omits customerFields from the wire when not provided', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));
    const client = makeClient();

    await client.send('5511999990000', { type: 'HANDOFF', text: 'hi', handoff_fields: { queue: 'X' } });

    const body = postedBody(fetchSpy);
    expect(body).not.toHaveProperty('customerFields');
    expect(body.handoff_fields).toEqual({ queue: 'X' });
    fetchSpy.mockRestore();
  });

  it('posts customerFields verbatim, in order, when provided', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));
    const client = makeClient();

    await client.send('5511999990000', {
      type: 'HANDOFF',
      text: 'hi',
      handoff_fields: { queue: 'X' },
      customer_fields: [
        { apiKey: 'Queue', value: 'X' },
        { apiKey: 'Source', value: 'assistant' },
      ],
    });

    expect(postedBody(fetchSpy).customerFields).toEqual([
      { apiKey: 'Queue', value: 'X' },
      { apiKey: 'Source', value: 'assistant' },
    ]);
    fetchSpy.mockRestore();
  });

  it('omits customerFields when the array is empty', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkResponse({ status: 'ok' }));
    const client = makeClient();

    await client.send('5511999990000', { type: 'HANDOFF', text: 'hi', customer_fields: [] });

    expect(postedBody(fetchSpy)).not.toHaveProperty('customerFields');
    fetchSpy.mockRestore();
  });
});

describe('GupshupClient — connection reset', () => {
  const RESET_MESSAGE =
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';

  function connectionReset(): TypeError {
    return Object.assign(new TypeError(RESET_MESSAGE), { code: 'ECONNRESET' });
  }

  function clientWithoutDelay(): GupshupClient {
    return new GupshupClient(CALLBACK_URL, AUTH_TOKEN, EVENT_ID, 0);
  }

  async function sendError(client: GupshupClient): Promise<unknown> {
    try {
      await client.send('5511888880000', { type: 'TEXT', text: 'hi' });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('posts the same body once more when the connection is reset before a response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connectionReset())
      .mockResolvedValueOnce(makeOkResponse({ messageId: 'gs-1' }));
    try {
      const response = await clientWithoutDelay().send('5511888880000', { type: 'TEXT', text: 'Hello!' });

      expect(response).toEqual({ messageId: 'gs-1' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [first, second] = fetchSpy.mock.calls.map((call) => (call[1] as RequestInit).body);
      expect(second).toBe(first);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('gives up after the second reset, with the reset as the error', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connectionReset())
      .mockRejectedValueOnce(connectionReset());
    try {
      const error = await sendError(clientWithoutDelay());

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as { code?: string }).code).toBe('ECONNRESET');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not post again after another network error', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(new TypeError('Unable to connect'), { code: 'ConnectionRefused' }),
    );
    try {
      const error = await sendError(clientWithoutDelay());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((error as Error).message).toBe('Unable to connect');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not post again after an HTTP error response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeErrorResponse(503, { status: 'error' }));
    try {
      const error = await sendError(clientWithoutDelay());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(GupshupError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('classifies a reset by its code, which the message does not name', () => {
    expect(isRetryable(connectionReset())).toBe(true);
    expect(mapGupshupError(connectionReset()).recoverable).toBe(true);
    expect(isRetryable(new TypeError(RESET_MESSAGE))).toBe(false);
  });
});
