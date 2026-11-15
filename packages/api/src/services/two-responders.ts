/**
 * Two responders on one instance: a read-only detector (`GET /system/two-responders`, `omni doctor`).
 *
 * An instance whose agent is set and active gets an Omni answer on every trigger message (the instance
 * gates in plugins/agent-dispatcher.ts). A durable consumer that receives the same messages, read by
 * someone who may send on that instance, can answer the same person a second time. Nothing in the
 * dispatcher looks at consumers, so this module lists the instances where both can happen. It writes
 * nothing and publishes no event.
 *
 * A consumer counts for an instance when all of these hold:
 * - it is active: `updated_at` moved within ACTIVE_CONSUMER_WINDOW_MS. The table has no status column;
 *   `updated_at` moves on create, on every non-shared ack, on a non-shared pull that skips past rows its
 *   payload filter drops, and on every shared lease claim or ack (services/event-consumers.ts). A reader
 *   that only streams and never acks does not move it;
 * - its type filter matches one of the instance's trigger types (`triggerEvents`, or `message.received`
 *   when empty, the dispatcher's rule) and no exclude glob drops it. Payload conditions are not evaluated:
 *   they may match;
 * - it can page the instance: unscoped, or `instance_ids` includes it (the scan's instanceScopeClause);
 * - its tenant stamp is empty or equals the instance's (the scan pages only its own tenant's rows);
 * - its access filter is not `denied`: the dispatcher never answers a message the access gate denied;
 * - its reader may send on the instance:
 *   - `owner-key`: the consumer stores `owner_key_id` (scoped consumers and `events:consume`-only keys).
 *     That key must be active, unexpired, allowed `messages:send` (the scope every send route needs)
 *     and not restricted away from the instance;
 *   - `owning-agent`: an agent-owned consumer with no owner key. Its agent must be active;
 *   - `unrecorded`: neither column is set, the default for a key with `events:write`. Any
 *     instance-unrestricted key with `events:write` may pull it, so it counts.
 *   An agent-owned consumer also needs its agent active when it has an owner key.
 *
 * A consumer owned by the instance's own agent counts too (`sameAgent`): agents have no delivery mode
 * yet, so that agent gets the message both from the dispatcher and from its consumer (RFC-0002).
 */

import type { Database, DurableConsumer } from '@omni/db';
import { agents, apiKeys, durableConsumers, instances } from '@omni/db';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { scopedHandle } from '../tenancy/tenant-scope';
import { ApiKeyService } from './api-keys';
import { consumerTypeMatches } from './events';

/** How recently a consumer's `updated_at` must have moved for it to count as active. */
export const ACTIVE_CONSUMER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The trigger types when an instance sets none (agent-dispatcher.ts `instanceTriggersOnEvent`). */
const DEFAULT_TRIGGER_TYPES = ['message.received'] as const;

/** Whose sends make a consumer a second responder. */
type ResponderReader = 'owner-key' | 'owning-agent' | 'unrecorded';

interface TwoResponderConsumer {
  id: string;
  name: string;
  eventType: string;
  /** When `updated_at` last moved (an ack, a skipped page, a lease, or the create). */
  lastMovedAt: string;
  reader: ResponderReader;
  /** The api_keys.id that owns the consumer; null when the row stores none. */
  ownerKeyId: string | null;
  /** The agent that owns the consumer; null for a consumer no agent owns. */
  agentId: string | null;
  /** The consumer belongs to the instance's own agent: one agent, two delivery paths. */
  sameAgent: boolean;
}

interface TwoResponderInstance {
  instanceId: string;
  instanceName: string;
  channel: string;
  agentId: string;
  agentName: string;
  consumers: TwoResponderConsumer[];
}

/** The request's view: its trusted tenant (null = legacy credential) and its key's instance restriction. */
interface ResponderCaller {
  tenantId: string | null;
  /** null = every instance (ApiKeyService.instanceAllowed's rule). */
  instanceIds: string[] | null;
}

interface AgentBoundInstance {
  id: string;
  name: string;
  channel: string;
  tenantId: string | null;
  agentId: string;
  agentName: string;
  agentActive: boolean;
  triggerEvents: string[] | null;
}

type ResponderConsumerRow = Pick<
  DurableConsumer,
  | 'id'
  | 'name'
  | 'tenantId'
  | 'eventType'
  | 'excludeTypes'
  | 'scoped'
  | 'instanceIds'
  | 'agentId'
  | 'ownerKeyId'
  | 'accessFilter'
  | 'updatedAt'
>;

interface ResponderKey {
  status: string;
  expiresAt: Date | null;
  scopes: string[];
  instanceIds: string[] | null;
}

export interface DetectInput {
  instances: AgentBoundInstance[];
  consumers: ResponderConsumerRow[];
  /** Owner keys by api_keys.id. */
  keys: ReadonlyMap<string, ResponderKey>;
  /** Whether each consumer-owning agent is active, by agents.id. */
  agentActive: ReadonlyMap<string, boolean>;
  caller: ResponderCaller;
  now: number;
}

function receivesTrigger(consumer: ResponderConsumerRow, instance: AgentBoundInstance): boolean {
  const triggers = instance.triggerEvents?.length ? instance.triggerEvents : DEFAULT_TRIGGER_TYPES;
  const excluded = consumer.excludeTypes ?? [];
  return triggers.some(
    (type) =>
      consumerTypeMatches(consumer.eventType, type) && !excluded.some((glob) => consumerTypeMatches(glob, type)),
  );
}

