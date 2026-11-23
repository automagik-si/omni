import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { PluginContext } from '@omni/channel-sdk';
import type { SlackAttachment } from '../connection/app-receiver';
import { SlackPlugin } from '../plugin';

const noop = () => undefined;
const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
const INSTANCE = 'slack-instance';
const USER = 'U_OWNER';
const CHAT = 'D_CHAT';
const ORIGINAL_TS = '1700000000.000001';
const CHANGE_TS = '1700000002.000001';

async function recordingHarness(config: Record<string, unknown> = {}) {
  const publish = mock(async (_type: string, _payload: unknown, _metadata: unknown) => 'evt');
  const plugin = new SlackPlugin();
  await plugin.initialize({ eventBus: { publish, subscribe: noop }, logger, config: {} } as unknown as PluginContext);
  const internal = plugin as unknown as {
    registerInboundHandler: (attachment: SlackAttachment) => void;
    inboundHandlers: Map<string, (msg: Record<string, unknown>) => Promise<void>>;
    trackActiveThread: (...args: unknown[]) => void;
    addAckReaction: (...args: unknown[]) => void;
  };
  const trackActiveThread = spyOn(internal, 'trackActiveThread');
  const addAckReaction = spyOn(internal, 'addAckReaction');
  const fetchUserProfile = spyOn(plugin, 'fetchUserProfile').mockResolvedValue({ displayName: 'Owner' });
  internal.registerInboundHandler({
    instanceId: INSTANCE,
    authMode: 'user',
    actingUserId: USER,
    botId: 'B_OMNI',
    botUserId: 'U_OMNI',
    config: { channels: { C_BLOCKED: { allowedUsers: ['U_ALLOWED'] } }, channelBlocklist: ['C_BLOCKED'], ...config },
  } as unknown as SlackAttachment);
  const receive = internal.inboundHandlers.get(INSTANCE);
  if (!receive) throw new Error('Slack message handler not registered');
  return { receive, publish, trackActiveThread, addAckReaction, fetchUserProfile };
}

