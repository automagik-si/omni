/**
 * The two-responder detector against real rows (services/two-responders.ts, GET /system/two-responders):
 * the loader's joins, the route, the tenant boundary and the caller's instance restriction, and that a
 * read leaves every consumer row as it was.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@omni/db';
import { agents, apiKeys, durableConsumers, instances, tenants } from '@omni/db';
import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { scopeEnforcerMiddleware } from '../middleware/scope-enforcer';
import { systemRoutes } from '../routes/v2/system';
import { TwoRespondersSchema } from '../schemas/openapi/system';
import { findTwoResponders } from '../services/two-responders';
import type { ApiKeyData, AppVariables } from '../types';
import { createMigratedTestDatabase } from './fixtures/pg-clone';

const superUrl = process.env.OMNI_G4_POSTGRES_URL ?? '';
const postgresDescribe = superUrl ? describe : describe.skip;
const psqlBin = process.env.OMNI_G4_PSQL_BIN ?? 'psql';
const DAY_MS = 24 * 60 * 60 * 1000;

postgresDescribe('two responders on one instance', () => {
  let db: Database;
  const clone = createMigratedTestDatabase({ superUrl, psqlBin });
  const ids = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    instA: randomUUID(),
    instB: randomUUID(),
    instRetired: randomUUID(),
    instBare: randomUUID(),
    sendKey: randomUUID(),
    readKey: randomUUID(),
  };
  let helperId = '';

  function mount(apiKey: Partial<ApiKeyData>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('apiKey', {
        id: 'doctor-key',
        name: 'doctor',
        scopes: ['system:read'],
        instanceIds: null,
        expiresAt: null,
        profile: null,
        chatAllowlist: [],
        instanceAllowlist: [],
        outboundRecipientAllowlist: [],
        ...apiKey,
      });
      await next();
    });
    app.use('*', scopeEnforcerMiddleware);
    app.route('/api/v2/system', systemRoutes);
    return app;
  }

  async function read(apiKey: Partial<ApiKeyData> = {}) {
    const response = await mount(apiKey).request('/api/v2/system/two-responders');
    expect(response.status).toBe(200);
    return z.object({ data: TwoRespondersSchema }).parse(await response.json()).data;
  }

  const names = (data: z.infer<typeof TwoRespondersSchema>) =>
    data.instances.map((row) => [row.instanceName, row.consumers.map((c) => c.name)]);

  beforeAll(async () => {
    db = clone.setup();
    for (const id of [ids.tenantA, ids.tenantB]) {
      await db.insert(tenants).values({
        id,
        slug: id,
        displayName: id,
        maxKeyTtlSeconds: 86400,
        maxKeyRateLimit: 1000,
        maxKeyBudget: 1000,
      });
    }
    const [helper] = await db.insert(agents).values({ name: 'helper', provider: 'custom' }).returning();
    const [retired] = await db
      .insert(agents)
      .values({ name: 'retired', provider: 'custom', isActive: false })
      .returning();
    if (!helper || !retired) throw new Error('agents not created');
    helperId = helper.id;
    const channel = 'whatsapp-baileys' as const;
    await db.insert(instances).values([
      { id: ids.instA, name: `a-line-${ids.instA}`, channel, tenantId: ids.tenantA, agentId: helper.id },
      { id: ids.instB, name: `b-line-${ids.instB}`, channel, tenantId: ids.tenantB, agentId: helper.id },
      { id: ids.instRetired, name: `retired-line-${ids.instRetired}`, channel, agentId: retired.id },
      { id: ids.instBare, name: `bare-line-${ids.instBare}`, channel },
    ]);
    const key = (id: string, scopes: string[]) => ({
      id,
      name: `key-${id}`,
      keyPrefix: id.slice(0, 8),
      keyHash: createHash('sha256').update(id).digest('hex'),
      scopes,
    });
    await db
      .insert(apiKeys)
      .values([
        key(ids.sendKey, ['events:consume', 'messages:send']),
        key(ids.readKey, ['events:consume', 'messages:read']),
      ]);
    const base = { eventType: 'message.received', cursor: 0 };
    await db.insert(durableConsumers).values([
      { ...base, name: 'app-a', tenantId: ids.tenantA, ownerKeyId: ids.sendKey },
      { ...base, name: 'app-legacy', eventType: 'message.*' },
      {
        ...base,
        name: 'app-b-conditions',
        tenantId: ids.tenantB,
        filters: [{ field: 'payload.from', operator: 'eq', value: 'nobody' }],
      },
      { ...base, name: 'stale', updatedAt: new Date(Date.now() - 30 * DAY_MS) },
      { ...base, name: 'no-send', ownerKeyId: ids.readKey },
      { ...base, name: 'bare-only', scoped: true, instanceIds: [ids.instBare], ownerKeyId: ids.sendKey },
      { ...base, name: 'denied-only', accessFilter: 'denied' },
    ]);
  });

  afterAll(() => clone.teardown());

  test('a legacy unrestricted key sees each agent instance with its matching consumers', async () => {
    const data = await read();
    expect(data.activeWindowDays).toBe(7);
    expect(names(data)).toEqual([
      [`a-line-${ids.instA}`, ['app-a', 'app-legacy']],
      [`b-line-${ids.instB}`, ['app-b-conditions', 'app-legacy']],
    ]);
    const [a] = data.instances;
    expect(a).toMatchObject({
      instanceId: ids.instA,
      agentId: helperId,
      agentName: 'helper',
      channel: 'whatsapp-baileys',
    });
    expect(a?.consumers.map((c) => [c.name, c.reader, c.ownerKeyId])).toEqual([
      ['app-a', 'owner-key', ids.sendKey],
      ['app-legacy', 'unrecorded', null],
    ]);
  });

  test("a tenant caller sees only its own tenant's instances and stamped consumers", async () => {
    const flagged = await findTwoResponders(db, { tenantId: ids.tenantA, instanceIds: null });
    expect(flagged.map((row) => [row.instanceId, row.consumers.map((c) => c.name)])).toEqual([[ids.instA, ['app-a']]]);
    expect(await findTwoResponders(db, { tenantId: randomUUID(), instanceIds: null })).toEqual([]);
  });

  test('an instance-restricted key sees only the instances it may access', async () => {
    expect(names(await read({ instanceIds: [ids.instB] }))).toEqual([
      [`b-line-${ids.instB}`, ['app-b-conditions', 'app-legacy']],
    ]);
    expect(names(await read({ instanceIds: [ids.instBare, ids.instRetired] }))).toEqual([]);
  });

  test('the read writes nothing', async () => {
    const snapshot = () => db.select().from(durableConsumers).orderBy(asc(durableConsumers.name));
    const before = await snapshot();
    await read();
    expect(await snapshot()).toEqual(before);
  });
});
