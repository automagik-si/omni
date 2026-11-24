import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { ZenviaPlugin } from '../plugin';
import type { ZenviaListedConversation } from '../types';
import { normalizeConversationStatus, pickOpenConversation } from '../utils/conversations';
import { HANDOFF_NOT_CONFIGURED_ERROR } from '../utils/handoff';
import { API_TOKEN, MockEventBus, SENDER_ID, connectPlugin, createContext, instanceId, jsonResponse } from './helpers';

const CONTACT = '5511999998888';
const OTHER_CONTACT = '5511910000000';
const OTHER_SENDER = '551140000099';
const GROUP_ID = 'group-chatbot';
const USER_ID = 'agent-7';
const CONVERSATION_ID = 'conv-open';
const MESSAGE_ID = '7390113b-e120-41b5-8a07-c4567726abc2';
const SALES_KEY = 'sales-secret-key';

type FetchCall = [string | URL | Request, RequestInit | undefined];

function call(fetchSpy: ReturnType<typeof spyOn>, index: number): { url: URL; init: RequestInit | undefined } {
  const [input, init] = fetchSpy.mock.calls[index] as FetchCall;
  return { url: new URL(String(input)), init };
}

function bodyOf(fetchSpy: ReturnType<typeof spyOn>, index: number): Record<string, unknown> {
  return JSON.parse((call(fetchSpy, index).init?.body as string) ?? '{}') as Record<string, unknown>;
}

function paths(fetchSpy: ReturnType<typeof spyOn>, from: number): string[] {
  return fetchSpy.mock.calls.slice(from).map((args: unknown[]) => {
    const url = new URL(String(args[0]));
    return `${(args[1] as RequestInit | undefined)?.method ?? 'GET'} ${url.pathname}`;
  });
}

function conversation(overrides: Partial<ZenviaListedConversation> = {}): ZenviaListedConversation {
  return {
    id: CONVERSATION_ID,
    status: 'STARTED',
    statusTimestamp: '2026-11-24T10:00:00.000Z',
    channel: 'whatsapp',
    to: CONTACT,
    from: SENDER_ID,
    contactId: 'contact-1',
    groupId: 'group-root',
    createdAt: '2026-11-24T09:00:00.000Z',
    ...overrides,
  };
}

function sendResponse(): Response {
  return jsonResponse({ id: MESSAGE_ID, from: SENDER_ID, to: CONTACT, direction: 'OUT' });
}

const handoffMessage = {
  to: CONTACT,
  content: { type: 'text' as const, text: 'Someone from the team will take it from here.' },
  metadata: {
    isHandoff: true,
    motivoHandoff: 'asked for a person',
    dadosLead: { plan: 'basic', lives: 2 },
    handoffFields: { queue: 'queue-a' },
  },
};

const NOTE_TEXT = 'Motivo do handoff: asked for a person\nDados do lead:\nplan: basic\nlives: 2\nqueue: queue-a';

