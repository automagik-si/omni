import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Database } from '@omni/db';
import { chatParticipants, chats, instances, persons, platformIdentities } from '@omni/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { instancesRoutes } from '../routes/v2/instances';
import { createServices } from '../services';
import type { AppVariables } from '../types';
import { createMigratedTestDatabase } from './fixtures/pg-clone';

const superUrl = process.env.OMNI_G4_POSTGRES_URL ?? '';
const psqlBin = process.env.OMNI_G4_PSQL_BIN ?? 'psql';
const postgresDescribe = superUrl ? describe : describe.skip;
const migration = readFileSync(
  new URL('../../../db/drizzle/0098_clear_telegram_pictures.sql', import.meta.url),
  'utf8',
);
const token = '123456:made-up-channel-credential';
const unsafePicture = `https://api.telegram.org/file/bot${token}/photos/picture.jpg`;
const safePicture = 'https://example.com/picture.jpg';

postgresDescribe('Existing Telegram pictures protect the channel credential', () => {
  const clone = createMigratedTestDatabase({ superUrl, psqlBin });
  let db: Database;

  beforeAll(() => {
    db = clone.setup();
  });
  afterAll(() => clone.teardown());

  async function seed(picture: string | null) {
    const [instance] = await db
      .insert(instances)
      .values({ name: `picture-${crypto.randomUUID()}`, channel: 'telegram', profilePicUrl: picture })
      .returning();
    const [person] = await db.insert(persons).values({ avatarUrl: picture }).returning();
    if (!instance || !person) throw new Error('Picture fixture missing');
    const [identity] = await db
      .insert(platformIdentities)
      .values({
        channel: 'telegram',
        instanceId: instance.id,
        personId: person.id,
        platformUserId: '2',
        profilePicUrl: picture,
      })
      .returning();
    const [chat] = await db
      .insert(chats)
      .values({ instanceId: instance.id, channel: 'telegram', externalId: '2', chatType: 'dm', avatarUrl: picture })
      .returning();
    if (!identity || !chat) throw new Error('Picture fixture missing');
    const [participant] = await db
      .insert(chatParticipants)
      .values({
        chatId: chat.id,
        personId: person.id,
        platformIdentityId: identity.id,
        platformUserId: '2',
        avatarUrl: picture,
      })
      .returning();
    if (!participant) throw new Error('Picture fixture missing');
    return { instance, person, identity, chat, participant };
  }

  async function pictures(fixture: Awaited<ReturnType<typeof seed>>) {
    const [instance] = await db.select().from(instances).where(eq(instances.id, fixture.instance.id));
    const [person] = await db.select().from(persons).where(eq(persons.id, fixture.person.id));
    const [identity] = await db.select().from(platformIdentities).where(eq(platformIdentities.id, fixture.identity.id));
    const [chat] = await db.select().from(chats).where(eq(chats.id, fixture.chat.id));
    const [participant] = await db
      .select()
      .from(chatParticipants)
      .where(eq(chatParticipants.id, fixture.participant.id));
    return [
      instance?.profilePicUrl,
      person?.avatarUrl,
      identity?.profilePicUrl,
      chat?.avatarUrl,
      participant?.avatarUrl,
    ];
  }

  test('previously saved unsafe pictures are cleared while other pictures are preserved', async () => {
    const unsafe = await seed(unsafePicture);
    const safe = await seed(safePicture);
    const empty = await seed(null);
    const unrelated = await seed(`https://example.com/picture?source=${unsafePicture}`);
    expect(await pictures(unsafe)).toEqual(Array(5).fill(unsafePicture));

    for (let pass = 0; pass < 2; pass++) {
      for (const statement of migration.split('--> statement-breakpoint')) await db.execute(sql.raw(statement));
      expect(await pictures(unsafe)).toEqual(Array(5).fill(null));
      expect(await pictures(safe)).toEqual(Array(5).fill(safePicture));
      expect(await pictures(empty)).toEqual(Array(5).fill(null));
      expect(await pictures(unrelated)).toEqual(Array(5).fill(`https://example.com/picture?source=${unsafePicture}`));
    }

    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('services', createServices(db, null));
      c.set('apiKey', { id: 'test', name: 'test', scopes: ['*'], instanceIds: null, expiresAt: null } as never);
      await next();
    });
    app.route('/instances', instancesRoutes);
    const response = await app.request(`/instances/${unsafe.instance.id}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(JSON.parse(body).data.profilePicUrl).toBeNull();
  });
});
