import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { EventBus } from '@omni/core';
import type { Database } from '@omni/db';
import type { Services } from '../../services';
import { type DispatcherCleanup, __test__, setupAgentDispatcher } from '../agent-dispatcher';
import type { BufferedMessage } from '../message-debouncer';

mock.module('../loader', () => ({
  getPlugin: mock(() => Promise.resolve(undefined)),
}));

const SENDER = '5511900000001';
const NEW_PERSON_ID = 'person-first-contact';

function mockDb(): Database {
  const agentRow = {
    id: 'agent-uuid-1',
    isActive: true,
    agentProviderId: 'provider-1',
    agentType: 'assistant',
    metadata: { providerAgentId: 'default-agent' },
    configPath: null,
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([agentRow]),
  };
  return {
    select: () => chain,
    insert: () => ({
      values: (row: { eventId?: string }) => ({
        onConflictDoNothing: () => ({ returning: async () => [{ eventId: row.eventId ?? 'evt' }] }),
      }),
    }),
  } as unknown as Database;
}

function instance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    name: 'Test Instance',
    channel: 'whatsapp-baileys',
    agentId: 'agent-uuid-1',
    agentProviderId: 'provider-1',
    agentType: 'agent',
    agentTimeout: 60,
    agentStreamMode: false,
    agentReplyFilter: {
      mode: 'all' as const,
      conditions: { onDm: true, onMention: true, onReply: true, onNameMatch: false },
    },
    agentSessionStrategy: 'per_chat',
    agentPrefixSenderName: true,
    triggerEvents: ['message.received'],
    triggerReactions: null,
    triggerMentionPatterns: null,
    triggerMode: 'round-trip',
    ownerIdentifier: 'bot-jid@s.whatsapp.net',
    enableAutoSplit: true,
    messageDebounceMode: 'disabled',
    messageDebounceMinMs: 0,
    messageDebounceMaxMs: 0,
    messageDebounceRestartOnTyping: false,
    messageSplitDelayMode: 'disabled',
    messageSplitDelayFixedMs: 0,
    messageSplitDelayMinMs: 0,
    messageSplitDelayMaxMs: 0,
    isActive: true,
    isDefault: false,
    ...overrides,
  } as Record<string, unknown>;
}

interface Harness {
  services: Services;
  lookups: () => number;
  creates: Array<{ data: Record<string, unknown>; link: Record<string, unknown> | undefined }>;
  getSenderName: ReturnType<typeof mock>;
  routeResolve: ReturnType<typeof mock>;
}

function harness(
  options: {
    chat?: { id: string } | null;
    instanceOverrides?: Record<string, unknown>;
    createError?: Error;
    persistedAfterLookups?: number;
  } = {},
): Harness {
  let identity: { id: string; personId: string } | null = null;
  let lookups = 0;
  const creates: Harness['creates'] = [];
  const getSenderName = mock(async (_personId?: string, fallback?: string) => fallback ?? 'Sender');
  const routeResolve = mock(async () => null);

  const services = {
    agentRunner: {
      getInstanceWithProvider: mock(async (id: string) =>
        id === 'inst-1' ? instance(options.instanceOverrides) : null,
      ),
      getSenderName,
      run: mock(async () => ({ parts: ['ok'], metadata: { runId: 'run-1', status: 'completed' } })),
    },
    access: { checkAccess: mock(async () => ({ allowed: true, reason: 'default allow' })) },
    providers: { getById: mock(async () => null) },
    routeResolver: { resolve: routeResolve },
    chats: {
      getByExternalId: mock(async () => null),
      findByExternalIdSmart: mock(async () => options.chat ?? null),
    },
    persons: {
      getIdentityByPlatformId: mock(async () => {
        lookups++;
        if (!identity && options.persistedAfterLookups !== undefined && lookups > options.persistedAfterLookups) {
          identity = { id: 'identity-persisted', personId: NEW_PERSON_ID };
        }
        return identity;
      }),
      findOrCreateIdentity: mock(async (data: Record<string, unknown>, link?: Record<string, unknown>) => {
        creates.push({ data, link });
        if (options.createError) throw options.createError;
        identity = { id: 'identity-new', personId: NEW_PERSON_ID };
        return { identity, person: { id: NEW_PERSON_ID }, isNew: false, wasLinked: false };
      }),
    },
  } as unknown as Services;

  return { services, lookups: () => lookups, creates, getSenderName, routeResolve };
}

function eventBus() {
  const handlers = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
  return {
    handlers,
    subscribe: mock(async (type: string, handler: (event: Record<string, unknown>) => Promise<void>) => {
      handlers.set(type, handler);
    }),
    publish: mock(async () => ({ seq: 1 })),
    connect: mock(async () => {}),
    disconnect: mock(async () => {}),
    async fire(type: string, event: Record<string, unknown>) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`No handler registered for ${type}`);
      await handler(event);
    },
  };
}

