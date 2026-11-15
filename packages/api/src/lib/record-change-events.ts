import { type CoreEventType, type EventBus, type EventPayloadMap, createLogger } from '@omni/core';
import { runAfterTenantCommit } from '../tenancy/tenant-scope';

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
  runAfterTenantCommit(() => {
    bus
      .publish(type, payload, instanceId ? { instanceId } : undefined)
      .catch((error) => log.warn('Failed to publish record change', { eventType: type, error: String(error) }));
  });
}
