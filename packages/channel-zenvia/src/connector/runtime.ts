import { randomUUID } from 'node:crypto';

import type { OutgoingMessage, PluginStorage, SendResult } from '@omni/channel-sdk';
import { markdownToWhatsApp } from '@omni/core';
import type { Logger } from '@omni/core';
import type { ContentType } from '@omni/core/types';

import { type HandoffRoutingMiss, type ZenviaHandoffRouting, resolveHandoffGroup } from '../handoff-routing';
import { ZenviaApiError, ZenviaErrorCode, isDefinitiveRefusal } from '../utils/errors';
import { toSenderId } from '../utils/identity';
import { omniTypeForMime } from '../utils/media-type';
import { ZenviaConnectorClient } from './client';
import {
  ConnectorFileStore,
  connectorFileIdOf,
  connectorMediaRef,
  decodeConnectorBuffer,
  extensionFor,
  isConnectorFileId,
  toNodeBufferJson,
} from './files';
import {
  connectorChatId,
  connectorContactName,
  connectorConversationId,
  connectorTimestampMs,
  joinConnectorTexts,
  userTextsAfterLastBot,
} from './mapping';
import { type ConnectorSession, ConnectorSessionStore } from './sessions';
import {
  type ConnectorAgent,
  type ConnectorEvent,
  ConnectorEventSchema,
  ConnectorMessageParametersSchema,
  ConnectorOpenParametersSchema,
  ConnectorSendFileParametersSchema,
  ConnectorUploadedFileSchema,
  type ZenviaConnectorConfig,
} from './types';

export const NO_OPEN_LIVE_CHAT_ERROR = 'no open Zenvia live chat for this contact';
const CONNECTOR_MAX_FILE_BYTES = 25 * 1024 * 1024;

const ACCEPT_RETRY_DELAY_MS = 500;
const MAX_STARTED_CLAIMS = 5000;
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document']);

export interface ConnectorInbound {
  externalId: string;
  chatId: string;
  senderName?: string;
  content: { type: ContentType; text?: string; mediaId?: string; mimeType?: string };
  sessionStart: boolean;
  timestampMs: number;
  rawPayload: Record<string, unknown>;
}

export interface ConnectorReply {
  status: number;
  body: Record<string, unknown>;
}

