import { describe, expect, test } from 'bun:test';
import type { HistorySyncMessage } from '@omni/channel-sdk';
import { type WAMessage, proto } from 'baileys';
import { WhatsAppPlugin } from '../plugin';

function fixture() {
  const plugin = new WhatsAppPlugin();
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const emitted: Record<string, unknown>[] = [];
  const received: HistorySyncMessage[] = [];
  const state = {
    chatJid: 'chat-a@jid',
    totalFetched: 0,
    onMessage: async (message: HistorySyncMessage) => {
      received.push(message);
    },
  };
  const initialize = plugin.initialize({
    eventBus: { publish: async () => ({ id: 'event' }), publishGeneric: async () => ({ id: 'event' }) },
    logger: { ...logger, child: () => logger },
    storage: {},
    config: {},
    db: {},
  } as never);
  const internals = plugin as unknown as {
    historySyncCallbacks: Map<string, typeof state>;
    backfillChats: Map<string, Set<string>>;
    emitMessageReceived: (message: Record<string, unknown>) => Promise<void>;
  };
  internals.historySyncCallbacks.set('line', state);
  internals.emitMessageReceived = async (message) => {
    emitted.push(message);
  };
  const message = (chatId: string): WAMessage => ({
    key: { id: `history-${chatId}`, remoteJid: chatId },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'history text' },
  });
  return { plugin, initialize, internals, state, received, emitted, message };
}

describe('passive history while a chat backfill is active', () => {
  for (const chatId of ['chat-a@jid', 'chat-b@jid']) {
    test(`passive history for ${chatId} keeps the passive path`, async () => {
      const f = fixture();
      await f.initialize;
      await f.plugin.handleHistorySync('line', {
        chats: [],
        contacts: [],
        messages: [f.message(chatId)],
        syncType: proto.HistorySync.HistorySyncType.RECENT,
      });
      expect(f.emitted).toHaveLength(1);
      expect(f.emitted[0]).toMatchObject({ chatId, isHistorySync: true });
      expect(f.received).toEqual([]);
      expect(f.state.totalFetched).toBe(0);
    });
  }
  test('an explicit reply for the selected chat stays on its callback', async () => {
    const f = fixture();
    await f.initialize;
    await f.plugin.handleHistorySync('line', {
      chats: [],
      contacts: [],
      messages: [f.message('chat-a@jid')],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    });
    expect(f.received).toHaveLength(1);
    expect(f.emitted).toEqual([]);
    expect(f.state.totalFetched).toBe(1);
  });
  test('a message outside the selected chat in an explicit batch keeps its passive path', async () => {
    const f = fixture();
    await f.initialize;
    await f.plugin.handleHistorySync('line', {
      chats: [],
      contacts: [],
      messages: [f.message('chat-a@jid'), f.message('chat-b@jid')],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    });
    expect(f.received.map((message) => message.chatId)).toEqual(['chat-a@jid']);
    expect(f.emitted.map((message) => message.chatId)).toEqual(['chat-b@jid']);
  });
  test('legacy fetch callbacks keep their existing passive-batch behavior', async () => {
    const f = fixture();
    await f.initialize;
    f.state.chatJid = '';
    await f.plugin.handleHistorySync('line', {
      chats: [],
      contacts: [],
      messages: [f.message('chat-b@jid')],
      syncType: proto.HistorySync.HistorySyncType.RECENT,
    });
    expect(f.received).toHaveLength(1);
    expect(f.emitted).toEqual([]);
  });
  test('late explicit replies stay suppressed while passive history stays readable', async () => {
    const f = fixture();
    await f.initialize;
    f.internals.backfillChats.set('line', new Set(['chat-b@jid']));
    await f.plugin.handleHistorySync('line', {
      chats: [],
      contacts: [],
      messages: [f.message('chat-b@jid')],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    });
    expect(f.received).toEqual([]);
    expect(f.emitted).toEqual([]);
    await f.plugin.handleHistorySync('line', { chats: [], contacts: [], messages: [f.message('chat-b@jid')] });
    expect(f.emitted).toHaveLength(1);
  });
});
