import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ZenviaPlugin } from '../plugin';
import {
  MockEventBus,
  SENDER_ID,
  VERIFY_TOKEN,
  connectPlugin,
  createContext,
  instanceId,
  jsonResponse,
} from './helpers';

const CONTACT = '5511999998888';
const WEBHOOK_URL = `http://localhost/api/v2/channels/zenvia/${instanceId}/webhook`;
const STATUS_AT = '2026-11-24T12:00:05.000Z';

type Published = { type: string; payload: Record<string, unknown>; metadata?: Record<string, unknown> };

function conversationStatus(
  status: string,
  extra: Record<string, unknown> = {},
  contactSide: 'from' | 'to' = 'from',
): Record<string, unknown> {
  return {
    id: `evt-${status}`,
    timestamp: '2026-11-24T12:00:06.000Z',
    type: 'CONVERSATION_STATUS',
    subscriptionId: 'sub-2',
    conversation: {
      id: 'conv-1',
      status,
      statusTimestamp: STATUS_AT,
      channel: 'whatsapp',
      from: contactSide === 'from' ? CONTACT : SENDER_ID,
      to: contactSide === 'from' ? SENDER_ID : CONTACT,
      contactId: 'contact-1',
      groupId: 'group-1',
      createdAt: '2026-11-24T11:59:00.000Z',
      ...extra,
    },
  };
}

function post(payload: unknown): Request {
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', 'x-webhook-token': VERIFY_TOKEN },
  });
}

