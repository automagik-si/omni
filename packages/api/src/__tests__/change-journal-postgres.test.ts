/** Real journal handlers, writers and every key-facing reader. Disposable PG gate only (#1738). */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ConnectorEventPublisher, EventBus } from '@omni/core';
import { type Database, chats, createDbHandle, instances, omniEvents, persons, platformIdentities } from '@omni/db';
import { pgRoleUrl, provisionMigratedDatabase } from '@omni/db/pg-migrated-template';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setupEventPersistence } from '../plugins/event-persistence';
import { automationsRoutes } from '../routes/v2/automations';
import { eventConsumersRoutes } from '../routes/v2/event-consumers';
import { eventOpsRoutes } from '../routes/v2/event-ops';
import { eventsRoutes } from '../routes/v2/events';
import { payloadsRoutes } from '../routes/v2/payloads';
import { personsRoutes } from '../routes/v2/persons';
import { AccessService } from '../services/access';
import { ChatService } from '../services/chats';
import type { DeadLetterService } from '../services/dead-letters';
import { type ConsumerCaller, EventConsumerService } from '../services/event-consumers';
import { EventOpsService } from '../services/event-ops';
import { EventService } from '../services/events';
import { CHANGE_JOURNAL_POLICY, type JournalReader } from '../services/journal-visibility';
import type { PayloadStoreService } from '../services/payload-store';
import { PersonService } from '../services/persons';
import type { AppVariables } from '../types';

const superUrl = process.env.OMNI_G3_POSTGRES_URL ?? '';
const postgresDescribe = superUrl ? describe : describe.skip;
type Delivery = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  metadata: Record<string, unknown>;
};
type Handler = (event: Delivery) => Promise<void>;

