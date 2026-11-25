import { describe, expect, test } from 'bun:test';
import type { Database } from '@omni/db';
import { __test__ } from '../agent-dispatcher';
import type { BufferedMessage } from '../message-debouncer';

const { passesChatStateGates, buildMessageTrigger } = __test__;

const INSTANCE_ID = 'inst-session-start';
const CHAT_ID = '5511900000001';
const CHAT_UUID = 'chat-uuid-1';

interface Harness {
  services: never;
  updates: Array<Record<string, unknown>>;
}

function harness(settings: Record<string, unknown> | null, failUpdate = false): Harness {
  const updates: Array<Record<string, unknown>> = [];
  const services = {
    db: {} as Database,
    chats: {
      findByExternalIdSmart: async () => (settings === null ? null : { id: CHAT_UUID, settings }),
      update: async (_id: string, data: { settings: Record<string, unknown> }) => {
        if (failUpdate) throw new Error('db down');
        updates.push(data.settings);
        return { id: CHAT_UUID, settings: data.settings };
      },
    },
  };
  return { services: services as never, updates };
}

function message(sessionStart?: boolean, platformMs?: number): BufferedMessage {
  return {
    payload: {
      externalId: 'msg-1',
      chatId: CHAT_ID,
      from: CHAT_ID,
      content: { type: 'text', text: 'hello again' },
      ...(sessionStart === undefined ? {} : { sessionStart }),
      rawPayload: platformMs === undefined ? {} : { messageTimestamp: platformMs },
    },
    metadata: { instanceId: INSTANCE_ID, traceId: 'trace-1' },
    timestamp: Date.now(),
  } as BufferedMessage;
}

const db = {} as Database;

describe('passesChatStateGates — sessionStart', () => {
  test('a paused chat is resumed and dispatched when the first message starts a channel session', async () => {
    const platformMs = Date.now() - 5_000;
    const h = harness({ agentPaused: true, agentResumedAt: '2020-01-01T00:00:00.000Z', keep: 'me' });

    const passed = await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(true, platformMs)]);

    expect(passed).toBe(true);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.agentPaused).toBe(false);
    expect(h.updates[0]?.keep).toBe('me');
    const resumedAt = new Date(String(h.updates[0]?.agentResumedAt)).getTime();
    expect(resumedAt).toBeLessThan(platformMs);
    expect(platformMs - resumedAt).toBeLessThan(1_000);
  });

  test('a closed (terminal) chat stays skipped even with sessionStart', async () => {
    const h = harness({ closed: true, agentPaused: true, closeOutcome: 'won' });

    const passed = await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(true)]);

    expect(passed).toBe(false);
    expect(h.updates).toEqual([]);
  });

  test('without the flag a paused chat is still skipped and untouched', async () => {
    const h = harness({ agentPaused: true });

    expect(await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message()])).toBe(false);
    expect(await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(false)])).toBe(false);
    expect(h.updates).toEqual([]);
  });

  test('sessionStart on a chat that is not paused writes nothing and dispatches', async () => {
    const h = harness({ agentPaused: false });

    expect(await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(true)])).toBe(true);
    expect(h.updates).toEqual([]);
  });

  test('a failed resume write defers the dispatch instead of answering a paused chat', async () => {
    const h = harness({ agentPaused: true }, true);

    expect(await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(true)])).toBe(false);
  });

  test('without the flag a message older than agentResumedAt is still dropped', async () => {
    const h = harness({ agentResumedAt: new Date(Date.now() + 60_000).toISOString() });

    expect(await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [message(undefined, Date.now())])).toBe(
      false,
    );
  });

  test('a delayed session start older than the current agentResumedAt does not resume', async () => {
    const resumedAt = new Date(Date.now() - 1_000).toISOString();
    const h = harness({ agentPaused: true, agentResumedAt: resumedAt });

    const passed = await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [
      message(true, Date.now() - 60_000),
    ]);

    expect(passed).toBe(false);
    expect(h.updates).toEqual([]);
  });

  test('a session start later in the batch resumes the chat and keeps the whole batch', async () => {
    const platformMs = Date.now() - 5_000;
    const h = harness({ agentPaused: true });

    const passed = await passesChatStateGates(h.services, db, INSTANCE_ID, CHAT_ID, [
      message(undefined, platformMs),
      message(true, platformMs + 1_000),
    ]);

    expect(passed).toBe(true);
    expect(h.updates[0]?.agentPaused).toBe(false);
    expect(new Date(String(h.updates[0]?.agentResumedAt)).getTime()).toBeLessThan(platformMs);
  });
});

describe('buildMessageTrigger — sessionStart', () => {
  function trigger(messages: BufferedMessage[]) {
    return buildMessageTrigger(
      'trace-1',
      'dm',
      { type: 'message.received', payload: {}, metadata: {} } as never,
      'zenvia' as never,
      { id: INSTANCE_ID } as never,
      CHAT_ID,
      CHAT_ID,
      undefined,
      undefined,
      messages,
      ['hello again'],
      undefined,
      'session-1',
      undefined,
      [],
    );
  }

  test('marks the trigger source when any message of the batch starts a session', () => {
    expect(trigger([message(true)]).source.sessionStart).toBe(true);
    expect(trigger([message(), message(true)]).source.sessionStart).toBe(true);
    expect(trigger([message()]).source).not.toHaveProperty('sessionStart');
    expect(trigger([message(false)]).source).not.toHaveProperty('sessionStart');
  });
});