describe('Zenvia CONVERSATION_STATUS', () => {
  let plugin: ZenviaPlugin;
  let eventBus: MockEventBus;

  function published(): Published[] {
    return eventBus.published as Published[];
  }

  function ofType(type: string): Array<Record<string, unknown>> {
    return published()
      .filter((e) => e.type === type)
      .map((e) => e.payload);
  }

  beforeEach(async () => {
    plugin = new ZenviaPlugin();
    eventBus = new MockEventBus();
    await plugin.initialize(createContext(eventBus));
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
    await connectPlugin(plugin);
    eventBus.published = [];
  });

  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  describe('a human attendant takes the conversation', () => {
    it('emits chat.human_takeover for the contact when the conversation is distributed to a user', async () => {
      const res = await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1' })),
      );

      expect(res.status).toBe(200);
      expect(published()).toHaveLength(1);
      const [event] = published();
      expect(event?.type).toBe('chat.human_takeover');
      expect(event?.payload).toEqual({
        instanceId,
        chatExternalId: CONTACT,
        providerConversationId: 'conv-1',
        providerStatus: 'DISTRIBUTED_TO_USER',
        attendantId: 'user-1',
        occurredAt: Date.parse(STATUS_AT),
      });
      expect(event?.metadata).toMatchObject({ instanceId, channelType: 'zenvia' });
    });

    it('emits chat.human_takeover when a user claims the conversation', async () => {
      await plugin.handleWebhook(post(conversationStatus('CONVERSATION_CLAIMED', { userId: 'user-2' })));

      expect(ofType('chat.human_takeover')).toEqual([
        expect.objectContaining({ chatExternalId: CONTACT, providerStatus: 'CLAIMED', attendantId: 'user-2' }),
      ]);
    });

    it('ignores a claim that names no user', async () => {
      const res = await plugin.handleWebhook(post(conversationStatus('CONVERSATION_CLAIMED')));

      expect(res.status).toBe(200);
      expect(published()).toHaveLength(0);
    });

    it('emits chat.human_takeover for a transfer to a user', async () => {
      await plugin.handleWebhook(
        post(
          conversationStatus('CONVERSATION_TRANSFERRED', {
            transferType: 'TRANSFER_TO_USER',
            transferredBy: { id: 'user-9', type: 'USER' },
            newUserId: 'user-3',
            previousUserId: 'user-9',
          }),
        ),
      );

      expect(ofType('chat.human_takeover')).toEqual([
        expect.objectContaining({ chatExternalId: CONTACT, providerStatus: 'TRANSFERRED', attendantId: 'user-3' }),
      ]);
    });

    it('ignores a transfer to a group with no user', async () => {
      await plugin.handleWebhook(
        post(
          conversationStatus('CONVERSATION_TRANSFERRED', {
            transferType: 'TRANSFER_TO_GROUP',
            transferredBy: { id: 'system', type: 'SYSTEM' },
            newGroupId: 'group-2',
          }),
        ),
      );

      expect(published()).toHaveLength(0);
    });

    it('accepts the unprefixed status names of the Conversations API', async () => {
      await plugin.handleWebhook(post(conversationStatus('DISTRIBUTED_TO_USER', { userId: 'user-1' })));

      expect(ofType('chat.human_takeover')).toEqual([
        expect.objectContaining({ providerStatus: 'DISTRIBUTED_TO_USER', attendantId: 'user-1' }),
      ]);
    });

    it('finds the contact on either side of the conversation and keeps only its digits', async () => {
      await plugin.handleWebhook(post(conversationStatus('CONVERSATION_CLAIMED', { userId: 'user-1' }, 'to')));
      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_CLAIMED', { userId: 'user-1', from: '+55 (11) 99999-8888' })),
      );

      expect(ofType('chat.human_takeover').map((p) => p.chatExternalId)).toEqual([CONTACT, CONTACT]);
    });

    it('falls back to the event timestamp when the status has none', async () => {
      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_CLAIMED', { userId: 'user-1', statusTimestamp: undefined })),
      );

      expect(ofType('chat.human_takeover')[0]?.occurredAt).toBe(Date.parse('2026-11-24T12:00:06.000Z'));
    });
  });

  describe('the conversation is closed', () => {
    it('emits chat.human_released with who closed it and why', async () => {
      await plugin.handleWebhook(
        post(
          conversationStatus('CONVERSATION_CLOSED', {
            closedBy: { id: 'user-1', type: 'USER' },
            closeReason: { key: 'reason-key', name: 'Reason label' },
          }),
        ),
      );

      expect(published().map((e) => e.type)).toEqual(['chat.human_released']);
      expect(ofType('chat.human_released')[0]).toEqual({
        instanceId,
        chatExternalId: CONTACT,
        providerConversationId: 'conv-1',
        providerStatus: 'CLOSED',
        releasedBy: 'attendant',
        releasedById: 'user-1',
        reason: 'reason-key',
        reasonLabel: 'Reason label',
        occurredAt: Date.parse(STATUS_AT),
      });
    });

    it('marks a close by the system and tolerates a close without details', async () => {
      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_CLOSED', { closedBy: { id: 'sys', type: 'SYSTEM' } })),
      );
      await plugin.handleWebhook(post(conversationStatus('CLOSED')));

      expect(ofType('chat.human_released')).toEqual([
        expect.objectContaining({ releasedBy: 'system', releasedById: 'sys' }),
        {
          instanceId,
          chatExternalId: CONTACT,
          providerConversationId: 'conv-1',
          providerStatus: 'CLOSED',
          occurredAt: Date.parse(STATUS_AT),
        },
      ]);
    });
  });

  it('publishes nothing for lifecycle statuses that do not involve a person', async () => {
    for (const status of [
      'CONVERSATION_CREATED',
      'CONVERSATION_QUEUED',
      'CONVERSATION_STARTED',
      'CONVERSATION_SNOOZED',
      'CONVERSATION_UNSNOOZED',
    ]) {
      const res = await plugin.handleWebhook(post(conversationStatus(status, { snoozedUntil: STATUS_AT })));
      expect(res.status).toBe(200);
    }

    expect(published()).toHaveLength(0);
  });

  describe('conversations that do not belong to the instance', () => {
    it('drops a status of another sender of the organization', async () => {
      const res = await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1', to: '5511988887777' })),
      );

      expect(res.status).toBe(200);
      expect(published()).toHaveLength(0);
    });

    it('drops a status of another channel, even on the same number', async () => {
      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1', channel: 'instagram' })),
      );

      expect(published()).toHaveLength(0);
    });

    it('drops a status that names no contact', async () => {
      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1', from: undefined })),
      );

      expect(published()).toHaveLength(0);
    });

    it('matches a keyword sender as written', async () => {
      const keyword = 'secret-drive';
      plugin = new ZenviaPlugin();
      eventBus = new MockEventBus();
      await plugin.initialize(createContext(eventBus));
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
      await connectPlugin(plugin, { zenviaSenderId: keyword });
      eventBus.published = [];

      await plugin.handleWebhook(
        post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1', to: keyword })),
      );

      expect(ofType('chat.human_takeover')).toEqual([expect.objectContaining({ chatExternalId: CONTACT })]);
    });
  });

  describe('delivery', () => {
    it('answers 503 when the event cannot be published, and publishes the redelivery', async () => {
      const payload = conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { userId: 'user-1' });
      spyOn(eventBus, 'publish').mockRejectedValueOnce(new Error('bus down'));

      const first = await plugin.handleWebhook(post(payload));
      const second = await plugin.handleWebhook(post(payload));

      expect(first.status).toBe(503);
      expect(second.status).toBe(200);
      expect(published().map((e) => e.type)).toEqual(['chat.human_takeover']);
    });

    it('acknowledges a payload that fails validation without publishing', async () => {
      const noConversation = await plugin.handleWebhook(post({ type: 'CONVERSATION_STATUS' }));
      const noStatus = await plugin.handleWebhook(
        post({ type: 'CONVERSATION_STATUS', conversation: { id: 'conv-1' } }),
      );

      expect(noConversation.status).toBe(200);
      expect(noStatus.status).toBe(200);
      expect(published()).toHaveLength(0);
    });

    it('never logs the contact number', async () => {
      const logger = plugin.getLogger();
      const lines: string[] = [];
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        });
      }

      await plugin.handleWebhook(post(conversationStatus('CONVERSATION_QUEUED')));
      await plugin.handleWebhook(post(conversationStatus('CONVERSATION_DISTRIBUTED_TO_USER', { to: '5511988887777' })));

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes(CONTACT))).toBe(false);
    });
  });
});
