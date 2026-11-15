import { describe, expect, test } from 'bun:test';
import {
  type EventBus,
  type EventMetadata,
  classifyEnvelope,
  createOmniEvent,
  setEnvelopeTenantResolver,
} from '@omni/core';
import type { Database } from '@omni/db';
import type { PlatformAuthContext } from '../../tenancy/auth-context';
import { currentTenantScope, runInTenantScope } from '../../tenancy/tenant-scope';
import { runConsumerInTenantContext } from '../../tenancy/worker-tenant-context';
import { changedRecordKeys, publishRecordChange } from '../record-change-events';

const context = {
  credentialClass: 'platform',
  requestId: 'request',
  principalId: null,
  credentialId: 'credential',
  scopes: ['*'],
  platformApiKeyId: 'key',
  platformAction: 'test-change-events',
  targetTenantId: '11111111-1111-4111-8111-111111111111',
} satisfies PlatformAuthContext;

describe('record notifications follow commit (#1738)', () => {
  const db = {
    transaction: async (callback: (tx: { execute: () => Promise<void> }) => Promise<unknown>) =>
      callback({ execute: async () => {} }),
  } as unknown as Database;

  test('rollback drops notifications; commit emits once after the transaction', async () => {
    const emitted: string[] = [];
    const bus = {
      publish: async (type: string) => {
        emitted.push(type);
      },
    } as unknown as EventBus;
    await expect(
      runInTenantScope(db, context, async () => {
        publishRecordChange(bus, 'person.created', { personId: 'person', changedKeys: [] });
        expect(emitted).toEqual([]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(emitted).toEqual([]);
    await runInTenantScope(db, context, async () => {
      publishRecordChange(bus, 'person.updated', { personId: 'person', changedKeys: ['displayName'] });
      expect(emitted).toEqual([]);
    });
    expect(emitted).toEqual(['person.updated']);
  });

  test('a publish rejection does not fail the committed write', async () => {
    const bus = {
      publish: async () => {
        throw new Error('bus unavailable');
      },
    } as unknown as EventBus;
    await runInTenantScope(db, context, async () => {
      publishRecordChange(bus, 'person.created', { personId: 'person', changedKeys: [] });
    });
  });

  for (const enabled of [true, false]) {
    test(`post-commit family envelopes reach the correct handler context, multitenancy=${enabled}`, async () => {
      const priorFlag = process.env.OMNI_MULTITENANCY_ENABLED;
      process.env.OMNI_MULTITENANCY_ENABLED = String(enabled);
      setEnvelopeTenantResolver(() => currentTenantScope()?.tenantId);
      const instanceId = crypto.randomUUID();
      const delivered: Array<{ type: string; world: string; tenantId: string | null }> = [];
      const deliveries: Promise<void>[] = [];
      const metadataSeen: Array<Partial<EventMetadata> | undefined> = [];
      const bus = {
        publish: async (
          type: 'person.created' | 'chat.created' | 'access.rule_created',
          payload: unknown,
          metadata?: Partial<EventMetadata>,
        ) => {
          expect(currentTenantScope()).toBeNull();
          metadataSeen.push(metadata);
          const event = createOmniEvent(type, payload, metadata, 'record-change-test');
          const delivery = runConsumerInTenantContext(db, event, async () => {
            delivered.push({
              type,
              world: classifyEnvelope(event.metadata).world,
              tenantId: currentTenantScope()?.tenantId ?? null,
            });
          });
          deliveries.push(delivery);
          await delivery;
          return { id: event.id };
        },
      } as unknown as EventBus;
      try {
        await runInTenantScope(db, context, async () => {
          publishRecordChange(bus, 'person.created', { personId: 'person', changedKeys: [] });
          publishRecordChange(bus, 'chat.created', { chatId: 'chat', instanceId: null, changedKeys: [] });
          publishRecordChange(bus, 'access.rule_created', { ruleId: 'rule', instanceId, changedKeys: [] }, instanceId);
          expect(delivered).toEqual([]);
        });
        await Promise.all(deliveries);
        const tenantId = context.targetTenantId;
        const world = enabled ? 'tenant' : 'legacy';
        expect(delivered).toEqual(
          ['person.created', 'chat.created', 'access.rule_created'].map((type) => ({
            type,
            world,
            tenantId: enabled ? tenantId : null,
          })),
        );
        expect(metadataSeen).toEqual(
          enabled ? [{ tenantId }, { tenantId }, { instanceId, tenantId }] : [undefined, undefined, { instanceId }],
        );
      } finally {
        await Promise.allSettled(deliveries);
        setEnvelopeTenantResolver(null);
        if (priorFlag === undefined) Reflect.deleteProperty(process.env, 'OMNI_MULTITENANCY_ENABLED');
        else process.env.OMNI_MULTITENANCY_ENABLED = priorFlag;
      }
    });
  }

  test('changed field names exclude undefined fields and server timestamps', () => {
    expect(
      changedRecordKeys({
        displayName: 'private-name',
        primaryPhone: null,
        metadata: undefined,
        updatedAt: new Date(),
      }),
    ).toEqual(['displayName', 'primaryPhone']);
  });
});
