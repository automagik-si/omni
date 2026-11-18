import { expect, test } from 'bun:test';
import type { HistorySyncMutation } from '@omni/channel-sdk';
import type { WAMessage } from 'baileys';
import { WhatsAppPlugin } from '../plugin';

test('explicit history mutations use only the job callback and publish no events', async () => {
  const plugin = new WhatsAppPlugin();
  const events: string[] = [];
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  await plugin.initialize({
    eventBus: {
      publish: async (type: string) => {
        events.push(type);
      },
    },
    logger: { ...logger, child: () => logger },
    storage: {},
    config: {},
    db: {},
  } as never);
  const mutations: HistorySyncMutation[] = [];
  const rows: unknown[] = [];
  const state = {
    chatJid: 'chat@jid',
    totalFetched: 0,
    onMessage: async (msg: unknown) => {
      rows.push(msg);
    },
    onMutation: async (mutation: HistorySyncMutation) => {
      mutations.push(mutation);
    },
  };
  const process = (
    plugin as unknown as { processHistoryMessage: (id: string, msg: WAMessage, state: unknown) => Promise<void> }
  ).processHistoryMessage.bind(plugin);
  const contents = [
    { reactionMessage: { key: { id: 'target' }, text: '👍' } },
    { protocolMessage: { type: 14, key: { id: 'target' }, editedMessage: { conversation: 'edited' } } },
    { protocolMessage: { type: 0, key: { id: 'target' } } },
  ];
  for (const [index, message] of contents.entries()) {
    await process(
      'line',
      { key: { id: `op-${index}`, remoteJid: 'chat@jid' }, messageTimestamp: 1_700_000_000, message } as WAMessage,
      state,
    );
  }
  expect(mutations.map((mutation) => mutation.kind)).toEqual(['reaction', 'edit', 'deletion']);
  expect(rows).toEqual([]);
  expect(events).toEqual([]);
});
