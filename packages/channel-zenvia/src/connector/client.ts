import { ZenviaApiError, ZenviaErrorCode, mapHttpStatusToZenviaError } from '../utils/errors';
import { parseJsonOrUndefined, readBodyText, zenviaFetch } from '../utils/http';
import { decodeConnectorBuffer, toNodeBufferJson } from './files';
import { signConnectorToken } from './jwt';
import {
  type ConnectorAgent,
  type ConnectorResponse,
  ConnectorResponseSchema,
  ConnectorUploadedFileSchema,
  type ZenviaConnectorConfig,
} from './types';

export const DEFAULT_ZENVIA_CONNECTOR_BASE_URL = 'https://agent.altubots.com/altu-connector';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_DETAIL_LENGTH = 200;

export interface ZenviaConnectorClientOptions extends ZenviaConnectorConfig {
  baseUrl?: string;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  now?: () => number;
}

export class ZenviaConnectorClient {
  private readonly endpoint: string;
  private readonly credentials: { accessToken: string; accessKey: string };
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ZenviaConnectorClientOptions) {
    const base = (opts.baseUrl ?? DEFAULT_ZENVIA_CONNECTOR_BASE_URL).replace(/\/+$/, '');
    const path = `${base}/${encodeURIComponent(opts.slug)}/${encodeURIComponent(opts.integrationId)}`;
    this.endpoint = opts.env ? `${path}?env=${encodeURIComponent(opts.env)}` : path;
    this.credentials = { accessToken: opts.accessToken, accessKey: opts.accessKey };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  acceptConversation(conversationId: string, agent: ConnectorAgent): Promise<ConnectorResponse> {
    return this.post({ action: 'ACCEPT_CONVERSATION', conversationId, parameters: { agent } }, 'acceptConversation');
  }

  sendMessage(conversationId: string, agent: ConnectorAgent, messages: string[]): Promise<ConnectorResponse> {
    return this.post({ action: 'SEND_MESSAGE', conversationId, parameters: { agent, messages } }, 'sendMessage');
  }

  async uploadFile(conversationId: string, contentType: string, bytes: Uint8Array): Promise<string> {
    const response = await this.post(
      { action: 'UPLOAD_FILE', conversationId, file: { contentType, buffer: toNodeBufferJson(bytes) } },
      'uploadFile',
      this.uploadTimeoutMs,
    );
    if (!response.fileId) {
      throw new ZenviaApiError(ZenviaErrorCode.UPSTREAM_ERROR, 'Zenvia connector uploadFile returned no fileId', {
        operation: 'uploadFile',
      });
    }
    return response.fileId;
  }

  sendFile(conversationId: string, agent: ConnectorAgent, fileId: string): Promise<ConnectorResponse> {
    return this.post({ action: 'SEND_FILE', conversationId, parameters: { agent, file: { id: fileId } } }, 'sendFile');
  }

  closeConversation(conversationId: string, reason: string): Promise<ConnectorResponse> {
    return this.post({ action: 'CLOSE_CONVERSATION', conversationId, reason }, 'closeConversation');
  }

  async getFile(fileId: string): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    const response = await this.post({ action: 'GET_FILE', fileId }, 'getFile', this.uploadTimeoutMs);
    const file = ConnectorUploadedFileSchema.safeParse(response.file ?? {});
    const bytes = file.success ? decodeConnectorBuffer(file.data.buffer) : undefined;
    if (!file.success || !bytes) return undefined;
    return { bytes, contentType: file.data.contentType || 'application/octet-stream' };
  }

  private async post(
    event: Record<string, unknown>,
    operation: string,
    timeoutMs: number = this.timeoutMs,
  ): Promise<ConnectorResponse> {
    const now = this.now();
    const res = await zenviaFetch(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: signConnectorToken(this.credentials, now),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...event, timestamp: now }),
      },
      { timeoutMs, operation },
    );
    const text = await readBodyText(res, operation);
    const parsed = ConnectorResponseSchema.safeParse(parseJsonOrUndefined(text) ?? {});
    const body = parsed.success ? parsed.data : {};

    if (res.status === 200 && body.message === 'OK') return body;

    const detail = (body.message ?? text).slice(0, MAX_DETAIL_LENGTH);
    const code = res.status === 200 ? ZenviaErrorCode.REFUSED : mapHttpStatusToZenviaError(res.status);
    throw new ZenviaApiError(
      code,
      `HTTP ${res.status} from Zenvia connector ${operation}${detail ? `: ${detail}` : ''}`,
      {
        httpStatus: res.status,
        operation,
        raw: text ? text.slice(0, MAX_DETAIL_LENGTH) : undefined,
      },
    );
  }
}
