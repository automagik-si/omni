import { describe, expect, mock, test } from 'bun:test';
import type { EventBus } from '@omni/core';
import type { Chat, Database } from '@omni/db';
import { SQL } from 'drizzle-orm';
import { ChatService } from '../services/chats';

function mockDb(stored: Record<string, unknown> | null, returned: Record<string, unknown> | null) {
  const sets: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'chat-1', settings: stored }] }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return {
          where: () => ({
            returning: async () => [{ id: 'chat-1', instanceId: 'inst-1', settings: returned } as unknown as Chat],
          }),
        };
      },
    }),
  } as unknown as Database;
  return { db, sets };
}

function mockEventBus() {
  const publish = mock(async (_type: string, _payload: unknown, _metadata?: unknown) => ({ id: 'evt', sequence: 1 }));
  return { eventBus: { publish } as unknown as EventBus, publish };
}

function handoffCalls(publish: ReturnType<typeof mockEventBus>['publish']) {
  return publish.mock.calls.filter(([type]) => type === 'chat.handoff_activated');
}

describe('ChatService.update — settings', () => {
  test('mergeSettings writes the settings as a jsonb merge instead of the body object', async () => {
    const { db, sets } = mockDb({ keep: true }, { keep: true, closed: false });
    const service = new ChatService(db, null);

    await service.update('chat-1', { settings: { closed: false } }, { mergeSettings: true });

    expect(sets[0]?.settings).toBeInstanceOf(SQL);
  });

  test('without mergeSettings, and for settings: null, the value is written as given', async () => {
    const { db, sets } = mockDb({ keep: true }, null);
    const service = new ChatService(db, null);

    await service.update('chat-1', { settings: { closed: false } });
    await service.update('chat-1', { settings: null }, { mergeSettings: true });

    expect(sets[0]?.settings).toEqual({ closed: false });
    expect(sets[1]?.settings).toBeNull();
  });

  test('a merge that leaves a stored pause in place does not announce a handoff', async () => {
    const { db } = mockDb({ agentPaused: true }, { agentPaused: true, note: 'x' });
    const { eventBus, publish } = mockEventBus();
    const service = new ChatService(db, eventBus);

    await service.update('chat-1', { settings: { note: 'x' } }, { mergeSettings: true });

    expect(handoffCalls(publish)).toHaveLength(0);
  });

  test('a merge that pauses an active chat announces the handoff once', async () => {
    const { db } = mockDb({ agentPaused: false }, { agentPaused: true });
    const { eventBus, publish } = mockEventBus();
    const service = new ChatService(db, eventBus);

    await service.update('chat-1', { settings: { agentPaused: true } }, { mergeSettings: true });

    expect(handoffCalls(publish)).toHaveLength(1);
  });
});
