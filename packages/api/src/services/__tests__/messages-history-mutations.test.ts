import { describe, expect, test } from 'bun:test';
import type { HistorySyncMutation } from '@omni/channel-sdk';
import type { EventBus } from '@omni/core';
import type { Database, Message } from '@omni/db';
import { MessageService } from '../messages';

function fixture() {
  const row = {
    id: 'target',
    chatId: 'chat',
    externalId: 'external',
    source: 'sync',
    textContent: 'original',
    status: 'sent',
    editCount: 0,
    editHistory: [],
    editedAt: null,
    deletedAt: null,
    originalText: null,
    reactions: [],
    reactionCounts: {},
    rawPayload: { key: { id: 'external' } },
    latestEventId: null,
  } as unknown as Message;
  const selectResult = () => Object.assign(Promise.resolve([row]), { for: async () => [row] });
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: selectResult }) }) }),
    update: () => ({
      set: (values: Partial<Message>) => ({
        where: () =>
          Object.assign(
            Promise.resolve().then(() => {
              Object.assign(row, values);
            }),
            {
              returning: async () => {
                Object.assign(row, values);
                return [row];
              },
            },
          ),
      }),
    }),
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
  };

  const events: string[] = [];
  const bus = {
    publish: async (type: string) => {
      events.push(type);
    },
  } as unknown as EventBus;
  return { row, events, service: new MessageService(db as unknown as Database, bus) };
}
const base = {
  id: 'operation',
  targetExternalId: 'external',
  chatId: 'chat@jid',
  actor: 'person',
  at: new Date('2026-01-15'),
};

describe('historical mutations use stored message state without events', () => {
  for (const mutation of [
    { ...base, kind: 'reaction', emoji: '👍' },
    { ...base, kind: 'edit', text: 'edited' },
    { ...base, kind: 'deletion' },
  ] as HistorySyncMutation[]) {
    test(`${mutation.kind} is applied once across reruns and preserves the original raw key`, async () => {
      const f = fixture();
      expect(await f.service.applyHistoryMutation('chat', mutation, 'whatsapp-baileys')).toBe('applied');
      const snapshot = structuredClone(f.row);
      expect(await f.service.applyHistoryMutation('chat', mutation, 'whatsapp-baileys')).toBe('duplicate');
      expect(f.row).toEqual(snapshot);
      expect(f.row.rawPayload?.key).toEqual({ id: 'external' });
      if (mutation.kind === 'reaction') expect(f.row.reactionCounts).toEqual({ '👍': 1 });
      if (mutation.kind === 'edit') {
        expect(f.row.editCount).toBe(1);
        expect(f.row.editHistory).toHaveLength(1);
      }
      if (mutation.kind === 'deletion') expect(f.row.deletedAt).toEqual(base.at);
      expect(f.events).toEqual([]);
    });
  }
  test('historical edits append history without replacing a newer stored edit', async () => {
    const f = fixture();
    await f.service.recordEdit('target', 'current', new Date('2026-01-20'), 'person');
    await f.service.applyHistoryMutation('chat', { ...base, kind: 'edit', text: 'older' }, 'whatsapp-baileys');
    expect(f.row.textContent).toBe('current');
    expect(f.row.editCount).toBe(2);
    expect(f.row.editHistory?.map((entry) => entry.text)).toEqual(['older', 'current']);
    expect(f.events).toEqual([]);
  });
  test('a removal uses the same reaction fields and is replay safe', async () => {
    const f = fixture();
    await f.service.applyHistoryMutation('chat', { ...base, kind: 'reaction', emoji: '👍' }, 'whatsapp-baileys');
    const removed = { ...base, id: 'remove', at: new Date('2026-01-16'), kind: 'reaction' as const, emoji: '' };
    await f.service.applyHistoryMutation('chat', removed, 'whatsapp-baileys');
    expect(f.row.reactions).toEqual([]);
    expect(f.row.reactionCounts).toBeNull();
    expect(await f.service.applyHistoryMutation('chat', removed, 'whatsapp-baileys')).toBe('duplicate');
    expect(f.events).toEqual([]);
  });
  test('an older reaction cannot undo a later historical removal', async () => {
    const f = fixture();
    await f.service.applyHistoryMutation(
      'chat',
      { ...base, id: 'remove', at: new Date('2026-01-20'), kind: 'reaction', emoji: '' },
      'whatsapp-baileys',
    );
    expect(
      await f.service.applyHistoryMutation('chat', { ...base, kind: 'reaction', emoji: '👍' }, 'whatsapp-baileys'),
    ).toBe('duplicate');
    expect(f.row.reactions).toEqual([]);
    expect(f.events).toEqual([]);
  });
});
