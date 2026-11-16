import { describe, expect, test } from 'bun:test';
import type { Database, SyncJob, SyncJobType } from '@omni/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SyncJobService } from '../sync-jobs';

/** Model transaction serialization while running the real service's start/update paths. */
function fixture(types: [SyncJobType, SyncJobType]) {
  const rows = new Map<string, SyncJob>(
    types.map((type, index) => [
      `job-${index}`,
      {
        id: `job-${index}`,
        instanceId: 'line',
        type,
        status: 'pending',
        config: {},
        progress: {},
      } as SyncJob,
    ]),
  );
  const dialect = new PgDialect();
  let tail = Promise.resolve();
  const db = {
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(db as unknown as Database);
      } finally {
        release();
      }
    },
    execute: async () => [],
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          const [instanceId, status] = dialect.sqlToQuery(condition).params;
          return [...rows.values()].filter((row) => row.instanceId === instanceId && row.status === status);
        },
      }),
    }),
    update: () => ({
      set: (values: Partial<SyncJob>) => ({
        where: (condition: SQL) => ({
          returning: async () => {
            const [id, ...statuses] = dialect.sqlToQuery(condition).params;
            const row = rows.get(String(id));
            if (!row || !statuses.includes(row.status)) return [];
            Object.assign(row, values);
            return [{ ...row }];
          },
        }),
      }),
    }),
  };
  const service = new SyncJobService(db as unknown as Database, null);
  service.getById = async (id) => ({ ...rows.get(id)! });
  return { service, rows };
}

describe('legacy history jobs share one history slot per line', () => {
  for (const types of [
    ['messages', 'messages'],
    ['messages', 'all'],
    ['all', 'messages'],
    ['all', 'all'],
  ] as [SyncJobType, SyncJobType][]) {
    test(`${types.join(' and ')} cannot both start before the first finishes`, async () => {
      const f = fixture(types);
      const started = await Promise.all([f.service.start('job-0'), f.service.start('job-1')]);
      expect(started.map((job) => job.status).sort()).toEqual(['pending', 'running']);
      expect([...f.rows.values()].filter((job) => job.status === 'running')).toHaveLength(1);
      const running = started.find((job) => job.status === 'running')!;
      const waiting = started.find((job) => job.status === 'pending')!;
      await f.service.complete(running.id);
      expect((await f.service.start(waiting.id)).status).toBe('running');
    });
  }
  test('another line can still start independently', async () => {
    const f = fixture(['messages', 'all']);
    f.rows.get('job-1')!.instanceId = 'other-line';
    const started = await Promise.all([f.service.start('job-0'), f.service.start('job-1')]);
    expect(started.map((job) => job.status)).toEqual(['running', 'running']);
  });
});
