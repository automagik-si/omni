import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { IngressClaim, InstanceConfig } from '@omni/channel-sdk';
import type { Bot } from 'grammy';
import { getBot } from '../client';
import { TelegramPlugin } from '../plugin';

describe('Telegram pending updates', () => {
  const instanceId = 'tg-pending-updates';
  const config: InstanceConfig = { instanceId, credentials: { token: '123456:local-test-token' } };
  const restores: Array<() => void> = [];
  const journal = new Map<string, string>();
  const published: Array<{ type: string; eventId?: string }> = [];
  let plugin: TelegramPlugin;
  let starts: Record<string, unknown>[];

  function newPlugin() {
    const result = new TelegramPlugin();
    const ingressClaim: IngressClaim = {
      claim: async ({ idempotencyKey }) => {
        if (journal.has(idempotencyKey)) return null;
        const id = crypto.randomUUID();
        journal.set(idempotencyKey, id);
        return id;
      },
      release: async () => {},
    };
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
    Object.assign(result, {
      logger,
      ingressClaim,
      eventBus: {
        publish: async (type: string, _payload: unknown, options: { publishEventId?: string }) => {
          published.push({ type, eventId: options.publishEventId });
        },
      },
    });
    return result;
  }

  beforeEach(async () => {
    journal.clear();
    published.length = 0;
    starts = [];
    const { Bot } = await import('grammy');
    const init = spyOn(Bot.prototype, 'init').mockImplementation(async function (this: Bot) {
      Object.assign(this, { botInfo: { id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot' } });
    });
    const start = spyOn(Bot.prototype, 'start').mockImplementation(async (options) => {
      starts.push(options as Record<string, unknown>);
    });
    const stop = spyOn(Bot.prototype, 'stop').mockImplementation(async () => {});
    restores.push(
      () => init.mockRestore(),
      () => start.mockRestore(),
      () => stop.mockRestore(),
    );
    plugin = newPlugin();
  });

  afterEach(async () => {
    try {
      await plugin.disconnect(instanceId);
    } finally {
      for (const restore of restores.splice(0).reverse()) restore();
    }
  });

  async function deliver(messageId = 42) {
    const bot = getBot(instanceId) as unknown as Bot;
    await bot.handleUpdate({
      update_id: 1000 + messageId,
      message: {
        message_id: messageId,
        date: 1700000000,
        chat: { id: -100, type: 'supergroup', title: 'Test group' },
        from: { id: 7, is_bot: false, first_name: 'Person' },
        text: 'Sent while offline',
      },
    });
  }

  test('connect and reconnect preserve pending updates and the other polling options', async () => {
    await plugin.connect(instanceId, config);
    await plugin.disconnect(instanceId);
    await plugin.connect(instanceId, config);

    expect(starts).toHaveLength(2);
    for (const options of starts) {
      expect(options).toEqual({
        drop_pending_updates: false,
        allowed_updates: [
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
          'message_reaction',
          'callback_query',
          'poll',
          'poll_answer',
          'my_chat_member',
        ],
        onStart: expect.any(Function),
      });
    }
  });

  test('redelivery after a plugin restart claims one journal row and publishes one message event', async () => {
    await plugin.connect(instanceId, config);
    await deliver();
    await plugin.disconnect(instanceId);

    // Retain only the journal fixture, as the host database survives a restart.
    // The new plugin and connection have no prior in-memory dedupe state.
    plugin = newPlugin();
    await plugin.connect(instanceId, config);
    await deliver();

    const key = 'telegram:tg-pending-updates:-100:42:text';
    expect([...journal.keys()]).toEqual([key]);
    expect(published.filter((event) => event.type === 'message.received')).toEqual([
      { type: 'message.received', eventId: journal.get(key) },
    ]);

    // Another queued message still gets its own claim and event.
    await deliver(43);
    expect(journal.size).toBe(2);
    expect(published.filter((event) => event.type === 'message.received')).toHaveLength(2);
  });
});
