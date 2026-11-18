import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as client from '../client';
import type { TelegramBotLike } from '../grammy-shim';
import { TelegramPlugin } from '../plugin';

const token = '123456:made-up-channel-credential';

describe('Telegram pictures protect the channel credential', () => {
  afterEach(() => mock.restore());

  function setup() {
    const bot = {
      token,
      api: {
        getMe: async () => ({ id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' }),
        getUserProfilePhotos: async () => ({ total_count: 1, photos: [[{ file_id: 'picture' }]] }),
        getFile: async () => ({ file_path: 'photos/picture.jpg' }),
        getChat: async () => ({
          id: 2,
          type: 'private',
          first_name: 'Person',
          bio: 'Test bio',
          photo: { big_file_id: 'picture' },
        }),
      },
    } as unknown as TelegramBotLike;
    spyOn(client, 'getBot').mockReturnValue(bot);
    return new TelegramPlugin();
  }

  test('the channel profile no longer exposes its credential', async () => {
    const profile = await setup().getProfile('instance');
    expect(profile.avatarUrl).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain(token);
    expect(profile.name).toBe('Test');
    expect(profile.ownerIdentifier).toBe('@test_bot');
  });

  test('a person profile no longer exposes the channel credential', async () => {
    const profile = await setup().fetchUserProfile('instance', '2');
    expect(profile.avatarUrl).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain(token);
    expect(profile.displayName).toBe('Person');
    expect(profile.bio).toBe('Test bio');
  });
});
