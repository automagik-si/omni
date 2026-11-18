import { describe, expect, mock, test } from 'bun:test';
import type { EventBus, TypedOmniEvent } from '@omni/core';
import type { Services } from '../../services';
import { setupMessagePersistence } from '../message-persistence';

const EVENT_ID = '3f8b1c2e-5d4a-4b6c-9e7f-0a1b2c3d4e5f';
const EVENT_TIMESTAMP = 1_700_000_001_000;
const PLATFORM_TIMESTAMP = 1_700_000_000_000;
const CHAT_EXTERNAL_ID = 'chat-platform-id';
const TARGET_EXTERNAL_ID = 'message-platform-id';

async function harness(options: { hasTarget?: boolean } = {}) {
  const chat = { id: 'chat-uuid', canonicalId: null, name: null };
  const target = { id: 'message-uuid', deletedAt: null as Date | null };
  const findChat = mock(async () => chat);
  const getTarget = mock(async () => (options.hasTarget === false ? null : target));
  const markDeleted = mock(async (_id: string, _eventId: string | undefined, deletedAt: Date) => {
    target.deletedAt = deletedAt;
    return target;
  });
  const findOrCreateMessage = mock(async () => ({ message: { id: 'synthetic-message' }, created: false }));
  const findOrCreateChat = mock(async () => ({ chat, created: false }));
  const updateLastMessage = mock(async () => undefined);
  const updateOffset = mock(async () => undefined);
  const handlers = new Map<string, (event: TypedOmniEvent<'message.received'>) => Promise<void>>();

  await setupMessagePersistence(
    {
      subscribe: async (type: string, handler: (event: TypedOmniEvent<'message.received'>) => Promise<void>) => {
        handlers.set(type, handler);
      },
    } as unknown as EventBus,
    {
      db: { update: () => ({ set: () => ({ where: async () => [] }) }) },
      chats: {
        findByExternalIdSmart: findChat,
        findOrCreate: findOrCreateChat,
        findOrCreateParticipant: async () => ({ participant: {} }),
        recordParticipantActivity: async () => undefined,
        updateLastMessage,
      },
      messages: { getByExternalId: getTarget, markDeleted, findOrCreate: findOrCreateMessage },
      instances: { updateLastMessageAt: async () => undefined },
      consumerOffsets: { updateOffset },
    } as unknown as Services,
  );

  const receive = handlers.get('message.received');
  if (!receive) throw new Error('Missing message.received handler');
  return {
    receive,
    findChat,
    getTarget,
    markDeleted,
    findOrCreateMessage,
    findOrCreateChat,
    updateLastMessage,
    updateOffset,
  };
}

function deletionEvent(rawPayload: Record<string, unknown>): TypedOmniEvent<'message.received'> {
  return {
    id: EVENT_ID,
    type: 'message.received',
    timestamp: EVENT_TIMESTAMP,
    payload: {
      externalId: 'delete-event-platform-id',
      chatId: CHAT_EXTERNAL_ID,
      from: CHAT_EXTERNAL_ID,
      content: { type: 'delete' },
      rawPayload,
    },
    metadata: {
      instanceId: 'instance-1',
      channelType: 'discord',
      platformIdentityId: 'identity-uuid',
      streamSequence: 5,
    },
  } as unknown as TypedOmniEvent<'message.received'>;
}

describe('message.received deletion persistence', () => {
  test('marks the original and does not create a chat or phantom message or update recency', async () => {
    const h = await harness();
    await h.receive(deletionEvent({ deletedMessageId: TARGET_EXTERNAL_ID, deletedAt: PLATFORM_TIMESTAMP }));

    expect(h.markDeleted).toHaveBeenCalledWith('message-uuid', EVENT_ID, new Date(PLATFORM_TIMESTAMP));
    expect(h.findChat).toHaveBeenCalledWith('instance-1', CHAT_EXTERNAL_ID);
    expect(h.getTarget).toHaveBeenCalledWith('chat-uuid', TARGET_EXTERNAL_ID);
    expect(h.findOrCreateChat).not.toHaveBeenCalled();
    expect(h.findOrCreateMessage).not.toHaveBeenCalled();
    expect(h.updateLastMessage).not.toHaveBeenCalled();
    expect(h.updateOffset).toHaveBeenCalledWith('message-persistence-received', 'MESSAGE', 5, EVENT_ID);
  });

  test('falls back to the event time and leaves a redelivered deletion alone', async () => {
    const h = await harness();
    const event = deletionEvent({ deletedMessageId: TARGET_EXTERNAL_ID });
    await h.receive(event);
    await h.receive(event);

    expect(h.markDeleted).toHaveBeenCalledTimes(1);
    expect(h.markDeleted).toHaveBeenCalledWith('message-uuid', EVENT_ID, new Date(EVENT_TIMESTAMP));
  });

  test('ignores an unknown original without creating a placeholder', async () => {
    const h = await harness({ hasTarget: false });
    await h.receive(deletionEvent({ deletedMessageId: TARGET_EXTERNAL_ID }));

    expect(h.getTarget).toHaveBeenCalledWith('chat-uuid', TARGET_EXTERNAL_ID);
    expect(h.markDeleted).not.toHaveBeenCalled();
    expect(h.findOrCreateMessage).not.toHaveBeenCalled();
  });

  test('ignores a malformed target without querying or creating a chat', async () => {
    const h = await harness();
    await h.receive(deletionEvent({ deletedMessageId: 123 }));

    expect(h.findChat).not.toHaveBeenCalled();
    expect(h.findOrCreateChat).not.toHaveBeenCalled();
    expect(h.markDeleted).not.toHaveBeenCalled();
  });
});
