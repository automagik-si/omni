import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { MediaStorageBackend } from '@omni/channel-sdk';
import { configureLogging, getLogConfig } from '@omni/core';
import type { TelegramBotLike } from '../grammy-shim';
import { getFileWithRetry, tryDownloadTelegramMedia } from '../utils/media-download';

const token = '123456:made-up-channel-credential';
const unsafePicture = `https://api.telegram.org/file/bot${token}/photos/picture.jpg`;

describe('Telegram downloads protect the channel credential', () => {
  let output: string[];
  let config: ReturnType<typeof getLogConfig>;
  const restores: Array<() => void> = [];
  const bot = {
    token,
    api: { getFile: async () => ({ file_path: 'photos/picture.jpg' }) },
  } as unknown as TelegramBotLike;
  const backend = {
    mode: 'remote',
    store: async () => ({ reference: 'instance/picture.jpg', size: 1 }),
  } as unknown as MediaStorageBackend;

  beforeEach(() => {
    output = [];
    config = { ...getLogConfig() };
    configureLogging({ level: 'debug', modules: '*', format: 'json' });
    const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    restores.push(() => stdout.mockRestore());
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    configureLogging(config);
  });

  function download() {
    return tryDownloadTelegramMedia({ bot, instanceId: 'instance', externalId: 'message', fileId: 'picture' }, backend);
  }

  for (const headers of [{}, { 'content-length': String(100 * 1024 * 1024) }]) {
    test('download warnings do not expose the channel credential', async () => {
      const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { headers }));
      restores.push(() => fetch.mockRestore());
      await download();
      expect(output.length).toBeGreaterThan(0);
      expect(output.join('')).not.toContain(token);
      expect(output.join('')).not.toContain(unsafePicture);
    });
  }

  test('download failures do not expose the channel credential', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`Failed ${unsafePicture}`));
    restores.push(() => fetch.mockRestore());
    expect(await download()).toBeNull();
    expect(output.join('')).toContain('[redacted]');
    expect(output.join('')).not.toContain(token);
  });

  test('file lookup failures do not expose the channel credential', async () => {
    const getFile = spyOn(bot.api, 'getFile').mockRejectedValue(new Error(`Failed ${unsafePicture}`));
    restores.push(() => getFile.mockRestore());
    expect(await getFileWithRetry(bot, 'picture')).toBeNull();
    expect(output.join('')).toContain('[redacted]');
    expect(output.join('')).not.toContain(token);
  });
});
