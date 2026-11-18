import { type CoreEventType, type EventBus, type EventPayloadMap, createLogger } from '@omni/core';
import { isMultitenancyEnabled } from '../tenancy/feature-flag';
import { currentTenantScope, runAfterTenantCommit } from '../tenancy/tenant-scope';

const log = createLogger('record-change-events');
type RecordChangeType = Extract<
  CoreEventType,
  `person.${string}` | `chat.${'created' | 'updated' | 'deleted'}` | `access.rule_${string}`
>;

/** Field names only, excluding undefined patches and server-managed timestamps. */
export function changedRecordKeys(data: object): string[] {
  return Object.entries(data)
    .filter(([key, value]) => value !== undefined && key !== 'updatedAt')
    .map(([key]) => key);
}

/** Same post-commit contract as instance.updated; a bus failure must not make callers retry a committed write. */
export function publishRecordChange<T extends RecordChangeType>(
  bus: EventBus | null | undefined,
  type: T,
  payload: EventPayloadMap[T],
  instanceId?: string | null,
): void {
  if (!bus) return;
  // The callback runs outside the committing scope; snapshot its trusted owner.
  // Explicit tenant metadata is always honored by the factory; leave flag-off metadata unchanged.
  const tenantId = isMultitenancyEnabled() ? currentTenantScope()?.tenantId : undefined;
  const metadata = tenantId
    ? { ...(instanceId ? { instanceId } : {}), tenantId }
    : instanceId
      ? { instanceId }
      : undefined;
  runAfterTenantCommit(() => {
    bus
      .publish(type, payload, metadata)
      .catch((error) => log.warn('Failed to publish record change', { eventType: type, error: String(error) }));
  });
}
