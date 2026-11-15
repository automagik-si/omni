import { describe, expect, test } from 'bun:test';
import type { EventBus } from '@omni/core';
import type { Database } from '@omni/db';
import type { PlatformAuthContext } from '../../tenancy/auth-context';
import { runInTenantScope } from '../../tenancy/tenant-scope';
import { changedRecordKeys, publishRecordChange } from '../record-change-events';

const context: PlatformAuthContext = {
  credentialClass: 'platform',
  requestId: 'request',
  principalId: null,
  credentialId: 'credential',
  scopes: ['*'],
  platformApiKeyId: 'key',
  platformAction: 'test-change-events',
  targetTenantId: '11111111-1111-4111-8111-111111111111',
};

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
