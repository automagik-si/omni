import { describe, expect, test } from 'bun:test';
import type { EventBus } from '@omni/core';
import type { Database, SyncJob } from '@omni/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SyncJobService } from '../sync-jobs';

describe('sync job cancellation races', () => {
  for (const action of ['complete', 'fail', 'updateProgress'] as const) {
    test(`${action} returns the persisted cancelled job without a terminal publish`, async () => {
      const job = {
        id: 'job',
        instanceId: 'line',
        status: 'cancelled',
        channel: 'whatsapp-baileys',
        type: 'messages',
        config: { backfill: { chatId: 'chat' } },
        progress: { state: 'cancelled', fetched: 0, stored: 0 },
      } as SyncJob;
      const queries: { sql: string; params: unknown[] }[] = [];
      const publishes: string[] = [];
      const db = {
        update: () => ({
          set: () => ({
            where: (condition: SQL) => {
              queries.push(new PgDialect().sqlToQuery(condition));
              return { returning: async () => [] };
            },
          }),
        }),
      } as unknown as Database;
      const bus = {
        publish: async (type: string) => {
          publishes.push(type);
        },
      } as unknown as EventBus;
      const service = new SyncJobService(db, bus);
      service.getById = async () => job;
      const result =
        action === 'fail'
          ? await service.fail('job', 'late failure')
          : action === 'updateProgress'
            ? await service.updateProgress('job', { state: 'done' })
            : await service.complete('job');
      expect(result).toBe(job);
      expect(queries[0]?.sql).toContain('"status" in');
      expect(queries[0]?.params).toEqual(['job', 'pending', 'running']);
      expect(publishes).toEqual([]);
    });
  }
});
