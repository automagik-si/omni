import type { PluginStorage } from '@omni/channel-sdk';

const CONNECTOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ConnectorSession {
  conversationId: string;
  identifier?: string;
  openedAt: number;
  name?: string;
  started?: boolean;
}

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

  async get(chatId: string): Promise<ConnectorSession | undefined> {
    const session = await this.storage.get<ConnectorSession>(this.sessionKey(chatId));
    return session && typeof session.conversationId === 'string' ? session : undefined;
  }

  async chatOf(conversationId: string): Promise<string | undefined> {
    const chatId = await this.storage.get<string>(this.conversationKey(conversationId));
    return typeof chatId === 'string' && chatId ? chatId : undefined;
  }

  private async isRetired(conversationId: string): Promise<boolean> {
    return this.storage.has(this.retiredKey(conversationId));
  }

  open(chatId: string, session: ConnectorSession): Promise<ConnectorSession | undefined> {
    return this.withChat(chatId, async () => {
      const previous = await this.get(chatId);
      if (previous && previous.conversationId !== session.conversationId) await this.retire(previous.conversationId);
      await this.storage.set(this.sessionKey(chatId), session, CONNECTOR_SESSION_TTL_MS);
      await this.storage.set(this.conversationKey(session.conversationId), chatId, CONNECTOR_SESSION_TTL_MS);
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
      await this.storage.set(this.sessionKey(chatId), session, CONNECTOR_SESSION_TTL_MS);
      await this.storage.set(this.conversationKey(session.conversationId), chatId, CONNECTOR_SESSION_TTL_MS);
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

  async close(conversationId: string): Promise<{ chatId: string; session: ConnectorSession } | undefined> {
    const chatId = await this.chatOf(conversationId);
    if (!chatId) {
      await this.retire(conversationId);
      return undefined;
    }
    return this.withChat(chatId, async () => {
      await this.retire(conversationId);
      const session = await this.get(chatId);
      if (!session || session.conversationId !== conversationId) return undefined;
      await this.storage.delete(this.sessionKey(chatId));
      return { chatId, session };
    });
  }
}
