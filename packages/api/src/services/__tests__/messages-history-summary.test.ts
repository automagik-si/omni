import { Database as SQLite } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type Database, type MessageSource, chats } from '@omni/db';
import { type SQL, getTableColumns, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { MessageService } from '../messages';

// Execute the service's actual summary expressions against disposable rows.
// PostgreSQL coverage lives in message-count-accuracy-postgres.test.ts.
function fixture() {
  const sqlite = new SQLite(':memory:');
  sqlite.exec(
    'create table chats (id text, last_message_at text, last_message_preview text, message_count integer, updated_at text)',
  );
  sqlite.exec("insert into chats values ('chat', null, null, 0, null)");
  const db = {
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    insert: () => ({ values: (row: unknown) => ({ returning: async () => [row] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: SQL) => {
          const columns = getTableColumns(chats);
          const assignments = Object.entries(values).map(
            ([key, value]) => sql`${sql.identifier(columns[key as keyof typeof columns].name)} = ${value}`,
          );
          const query = new PgDialect().sqlToQuery(
            sql`update ${chats} set ${sql.join(assignments, sql`, `)} where ${condition}`,
          );
          const params = query.params.map((value) => (value instanceof Date ? value.toISOString() : value));
          sqlite.query(query.sql).run(...(params as (string | number | null)[]));
        },
      }),
    }),
  };
  let id = 0;
  return {
    sqlite,
    create: (source: MessageSource, at: string, text: string) =>
      new MessageService(db as unknown as Database, null).create({
        chatId: 'chat',
        externalId: String(++id),
        source,
        messageType: 'text',
        textContent: text,
        platformTimestamp: new Date(at),
      }),
    summary: () =>
      sqlite
        .query('select last_message_at as at, last_message_preview as preview, message_count as count from chats')
        .get(),
  };
}

describe('history message chat summaries', () => {
  test('backward history preserves the newer summary and increments every message count; live behavior stays unchanged', async () => {
    const f = fixture();
    try {
      await f.create('realtime', '2026-02-01', 'newest');
      await f.create('sync', '2026-01-15', 'older');
      await f.create('sync', '2026-01-01', 'oldest');
      expect(f.summary()).toEqual({ at: '2026-02-01T00:00:00.000Z', preview: 'newest', count: 3 });
      await f.create('sync', '2026-02-01', 'equal timestamp');
      expect(f.summary()).toEqual({ at: '2026-02-01T00:00:00.000Z', preview: 'newest', count: 4 });
      await f.create('realtime', '2026-01-20', 'live arrival');
      expect(f.summary()).toEqual({ at: '2026-01-20T00:00:00.000Z', preview: 'live arrival', count: 5 });
    } finally {
      f.sqlite.close();
    }
  });
  test('history initializes an empty summary and advances both fields for a newer message', async () => {
    const f = fixture();
    try {
      await f.create('sync', '2026-01-01', 'first');
      expect(f.summary()).toEqual({ at: '2026-01-01T00:00:00.000Z', preview: 'first', count: 1 });
      await f.create('sync', '2026-02-01', 'later');
      expect(f.summary()).toEqual({ at: '2026-02-01T00:00:00.000Z', preview: 'later', count: 2 });
    } finally {
      f.sqlite.close();
    }
  });
});