describe('pickOpenConversation', () => {
  it('picks the most recent open conversation of the contact on the sender', () => {
    const older = conversation({ id: 'older', createdAt: '2026-11-20T09:00:00.000Z' });
    const newer = conversation({ id: 'newer', status: 'QUEUED', createdAt: '2026-11-24T09:00:00.000Z' });

    expect(pickOpenConversation([older, newer], CONTACT, SENDER_ID)?.id).toBe('newer');
    expect(pickOpenConversation([newer, older], CONTACT, SENDER_ID)?.id).toBe('newer');
  });

  it('skips closed conversations, other senders, other contacts and other channels', () => {
    const candidates = [
      conversation({ id: 'closed', status: 'CLOSED', createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'closed-webhook-spelling', status: 'CONVERSATION_CLOSED' }),
      conversation({ id: 'other-sender', from: OTHER_SENDER, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'other-contact', to: OTHER_CONTACT, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'sms', channel: 'sms', createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'swapped', to: SENDER_ID, from: CONTACT, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'no-to', to: undefined, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'right', createdAt: '2026-11-01T09:00:00.000Z' }),
    ];

    expect(pickOpenConversation(candidates, CONTACT, SENDER_ID)?.id).toBe('right');
  });

  it('compares the contact by its digits and the sender the way inbound messages do', () => {
    const formatted = conversation({ to: '+55 (11) 99999-8888', from: `+${SENDER_ID}` });

    expect(pickOpenConversation([formatted], CONTACT, SENDER_ID)?.id).toBe(CONVERSATION_ID);
  });

  it('keeps the server order when the creation times cannot be compared', () => {
    const first = conversation({ id: 'first', createdAt: undefined });
    const second = conversation({ id: 'second', createdAt: 'not a date' });

    expect(pickOpenConversation([first, second], CONTACT, SENDER_ID)?.id).toBe('first');
  });

  it('finds nothing when every conversation is closed or belongs to someone else', () => {
    const candidates = [conversation({ status: 'CLOSED' }), conversation({ from: OTHER_SENDER })];

    expect(pickOpenConversation(candidates, CONTACT, SENDER_ID)).toBeUndefined();
    expect(pickOpenConversation([], CONTACT, SENDER_ID)).toBeUndefined();
  });

  it('normalizes both status spellings', () => {
    expect(normalizeConversationStatus(' conversation_claimed ')).toBe('CLAIMED');
    expect(normalizeConversationStatus('CLOSED')).toBe('CLOSED');
  });
});

