/**
 * `omni chats messages` pages with --cursor and --include-deleted, and prints
 * the cursor of the next page; `omni chats coverage` reads a chat's coverage.
 *
 * Bun's `mock.module` is process-wide (see history.test.ts): this file mocks
 * the complete `../output.js` and `../client.js` shapes before importing the
 * command, with `tip` writing to stderr as the real one does, since later files
 * read it. Chat ids are UUIDs, so `resolveChatId` never reaches the client.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const CHAT = '11111111-1111-4111-8111-111111111111';
const COVERAGE = {
  oldest: '2026-11-01T10:00:00.000Z',
  newest: '2026-11-10T10:00:00.000Z',
  count: 7,
  countInWindow: 5,
  mediaMissing: 1,
  deletedCount: 2,
  lastInbound: '2026-11-05T10:00:00.000Z',
  lastOutbound: '2026-11-10T10:00:00.000Z',
};

const mockError = mock((msg: string): never => {
  throw new Error(msg);
});
const mockInfo = mock((_msg: string) => {});
const mockList = mock(<T>(_items: T[], _opts?: { rawData?: unknown[] }) => {});
const mockData = mock((_value: unknown) => {});

mock.module('../output.js', () => ({
  error: mockError,
  success: mock(),
  info: mockInfo,
  warn: mock(),
  table: mock(),
  json: mock(),
  raw: mock(),
  data: mockData,
  list: mockList,
  keyValue: mock(),
  header: mock(),
  dim: mock(),
  tip: (msg: string) => {
    // biome-ignore lint/suspicious/noConsole: matches real output.tip — writes to stderr via console.error
    console.error(msg);
  },
  disableColors: mock(),
  areColorsEnabled: () => true,
  setMaxCellWidth: mock(),
  getCurrentFormat: () => 'human',
  flushStdout: () => Promise.resolve(),
}));

const message = {
  id: 'msg-1',
  chatId: CHAT,
  messageType: 'text',
  textContent: 'hi',
  platformTimestamp: COVERAGE.newest,
};
const mockPageMessages = mock(async (_id: string, _params: Record<string, unknown>) => ({
  items: [message],
  meta: { hasMore: true, cursor: 'next-page' as string | null },
}));
const mockGetCoverage = mock(async (_id: string, _params: Record<string, unknown>) => COVERAGE);

mock.module('../client.js', () => ({
  // Bun's module mocks are process-wide: every export another test file imports must exist.
  exitNotAuthenticated: () => {
    throw new Error('not authenticated');
  },
  getOptionalClient: () => null,
  installActorHeader: () => {},
  getClient: () => ({ chats: { pageMessages: mockPageMessages, getCoverage: mockGetCoverage } }),
}));

const { createChatsCommand } = await import('../commands/chats.js');

async function run(...argv: string[]): Promise<void> {
  await createChatsCommand().parseAsync(['node', 'chats', ...argv]);
}

function subcommand(name: string) {
  const cmd = createChatsCommand().commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`'chats ${name}' is not registered`);
  return cmd;
}

beforeEach(() => {
  for (const spy of [mockError, mockInfo, mockList, mockData, mockPageMessages, mockGetCoverage]) spy.mockClear();
});

describe("'omni chats messages' pages by cursor", () => {
  test('has --cursor and --include-deleted', () => {
    const flags = subcommand('messages').options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--cursor', '--include-deleted', '--before', '--after']));
  });

  test('the first page asks as before and prints the cursor of the next one', async () => {
    await run('messages', CHAT);

    expect(mockPageMessages).toHaveBeenCalledWith(CHAT, {
      limit: 100,
      before: undefined,
      after: undefined,
      mediaOnly: undefined,
      includeDeleted: undefined,
      cursor: undefined,
    });
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList.mock.calls[0]?.[1]?.rawData).toEqual([message]);
    expect(mockInfo).toHaveBeenCalledWith('Older messages: add --cursor next-page');
  });

  test('--cursor and --include-deleted reach the SDK', async () => {
    await run('messages', CHAT, '--cursor', 'abc', '--include-deleted', '--limit', '20');

    expect(mockPageMessages.mock.calls[0]?.[1]).toMatchObject({ limit: 20, cursor: 'abc', includeDeleted: true });
  });

  test('the last page prints no cursor', async () => {
    mockPageMessages.mockImplementationOnce(async () => ({ items: [message], meta: { hasMore: false, cursor: null } }));

    await run('messages', CHAT, '--cursor', 'abc');

    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe("'omni chats coverage'", () => {
  test('has --from, --to and --include-deleted', () => {
    const flags = subcommand('coverage').options.map((o) => o.long);
    expect(flags).toEqual(['--from', '--to', '--include-deleted']);
  });

  test('reads the coverage of the chat and prints it', async () => {
    await run('coverage', CHAT);

    expect(mockGetCoverage).toHaveBeenCalledWith(CHAT, { from: undefined, to: undefined, includeDeleted: undefined });
    expect(mockData).toHaveBeenCalledWith(COVERAGE);
  });

  test('--from, --to and --include-deleted reach the SDK', async () => {
    await run('coverage', CHAT, '--from', '2026-11-01', '--to', '2026-11-15', '--include-deleted');

    expect(mockGetCoverage).toHaveBeenCalledWith(CHAT, { from: '2026-11-01', to: '2026-11-15', includeDeleted: true });
  });

  test('an API error is reported, not thrown', async () => {
    mockGetCoverage.mockImplementationOnce(async () => {
      throw new Error('Chat not found');
    });

    await expect(run('coverage', CHAT)).rejects.toThrow('Failed to get coverage: Chat not found');
  });
});