export interface ConnectorHost {
  logger: Logger;
  publish(inbound: ConnectorInbound): Promise<boolean>;
  sent(params: { externalId: string; chatId: string; message: OutgoingMessage }): Promise<void>;
  failed(params: { chatId: string; error: string; retryable: boolean }): Promise<void>;
  loadMedia(message: OutgoingMessage): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface ConnectorHandoffConfig {
  handoffGroupId?: string;
  handoffRouting?: ZenviaHandoffRouting;
}

type Delivery = { ok: true; messageId: string } | { ok: false; error: ZenviaApiError | Error };

function reply(status: number, message: string, extra: Record<string, unknown> = {}): ConnectorReply {
  return { status, body: { ...extra, requestId: randomUUID(), message } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function retryableOf(err: unknown): boolean {
  return err instanceof ZenviaApiError && err.retryable;
}

function failure(err: unknown): SendResult {
  return {
    success: false,
    error: errorText(err),
    ...(err instanceof ZenviaApiError ? { errorCode: err.channelCode } : {}),
    retryable: retryableOf(err),
    ...(isDefinitiveRefusal(err) ? { rejected: true } : {}),
    timestamp: Date.now(),
  };
}

function refusal(error: string): SendResult {
  return { success: false, error, retryable: false, rejected: true, timestamp: Date.now() };
}

function outboundText(message: OutgoingMessage, text: string | undefined): string {
  const mode = (message.metadata?.messageFormatMode as 'convert' | 'passthrough') ?? 'convert';
  const value = text ?? '';
  return mode === 'passthrough' ? value : markdownToWhatsApp(value);
}

export class ZenviaConnectorRuntime {
  readonly client: ZenviaConnectorClient;
  readonly sessions: ConnectorSessionStore;
  readonly files: ConnectorFileStore;
  private readonly agent: ConnectorAgent;
  private readonly pending = new Set<Promise<void>>();
  private readonly startedClaims = new Set<string>();

  constructor(
    private readonly instanceId: string,
    config: ZenviaConnectorConfig,
    storage: PluginStorage,
    private readonly handoff: ConnectorHandoffConfig,
    private readonly host: ConnectorHost,
    client?: ZenviaConnectorClient,
  ) {
    this.client = client ?? new ZenviaConnectorClient(config);
    this.sessions = new ConnectorSessionStore(storage, instanceId);
    this.files = new ConnectorFileStore(storage, instanceId);
    this.agent = { id: instanceId, name: 'Omni' };
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async handleEvent(payload: unknown): Promise<ConnectorReply> {
    const parsed = ConnectorEventSchema.safeParse(payload);
    if (!parsed.success) return reply(400, 'invalid event: missing action');
    const event = parsed.data;

    switch (event.action) {
      case 'OPEN_CONVERSATION':
        return this.onOpen(event);
      case 'SEND_MESSAGE':
        return this.onMessage(event);
      case 'UPLOAD_FILE':
        return this.onUpload(event);
      case 'SEND_FILE':
        return this.onSendFile(event);
      case 'GET_FILE':
        return this.onGetFile(event);
      case 'CLOSE_CONVERSATION':
        return this.onClose(event);
      case 'ACCEPT_CONVERSATION':
      case 'REJECT_CONVERSATION':
        this.host.logger.info('[zenvia] connector reopen reply received', {
          instanceId: this.instanceId,
          action: event.action,
          conversationId: connectorConversationId(event),
          status: typeof event.parameters?.status === 'string' ? event.parameters.status : undefined,
        });
        return reply(200, 'OK');
      default:
        this.host.logger.debug('[zenvia] connector action ignored', {
          instanceId: this.instanceId,
          action: event.action.slice(0, 64),
        });
        return reply(200, 'OK');
    }
  }

  private async onOpen(event: ConnectorEvent): Promise<ConnectorReply> {
    const conversationId = connectorConversationId(event);
    if (!conversationId) return reply(400, 'missing conversationId');
    const params = ConnectorOpenParametersSchema.safeParse(event.parameters ?? {});
    const contact = params.success ? params.data.contact : undefined;
    const chatId = connectorChatId(contact, event.identifier);
    if (!chatId) return reply(400, 'missing contact phone and identifier');

    const name = connectorContactName(contact);
    const session: ConnectorSession = {
      conversationId,
      ...(event.identifier ? { identifier: event.identifier } : {}),
      openedAt: Date.now(),
      ...(name ? { name } : {}),
    };
    const previous = await this.sessions.open(chatId, session);
    if (previous && previous.conversationId !== conversationId) {
      this.startedClaims.delete(previous.conversationId);
      this.host.logger.info('[zenvia] connector conversation replaced an open one for the contact', {
        instanceId: this.instanceId,
        conversationId,
        replacedConversationId: previous.conversationId,
      });
    }
    this.track(this.accept(conversationId));

    const text = userTextsAfterLastBot(contact?.history);
    if (!text) return reply(200, 'OK');

    const extraInfo = params.success ? params.data.extraInfo : undefined;
    const contactInfo = contact?.extra?.contact_info;
    await this.publish(chatId, session, {
      externalId: event.requestId ?? `${conversationId}:open`,
      content: { type: 'text', text },
      timestampMs: connectorTimestampMs(event),
      rawPayload: {
        zenviaConnector: event as Record<string, unknown>,
        ...(extraInfo !== undefined ? { extraInfo } : {}),
        ...(contactInfo !== undefined ? { contactInfo } : {}),
      },
    });
    return reply(200, 'OK');
  }

  private async onMessage(event: ConnectorEvent): Promise<ConnectorReply> {
    const conversationId = connectorConversationId(event);
    if (!conversationId) return reply(400, 'missing conversationId');
    const params = ConnectorMessageParametersSchema.safeParse(event.parameters ?? {});
    const data = params.success ? params.data : {};
    const located = await this.sessionFor(conversationId, event, data.contact);
    if (located === 'missing-contact') return reply(400, 'missing contact phone and identifier');
    if (located === 'stale') return reply(200, 'OK');

    const text = joinConnectorTexts(data.messages);
    const location = data.location;
    if (!text && !location) {
      this.host.logger.debug('[zenvia] connector message without text or location ignored', {
        instanceId: this.instanceId,
        conversationId,
      });
      return reply(200, 'OK');
    }

    await this.publish(located.chatId, located.session, {
      externalId: event.requestId ?? `${conversationId}:${String(event.timestamp ?? Date.now())}`,
      content: location
        ? { type: 'location', text: `${location.latitude},${location.longitude}` }
        : { type: 'text', text },
      timestampMs: connectorTimestampMs(event),
      rawPayload: { zenviaConnector: event as Record<string, unknown> },
    });
    return reply(200, 'OK');
  }

  private async onUpload(event: ConnectorEvent): Promise<ConnectorReply> {
    const file = ConnectorUploadedFileSchema.safeParse(event.file ?? event.parameters?.file ?? {});
    const bytes = file.success ? decodeConnectorBuffer(file.data.buffer) : undefined;
    if (!file.success || !bytes) return reply(400, 'invalid file buffer');
    if (bytes.byteLength > CONNECTOR_MAX_FILE_BYTES) return reply(400, 'file too large');

    const contentType = file.data.contentType?.trim() || 'application/octet-stream';
    const fileId = await this.files.put(bytes, contentType, file.data.name);
    this.host.logger.debug('[zenvia] connector file stored', {
      instanceId: this.instanceId,
      fileId,
      contentType,
      size: bytes.byteLength,
    });
    return reply(200, 'OK', { fileId });
  }

  private async onSendFile(event: ConnectorEvent): Promise<ConnectorReply> {
    const conversationId = connectorConversationId(event);
    if (!conversationId) return reply(400, 'missing conversationId');
    const params = ConnectorSendFileParametersSchema.safeParse(event.parameters ?? {});
    const data = params.success ? params.data : {};
    const fileId = data.file?.id;
    if (!isConnectorFileId(fileId)) return reply(400, 'missing file id');
    const located = await this.sessionFor(conversationId, event, data.contact);
    if (located === 'missing-contact') return reply(400, 'missing contact phone and identifier');
    if (located === 'stale') return reply(200, 'OK');

    const stored = await this.files.get(fileId);
    const mimeType = data.file?.contentType?.trim() || stored?.contentType;
    if (!stored) {
      this.host.logger.warn('[zenvia] connector SEND_FILE names a file that was not uploaded here', {
        instanceId: this.instanceId,
        conversationId,
        fileId,
      });
    }
    const caption = data.file?.caption?.trim();
    await this.publish(located.chatId, located.session, {
      externalId: event.requestId ?? `${conversationId}:file:${fileId}`,
      content: {
        type: omniTypeForMime(mimeType),
        mediaId: connectorMediaRef(fileId),
        ...(mimeType ? { mimeType } : {}),
        ...(caption ? { text: caption } : {}),
      },
      timestampMs: connectorTimestampMs(event),
      rawPayload: {
        zenviaConnector: event as Record<string, unknown>,
        ...(data.file?.name ? { filename: data.file.name } : {}),
      },
    });
    return reply(200, 'OK');
  }

  private async onGetFile(event: ConnectorEvent): Promise<ConnectorReply> {
    const fileId = event.fileId ?? event.parameters?.fileId;
    if (!isConnectorFileId(fileId)) return reply(400, 'missing fileId');
    const stored = await this.files.get(fileId);
    if (!stored) return reply(404, 'not found');
    return reply(200, 'OK', {
      file: {
        contentLength: stored.bytes.byteLength,
        contentType: stored.contentType,
        type: extensionFor(stored.contentType, stored.name),
        buffer: toNodeBufferJson(stored.bytes),
      },
    });
  }

  private async onClose(event: ConnectorEvent): Promise<ConnectorReply> {
    const conversationId = connectorConversationId(event);
    if (!conversationId) return reply(400, 'missing conversationId');
    const closed = await this.sessions.close(conversationId);
    this.startedClaims.delete(conversationId);
    this.host.logger.info('[zenvia] connector conversation closed by the platform', {
      instanceId: this.instanceId,
      conversationId,
      hadSession: Boolean(closed),
    });
    return reply(200, 'OK');
  }

  private async sessionFor(
    conversationId: string,
    event: ConnectorEvent,
    contact: Parameters<typeof connectorChatId>[0],
  ): Promise<{ chatId: string; session: ConnectorSession } | 'missing-contact' | 'stale'> {
    const chatId = (await this.sessions.chatOf(conversationId)) ?? connectorChatId(contact, event.identifier);
    if (!chatId) return 'missing-contact';
    const session = await this.sessions.get(chatId);
    if (session?.conversationId === conversationId) return { chatId, session };

    const adopted = await this.sessions.adopt(chatId, {
      conversationId,
      ...(event.identifier ? { identifier: event.identifier } : {}),
      openedAt: Date.now(),
    });
    if (!adopted) {
      this.host.logger.warn('[zenvia] connector event for a replaced or closed conversation ignored', {
        instanceId: this.instanceId,
        conversationId,
        action: event.action,
      });
      return 'stale';
    }
    this.host.logger.warn('[zenvia] connector event for a conversation without a session; adopting it', {
      instanceId: this.instanceId,
      conversationId,
      replacedConversationId: adopted.replaced,
    });
    if (adopted.replaced) this.startedClaims.delete(adopted.replaced);
    return { chatId, session: adopted.session };
  }

  private async publish(
    chatId: string,
    session: ConnectorSession,
    inbound: Omit<ConnectorInbound, 'chatId' | 'sessionStart' | 'senderName'>,
  ): Promise<void> {
    const sessionStart = this.claimSessionStart(session);
    let published = false;
    try {
      published = await this.host.publish({
        ...inbound,
        chatId,
        sessionStart,
        ...(session.name ? { senderName: session.name } : {}),
      });
    } finally {
      if (sessionStart && !published) this.startedClaims.delete(session.conversationId);
    }
    if (sessionStart && published) await this.sessions.markStarted(chatId, session.conversationId);
  }

  private claimSessionStart(session: ConnectorSession): boolean {
    if (session.started || this.startedClaims.has(session.conversationId)) return false;
    if (this.startedClaims.size >= MAX_STARTED_CLAIMS) {
      const oldest = this.startedClaims.values().next().value;
      if (oldest !== undefined) this.startedClaims.delete(oldest);
    }
    this.startedClaims.add(session.conversationId);
    return true;
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async accept(conversationId: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.client.acceptConversation(conversationId, this.agent);
        return;
      } catch (err) {
        const retry = attempt === 1 && retryableOf(err);
        this.host.logger.warn('[zenvia] connector ACCEPT_CONVERSATION failed', {
          instanceId: this.instanceId,
          conversationId,
          attempt,
          willRetry: retry,
          error: errorText(err),
        });
        if (!retry) return;
        await Bun.sleep(ACCEPT_RETRY_DELAY_MS);
      }
    }
  }

  async download(mediaRef: string): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
    const fileId = connectorFileIdOf(mediaRef);
    if (!fileId) return undefined;
    const stored = await this.files.get(fileId);
    if (stored) return { buffer: stored.bytes, mimeType: stored.contentType };
    const fetched = await this.client.getFile(fileId);
    if (!fetched) {
      throw new ZenviaApiError(ZenviaErrorCode.INVALID_REQUEST, 'Zenvia connector file is not available', {
        operation: 'downloadFile',
      });
    }
    return { buffer: fetched.bytes, mimeType: fetched.contentType };
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const chatId = toSenderId(message.to);
    const session = chatId ? await this.sessions.get(chatId) : undefined;
    if (!session) return refusal(NO_OPEN_LIVE_CHAT_ERROR);

    const isHandoff = message.metadata?.isHandoff === true;
    const queue = isHandoff ? this.resolveQueue(message.metadata ?? {}) : undefined;
    if (queue && !queue.ok) return refusal(queue.error);

    const delivery = await this.deliver(session.conversationId, chatId, message, isHandoff);
    if (!delivery.ok) {
      await this.host.failed({ chatId, error: errorText(delivery.error), retryable: retryableOf(delivery.error) });
      return failure(delivery.error);
    }
    if (!queue?.ok) return { success: true, messageId: delivery.messageId, timestamp: Date.now() };

    const closed = await this.close(session.conversationId, queue.queue);
    if (!closed.ok) return failure(closed.error);
    await this.sessions.close(session.conversationId);
    this.startedClaims.delete(session.conversationId);
    this.host.logger.info('[zenvia] connector conversation closed for handoff', {
      instanceId: this.instanceId,
      conversationId: session.conversationId,
      queue: queue.queue,
    });
    return { success: true, messageId: delivery.messageId, timestamp: Date.now(), pauseAgent: false };
  }

  private resolveQueue(metadata: Record<string, unknown>): { ok: true; queue: string } | { ok: false; error: string } {
    const resolution = resolveHandoffGroup(this.handoff.handoffRouting, this.handoff.handoffGroupId, metadata);
    if (resolution.miss) this.logRoutingMiss(resolution.miss, resolution.ok);
    return resolution.ok ? { ok: true, queue: resolution.groupId } : { ok: false, error: resolution.error };
  }

  private logRoutingMiss(miss: HandoffRoutingMiss, usingDefault: boolean): void {
    this.host.logger.warn(
      usingDefault
        ? 'Zenvia connector handoff queue is not mapped; closing with the default queue'
        : 'Zenvia connector handoff queue is not mapped and there is no default queue; refusing',
      {
        instanceId: this.instanceId,
        field: miss.field,
        reason: miss.reason,
        ...(miss.reason === 'unmatched' ? { value: miss.value } : {}),
      },
    );
  }

  private async deliver(
    conversationId: string,
    chatId: string,
    message: OutgoingMessage,
    isHandoff: boolean,
  ): Promise<Delivery> {
    const { content } = message;
    try {
      let messageId: string;
      if (content.type === 'text') {
        const text = outboundText(message, content.text);
        if (!text.trim()) {
          if (!isHandoff) return { ok: false, error: new Error('Refusing to send an empty text message') };
          return { ok: true, messageId: randomUUID() };
        }
        messageId = await this.sendText(conversationId, text);
      } else if (MEDIA_TYPES.has(content.type)) {
        messageId = await this.sendMedia(conversationId, message);
      } else {
        return {
          ok: false,
          error: new ZenviaApiError(
            ZenviaErrorCode.INVALID_REQUEST,
            `Unsupported content.type=${content.type} for a Zenvia live chat`,
          ),
        };
      }
      await this.host.sent({ externalId: messageId, chatId, message });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async sendText(conversationId: string, text: string): Promise<string> {
    const response = await this.client.sendMessage(conversationId, this.agent, [text]);
    return response.requestId ?? randomUUID();
  }

  private async sendMedia(conversationId: string, message: OutgoingMessage): Promise<string> {
    const media = await this.host.loadMedia(message);
    if (media.bytes.byteLength > CONNECTOR_MAX_FILE_BYTES) {
      throw new ZenviaApiError(ZenviaErrorCode.INVALID_REQUEST, 'Media is too large for a Zenvia live chat');
    }
    const mimeType = message.content.mimeType || media.mimeType;
    const fileId = await this.client.uploadFile(conversationId, mimeType, media.bytes);
    const response = await this.client.sendFile(conversationId, this.agent, fileId);
    const caption = outboundText(message, message.content.caption ?? message.content.text);
    if (caption.trim()) {
      try {
        await this.client.sendMessage(conversationId, this.agent, [caption]);
      } catch (err) {
        this.host.logger.error('[zenvia] connector caption failed after the file was delivered', {
          instanceId: this.instanceId,
          conversationId,
          error: errorText(err),
        });
      }
    }
    return response.requestId ?? fileId;
  }

  private async close(conversationId: string, reason: string): Promise<{ ok: true } | { ok: false; error: unknown }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.client.closeConversation(conversationId, reason);
        return { ok: true };
      } catch (err) {
        lastError = err;
        this.host.logger.error('[zenvia] connector CLOSE_CONVERSATION failed after the farewell', {
          instanceId: this.instanceId,
          conversationId,
          attempt,
          error: errorText(err),
        });
        if (!retryableOf(err)) break;
      }
    }
    return { ok: false, error: lastError };
  }
}