function firstContactEvent(chatId = `${SENDER}@s.whatsapp.net`) {
  return {
    id: `evt-first-contact-${crypto.randomUUID()}`,
    type: 'message.received',
    payload: {
      externalId: `ext-${crypto.randomUUID()}`,
      chatId,
      from: SENDER,
      senderName: 'New Sender',
      content: { type: 'text', text: 'hello' },
      rawPayload: {},
    },
    metadata: {
      correlationId: 'corr-first-contact',
      instanceId: 'inst-1',
      channelType: 'whatsapp-baileys',
    },
    timestamp: Date.now(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function buffered(): BufferedMessage {
  return {
    payload: {
      externalId: 'ext-unit',
      chatId: `${SENDER}@s.whatsapp.net`,
      from: SENDER,
      content: { type: 'text', text: 'hello' },
      rawPayload: {},
    },
    metadata: { instanceId: 'inst-1', channelType: 'whatsapp-baileys', traceId: 'trc-unit' },
    timestamp: Date.now(),
  } as BufferedMessage;
}

describe('agent-dispatcher first contact (identity not persisted yet)', () => {
  let cleanup: DispatcherCleanup | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('dispatches the first message of a new sender instead of dropping it while persistence lags', async () => {
    const bus = eventBus();
    const h = harness();
    cleanup = await setupAgentDispatcher(bus as unknown as EventBus, h.services, mockDb());

    await bus.fire('message.received', firstContactEvent());
    await waitFor(() => h.getSenderName.mock.calls.length > 0);

    expect(h.getSenderName).toHaveBeenCalledTimes(1);
    expect(h.getSenderName.mock.calls[0]?.[0]).toBe(NEW_PERSON_ID);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]?.data).toMatchObject({ channel: 'whatsapp-baileys', instanceId: 'inst-1' });
    expect(h.creates[0]?.link).toMatchObject({ createPerson: true, matchByPhone: `+${SENDER}` });
  });

  it('does not poll for the identity inside the serial message consumer when the chat is new', async () => {
    const bus = eventBus();
    const h = harness({
      instanceOverrides: { messageDebounceMode: 'fixed', messageDebounceMinMs: 300, messageDebounceMaxMs: 300 },
    });
    cleanup = await setupAgentDispatcher(bus as unknown as EventBus, h.services, mockDb());

    const startedAt = Date.now();
    await bus.fire('message.received', firstContactEvent());
    const elapsed = Date.now() - startedAt;

    expect(h.lookups()).toBe(0);
    expect(h.creates).toHaveLength(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves a new participant of a known chat by creating the identity, so user routes can match', async () => {
    const bus = eventBus();
    const h = harness({
      chat: { id: 'chat-uuid-1' },
      instanceOverrides: { messageDebounceMode: 'fixed', messageDebounceMinMs: 300, messageDebounceMaxMs: 300 },
    });
    cleanup = await setupAgentDispatcher(bus as unknown as EventBus, h.services, mockDb());

    await bus.fire('message.received', firstContactEvent());

    expect(h.lookups()).toBe(1);
    expect(h.creates).toHaveLength(1);
    expect(h.routeResolve.mock.calls.map((call) => (call as unknown[])[2])).toContain(NEW_PERSON_ID);
  });

  it('waits with backoff for persistence beyond the old 2s budget when creating the identity fails', async () => {
    const h = harness({ createError: new Error('connection reset'), persistedAfterLookups: 4 });

    const result = await __test__.resolveDispatchPersonId(h.services, 'whatsapp-baileys', 'inst-1', buffered(), {
      maxWaitMs: 2_000,
      initialDelayMs: 5,
      maxDelayMs: 40,
    });

    expect(result.personId).toBe(NEW_PERSON_ID);
    expect(h.creates).toHaveLength(1);
    expect(h.lookups()).toBe(5);
  });

  it('gives up after the bounded wait and reports why, instead of looping forever', async () => {
    const h = harness({ createError: new Error('connection reset') });

    const startedAt = Date.now();
    const result = await __test__.resolveDispatchPersonId(h.services, 'whatsapp-baileys', 'inst-1', buffered(), {
      maxWaitMs: 120,
      initialDelayMs: 10,
      maxDelayMs: 40,
    });

    expect(result.personId).toBeUndefined();
    expect(String(result.error)).toContain('connection reset');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
    expect(h.lookups()).toBeGreaterThan(1);
  });

  it('never creates an identity for a personless channel', async () => {
    const h = harness();
    const message = buffered();
    message.metadata.channelType = 'internal';

    const result = await __test__.ensureSenderPersonId(h.services, 'internal', 'inst-1', message);

    expect(result).toEqual({});
    expect(h.creates).toHaveLength(0);
  });

  it('keeps the metadata person id without touching the database', async () => {
    const h = harness();
    const message = buffered();
    message.metadata.personId = 'person-from-metadata';

    const result = await __test__.ensureSenderPersonId(h.services, 'whatsapp-baileys', 'inst-1', message);

    expect(result).toEqual({ personId: 'person-from-metadata' });
    expect(h.lookups()).toBe(0);
    expect(h.creates).toHaveLength(0);
  });
});
