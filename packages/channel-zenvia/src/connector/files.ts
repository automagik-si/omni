import { randomUUID } from 'node:crypto';

import type { PluginStorage } from '@omni/channel-sdk';

const CONNECTOR_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const CONNECTOR_FILE_SCHEME = 'zenvia-connector-file:';

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const DATA_URI = /^data:[^;,]*;base64,/i;

export interface StoredConnectorFile {
  contentType: string;
  name?: string;
  size: number;
  data: string;
}

export function decodeConnectorBuffer(value: unknown): Buffer | undefined {
  if (typeof value === 'string') {
    const compact = value.replace(DATA_URI, '').replace(/\s+/g, '');
    if (!compact || !BASE64.test(compact)) return undefined;
    return Buffer.from(compact, 'base64');
  }
  if (!value || typeof value !== 'object') return undefined;
  const { type, data } = value as { type?: unknown; data?: unknown };
  if (type !== 'Buffer' || !Array.isArray(data) || data.length === 0) return undefined;
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
    bytes[i] = byte;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function toNodeBufferJson(bytes: Uint8Array): { type: 'Buffer'; data: number[] } {
  return { type: 'Buffer', data: Array.from(bytes) };
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};

export function extensionFor(contentType: string, name?: string): string {
  const fromName = name?.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  if (fromName) return fromName;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[mime] ?? mime.split('/')[1] ?? 'bin';
}

const FILE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isConnectorFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID.test(value);
}

export function connectorMediaRef(fileId: string): string {
  return `${CONNECTOR_FILE_SCHEME}${fileId}`;
}

export function connectorFileIdOf(mediaRef: string): string | undefined {
  if (!mediaRef.startsWith(CONNECTOR_FILE_SCHEME)) return undefined;
  const fileId = mediaRef.slice(CONNECTOR_FILE_SCHEME.length);
  return isConnectorFileId(fileId) ? fileId : undefined;
}

export class ConnectorFileStore {
  constructor(
    private readonly storage: PluginStorage,
    private readonly instanceId: string,
  ) {}

  private key(fileId: string): string {
    return `connector:file:${this.instanceId}:${fileId}`;
  }

  async put(bytes: Buffer, contentType: string, name?: string): Promise<string> {
    const fileId = randomUUID();
    const stored: StoredConnectorFile = {
      contentType,
      ...(name ? { name } : {}),
      size: bytes.byteLength,
      data: bytes.toString('base64'),
    };
    await this.storage.set(this.key(fileId), stored, CONNECTOR_FILE_TTL_MS);
    return fileId;
  }

  async get(fileId: string): Promise<{ bytes: Buffer; contentType: string; name?: string } | undefined> {
    const stored = await this.storage.get<StoredConnectorFile>(this.key(fileId));
    if (!stored || typeof stored.data !== 'string') return undefined;
    return {
      bytes: Buffer.from(stored.data, 'base64'),
      contentType: stored.contentType || 'application/octet-stream',
      ...(stored.name ? { name: stored.name } : {}),
    };
  }
}
