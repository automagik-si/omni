/** RFC-0002: seek over a migrated disposable PostgreSQL database; never ambient DATABASE_URL. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EventBus } from '@omni/core';
import { type Database, apiKeys, configAuditLogs, durableConsumers, instances, omniEvents, tenants } from '@omni/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { configAuditMiddleware } from '../middleware/config-audit';
import { errorHandler } from '../middleware/error';
import { scopeEnforcerMiddleware } from '../middleware/scope-enforcer';
import { eventConsumersRoutes } from '../routes/v2/event-consumers';
import { EventConsumerService } from '../services/event-consumers';
import type { ApiKeyData, AppVariables } from '../types';
import { createMigratedTestDatabase } from './fixtures/pg-clone';

const superUrl = process.env.OMNI_G3_POSTGRES_URL ?? '';
const postgresDescribe = superUrl ? describe : describe.skip;
const fixture = createMigratedTestDatabase({ superUrl, psqlBin: process.env.OMNI_G3_PSQL_BIN ?? 'psql' });

postgresDescribe('audited consumer seek (RFC-0002)', () => {
  let db: Database;
  let service: EventConsumerService;
  let rows: Array<typeof omniEvents.$inferSelect>;
  let owner: ApiKeyData;
  let other: ApiKeyData;
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus = {
    publishGeneric: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    },
  } as unknown as EventBus;

  beforeAll(async () => {
    db = fixture.setup();
    service = new EventConsumerService(db);
    const keys = await db
      .insert(apiKeys)
      .values(
        ['owner', 'other'].map((name) => ({
          name,
          keyPrefix: name,
          keyHash: name.padEnd(64, '0'),
          scopes: ['events:consume'],
        })),
      )
      .returning();
    owner = { ...keys[0]!, expiresAt: null };
    other = { ...keys[1]!, expiresAt: null };
    const instanceRows = await db
      .insert(instances)
      .values(['visible', 'hidden'].map((name) => ({ name, channel: 'whatsapp-baileys' as const })))
      .returning();
    rows = await db
      .insert(omniEvents)
      .values(
        [0, 1, 2, 3].map((index) => ({
          channel: 'whatsapp-baileys' as const,
          eventType: 'custom.seek' as const,
          receivedAt: new Date(`2026-01-01T00:00:0${index}.000Z`),
          instanceId: instanceRows[index === 2 ? 1 : 0]!.id,
          accessDecision: index === 1 ? ('denied' as const) : ('allowed' as const),
          rawPayload: { index },
        })),
      )
      .returning();
    owner = { ...owner, instanceIds: [instanceRows[0]!.id] };
    other = { ...other, instanceIds: [instanceRows[1]!.id] };
  }, 180_000);
  afterAll(() => fixture.teardown());

  const caller = () => ({ keyId: owner.id, instanceIds: owner.instanceIds, ownOnly: true });
  const seq = (index: number) => Number(rows[index]!.journalSeq);
  async function create(name: string, shared = false) {
    return service.create({ name, eventType: 'custom.seek', startFrom: 'now', scoped: true, shared }, caller());
  }
  function mount(key: ApiKeyData = owner) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('services', { db, eventConsumers: service } as never);
      c.set('apiKey', key);
      c.set('eventBus', bus);
      c.set('requestId', 'seek-test');
      await next();
    });
    app.use('*', configAuditMiddleware);
    app.use('*', scopeEnforcerMiddleware);
    app.route('/api/v2', eventConsumersRoutes);
    return app;
  }
  function request(name: string, body: unknown, key = owner) {
    return mount(key).request(`/api/v2/events/consumers/${name}/seek`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-omni-actor': 'seek-test' },
      body: JSON.stringify(body),
    });
  }

  test('sequence seeks backward and forward, including both journal bounds', async () => {
    await create('seek-sequence');
    expect((await service.seek('seek-sequence', { toSequence: seq(0) }, caller())).data.cursor).toBe(seq(0));
    expect((await service.pull('seek-sequence', {}, caller())).items[0]?.id).toBe(rows[1]!.id);
    expect((await service.seek('seek-sequence', { toSequence: seq(3) }, caller())).data.cursor).toBe(seq(3));
    expect((await service.pull('seek-sequence', {}, caller())).items).toEqual([]);
  });

  test('time seeks backward/forward and delivers the row at or immediately after the target first', async () => {
    await create('seek-time');
    for (const [time, expected] of [
      ['2026-01-01T00:00:01Z', 1],
      ['2026-01-01T00:00:02.500Z', 3],
      ['2026-01-01T00:00:00Z', 0],
    ] as const) {
      await service.seek('seek-time', { toTime: time }, caller());
      expect((await service.pull('seek-time', {}, caller())).items[0]?.id).toBe(rows[expected]!.id);
    }
  });

  test('outside sequence/time bounds is refused without changing the cursor', async () => {
    const consumer = await create('seek-bounds');
    for (const target of [
      { toSequence: seq(0) - 1 },
      { toSequence: seq(3) + 1 },
      { toTime: '2025-12-31T23:59:59Z' },
      { toTime: '2026-01-01T00:00:04Z' },
    ]) {
      await expect(service.seek('seek-bounds', target, caller())).rejects.toThrow(/within/);
      expect((await service.inspect('seek-bounds', caller())).cursor).toBe(consumer.cursor);
    }
  });

  test('successful HTTP seek writes config audit and exactly one provisional custom.consumer.sought event', async () => {
    const consumer = await create('seek-audit');
    const before = published.length;
    const response = await request('seek-audit', { toSequence: seq(0) });
    expect(response.status).toBe(200);
    await Bun.sleep(25); // existing audit middleware persists asynchronously
    const audit = await db.select().from(configAuditLogs).where(eq(configAuditLogs.targetId, 'seek-audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'consumer.seek',
      apiKeyId: owner.id,
      actor: 'seek-test',
      statusCode: 200,
    });
    expect(audit[0]!.changes).toMatchObject({ cursor: { before: consumer.cursor, after: seq(0) } });
    expect(published.slice(before)).toEqual([
      {
        type: 'custom.consumer.sought',
        payload: {
          consumerId: consumer.id,
          name: consumer.name,
          from: consumer.cursor,
          to: seq(0),
          by: owner.id,
          when: expect.any(String),
        },
      },
    ]);
    expect(Number.isFinite(Date.parse(published[before]!.payload.when as string))).toBe(true);
  });

  test('unauthorized scopes, non-owner keys and restricted keys on unscoped consumers are refused', async () => {
    const consumer = await create('seek-forbidden');
    const before = published.length;
    expect(
      (await request('seek-forbidden', { toSequence: seq(0) }, { ...owner, scopes: ['events:read'] })).status,
    ).toBe(403);
    expect((await request('seek-forbidden', { toSequence: seq(0) }, other)).status).toBe(404);
    await service.create({ name: 'seek-unscoped', eventType: 'custom.seek' });
    expect((await request('seek-unscoped', { toSequence: seq(0) }, { ...owner, scopes: ['*'] })).status).toBe(403);
    expect((await service.inspect('seek-forbidden', caller())).cursor).toBe(consumer.cursor);
    expect(published).toHaveLength(before);
    expect(
      (await request('seek-forbidden', { toSequence: seq(0) }, { ...other, scopes: ['*'], instanceIds: null })).status,
    ).toBe(200);
  });

  test('exactly one valid target is required at the HTTP boundary', async () => {
    await create('seek-invalid');
    for (const target of [
      {},
      { toSequence: seq(0), toTime: '2026-01-01T00:00:00Z' },
      { toSequence: -1 },
      { toSequence: 1.5 },
      { toSequence: '1' },
      { toTime: 'yesterday' },
      { toSequence: seq(0), extra: true },
      { toSequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect((await request('seek-invalid', target)).status).toBe(400);
    }
  });

  test('outstanding and expired shared leases refuse seek; ack allows atomic watermark reset and replay', async () => {
    await create('seek-shared', true);
    await service.seek('seek-shared', { toTime: '2026-01-01T00:00:00Z' }, caller());
    const page = await service.pull('seek-shared', { limit: 1 }, caller());
    expect(page.leaseId).toBeString();
    expect((await request('seek-shared', { toSequence: seq(3) })).status).toBe(409);
    const consumer = await service.getByName('seek-shared');
    await db
      .update(durableConsumers)
      .set({
        leaseState: {
          ...consumer.leaseState!,
          leases: consumer.leaseState!.leases.map((lease) => ({ ...lease, expiresAt: 0 })),
        },
      })
      .where(eq(durableConsumers.id, consumer.id));
    expect((await request('seek-shared', { toSequence: seq(3) })).status).toBe(409);
    await service.ack('seek-shared', 0, page.leaseId, caller());
    await service.seek('seek-shared', { toSequence: seq(0) }, caller());
    expect((await service.getByName('seek-shared')).leaseState).toEqual({ claimed: seq(0), leases: [] });
    expect((await service.pull('seek-shared', { limit: 1 }, caller())).items[0]?.id).toBe(rows[1]!.id);
  });

  test('concurrent shared pull and seek never overwrite an outstanding lease', async () => {
    await create('seek-race', true);
    await service.seek('seek-race', { toSequence: seq(0) }, caller());
    const [pull, seek] = await Promise.allSettled([
      service.pull('seek-race', { limit: 1 }, caller()),
      service.seek('seek-race', { toSequence: seq(0) }, caller()),
    ]);
    expect(pull.status).toBe('fulfilled');
    if (pull.status !== 'fulfilled') throw pull.reason;
    const stored = await service.getByName('seek-race');
    expect(stored.leaseState?.leases.map((lease) => lease.id)).toContain(pull.value.leaseId);
    if (seek.status === 'rejected') expect(seek.reason.code).toBe('CONFLICT');
    await service.ack('seek-race', 0, pull.value.leaseId, caller());
  });

  test('back-seek preserves instance visibility and access-verdict filters', async () => {
    await service.create(
      { name: 'seek-visibility', eventType: 'custom.seek', scoped: true, access: 'allowed' },
      caller(),
    );
    await service.seek('seek-visibility', { toTime: '2026-01-01T00:00:00Z' }, caller());
    const page = await service.pull('seek-visibility', {}, caller());
    expect(page.items.map((row) => row.id)).toEqual([rows[0]!.id, rows[3]!.id]);
    expect(page.items.map((row) => row.id)).not.toContain(rows[2]!.id);
  });

  test('bounds are tenant-local and an empty tenant journal refuses seek', async () => {
    const tenantRows = await db
      .insert(tenants)
      .values([
        { slug: 'seek-a', displayName: 'Seek A', maxKeyTtlSeconds: 86400, maxKeyRateLimit: 100, maxKeyBudget: 100 },
        { slug: 'seek-b', displayName: 'Seek B', maxKeyTtlSeconds: 86400, maxKeyRateLimit: 100, maxKeyBudget: 100 },
      ])
      .returning();
    const tenantCaller = { keyId: null, instanceIds: null, tenantId: tenantRows[0]!.id };
    await service.create({ name: 'seek-empty-tenant', eventType: 'custom.seek' }, tenantCaller);
    await expect(service.seek('seek-empty-tenant', { toSequence: seq(0) }, tenantCaller)).rejects.toThrow(/empty/);
    const [event] = await db
      .insert(omniEvents)
      .values({ tenantId: tenantRows[0]!.id, channel: 'whatsapp-baileys', eventType: 'custom.seek' })
      .returning();
    await expect(service.seek('seek-empty-tenant', { toSequence: seq(3) }, tenantCaller)).rejects.toThrow(/within/);
    expect(
      (await service.seek('seek-empty-tenant', { toSequence: Number(event!.journalSeq) }, tenantCaller)).data.cursor,
    ).toBe(Number(event!.journalSeq));
    await expect(
      service.seek(
        'seek-empty-tenant',
        { toSequence: Number(event!.journalSeq) },
        { ...tenantCaller, tenantId: tenantRows[1]!.id },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
