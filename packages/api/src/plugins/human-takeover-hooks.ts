import type { ChatHumanTakeoverPayload, EventBus, OmniEvent } from '@omni/core';
import { classifyEnvelope, createLogger } from '@omni/core';
import type { Database } from '@omni/db';
import type { Services } from '../services';
import { runTenantWorkDb } from '../tenancy/worker-tenant-context';

const log = createLogger('human-takeover-hooks');

function trustedTenantOf(event: Pick<OmniEvent, 'metadata'>): string | null {
  const classification = classifyEnvelope(event.metadata);
  if (classification.world === 'quarantine') {
    throw new Error(`human-takeover-hooks: refusing quarantined envelope (${classification.reason})`);
  }
  return classification.world === 'tenant' ? classification.tenantId : null;
}

async function applyHumanTakeover(
  services: Services,
  db: Database,
  event: Pick<OmniEvent, 'metadata' | 'payload'>,
): Promise<void> {
  const payload = event.payload as ChatHumanTakeoverPayload;
  const instanceId = event.metadata.instanceId;
  if (!instanceId || !payload.chatExternalId) return;

  const tenantId = trustedTenantOf(event);
  const chat = await runTenantWorkDb(db, tenantId, () =>
    services.chats.findByExternalIdSmart(instanceId, payload.chatExternalId),
  );
  if (!chat) {
    log.info('Human takeover for a contact with no stored chat; nothing to pause', {
      instanceId,
      providerStatus: payload.providerStatus,
    });
    return;
  }

  await services.followUpLifecycle.disarm({ chatId: chat.id, instanceId, reason: 'handoff', tenantId });

  const settings = (chat.settings as Record<string, unknown> | null) ?? {};
  if (settings.agentPaused === true) {
    log.debug('Human takeover on a chat whose agent is already paused', { instanceId, chatId: chat.id });
    return;
  }

  await runTenantWorkDb(db, tenantId, () =>
    services.chats.update(chat.id, { settings: { ...settings, agentPaused: true } }),
  );

  log.info('Agent paused: a human took over the chat on the channel', {
    instanceId,
    chatId: chat.id,
    providerStatus: payload.providerStatus,
  });
}

export async function setupHumanTakeoverHooks(eventBus: EventBus, services: Services, db: Database): Promise<void> {
  await eventBus.subscribe('chat.human_takeover', (event) => applyHumanTakeover(services, db, event), {
    durable: 'human-takeover-hooks',
    queue: 'human-takeover-hooks',
    maxRetries: 2,
    retryDelayMs: 500,
    startFrom: 'new',
  });
  log.info('Human takeover hooks active (chat.human_takeover)');
}