describe('ZenviaPlugin handoff through the Conversations API', () => {
  let plugin: ZenviaPlugin;
  let bus: MockEventBus;

  async function connect(extra: Record<string, unknown> = {}, groups: unknown = [{ id: GROUP_ID, name: 'chatbot' }]) {
    bus = new MockEventBus();
    plugin = new ZenviaPlugin();
    await plugin.initialize(createContext(bus));
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse(groups));
    await connectPlugin(plugin, { zenviaHandoffGroupId: GROUP_ID, ...extra });
  }

  function queueHandoff(fetchSpy: ReturnType<typeof spyOn>, conversations: unknown[] = [conversation()]) {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(conversations))
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1', type: 'note', direction: 'INTERNAL' }, 201))
      .mockResolvedValueOnce(jsonResponse(conversation({ status: 'QUEUED', groupId: GROUP_ID }), 202))
      .mockResolvedValueOnce(sendResponse());
  }

  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  describe('on connect', () => {
    it('lists the groups with the API token instead of keeping the transfer off', async () => {
      await connect();
      const fetchSpy = spyOn(globalThis, 'fetch');

      const { url, init } = call(fetchSpy, 1);
      expect(url.href).toBe('https://api.zenvia.com/v2/groups');
      expect((init?.headers as Record<string, string>)['X-API-TOKEN']).toBe(API_TOKEN);
      expect(plugin.getInstanceState(instanceId)?.salesClient).toBeUndefined();
    });

    it('warns about the default and mapped groups the token does not list, without blocking', async () => {
      bus = new MockEventBus();
      plugin = new ZenviaPlugin();
      await plugin.initialize(createContext(bus));
      const warn = spyOn(plugin.getLogger(), 'warn');
      spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([{ id: 'group-1', name: 'a', enabled: true }]));

      await connectPlugin(plugin, {
        zenviaHandoffGroupId: GROUP_ID,
        zenviaHandoffRouting: { field: 'queue', groups: { 'queue-a': 'group-1', 'queue-b': 'group-2' } },
      });

      const lines = warn.mock.calls.map((args) => JSON.stringify(args));
      expect(lines.filter((line) => line.includes('handoff group not among'))).toHaveLength(1);
      expect(lines.filter((line) => line.includes('group-2'))).toHaveLength(1);
      expect(lines.some((line) => line.includes('"group-1"'))).toBe(false);
      expect(plugin.getInstanceState(instanceId)).toBeDefined();
    });

    it('still connects when the groups cannot be listed', async () => {
      for (const failure of [jsonResponse({ message: 'forbidden' }, 403), new Response('', { status: 503 })]) {
        bus = new MockEventBus();
        plugin = new ZenviaPlugin();
        await plugin.initialize(createContext(bus));
        const warn = spyOn(plugin.getLogger(), 'warn');
        spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(failure);

        await connectPlugin(plugin, { zenviaHandoffGroupId: GROUP_ID });

        expect(plugin.getInstanceState(instanceId)).toBeDefined();
        expect(warn.mock.calls.some((args) => String(args[0]).includes('Conversations API check failed'))).toBe(true);
        spyOn(globalThis, 'fetch').mockRestore();
      }
    });
  });

  it('finds the open conversation, writes the note, transfers to the group and then sends the farewell', async () => {
    await connect();
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy);
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result).toMatchObject({ success: true, messageId: MESSAGE_ID });
    expect(result.rejected).toBeUndefined();
    expect(paths(fetchSpy, before)).toEqual([
      'GET /v2/conversations',
      'POST /v2/conversations/conv-open/notes',
      'POST /v2/conversations/conv-open/actions/transfer',
      'POST /v2/channels/whatsapp/messages',
    ]);

    const lookup = call(fetchSpy, before);
    expect(lookup.url.origin).toBe('https://api.zenvia.com');
    expect(lookup.url.searchParams.get('search')).toBe(CONTACT);
    expect(lookup.url.searchParams.get('sort')).toBe('createdAt,desc');
    expect(Number(lookup.url.searchParams.get('size'))).toBeGreaterThan(1);
    for (const index of [0, 1, 2]) {
      expect((call(fetchSpy, before + index).init?.headers as Record<string, string>)['X-API-TOKEN']).toBe(API_TOKEN);
    }

    expect(bodyOf(fetchSpy, before + 1)).toEqual({ text: NOTE_TEXT });
    expect(bodyOf(fetchSpy, before + 2)).toEqual({ type: 'GROUP', groupId: GROUP_ID });
    expect(bodyOf(fetchSpy, before + 3).conversation).toBeUndefined();
    expect(bus.published.some((event) => event.type === 'message.sent')).toBe(true);
  });

  it('writes the same note text the Sales transfer writes', async () => {
    await connect();
    const conversationsSpy = spyOn(globalThis, 'fetch');
    queueHandoff(conversationsSpy);
    const conversationsBefore = conversationsSpy.mock.calls.length;
    await plugin.sendMessage(instanceId, handoffMessage);
    const conversationsNote = bodyOf(conversationsSpy, conversationsBefore + 1).text;
    spyOn(globalThis, 'fetch').mockRestore();

    bus = new MockEventBus();
    plugin = new ZenviaPlugin();
    await plugin.initialize(createContext(bus));
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse([]));
    await connectPlugin(plugin, { zenviaSalesApiKey: SALES_KEY, zenviaHandoffGroupId: GROUP_ID });
    const salesSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'prospect-1' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'n1' }]))
      .mockResolvedValueOnce(sendResponse());
    const salesBefore = salesSpy.mock.calls.length;
    await plugin.sendMessage(instanceId, handoffMessage);

    expect(conversationsNote).toBe(NOTE_TEXT);
    expect(bodyOf(salesSpy, salesBefore + 2).content).toBe(conversationsNote);
  });

  it('transfers the conversation picked among closed, foreign and older ones', async () => {
    await connect();
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy, [
      conversation({ id: 'closed', status: 'CLOSED', createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'other-sender', from: OTHER_SENDER, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'other-contact', to: OTHER_CONTACT, createdAt: '2026-11-24T11:00:00.000Z' }),
      conversation({ id: 'older', createdAt: '2026-11-01T09:00:00.000Z' }),
      conversation({ id: 'current', status: 'QUEUED', createdAt: '2026-11-24T09:00:00.000Z' }),
    ]);
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(true);
    expect(call(fetchSpy, before + 1).url.pathname).toBe('/v2/conversations/current/notes');
    expect(call(fetchSpy, before + 2).url.pathname).toBe('/v2/conversations/current/actions/transfer');
  });

  it('ignores conversation items it cannot read', async () => {
    await connect();
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy, [{ status: 'STARTED' }, 'garbage', conversation()]);
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(true);
    expect(call(fetchSpy, before + 2).url.pathname).toBe(`/v2/conversations/${CONVERSATION_ID}/actions/transfer`);
  });

  it('transfers to the configured agent inside the group', async () => {
    await connect({ zenviaHandoffUserId: USER_ID });
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy);
    const before = fetchSpy.mock.calls.length;

    await plugin.sendMessage(instanceId, handoffMessage);

    expect(bodyOf(fetchSpy, before + 2)).toEqual({ type: 'USER', groupId: GROUP_ID, userId: USER_ID });
  });

  it('transfers to the group the routing map picks', async () => {
    await connect(
      { zenviaHandoffGroupId: undefined, zenviaHandoffRouting: { field: 'queue', groups: { 'queue-a': 'group-1' } } },
      [{ id: 'group-1' }],
    );
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy);
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(true);
    expect(bodyOf(fetchSpy, before + 2)).toEqual({ type: 'GROUP', groupId: 'group-1' });
  });

  it('prefers the transfer over conversation routing when a group is set', async () => {
    await connect({ zenviaHandoffSolution: 'conversion' });
    const fetchSpy = spyOn(globalThis, 'fetch');
    queueHandoff(fetchSpy);
    const before = fetchSpy.mock.calls.length;

    await plugin.sendMessage(instanceId, handoffMessage);

    expect(call(fetchSpy, before + 2).url.pathname).toBe(`/v2/conversations/${CONVERSATION_ID}/actions/transfer`);
    expect(bodyOf(fetchSpy, before + 3).conversation).toBeUndefined();
  });

  it('skips the note when the handoff carries no context', async () => {
    await connect();
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([conversation()]))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(sendResponse());
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, { ...handoffMessage, metadata: { isHandoff: true } });

    expect(result.success).toBe(true);
    expect(paths(fetchSpy, before)).toEqual([
      'GET /v2/conversations',
      `POST /v2/conversations/${CONVERSATION_ID}/actions/transfer`,
      'POST /v2/channels/whatsapp/messages',
    ]);
  });

  it('still transfers, warning, when the note cannot be written', async () => {
    await connect();
    const warn = spyOn(plugin.getLogger(), 'warn');
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([conversation()]))
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse(conversation(), 202))
      .mockResolvedValueOnce(sendResponse());
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result).toMatchObject({ success: true, messageId: MESSAGE_ID });
    expect(call(fetchSpy, before + 2).url.pathname).toBe(`/v2/conversations/${CONVERSATION_ID}/actions/transfer`);
    const noteWarning = warn.mock.calls.map((args) => JSON.stringify(args)).find((line) => line.includes('note'));
    expect(noteWarning).toBeDefined();
    expect(noteWarning).not.toContain('asked for a person');
  });

  it('pages through the search until it finds the open conversation', async () => {
    await connect();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      conversation({ id: `foreign-${index}`, from: OTHER_SENDER }),
    );
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([conversation({ id: 'on-page-two' })]))
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
      .mockResolvedValueOnce(jsonResponse(conversation(), 202))
      .mockResolvedValueOnce(sendResponse());
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result).toMatchObject({ success: true, messageId: MESSAGE_ID });
    expect(call(fetchSpy, before).url.searchParams.get('page')).toBe('1');
    expect(call(fetchSpy, before + 1).url.searchParams.get('page')).toBe('2');
    expect(call(fetchSpy, before + 3).url.pathname).toBe('/v2/conversations/on-page-two/actions/transfer');
  });

  it('keeps paging after a full page that carries an unreadable item', async () => {
    await connect();
    const firstPage: unknown[] = Array.from({ length: 99 }, (_, index) =>
      conversation({ id: `foreign-${index}`, from: OTHER_SENDER }),
    );
    firstPage.push({ unexpected: true });
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([conversation({ id: 'on-page-two' })]))
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
      .mockResolvedValueOnce(jsonResponse(conversation(), 202))
      .mockResolvedValueOnce(sendResponse());
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result).toMatchObject({ success: true, messageId: MESSAGE_ID });
    expect(call(fetchSpy, before + 3).url.pathname).toBe('/v2/conversations/on-page-two/actions/transfer');
  });

  it('does not claim there is no conversation when every page it may read is full', async () => {
    await connect();
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      conversation({ id: `foreign-${index}`, from: OTHER_SENDER }),
    );
    const fetchSpy = spyOn(globalThis, 'fetch');
    for (let page = 0; page < 5; page++) fetchSpy.mockResolvedValueOnce(jsonResponse(fullPage));
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(false);
    expect(result.rejected).toBeUndefined();
    expect(result.retryable).toBe(true);
    expect(result.error).not.toMatch(/no conversation to transfer/);
    expect(paths(fetchSpy, before)).toHaveLength(5);
    expect(bus.published.some((event) => event.type === 'message.sent')).toBe(false);
  });

  it('treats an accepted transfer whose answer cannot be read as done, never as retryable', async () => {
    await connect();
    const unreadable = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 202 },
    );
    spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([conversation()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValueOnce(sendResponse());

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result).toMatchObject({ success: true, messageId: MESSAGE_ID });
    expect(result.retryable).toBeUndefined();
  });

  describe('no conversation to transfer', () => {
    it('stops paging at the first short page and refuses', async () => {
      await connect();
      const fullPage = Array.from({ length: 100 }, (_, index) =>
        conversation({ id: `closed-${index}`, status: 'CLOSED' }),
      );
      const fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(fullPage))
        .mockResolvedValueOnce(jsonResponse([conversation({ status: 'CLOSED' })]));
      const before = fetchSpy.mock.calls.length;

      const result = await plugin.sendMessage(instanceId, handoffMessage);

      expect(result.rejected).toBe(true);
      expect(paths(fetchSpy, before)).toEqual(['GET /v2/conversations', 'GET /v2/conversations']);
    });

    it('refuses for good, sending nothing, when the contact has no open conversation on this sender', async () => {
      for (const listed of [
        [],
        [conversation({ status: 'CLOSED' })],
        [conversation({ from: OTHER_SENDER }), conversation({ to: OTHER_CONTACT })],
      ]) {
        await connect();
        const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(listed));
        const before = fetchSpy.mock.calls.length;

        const result = await plugin.sendMessage(instanceId, handoffMessage);

        expect(result.success).toBe(false);
        expect(result.rejected).toBe(true);
        expect(result.retryable).toBe(false);
        expect(result.error).toMatch(/no conversation to transfer/);
        expect(paths(fetchSpy, before)).toEqual(['GET /v2/conversations']);
        expect(bus.published.some((event) => event.type === 'message.sent')).toBe(false);
        spyOn(globalThis, 'fetch').mockRestore();
      }
    });

    it('refuses without calling Zenvia when the recipient has no digits', async () => {
      await connect();
      const fetchSpy = spyOn(globalThis, 'fetch');
      const before = fetchSpy.mock.calls.length;

      const result = await plugin.sendMessage(instanceId, { ...handoffMessage, to: 'not-a-number' });

      expect(result.success).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.error).toMatch(/no conversation to transfer/);
      expect(fetchSpy.mock.calls.length).toBe(before);
    });
  });

  describe('definitive refusal versus transient failure', () => {
    it('marks a 4xx on the transfer as rejected and sends no farewell', async () => {
      for (const status of [400, 404, 409, 422]) {
        await connect();
        const fetchSpy = spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(jsonResponse([conversation()]))
          .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
          .mockResolvedValueOnce(jsonResponse({ code: 'VALIDATION_ERROR', message: 'refused' }, status));
        const before = fetchSpy.mock.calls.length;

        const result = await plugin.sendMessage(instanceId, handoffMessage);

        expect(result.success).toBe(false);
        expect(result.rejected).toBe(true);
        expect(result.retryable).toBe(false);
        expect(result.errorCode).toBe('ZENVIA_INVALID_REQUEST');
        expect(fetchSpy.mock.calls.length - before).toBe(3);
        spyOn(globalThis, 'fetch').mockRestore();
      }
    });

    it('marks a 4xx on the conversation lookup as rejected', async () => {
      await connect();
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ message: 'bad search' }, 400));
      const before = fetchSpy.mock.calls.length;

      const result = await plugin.sendMessage(instanceId, handoffMessage);

      expect(result.success).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.retryable).toBe(false);
      expect(result.errorCode).toBe('ZENVIA_INVALID_REQUEST');
      expect(paths(fetchSpy, before)).toEqual(['GET /v2/conversations']);
    });

    it('does not mark credential failures (401, 403) or rate limits (429) as rejected', async () => {
      for (const [status, retryable] of [
        [401, false],
        [403, false],
        [429, true],
      ] as const) {
        await connect();
        spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(jsonResponse([conversation()]))
          .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
          .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, status));

        const result = await plugin.sendMessage(instanceId, handoffMessage);

        expect(result.success).toBe(false);
        expect(result.rejected).toBeUndefined();
        expect(result.retryable).toBe(retryable);
        spyOn(globalThis, 'fetch').mockRestore();
      }
    });

    it('keeps a 5xx on the transfer retryable and not rejected', async () => {
      await connect();
      spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse([conversation()]))
        .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
        .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 503));

      const result = await plugin.sendMessage(instanceId, handoffMessage);

      expect(result.success).toBe(false);
      expect(result.rejected).toBeUndefined();
      expect(result.retryable).toBe(true);
    });

    it('keeps a 5xx or an unreadable answer on the lookup retryable and not rejected', async () => {
      for (const answer of [jsonResponse({ message: 'boom' }, 500), jsonResponse({ unexpected: true })]) {
        await connect();
        const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer);
        const before = fetchSpy.mock.calls.length;

        const result = await plugin.sendMessage(instanceId, handoffMessage);

        expect(result.success).toBe(false);
        expect(result.rejected).toBeUndefined();
        expect(result.retryable).toBe(true);
        expect(fetchSpy.mock.calls.length - before).toBe(1);
        spyOn(globalThis, 'fetch').mockRestore();
      }
    });

    it('keeps a timeout on the transfer retryable and not rejected', async () => {
      await connect();
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse([conversation()]))
        .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
        .mockRejectedValueOnce(timeout);

      const result = await plugin.sendMessage(instanceId, handoffMessage);

      expect(result.success).toBe(false);
      expect(result.rejected).toBeUndefined();
      expect(result.retryable).toBe(true);
      expect(result.error).toMatch(/timed out/);
    });
  });

  it('reports the handoff as done, without a message id, when only the farewell fails after the transfer', async () => {
    await connect();
    const logError = spyOn(plugin.getLogger(), 'error');
    spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([conversation()]))
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }, 201))
      .mockResolvedValueOnce(jsonResponse(conversation(), 202))
      .mockResolvedValueOnce(jsonResponse({ message: 'down' }, 503));

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(true);
    expect(result.messageId ?? null).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(bus.published.filter((event) => event.type === 'message.failed')).toHaveLength(1);
  });

  it('leaves the Sales transfer untouched when the Sales key is set', async () => {
    bus = new MockEventBus();
    plugin = new ZenviaPlugin();
    await plugin.initialize(createContext(bus));
    const connectSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: GROUP_ID }]));
    await connectPlugin(plugin, { zenviaSalesApiKey: SALES_KEY, zenviaHandoffGroupId: GROUP_ID });
    expect(call(connectSpy, 1).url.href).toStartWith('https://sales.zenvia.com/api/v1/groups');
    const fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'prospect-1' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'n1' }]))
      .mockResolvedValueOnce(sendResponse());
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(true);
    expect(paths(fetchSpy, before)).toEqual([
      'GET /api/v1/prospect-by',
      'POST /api/v1/prospect/prospect-1/transfer',
      'POST /api/v1/prospect/prospect-1/interactions',
      'POST /v2/channels/whatsapp/messages',
    ]);
  });

  it('still refuses a handoff with no group and no routing solution, even with the Sales key', async () => {
    bus = new MockEventBus();
    plugin = new ZenviaPlugin();
    await plugin.initialize(createContext(bus));
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
    await connectPlugin(plugin, { zenviaSalesApiKey: SALES_KEY });
    const fetchSpy = spyOn(globalThis, 'fetch');
    const before = fetchSpy.mock.calls.length;

    const result = await plugin.sendMessage(instanceId, handoffMessage);

    expect(result.success).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.error).toBe(HANDOFF_NOT_CONFIGURED_ERROR);
    expect(fetchSpy.mock.calls.length).toBe(before);
  });
});
