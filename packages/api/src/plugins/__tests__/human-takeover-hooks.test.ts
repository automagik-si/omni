import { describe, expect, mock, test } from 'bun:test';
import type { ChatHumanTakeoverPayload, EventBus } from '@omni/core';
import { currentTenantScope } from '../../tenancy/tenant-scope';
import { setupHumanTakeoverHooks } from '../human-takeover-hooks';

const TENANT_A = '11111111-1111-4111-8111-1111111111aa';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000021';
const CONTACT = '5511999998888';

function captureBus() {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const subscribed: Array<{ type: string; options: unknown }> = [];
  const bus = {
    subscribe: async (type: string, handler: (event: never) => Promise<void>, options: unknown) => {
      handlers.set(type, handler as unknown as (event: unknown) => Promise<void>);
      subscribed.push({ type, options });
    },
  } as unknown as EventBus;
  const fire = (event: unknown): Promise<void> => {
    const handler = handlers.get('chat.human_takeover');
    if (!handler) throw new Error('no chat.human_takeover handler');
    return handler(event);
  };
  return { bus, fire, subscribed };
}

function fakeDb(stamped: string[]) {
  return {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb({
        execute: async (q: unknown) => {
          const match = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.exec(JSON.stringify(q));
          if (match) stamped.push(match[0]);
          return [] as unknown;
        },
      }),
  } as never;
}

interface Calls {
  lookups: Array<{ instanceId: string; externalId: string; tenant: string | null }>;
  updates: Array<{ id: string; data: { settings?: Record<string, unknown> }; tenant: string | null }>;
  disarms: Array<Record<string, unknown>>;
}

function servicesWith(chat: { id: string; settings: Record<string, unknown> | null } | null) {
  const calls: Calls = { lookups: [], updates: [], disarms: [] };
  const services = {
    chats: {
      findByExternalIdSmart: mock(async (instanceId: string, externalId: string) => {
        calls.lookups.push({ instanceId, externalId, tenant: currentTenantScope()?.tenantId ?? null });
        return chat;
      }),
      update: mock(async (id: string, data: { settings?: Record<string, unknown> }) => {
        calls.updates.push({ id, data, tenant: currentTenantScope()?.tenantId ?? null });
        return { ...chat, ...data };
      }),
    },
    followUpLifecycle: {
      disarm: mock(async (input: Record<string, unknown>) => {
        calls.disarms.push(input);
      }),
    },
  } as never;
  return { services, calls };
}

function takeoverEvent(
  envelope: 'tenant' | 'legacy' | 'malformed' = 'legacy',
  overrides: Partial<ChatHumanTakeoverPayload> = {},
) {
  const metadata: Record<string, unknown> = { instanceId: INSTANCE_ID, channelType: 'zenvia' };
  if (envelope === 'tenant') {
    metadata.envelopeVersion = 1;
    metadata.tenantId = TENANT_A;
  } else if (envelope === 'malformed') {
    metadata.tenantId = TENANT_A;
  }
  const payload: ChatHumanTakeoverPayload = {
    instanceId: INSTANCE_ID,
    chatExternalId: CONTACT,
    providerConversationId: 'conv-1',
    providerStatus: 'DISTRIBUTED_TO_USER',
    attendantId: 'user-1',
    occurredAt: Date.parse('2026-11-24T12:00:00.000Z'),
    ...overrides,
  };
  return { id: crypto.randomUUID(), type: 'chat.human_takeover', payload, metadata, timestamp: Date.now() };
}

describe('human-takeover-hooks', () => {
  test('subscribes a durable consumer to chat.human_takeover', async () => {
    const { bus, subscribed } = captureBus();
    await setupHumanTakeoverHooks(bus, servicesWith(null).services, fakeDb([]));
    expect(subscribed).toEqual([
      { type: 'chat.human_takeover', options: expect.objectContaining({ durable: 'human-takeover-hooks' }) },
    ]);
  });

  test('pauses the agent on the stored chat, keeping its other settings, and disarms the follow-up', async () => {
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: { followUpConfig: { enabled: true } } });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    await fire(takeoverEvent());

    expect(calls.lookups).toEqual([{ instanceId: INSTANCE_ID, externalId: CONTACT, tenant: null }]);
    expect(calls.updates).toEqual([
      {
        id: 'chat-uuid',
        data: { settings: { followUpConfig: { enabled: true }, agentPaused: true } },
        tenant: null,
      },
    ]);
    expect(calls.disarms).toEqual([
      { chatId: 'chat-uuid', instanceId: INSTANCE_ID, reason: 'handoff', tenantId: null },
    ]);
  });

  test('pauses a chat that has no settings yet', async () => {
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: null });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    await fire(takeoverEvent());

    expect(calls.updates[0]?.data).toEqual({ settings: { agentPaused: true } });
  });

  test('leaves a chat whose agent is already paused untouched', async () => {
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: { agentPaused: true } });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    await fire(takeoverEvent());

    expect(calls.updates).toEqual([]);
    expect(calls.disarms).toEqual([]);
  });

  test('does nothing when the contact has no stored chat', async () => {
    const { services, calls } = servicesWith(null);
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    await fire(takeoverEvent());

    expect(calls.lookups).toHaveLength(1);
    expect(calls.updates).toEqual([]);
    expect(calls.disarms).toEqual([]);
  });

  test('ignores an event without an instance in its envelope', async () => {
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: {} });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    const event = takeoverEvent();
    event.metadata.instanceId = undefined;
    await fire(event);

    expect(calls.lookups).toEqual([]);
    expect(calls.updates).toEqual([]);
  });

  test('threads the envelope tenant into the chat read, the update and the disarm', async () => {
    const stamped: string[] = [];
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: {} });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb(stamped));

    await fire(takeoverEvent('tenant'));

    expect(calls.lookups[0]?.tenant).toBe(TENANT_A);
    expect(calls.updates[0]?.tenant).toBe(TENANT_A);
    expect(calls.disarms[0]?.tenantId).toBe(TENANT_A);
    expect(stamped).toContain(TENANT_A);
  });

  test('refuses a malformed envelope before touching the chat', async () => {
    const { services, calls } = servicesWith({ id: 'chat-uuid', settings: {} });
    const { bus, fire } = captureBus();
    await setupHumanTakeoverHooks(bus, services, fakeDb([]));

    await expect(fire(takeoverEvent('malformed'))).rejects.toThrow(/quarantined/);
    expect(calls.lookups).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(calls.disarms).toEqual([]);
  });
});
