import { randomUUID, timingSafeEqual } from 'node:crypto';

import { verifyConnectorToken } from '../connector/jwt';
import type { ZenviaConnectorRuntime } from '../connector/runtime';
import type { ZenviaConnectorConfig } from '../connector/types';
import type { ZenviaPlugin } from '../plugin';
import { handleZenviaEvent } from './webhook';

export const MAX_CONNECTOR_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CHANNELS_BODY_BYTES = 1024 * 1024;

const TOKEN_HEADER = 'x-webhook-token';
const TOKEN_QUERY_PARAM = 'token';

function json(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ...extra, requestId: randomUUID(), message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function verifyTokenMatches(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const supplied = request.headers.get(TOKEN_HEADER) ?? new URL(request.url).searchParams.get(TOKEN_QUERY_PARAM);
  if (supplied === null) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function shapeOf(body: unknown): 'connector' | 'channels' | 'unknown' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const record = body as Record<string, unknown>;
  if (typeof record.action === 'string') return 'connector';
  if (typeof record.type === 'string') return 'channels';
  return 'unknown';
}

async function readJson(
  request: Request,
  limit: number,
): Promise<{ ok: true; body: unknown; size: number } | { ok: false }> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return { ok: false };
  try {
    const bytes = await readLimited(request, limit);
    if (!bytes) return { ok: false };
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)), size: bytes.byteLength };
  } catch {
    return { ok: false };
  }
}

async function readLimited(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function handleZenviaConnectorWebhookRequest(
  request: Request,
  plugin: ZenviaPlugin,
  instanceId: string,
  runtime: ZenviaConnectorRuntime,
  config: { connector: ZenviaConnectorConfig; webhookVerifyToken?: string },
): Promise<Response> {
  const logger = plugin.getLogger();
  const auth = verifyConnectorToken(request.headers.get('authorization'), config.connector);
  const tokenOk = verifyTokenMatches(request, config.webhookVerifyToken);

  if (!auth.ok && !tokenOk) {
    logger.warn('[zenvia] connector webhook rejected: authorization did not verify', {
      instanceId,
      reason: auth.reason,
      scheme: auth.scheme,
      alg: auth.alg,
      hasVerifyTokenParam:
        request.headers.has(TOKEN_HEADER) || new URL(request.url).searchParams.has(TOKEN_QUERY_PARAM),
    });
    return json(401, 'Unauthorized');
  }

  const read = await readJson(request, MAX_CONNECTOR_BODY_BYTES);
  if (!read.ok) {
    logger.warn('[zenvia] connector webhook body is too large or not JSON', { instanceId });
    return json(400, 'invalid body');
  }

  const shape = shapeOf(read.body);
  if (shape === 'channels') {
    if (!tokenOk) {
      logger.warn('[zenvia] Channels API event on a connector instance without the verify token', { instanceId });
      return json(401, 'Unauthorized');
    }
    if (read.size > MAX_CHANNELS_BODY_BYTES) return new Response('OK', { status: 200 });
    try {
      await handleZenviaEvent(plugin, instanceId, read.body);
    } catch {
      return new Response('Service Unavailable', { status: 503 });
    }
    return new Response('OK', { status: 200 });
  }

  if (shape !== 'connector') return json(400, 'missing action');
  if (!auth.ok) {
    logger.warn('[zenvia] connector event rejected: the verify token does not authorize connector events', {
      instanceId,
      reason: auth.reason,
      scheme: auth.scheme,
    });
    return json(401, 'Unauthorized');
  }

  try {
    const result = await runtime.handleEvent(read.body);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    logger.error('[zenvia] connector event failed', { instanceId, error: String(err) });
    return json(500, 'Unexpected error. Please contact support.');
  }
}
