import { describe, expect, test } from 'bun:test';
import { NotFoundError } from '@omni/core';
import { Hono } from 'hono';
import type { JournalReader } from '../../../services/journal-visibility';
import type { AppVariables } from '../../../types';
import { automationsRoutes } from '../automations';
import { payloadsRoutes } from '../payloads';

const id = '11111111-1111-4111-8111-111111111111';

describe('journal secondary readers fail closed (#1738)', () => {
  for (const instanceIds of [null, [id], []]) {
    for (const [method, path, body] of [
      ['GET', `/events/${id}/payloads`, undefined],
      ['GET', `/events/${id}/payloads/webhook_raw`, undefined],
      ['DELETE', `/events/${id}/payloads`, { reason: 'test' }],
      ['POST', `/automations/${id}/test`, { eventId: id }],
      ['POST', `/automations/${id}/execute`, { eventId: id }],
    ] as const) {
      test(`${method} ${path}, instances=${JSON.stringify(instanceIds)}: denied parent stops the operation`, async () => {
        let effects = 0;
        const readers: JournalReader[] = [];
        const app = new Hono<{ Variables: AppVariables }>();
        app.use('*', async (c, next) => {
          c.set('apiKey', { id, scopes: ['events:read'], instanceIds } as never);
          c.set('services', {
            events: {
              getById: async (_id: string, reader: JournalReader) => {
                readers.push(reader);
                throw new NotFoundError('Event', id);
              },
            },
            payloadStore: {
              getByEventId: async () => {
                effects++;
                return [];
              },
              getByStage: async () => {
                effects++;
                return {};
              },
              softDelete: async () => {
                effects++;
                return 1;
              },
            },
            automations: {
              test: async () => {
                effects++;
                return {};
              },
              execute: async () => {
                effects++;
                return {};
              },
            },
          } as never);
          await next();
        });
        app.onError((err, c) => c.json({ error: err.message }, 404));
        app.route('/', payloadsRoutes);
        app.route('/automations', automationsRoutes);
        const response = await app.request(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status).toBe(404);
        expect(readers).toEqual([{ instanceIds, fullAccess: false }]);
        expect(effects).toBe(0);
      });
    }
  }
});
