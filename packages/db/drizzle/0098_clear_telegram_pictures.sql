-- Telegram pictures could expose the channel credential; clear existing pictures (#1747).
-- no-schema-change: Data-only cleanup of previously saved pictures.
-- Hand-written following the 0043/0044/0052 precedent (idempotent).

UPDATE "instances" SET "profile_pic_url" = NULL
WHERE "profile_pic_url" LIKE 'https://api.telegram.org/file/bot%';
--> statement-breakpoint
UPDATE "persons" SET "avatar_url" = NULL
WHERE "avatar_url" LIKE 'https://api.telegram.org/file/bot%';
--> statement-breakpoint
UPDATE "platform_identities" SET "profile_pic_url" = NULL
WHERE "profile_pic_url" LIKE 'https://api.telegram.org/file/bot%';
--> statement-breakpoint
UPDATE "chats" SET "avatar_url" = NULL
WHERE "avatar_url" LIKE 'https://api.telegram.org/file/bot%';
--> statement-breakpoint
UPDATE "chat_participants" SET "avatar_url" = NULL
WHERE "avatar_url" LIKE 'https://api.telegram.org/file/bot%';