describe('passive Slack message recording', () => {
  test('records authorizing-user messages as outbound without requesting a reply', async () => {
    const h = await recordingHarness();
    await h.receive({ channel: CHAT, channel_type: 'im', ts: ORIGINAL_TS, user: USER, text: 'My reply' });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[0]).toBe('message.received');
    expect(h.publish.mock.calls[0]?.[1]).toMatchObject({
      chatId: CHAT,
      externalId: ORIGINAL_TS,
      from: USER,
      content: { type: 'text', text: 'My reply' },
      rawPayload: { isFromMe: true, noAgentDispatch: true, messageTimestamp: 1_700_000_000_000 },
    });
    expect(h.publish.mock.calls[0]?.[1]).not.toHaveProperty('chatName', 'Owner');
    expect(h.trackActiveThread).not.toHaveBeenCalled();
    expect(h.addAckReaction).not.toHaveBeenCalled();
  });

  test('keeps dropping the same app send echo', async () => {
    const h = await recordingHarness();
    await h.receive({
      channel: CHAT,
      channel_type: 'im',
      ts: ORIGINAL_TS,
      user: USER,
      bot_id: 'B_OMNI',
      text: 'App response',
    });

    expect(h.publish).not.toHaveBeenCalled();
    expect(h.addAckReaction).not.toHaveBeenCalled();
  });

  test('records the original Slack timestamp and edited text without a new turn', async () => {
    const h = await recordingHarness();
    await h.receive({
      subtype: 'message_changed',
      channel: CHAT,
      ts: CHANGE_TS,
      message: { ts: ORIGINAL_TS, user: 'U_OTHER', text: 'Replacement', edited: { ts: CHANGE_TS } },
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[0]).toBe('message.received');
    expect(h.publish.mock.calls[0]?.[1]).toMatchObject({
      chatId: CHAT,
      externalId: `${CHAT}:message_changed:${CHANGE_TS}`,
      content: { type: 'edit', text: 'Replacement' },
      rawPayload: { editedMessageId: ORIGINAL_TS, editedAt: 1_700_000_002_000, noAgentDispatch: true },
    });
    expect(h.trackActiveThread).not.toHaveBeenCalled();
    expect(h.addAckReaction).not.toHaveBeenCalled();
    expect(h.fetchUserProfile).not.toHaveBeenCalled();
  });

  test('retains edits by the authorizing user in a paired DM and a restricted channel', async () => {
    const h = await recordingHarness({
      dmPolicy: 'pairing',
      dmAllowlist: ['U_ALLOWED'],
      channels: { C_RESTRICTED: { allowedUsers: ['U_ALLOWED'] } },
    });
    for (const channel of [CHAT, 'C_RESTRICTED', 'C_BLOCKED']) {
      for (const user of [USER, 'U_STRANGER']) {
        await h.receive({
          subtype: 'message_changed',
          channel,
          ts: CHANGE_TS,
          message: { ts: ORIGINAL_TS, user, text: 'Revised' },
        });
      }
    }
    expect(h.publish.mock.calls.map((call) => call[1])).toEqual(
      [CHAT, 'C_RESTRICTED'].map((chatId) =>
        expect.objectContaining({
          chatId,
          from: USER,
          content: { type: 'edit', text: 'Revised' },
          rawPayload: expect.objectContaining({ noAgentDispatch: true }),
        }),
      ),
    );
  });

  test('uses the prior message author on a sparse edit and respects its app identity', async () => {
    const h = await recordingHarness({ dmPolicy: 'pairing', dmAllowlist: ['U_ALLOWED'] });
    for (const prior of [{ user: USER }, { user: USER, bot_id: 'B_OMNI' }, { user: 'U_STRANGER' }]) {
      await h.receive({
        subtype: 'message_changed',
        channel: CHAT,
        ts: CHANGE_TS,
        previous_message: prior,
        message: { ts: ORIGINAL_TS, text: 'Replacement' },
      });
    }
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[1]).toMatchObject({ from: USER, content: { type: 'edit', text: 'Replacement' } });
  });

  test('records a deletion without requiring Slack to send the old message', async () => {
    const h = await recordingHarness();
    await h.receive({ subtype: 'message_deleted', channel: CHAT, ts: CHANGE_TS, deleted_ts: ORIGINAL_TS });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[0]).toBe('message.received');
    expect(h.publish.mock.calls[0]?.[1]).toMatchObject({
      chatId: CHAT,
      externalId: `${CHAT}:message_deleted:${CHANGE_TS}`,
      content: { type: 'delete' },
      rawPayload: { deletedMessageId: ORIGINAL_TS, deletedAt: 1_700_000_002_000, noAgentDispatch: true },
    });
    expect(h.trackActiveThread).not.toHaveBeenCalled();
    expect(h.addAckReaction).not.toHaveBeenCalled();
  });

  test('drops malformed events and edits from blocked channels', async () => {
    const h = await recordingHarness();
    await h.receive({ subtype: 'message_deleted', channel: CHAT, ts: CHANGE_TS, deleted_ts: 42 });
    await h.receive({ channel: CHAT, channel_type: 'im', ts: ORIGINAL_TS, user: USER, text: 42 });
    await h.receive({
      subtype: 'message_changed',
      channel: 'C_BLOCKED',
      ts: CHANGE_TS,
      message: { ts: ORIGINAL_TS, user: 'U_OTHER', text: 'Never record this' },
    });

    expect(h.publish).not.toHaveBeenCalled();
  });

  test('ignores metadata updates that leave the original text unchanged', async () => {
    const h = await recordingHarness();
    await h.receive({
      subtype: 'message_changed',
      channel: CHAT,
      ts: CHANGE_TS,
      previous_message: { user: 'U_OTHER', text: 'Same text' },
      message: { ts: ORIGINAL_TS, user: 'U_OTHER', text: 'Same text' },
    });

    expect(h.publish).not.toHaveBeenCalled();
  });
});
