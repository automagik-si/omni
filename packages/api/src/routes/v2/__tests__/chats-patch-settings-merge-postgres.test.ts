import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EventBus } from '@omni/core';
import { type Database, chats, createDbHandle, instances } from '@omni/db';
import { pgRoleUrl, provisionMigratedDatabase } from '@omni/db/pg-migrated-template';
import { dropDatabaseOrThrow } from '@omni/db/pg-testing';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { errorHandler } from '../../../middleware/error';
import { ChatService } from '../../../services/chats';
import type { AppVariables } from '../../../types';
import { chatsRoutes } from '../chats';

const superUrl = process.env.OMNI_G4_POSTGRES_URL ?? '';
const postgresDescribe = superUrl.length > 0 ? describe : describe.skip;
const psqlBin = process.env.OMNI_G4_PSQL_BIN ?? 'psql';

postgresDescribe('PATCH /chats/:id merges settings (real PostgreSQL)', () => {
  const dbName = `omni_chat_settings_merge_${crypto.randomUUID().replaceAll('-', '')}`;
  let db: Database;
  let closeDb: () => Promise<void>;
  let chatService: ChatService;
  let instanceId: string;
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  function app() {
    const hono = new Hono<{ Variables: AppVariables }>();
    hono.onError(errorHandler);
    hono.use('*', async (c, next) => {
      c.set('services', {
        instances: {
          getById: async (id: string) => (await db.select().from(instances).where(eq(instances.id, id)))[0],
        },
        chats: chatService,
      } as never);
      c.set('apiKey', { id: 'k', name: 'k', scopes: ['*'], instanceIds: null, expiresAt: null } as never);
      await next();
    });
    hono.route('/chats', chatsRoutes);
    return hono;
  }

  async function addChat(settings: Record<string, unknown> | null): Promise<string> {
    const [row] = await db
      .insert(chats)
      .values({
        instanceId,
        externalId: `${crypto.randomUUID()}@s.whatsapp.net`,
        chatType: 'dm',
        channel: 'whatsapp-baileys',
        settings,
      })
      .returning();
    if (!row) throw new Error('chat insert returned nothing');
    return row.id;
  }

  async function patch(chatId: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await app().request(`/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select({ settings: chats.settings }).from(chats).where(eq(chats.id, chatId));
    return (row?.settings as Record<string, unknown> | null) ?? null;
  }

  function handoffEventsFor(chatId: string) {
    return published.filter((event) => event.type === 'chat.handoff_activated' && event.payload.chatId === chatId);
  }

  beforeAll(async () => {
    provisionMigratedDatabase({ superUrl, psqlBin }, dbName);
    const handle = createDbHandle({ url: pgRoleUrl(superUrl, dbName), maxConnections: 3 });
    db = handle.db;
    closeDb = () => handle.close().catch(() => undefined);
    const eventBus = {
      publish: async (type: string, payload: Record<string, unknown>) => {
        published.push({ type, payload });
        return { id: 'evt', sequence: published.length };
      },
    } as unknown as EventBus;
    chatService = new ChatService(db, eventBus);
    const [instance] = await db
      .insert(instances)
      .values({ name: 'settings-merge', channel: 'whatsapp-baileys' })
      .returning();
    if (!instance) throw new Error('instance insert returned nothing');
    instanceId = instance.id;
  }, 180_000);

  afterAll(async () => {
    if (closeDb) await closeDb();
    dropDatabaseOrThrow({ superUrl, psqlBin }, dbName);
  });

  test('keys left out of the body are kept', async () => {
    const chatId = await addChat({ followUpConfig: { enabled: false }, closeOutcome: 'lost', agentPaused: true });

    const stored = await patch(chatId, { settings: { closed: false, closeUntil: '2030-01-01T00:00:00.000Z' } });

    expect(stored).toEqual({
      followUpConfig: { enabled: false },
      closeOutcome: 'lost',
      agentPaused: true,
      closed: false,
      closeUntil: '2030-01-01T00:00:00.000Z',
    });
  });

  test('a key sent as null is stored as null and a nested object is replaced whole', async () => {
    const chatId = await addChat({ followUpConfig: { enabled: false, maxFollowUps: 2 }, agentPaused: true, keep: 1 });

    const stored = await patch(chatId, { settings: { agentPaused: null, followUpConfig: { enabled: true } } });

    expect(stored).toEqual({ followUpConfig: { enabled: true }, agentPaused: null, keep: 1 });
  });

  test('a chat without settings takes the body as its settings', async () => {
    const chatId = await addChat(null);

    expect(await patch(chatId, { settings: { closed: false } })).toEqual({ closed: false });
  });

  test('settings: null clears every setting and a body without settings leaves them alone', async () => {
    const chatId = await addChat({ agentPaused: true });

    expect(await patch(chatId, { name: 'Renamed' })).toEqual({ agentPaused: true });
    expect(await patch(chatId, { settings: null })).toBeNull();
  });

  test('chat.handoff_activated fires when the body pauses the agent, not when a paused chat keeps its pause', async () => {
    const pausedId = await addChat({ agentPaused: true });
    const activeId = await addChat({ agentPaused: false });

    await patch(pausedId, { settings: { note: 'kept paused' } });
    await patch(activeId, { settings: { agentPaused: true } });

    expect(handoffEventsFor(pausedId)).toHaveLength(0);
    expect(handoffEventsFor(activeId)).toHaveLength(1);
  });
});
