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

  async get(chatId: string): Promise<ConnectorSession | undefined> {
    const session = await this.storage.get<ConnectorSession>(this.sessionKey(chatId));
    return session && typeof session.conversationId === 'string' ? session : undefined;
  }

  async chatOf(conversationId: string): Promise<string | undefined> {
    const chatId = await this.storage.get<string>(this.conversationKey(conversationId));
    return typeof chatId === 'string' && chatId ? chatId : undefined;
  }

  async open(chatId: string, session: ConnectorSession): Promise<ConnectorSession | undefined> {
    const previous = await this.get(chatId);
    if (previous && previous.conversationId !== session.conversationId) {
      await this.storage.delete(this.conversationKey(previous.conversationId));
    }
    await this.storage.set(this.sessionKey(chatId), session, CONNECTOR_SESSION_TTL_MS);
    await this.storage.set(this.conversationKey(session.conversationId), chatId, CONNECTOR_SESSION_TTL_MS);
    return previous;
  }

  async markStarted(chatId: string, session: ConnectorSession): Promise<void> {
    await this.storage.set(this.sessionKey(chatId), { ...session, started: true }, CONNECTOR_SESSION_TTL_MS);
  }

  async close(conversationId: string): Promise<{ chatId: string; session: ConnectorSession } | undefined> {
    const chatId = await this.chatOf(conversationId);
    await this.storage.delete(this.conversationKey(conversationId));
    if (!chatId) return undefined;
    const session = await this.get(chatId);
    if (!session || session.conversationId !== conversationId) return undefined;
    await this.storage.delete(this.sessionKey(chatId));
    return { chatId, session };
  }
}