postgresDescribe('record change journal (#1738, real PostgreSQL)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let instanceId: string;
  let personId: string;
  let chatId: string;
  let events: EventService;
  let consumers: EventConsumerService;
  let ops: EventOpsService;
  const handlers = new Map<string, Handler>();
  const replayed: string[] = [];
  const published: Array<{ type: string; payload: Record<string, unknown>; metadata?: Record<string, unknown> }> = [];
  const bus = {
    subscribe: async () => {},
    subscribePattern: async (pattern: string, handler: Handler) => {
      handlers.set(pattern, handler);
    },
    publish: async (type: string, payload: Record<string, unknown>, metadata?: Record<string, unknown>) => {
      published.push({ type, payload, metadata });
      return { id: randomUUID() };
    },
  } as unknown as EventBus;

  beforeAll(async () => {
    const name = `omni_change_journal_${randomUUID().replaceAll('-', '')}`;
    provisionMigratedDatabase({ superUrl, psqlBin: process.env.OMNI_G3_PSQL_BIN ?? 'psql' }, name);
    const handle = createDbHandle({ url: pgRoleUrl(superUrl, name), maxConnections: 3 });
    db = handle.db;
    close = () => handle.close();
    instanceId = (
      await db.insert(instances).values({ name: 'journal-test', channel: 'whatsapp-baileys' }).returning()
    )[0]!.id;
    personId = (await db.insert(persons).values({ displayName: 'journal-test' }).returning())[0]!.id;
    chatId = (
      await db
        .insert(chats)
        .values({ instanceId, externalId: 'journal-test', channel: 'whatsapp-baileys', chatType: 'dm' })
        .returning()
    )[0]!.id;
    events = new EventService(db);
    consumers = new EventConsumerService(db);
    ops = new EventOpsService(
      db,
      {
        publishGeneric: async (type: string) => {
          replayed.push(type);
          return { id: randomUUID() };
        },
      } as unknown as EventBus & ConnectorEventPublisher,
      { getStats: async () => ({ pending: 0, resolved: 0 }) } as unknown as DeadLetterService,
      { getStats: async () => ({ totalPayloads: 0, totalSizeCompressed: 0 }) } as unknown as PayloadStoreService,
    );
    await setupEventPersistence(bus, db);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await db.delete(omniEvents);
    published.length = 0;
  });

  async function journal(type: string, scoped = true, causationId?: string): Promise<string> {
    const id = randomUUID();
    const family = type.split('.')[0];
    const handler = handlers.get(`${family}.>`);
    if (!handler) throw new Error(`missing ${family} subscriber`);
    await handler({
      id,
      type,
      payload: { personId, chatId },
      timestamp: Date.now(),
      metadata: { ...(scoped ? { instanceId } : {}), causationId },
    });
    return id;
  }

  test('each CRUD event emits once and contains IDs and changed field names only', async () => {
    const access = new AccessService(db, bus);
    const chatService = new ChatService(db, bus);
    const personService = new PersonService(db, bus);
    const rule = await access.create({
      instanceId,
      ruleType: 'allow',
      phonePattern: 'private-phone',
      reason: 'private-reason',
    });
    await access.update(rule.id, { reason: 'private-change', enabled: false, blockMessage: undefined });
    await access.delete(rule.id);
    const chat = await chatService.create({
      instanceId,
      externalId: 'private-jid',
      channel: 'whatsapp-baileys',
      chatType: 'dm',
      name: 'private-name',
    });
    await chatService.update(chat.id, { name: 'private-change' });
    await chatService.addLabel(chat.id, 'private-label');
    await chatService.removeLabel(chat.id, 'private-label');
    await chatService.delete(chat.id);
    const source = await personService.create({ displayName: 'private-name', primaryPhone: 'private-phone' });
    await personService.update(source.id, { displayName: 'private-change', primaryEmail: undefined });
    await db
      .insert(platformIdentities)
      .values({ personId: source.id, instanceId, channel: 'whatsapp-baileys', platformUserId: randomUUID() });
    await personService.mergePersons(source.id, personId, 'private-reason');
    expect(published.map((event) => event.type)).toEqual([
      'access.rule_created',
      'access.rule_updated',
      'access.rule_deleted',
      'chat.created',
      'chat.updated',
      'chat.updated',
      'chat.updated',
      'chat.deleted',
      'person.created',
      'person.updated',
      'person.merged',
    ]);
    expect(published[1]?.payload.changedKeys).toEqual(['reason', 'enabled']);
    expect(published[5]?.payload.changedKeys).toEqual(['labels']);
    expect(published[6]?.payload.changedKeys).toEqual(['labels']);
    expect(published[9]?.payload.changedKeys).toEqual(['displayName']);
    for (const event of published) {
      expect(JSON.stringify(event.payload)).not.toContain('private-');
      expect(
        Object.keys(event.payload).every((key) =>
          [
            'ruleId',
            'instanceId',
            'chatId',
            'personId',
            'changedKeys',
            'sourcePersonId',
            'targetPersonId',
            'mergedIdentityIds',
          ].includes(key),
        ),
      ).toBe(true);
    }
    published.length = 0;
    await expect(personService.update(randomUUID(), { displayName: 'absent' })).rejects.toThrow();
    await expect(access.delete(randomUUID())).rejects.toThrow();
    await chatService.delete(randomUUID());
    expect(published).toEqual([]);
  });

  test('every classified family lands once; verdicts and credentials never land', async () => {
    for (const [type, policy] of Object.entries(CHANGE_JOURNAL_POLICY)) {
      const id = await journal(type);
      const handler = handlers.get(`${type.split('.')[0]}.>`)!;
      await handler({ id, type, payload: { personId, chatId }, timestamp: Date.now(), metadata: { instanceId } });
      const rows = await db.select().from(omniEvents).where(eq(omniEvents.id, id));
      expect(rows.length).toBe(policy === 'never' ? 0 : 1);
      if (type === 'chat.created') expect(rows[0]?.chatUuid).toBe(chatId);
    }
  });

  function caller(fullAccess: boolean, restricted: boolean): ConsumerCaller {
    const instanceIds = restricted ? [instanceId] : null;
    return { keyId: randomUUID(), instanceIds, admin: fullAccess };
  }

  async function expectSensitiveRows(reader: JournalReader, sensitive: string[], fullAccess: boolean) {
    for (const id of sensitive) {
      if (fullAccess) expect((await events.getById(id, reader)).id).toBe(id);
      else await expect(events.getById(id, reader)).rejects.toThrow();
    }
  }

  async function expectConsumerPages(access: ConsumerCaller, restricted: boolean, expected: string[]) {
    for (const shared of [false, true]) {
      const consumer = await consumers.create(
        {
          name: randomUUID(),
          eventType: '*',
          startFrom: 'beginning',
          shared,
          ...(restricted ? { scoped: true, instanceIds: [instanceId] } : {}),
        },
        access,
      );
      expect((await consumers.pull(consumer.name, { limit: 100 }, access)).items.map((e) => e.id).sort()).toEqual(
        expected,
      );
      if (!shared)
        expect(
          (await consumers.scanForStream(consumer.name, 0, { tenantId: null, caller: access }, 100)).items
            .map((e) => e.id)
            .sort(),
        ).toEqual(expected);
    }
  }

  for (const [fullAccess, restricted] of [
    [false, true],
    [false, false],
    [true, false],
  ] as const) {
    test(`reader full=${fullAccess} restricted=${restricted}: services/pull/shared/SSE`, async () => {
      const normal = await journal('chat.created');
      const noInstance = await journal('person.created', false);
      const sensitive: string[] = [];
      for (const [type, policy] of Object.entries(CHANGE_JOURNAL_POLICY))
        if (policy === 'full-access') sensitive.push(await journal(type));
      const access = caller(fullAccess, restricted);
      const reader = { instanceIds: access.instanceIds, fullAccess };
      const expected = [normal, ...(!restricted ? [noInstance] : []), ...(fullAccess ? sensitive : [])].sort();
      expect((await events.list({ reader, limit: 100 })).items.map((e) => e.id).sort()).toEqual(expected);
      expect((await events.getTimeline(personId, { reader, limit: 100 })).items.map((e) => e.id).sort()).toEqual(
        expected,
      );
      expect((await events.getAnalytics({ reader, granularity: 'daily' })).totalMessages).toBe(expected.length);
      expect((await events.getTypes({ reader })).reduce((total, row) => total + row.count, 0)).toBe(expected.length);
      expect((await ops.getMetrics(reader)).totalEvents).toBe(expected.length);
      await expectSensitiveRows(reader, sensitive, fullAccess);
      if (restricted) await expect(events.getById(noInstance, reader)).rejects.toThrow();
      await expectConsumerPages(access, restricted, expected);
    });
  }

  test('trace prunes sensitive ancestors and descendants and rejects sensitive focus', async () => {
    const parent = await journal('access.key_minted');
    const focus = await journal('chat.updated', true, parent);
    await journal('access.device_authorized', true, focus);
    await journal('person.created', false, focus);
    const limited: JournalReader = { instanceIds: [instanceId], fullAccess: false };
    const trace = await events.trace(focus, limited);
    expect(trace.ancestors).toEqual([]);
    expect(trace.descendants).toEqual([]);
    await expect(events.trace(parent, limited)).rejects.toThrow();
    const full = await events.trace(focus, { instanceIds: null, fullAccess: true });
    expect(full.ancestors.map((e) => e.id)).toEqual([parent]);
    expect(full.descendants).toHaveLength(2);
  });

  async function responseJson(
    response: Response,
  ): Promise<{ items: Array<{ id: string; count: number }>; totalMessages: number; data: { totalEvents: number } }> {
    return (await response.json()) as {
      items: Array<{ id: string; count: number }>;
      totalMessages: number;
      data: { totalEvents: number };
    };
  }

  function appFor(scopes: string[], instanceIds: string[] | null) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('apiKey', { id: randomUUID(), scopes, instanceIds } as never);
      c.set('services', {
        db,
        events,
        eventConsumers: consumers,
        eventOps: ops,
        automations: { list: async () => [], test: async () => ({}), execute: async () => ({}) },
        payloadStore: { getByEventId: async () => [], getByStage: async () => ({}), softDelete: async () => 0 },
      } as never);
      await next();
    });
    app.onError((err, c) => c.json({ error: err.message }, 404));
    app.route('/', eventConsumersRoutes);
    app.route('/', payloadsRoutes);
    app.route('/automations', automationsRoutes);
    app.route('/events', eventsRoutes);
    app.route('/persons', personsRoutes);
    app.route('/event-ops', eventOpsRoutes);
    return app;
  }

  async function expectSecondaryRoutes(app: ReturnType<typeof appFor>, sensitive: string, expectedStatus: number) {
    for (const path of [`/events/${sensitive}/payloads`, `/events/${sensitive}/payloads/webhook_raw`])
      expect((await app.request(path)).status).toBe(expectedStatus);
    for (const action of ['test', 'execute']) {
      const response = await app.request(`/automations/${randomUUID()}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: sensitive }),
      });
      expect(response.status).toBe(expectedStatus);
    }
    const deleted = await app.request(`/events/${sensitive}/payloads`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(deleted.status).toBe(expectedStatus);
  }

  test('HTTP list/search/by-sender/analytics/types/both timelines/id/trace/metrics respect the same reader', async () => {
    const normal = await journal('chat.created');
    const sensitive = await journal('access.key_minted');
    const noInstance = await journal('person.updated', false);
    await db.update(omniEvents).set({ textContent: 'journal-boundary' });
    for (const [scopes, instanceIds, expectedCount] of [
      [['*'], [instanceId], 1],
      [['events:read'], null, 2],
      [['*'], null, 3],
      [['*'], [], 0],
    ] as const) {
      const app = appFor([...scopes], instanceIds ? [...instanceIds] : null);
      const sensitiveStatus = expectedCount === 3 ? 200 : 404;
      for (const path of [
        '/events',
        '/events/by-sender/journal-boundary',
        `/events/timeline/${personId}`,
        `/persons/${personId}/timeline`,
      ]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect((await responseJson(res)).items).toHaveLength(expectedCount);
      }
      const search = await app.request('/events/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect((await responseJson(search)).items).toHaveLength(expectedCount);
      expect((await responseJson(await app.request('/events/analytics?allTime=true'))).totalMessages).toBe(
        expectedCount,
      );
      const inventory = await responseJson(await app.request('/events/types'));
      expect(inventory.items.reduce((total: number, item: { count: number }) => total + item.count, 0)).toBe(
        expectedCount,
      );
      expect((await responseJson(await app.request('/event-ops/metrics'))).data.totalEvents).toBe(expectedCount);
      expect((await app.request(`/events/${sensitive}`)).status).toBe(sensitiveStatus);
      expect((await app.request(`/events/${sensitive}/trace`)).status).toBe(sensitiveStatus);
      expect((await app.request(`/events/${noInstance}`)).status).toBe(instanceIds === null ? 200 : 404);
      expect((await app.request(`/events/${normal}`)).status).toBe(expectedCount === 0 ? 404 : 200);
      await expectSecondaryRoutes(app, sensitive, sensitiveStatus);
    }
  });

  test('generic replay skips all new journal families, including dry-run totals', async () => {
    for (const type of ['access.key_minted', 'chat.created', 'identity.linked', 'person.created', 'instance.connected'])
      await journal(type);
    const custom = await journal('custom.record_changed');
    const session = await ops.startReplay({ since: new Date(0), dryRun: true });
    expect(session.progress.total).toBe(1);
    for (let i = 0; i < 100 && session.status === 'running'; i++) await Bun.sleep(5);
    expect(session.status).toBe('completed');
    expect(session.progress.processed).toBe(1);
    replayed.length = 0;
    const live = await ops.startReplay({ since: new Date(0), speedMultiplier: 0 });
    for (let i = 0; i < 100 && live.status === 'running'; i++) await Bun.sleep(5);
    expect(live.status).toBe('completed');
    expect(replayed.filter((type) => !type.startsWith('system.'))).toEqual(['custom.record_changed']);

    expect((await db.select().from(omniEvents).where(eq(omniEvents.id, custom)))[0]).toBeDefined();
  });
});