function pagesInstance(consumer: ResponderConsumerRow, instance: AgentBoundInstance): boolean {
  if (consumer.tenantId && consumer.tenantId !== instance.tenantId) return false;
  if (!consumer.scoped) return true;
  return (consumer.instanceIds ?? []).some((id) => id.toLowerCase() === instance.id.toLowerCase());
}

function keyMaySend(key: ResponderKey | undefined, instanceId: string, now: number): boolean {
  return (
    !!key &&
    key.status === 'active' &&
    (key.expiresAt === null || key.expiresAt.getTime() > now) &&
    ApiKeyService.scopeAllows(key.scopes, 'messages:send') &&
    ApiKeyService.instanceAllowed(key.instanceIds, instanceId)
  );
}

/** Who may send through this consumer on this instance, or null when nobody can. */
function readerOf(
  consumer: ResponderConsumerRow,
  instance: AgentBoundInstance,
  input: DetectInput,
): ResponderReader | null {
  if (consumer.agentId && !input.agentActive.get(consumer.agentId)) return null;
  if (consumer.ownerKeyId) {
    return keyMaySend(input.keys.get(consumer.ownerKeyId), instance.id, input.now) ? 'owner-key' : null;
  }
  return consumer.agentId ? 'owning-agent' : 'unrecorded';
}

/** The instances the caller may see where an Omni agent and a consumer's reader may both answer. */
export function detectTwoResponders(input: DetectInput): TwoResponderInstance[] {
  const { caller } = input;
  const consumers = input.consumers.filter(
    (consumer) =>
      input.now - consumer.updatedAt.getTime() <= ACTIVE_CONSUMER_WINDOW_MS &&
      consumer.accessFilter !== 'denied' &&
      (!caller.tenantId || consumer.tenantId === caller.tenantId),
  );
  const flagged: TwoResponderInstance[] = [];
  for (const instance of input.instances) {
    if (!instance.agentActive) continue;
    if (caller.tenantId && instance.tenantId !== caller.tenantId) continue;
    if (!ApiKeyService.instanceAllowed(caller.instanceIds, instance.id)) continue;
    const matches: TwoResponderConsumer[] = [];
    for (const consumer of consumers) {
      if (!pagesInstance(consumer, instance) || !receivesTrigger(consumer, instance)) continue;
      const reader = readerOf(consumer, instance, input);
      if (!reader) continue;
      matches.push({
        id: consumer.id,
        name: consumer.name,
        eventType: consumer.eventType,
        lastMovedAt: consumer.updatedAt.toISOString(),
        reader,
        ownerKeyId: consumer.ownerKeyId,
        agentId: consumer.agentId,
        sameAgent: consumer.agentId === instance.agentId,
      });
    }
    if (matches.length === 0) continue;
    flagged.push({
      instanceId: instance.id,
      instanceName: instance.name,
      channel: instance.channel,
      agentId: instance.agentId,
      agentName: instance.agentName,
      consumers: matches.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return flagged.sort((a, b) => a.instanceName.localeCompare(b.instanceName));
}

/**
 * Read what the detector needs and run it. Instances and agents are tenant rows and go through the
 * request's tenant scope; durable consumers and api keys are global registries, filtered above.
 */
export async function findTwoResponders(
  db: Database,
  caller: ResponderCaller,
  now: number = Date.now(),
): Promise<TwoResponderInstance[]> {
  const sdb = scopedHandle(db);
  const bound = await sdb
    .select({
      id: instances.id,
      name: instances.name,
      channel: instances.channel,
      tenantId: instances.tenantId,
      agentId: agents.id,
      agentName: agents.name,
      agentActive: agents.isActive,
      triggerEvents: instances.triggerEvents,
    })
    .from(instances)
    .innerJoin(agents, eq(agents.id, instances.agentId))
    .where(isNotNull(instances.agentId));
  if (bound.length === 0) return [];

  const consumers = await db
    .select({
      id: durableConsumers.id,
      name: durableConsumers.name,
      tenantId: durableConsumers.tenantId,
      eventType: durableConsumers.eventType,
      excludeTypes: durableConsumers.excludeTypes,
      scoped: durableConsumers.scoped,
      instanceIds: durableConsumers.instanceIds,
      agentId: durableConsumers.agentId,
      ownerKeyId: durableConsumers.ownerKeyId,
      accessFilter: durableConsumers.accessFilter,
      updatedAt: durableConsumers.updatedAt,
    })
    .from(durableConsumers);
  if (consumers.length === 0) return [];

  const keyIds = [...new Set(consumers.flatMap((c) => (c.ownerKeyId ? [c.ownerKeyId] : [])))];
  const keyRows = keyIds.length
    ? await db
        .select({
          id: apiKeys.id,
          status: apiKeys.status,
          expiresAt: apiKeys.expiresAt,
          scopes: apiKeys.scopes,
          instanceIds: apiKeys.instanceIds,
        })
        .from(apiKeys)
        .where(inArray(apiKeys.id, keyIds))
    : [];
  const agentIds = [...new Set(consumers.flatMap((c) => (c.agentId ? [c.agentId] : [])))];
  const agentRows = agentIds.length
    ? await sdb.select({ id: agents.id, isActive: agents.isActive }).from(agents).where(inArray(agents.id, agentIds))
    : [];

  return detectTwoResponders({
    instances: bound,
    consumers,
    keys: new Map(keyRows.map(({ id, ...key }) => [id, key])),
    agentActive: new Map(agentRows.map((agent) => [agent.id, agent.isActive])),
    caller,
    now,
  });
}
