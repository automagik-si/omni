import type { PluginStorage } from '@omni/channel-sdk';

const CONNECTOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONNECTOR_CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConnectorSession {
  conversationId: string;
  identifier?: string;
  openedAt: number;
  name?: string;
  started?: boolean;
  awaitingReplyUntil?: number;
}

export type ConnectorClosedBy = 'platform' | 'handoff';

export interface ConnectorClosedSession {
  conversationId: string;
  closedAt: number;
  by: ConnectorClosedBy;
  identifier?: string;
  name?: string;
}

export interface ConnectorReopenRejection {
  status?: string;
  reason?: string;
}

export interface ConnectorReopenRequest {
  chatId: string;
  conversationId: string;
  requestedAt: number;
  expirationMinutes: number;
  externalId?: string;
  rejection?: ConnectorReopenRejection;
  identifier?: string;
  name?: string;
}

export type ReopenClaim =
  | { kind: 'claimed'; request: ConnectorReopenRequest }
  | { kind: 'open'; session: ConnectorSession }
  | { kind: 'pending' }
  | { kind: 'handoff' }
  | { kind: 'none' };

export class ConnectorSessionStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: PluginStorage,
    private readonly instanceId: string,
  ) {}

  private sessionKey(chatId: string): string {
    return `connector:session:${this.instanceId}:${chatId}`;
  }

  private conversationKey(conversationId: string): string {
    return `connector:conversation:${this.instanceId}:${conversationId}`;
  }

  private retiredKey(conversationId: string): string {
    return `connector:retired:${this.instanceId}:${conversationId}`;
  }

  private closedKey(chatId: string): string {
    return `connector:closed:${this.instanceId}:${chatId}`;
  }

  private reopenKey(conversationId: string): string {
    return `connector:reopen:${this.instanceId}:${conversationId}`;
  }

  private async withChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(chatId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId);
    }
  }

  private async retire(conversationId: string): Promise<void> {
    await this.storage.delete(this.conversationKey(conversationId));
    await this.storage.set(this.retiredKey(conversationId), true, CONNECTOR_SESSION_TTL_MS);
  }

  private async store(chatId: string, session: ConnectorSession): Promise<void> {
    await this.storage.set(this.sessionKey(chatId), session, CONNECTOR_SESSION_TTL_MS);
    await this.storage.set(this.conversationKey(session.conversationId), chatId, CONNECTOR_SESSION_TTL_MS);
  }

  private async forgetClosed(chatId: string): Promise<void> {
    const closed = await this.closedOf(chatId);
    if (!closed) return;
    await this.storage.delete(this.closedKey(chatId));
    await this.storage.delete(this.reopenKey(closed.conversationId));
  }

  async get(chatId: string): Promise<ConnectorSession | undefined> {
    const session = await this.storage.get<ConnectorSession>(this.sessionKey(chatId));
    return session && typeof session.conversationId === 'string' ? session : undefined;
  }

  async chatOf(conversationId: string): Promise<string | undefined> {
    const chatId = await this.storage.get<string>(this.conversationKey(conversationId));
    return typeof chatId === 'string' && chatId ? chatId : undefined;
  }

  async closedOf(chatId: string): Promise<ConnectorClosedSession | undefined> {
    const closed = await this.storage.get<ConnectorClosedSession>(this.closedKey(chatId));
    return closed && typeof closed.conversationId === 'string' ? closed : undefined;
  }

  async reopenOf(conversationId: string): Promise<ConnectorReopenRequest | undefined> {
    const request = await this.storage.get<ConnectorReopenRequest>(this.reopenKey(conversationId));
    return request && typeof request.chatId === 'string' ? request : undefined;
  }

  private async isRetired(conversationId: string): Promise<boolean> {
    return this.storage.has(this.retiredKey(conversationId));
  }

  open(chatId: string, session: ConnectorSession): Promise<ConnectorSession | undefined> {
    return this.withChat(chatId, async () => {
      const previous = await this.get(chatId);
      if (previous && previous.conversationId !== session.conversationId) await this.retire(previous.conversationId);
      await this.forgetClosed(chatId);
      await this.store(chatId, session);
      return previous;
    });
  }

  adopt(
    chatId: string,
    session: ConnectorSession,
  ): Promise<{ session: ConnectorSession; replaced?: string } | undefined> {
    return this.withChat(chatId, async () => {
      if (await this.isRetired(session.conversationId)) return undefined;
      const current = await this.get(chatId);
      if (current?.conversationId === session.conversationId) return { session: current };
      if (current) await this.retire(current.conversationId);
      await this.forgetClosed(chatId);
      await this.store(chatId, session);
      return { session, ...(current ? { replaced: current.conversationId } : {}) };
    });
  }

  markStarted(chatId: string, conversationId: string): Promise<void> {
    return this.withChat(chatId, async () => {
      const current = await this.get(chatId);
      if (current?.conversationId !== conversationId) return;
      await this.storage.set(this.sessionKey(chatId), { ...current, started: true }, CONNECTOR_SESSION_TTL_MS);
    });
  }

  markReplied(chatId: string, conversationId: string, awaitingReplyUntil: number): Promise<void> {
    return this.withChat(chatId, async () => {
      const current = await this.get(chatId);
      if (current?.conversationId !== conversationId || current.awaitingReplyUntil !== awaitingReplyUntil) return;
      const { awaitingReplyUntil: _, ...replied } = current;
      await this.storage.set(this.sessionKey(chatId), replied, CONNECTOR_SESSION_TTL_MS);
    });
  }

  expireReopenWindow(chatId: string, now: number): Promise<ConnectorSession | undefined> {
    return this.withChat(chatId, async () => {
      const current = await this.get(chatId);
      if (current?.awaitingReplyUntil === undefined || now < current.awaitingReplyUntil) return undefined;
      await this.retire(current.conversationId);
      await this.storage.delete(this.sessionKey(chatId));
      await this.recordClosed(chatId, current.conversationId, 'platform', current);
      return current;
    });
  }

  async close(
    conversationId: string,
    by: ConnectorClosedBy = 'platform',
    chatIdHint?: string,
  ): Promise<{ chatId: string; session: ConnectorSession } | undefined> {
    const chatId = (await this.chatOf(conversationId)) ?? (await this.reopenOf(conversationId))?.chatId ?? chatIdHint;
    if (!chatId) {
      await this.retire(conversationId);
      return undefined;
    }
    return this.withChat(chatId, async () => {
      await this.retire(conversationId);
      await this.storage.delete(this.reopenKey(conversationId));
      const session = await this.get(chatId);
      const current = session?.conversationId === conversationId ? session : undefined;
      if (current) await this.storage.delete(this.sessionKey(chatId));
      await this.recordClosed(chatId, conversationId, by, current);
      return current ? { chatId, session: current } : undefined;
    });
  }

  private async recordClosed(
    chatId: string,
    conversationId: string,
    by: ConnectorClosedBy,
    current: ConnectorSession | undefined,
  ): Promise<void> {
    const prior = await this.closedOf(chatId);
    const same = prior?.conversationId === conversationId ? prior : undefined;
    if (same?.by === 'handoff' && by === 'platform') return;
    if (!current && !same && by !== 'handoff') return;
    const identifier = current?.identifier ?? same?.identifier;
    const name = current?.name ?? same?.name;
    const record: ConnectorClosedSession = {
      conversationId,
      closedAt: Date.now(),
      by,
      ...(identifier ? { identifier } : {}),
      ...(name ? { name } : {}),
    };
    await this.storage.set(this.closedKey(chatId), record, CONNECTOR_CLOSED_TTL_MS);
  }

  claimReopen(
    chatId: string,
    params: { now: number; inFlightMs: number; expirationMinutes: number },
  ): Promise<ReopenClaim> {
    return this.withChat(chatId, async () => {
      const session = await this.get(chatId);
      if (session) return { kind: 'open', session };
      const closed = await this.closedOf(chatId);
      if (!closed) return { kind: 'none' };
      if (closed.by === 'handoff') return { kind: 'handoff' };
      const pending = await this.reopenOf(closed.conversationId);
      if (pending && params.now - pending.requestedAt < params.inFlightMs) return { kind: 'pending' };
      const request: ConnectorReopenRequest = {
        chatId,
        conversationId: closed.conversationId,
        requestedAt: params.now,
        expirationMinutes: params.expirationMinutes,
        ...(closed.identifier ? { identifier: closed.identifier } : {}),
        ...(closed.name ? { name: closed.name } : {}),
      };
      await this.storage.set(
        this.reopenKey(closed.conversationId),
        request,
        params.expirationMinutes * 60_000 + params.inFlightMs,
      );
      return { kind: 'claimed', request };
    });
  }

  reopenRequested(request: ConnectorReopenRequest, externalId: string): Promise<ConnectorReopenRejection | undefined> {
    return this.withChat(request.chatId, async () => {
      const current = await this.reopenOf(request.conversationId);
      if (current?.requestedAt !== request.requestedAt) return undefined;
      if (current.rejection) {
        await this.storage.delete(this.reopenKey(request.conversationId));
        return current.rejection;
      }
      await this.storage.set(
        this.reopenKey(request.conversationId),
        { ...current, externalId },
        Math.max(1, current.requestedAt + current.expirationMinutes * 60_000 - Date.now()),
      );
      return undefined;
    });
  }

  abandonReopen(request: ConnectorReopenRequest): Promise<void> {
    return this.withChat(request.chatId, async () => {
      const current = await this.reopenOf(request.conversationId);
      if (current?.requestedAt === request.requestedAt)
        await this.storage.delete(this.reopenKey(request.conversationId));
    });
  }

  async acceptReopen(
    conversationId: string,
    now: number,
  ): Promise<{ chatId: string; session: ConnectorSession; request: ConnectorReopenRequest } | undefined> {
    const pending = await this.reopenOf(conversationId);
    if (!pending) return undefined;
    return this.withChat(pending.chatId, async () => {
      const request = await this.reopenOf(conversationId);
      if (!request || request.rejection) return undefined;
      await this.storage.delete(this.reopenKey(conversationId));
      const current = await this.get(request.chatId);
      if (current && current.conversationId !== conversationId) return undefined;
      const session: ConnectorSession = {
        ...(current ?? {}),
        conversationId,
        ...(request.identifier ? { identifier: request.identifier } : {}),
        ...(request.name ? { name: request.name } : {}),
        openedAt: current?.openedAt ?? now,
        started: true,
        awaitingReplyUntil: request.requestedAt + request.expirationMinutes * 60_000,
      };
      await this.storage.delete(this.retiredKey(conversationId));
      await this.storage.delete(this.closedKey(request.chatId));
      await this.store(request.chatId, session);
      return { chatId: request.chatId, session, request };
    });
  }

  async rejectReopen(
    conversationId: string,
    rejection: ConnectorReopenRejection,
  ): Promise<{ request: ConnectorReopenRequest; deferred: boolean } | undefined> {
    const pending = await this.reopenOf(conversationId);
    if (!pending) return undefined;
    return this.withChat(pending.chatId, async () => {
      const request = await this.reopenOf(conversationId);
      if (!request || request.rejection) return undefined;
      if (request.externalId) {
        await this.storage.delete(this.reopenKey(conversationId));
        return { request, deferred: false };
      }
      await this.storage.set(
        this.reopenKey(conversationId),
        { ...request, rejection },
        Math.max(1, request.requestedAt + request.expirationMinutes * 60_000 - Date.now()),
      );
      return { request, deferred: true };
    });
  }
}
