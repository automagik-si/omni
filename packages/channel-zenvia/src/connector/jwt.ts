import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONNECTOR_TOKEN_LIFETIME_SECONDS = 60;
export const CONNECTOR_CLOCK_SKEW_SECONDS = 30;

const SIGNED_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export interface ConnectorCredentials {
  accessToken: string;
  accessKey: string;
}

export type ConnectorTokenFailure =
  | 'missing'
  | 'malformed'
  | 'bad-signature'
  | 'wrong-access-token'
  | 'expired'
  | 'issued-in-future'
  | 'lifetime-too-long';

export type ConnectorTokenCheck =
  | { ok: true }
  | { ok: false; reason: ConnectorTokenFailure; scheme: 'bearer' | 'bare' | 'none'; alg?: string };

function sign(input: string, key: string): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function signConnectorToken(credentials: ConnectorCredentials, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(
    JSON.stringify({ access_token: credentials.accessToken, iat, exp: iat + CONNECTOR_TOKEN_LIFETIME_SECONDS }),
  ).toString('base64url');
  const signingInput = `${SIGNED_HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, credentials.accessKey).toString('base64url')}`;
}

function splitAuthorization(header: string | null): { token: string; scheme: 'bearer' | 'bare' } | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const bearer = /^bearer\s+(\S+)$/i.exec(value);
  if (bearer?.[1]) return { token: bearer[1], scheme: 'bearer' };
  return /^\S+\.\S+\.\S+$/.test(value) ? { token: value, scheme: 'bare' } : undefined;
}

function checkClaims(
  claims: Record<string, unknown>,
  credentials: ConnectorCredentials,
  nowMs: number,
): ConnectorTokenFailure | undefined {
  const { access_token: accessToken, iat, exp } = claims;
  if (typeof accessToken !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return 'malformed';
  if (!safeEqual(Buffer.from(accessToken), Buffer.from(credentials.accessToken))) return 'wrong-access-token';
  const now = nowMs / 1000;
  if (exp + CONNECTOR_CLOCK_SKEW_SECONDS < now) return 'expired';
  if (iat - CONNECTOR_CLOCK_SKEW_SECONDS > now) return 'issued-in-future';
  if (exp - iat > CONNECTOR_TOKEN_LIFETIME_SECONDS + CONNECTOR_CLOCK_SKEW_SECONDS) return 'lifetime-too-long';
  return undefined;
}

export function verifyConnectorToken(
  authorization: string | null,
  credentials: ConnectorCredentials,
  nowMs: number = Date.now(),
): ConnectorTokenCheck {
  const supplied = splitAuthorization(authorization);
  if (!supplied) return { ok: false, reason: authorization?.trim() ? 'malformed' : 'missing', scheme: 'none' };
  const { token, scheme } = supplied;

  const [header, payload, signature, ...rest] = token.split('.');
  if (!header || !payload || !signature || rest.length > 0) return { ok: false, reason: 'malformed', scheme };
  const headerAlg = decodeJson(header)?.alg;
  const alg = typeof headerAlg === 'string' ? headerAlg.slice(0, 16) : undefined;

  const expected = sign(`${header}.${payload}`, credentials.accessKey);
  if (!safeEqual(Buffer.from(signature, 'base64url'), expected)) {
    return { ok: false, reason: 'bad-signature', scheme, alg };
  }

  const claims = decodeJson(payload);
  if (!claims) return { ok: false, reason: 'malformed', scheme, alg };
  const failure = checkClaims(claims, credentials, nowMs);
  return failure ? { ok: false, reason: failure, scheme, alg } : { ok: true };
}
