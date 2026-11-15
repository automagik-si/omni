/**
 * OpenAPI schemas for the unified chat endpoints (routes/v2/chats.ts).
 *
 * Request bodies and queries are the route's own validators, imported rather than
 * restated, so the documented contract cannot drift from what the route accepts.
 */

import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../lib/zod-openapi';
import {
  ChatTypeSchema,
  addParticipantSchema,
  chatBackfillParams,
  chatBackfillSchema,
  chatCoverageQuerySchema,
  createChatSchema,
  listMessagesQuerySchema,
  listQuerySchema,
  updateChatSchema,
} from '../../routes/v2/chats';
import { ErrorSchema, SuccessSchema } from './common';
import { StoredMessageSchema } from './messages-core';

export const ChatSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Chat UUID' }),
  instanceId: z.string().uuid().openapi({ description: 'Instance (channel) the chat lives on' }),
  externalId: z.string().openapi({ description: 'Platform-native chat id (WhatsApp JID, Telegram id, …)' }),
  canonicalId: z.string().nullable().openapi({ description: 'Canonical platform id when the platform has several' }),
  chatType: ChatTypeSchema.openapi({ description: 'Kind of chat' }),
  channel: z.string().openapi({ description: 'Channel type, e.g. whatsapp-baileys' }),
  name: z.string().nullable().openapi({ description: 'Display name' }),
  description: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  parentChatId: z.string().uuid().nullable(),
  participantCount: z.number().int().nullable(),
  messageCount: z.number().int().nullable(),
  unreadCount: z.number().int().nullable().openapi({ description: 'Messages not yet read' }),
  lastMessageAt: z.string().nullable().openapi({ description: 'ISO time of the latest message' }),
  lastMessagePreview: z.string().nullable(),
  lastMessageFromMe: z.boolean().nullable(),
  isGroup: z.boolean(),
  labels: z.array(z.string()).nullable(),
  settings: z.record(z.unknown()).nullable(),
  platformMetadata: z.record(z.unknown()).nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ChatParticipantSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().uuid(),
  platformUserId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.string().nullable(),
  personId: z.string().uuid().nullable(),
});

const ChatListResponse = z.object({
  items: z.array(ChatSchema),
  meta: z.object({
    hasMore: z.boolean(),
    cursor: z.string().nullable().optional(),
    total: z.number().int().optional(),
  }),
});

const ReactionSchema = z.object({
  emoji: z.string(),
  platformUserId: z.string(),
  personId: z.string().optional(),
  displayName: z.string().optional(),
  at: z.string().openapi({ description: 'ISO time of the reaction' }),
});

/** One item of GET /chats/{id}/messages: the stored message row, as the route returns it. */
export const ChatMessageSchema = StoredMessageSchema.extend({
  senderPlatformUserId: z.string().nullable().optional(),
  senderAgentId: z.string().uuid().nullable().optional().openapi({ description: 'Set when an agent sent it' }),
  mediaMimeType: z.string().nullable().optional(),
  imageDescription: z.string().nullable().optional().openapi({ description: 'Description of an image' }),
  videoDescription: z.string().nullable().optional().openapi({ description: 'Description of a video' }),
  documentExtraction: z.string().nullable().optional().openapi({ description: 'Text read from a document' }),
  reactions: z.array(ReactionSchema).nullable().optional(),
  reactionCounts: z.record(z.number().int()).nullable().optional().openapi({ description: 'Reactions per emoji' }),
  editCount: z.number().int().optional(),
  editedAt: z.string().nullable().optional().openapi({ description: 'ISO time of the last edit' }),
  deletedAt: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: 'ISO time it was deleted; listed only with includeDeleted=true' }),
}).passthrough();

const ChatMessagesPageSchema = z.object({
  items: z.array(ChatMessageSchema).openapi({ description: 'Newest first' }),
  meta: z.object({
    hasMore: z.boolean(),
    cursor: z.string().nullable().openapi({ description: 'Pass as cursor for the next page; null on the last page' }),
  }),
});

export const ChatCoverageSchema = z.object({
  oldest: z.string().nullable().openapi({ description: 'ISO platform time of the oldest stored message' }),
  newest: z.string().nullable().openapi({ description: 'ISO platform time of the newest stored message' }),
  count: z.number().int().openapi({ description: 'Stored messages, as paging the whole chat returns them' }),
  countInWindow: z.number().int().openapi({ description: 'Those between from and to, both inclusive' }),
  mediaMissing: z.number().int().openapi({ description: 'Media messages with no stored file' }),
  deletedCount: z.number().int().openapi({ description: 'Deleted messages, counted whatever includeDeleted says' }),
  lastInbound: z
    .string()
    .nullable()
    .openapi({ description: 'ISO platform time of the newest message not sent from the account' }),
  lastOutbound: z
    .string()
    .nullable()
    .openapi({ description: 'ISO platform time of the newest message sent from the account' }),
});

const idParam = z.object({
  id: z
    .string()
    .openapi({ description: "Chat UUID, or a platform-native chat id resolved through the API key's instance" }),
});

const notFound = { description: 'Chat not found', content: { 'application/json': { schema: ErrorSchema } } };
const chatData = (description: string) => ({
  description,
  content: { 'application/json': { schema: z.object({ data: ChatSchema }) } },
});

export function registerChatSchemas(registry: OpenAPIRegistry): void {
  const backfillJob = z.object({
    data: z.object({
      id: z.string().uuid(),
      chatId: z.string().uuid(),
      state: z.enum(['queued', 'fetching', 'done', 'phone-did-not-answer', 'cancelled', 'failed']),
      fetched: z.number(),
      stored: z.number(),
      duplicates: z.number(),
      mediaDownloaded: z.number(),
      mediaMissing: z.number(),
      reactionsApplied: z.number(),
      editsApplied: z.number(),
      deletionsApplied: z.number(),
      unmatched: z.number(),
      oldestReached: z.string().nullable(),
      outcome: z.string().optional(),
      coverage: z.object({
        oldest: z.string().nullable(),
        newest: z.string().nullable(),
        count: z.number(),
        countInWindow: z.number(),
        deletedCount: z.number(),
        mediaMissing: z.number(),
        lastInbound: z.string().nullable(),
        lastOutbound: z.string().nullable(),
      }),
    }),
  });
  registry.registerPath({
    method: 'post',
    path: '/chats/{id}/backfill',
    tags: ['Chats'],
    summary: 'Queue a chat backfill',
    request: { params: idParam, body: { content: { 'application/json': { schema: chatBackfillSchema } } } },
    responses: {
      202: {
        description: 'Queued',
        content: { 'application/json': { schema: z.object({ jobId: z.string().uuid() }) } },
      },
      404: notFound,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/chats/{id}/backfill/{jobId}',
    tags: ['Chats'],
    summary: 'Read chat backfill progress',
    request: { params: chatBackfillParams },
    responses: {
      200: { description: 'Job progress and coverage', content: { 'application/json': { schema: backfillJob } } },
      404: notFound,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/chats/{id}/backfill/{jobId}/cancel',
    tags: ['Chats'],
    summary: 'Cancel a chat backfill',
    request: { params: chatBackfillParams },
    responses: {
      200: { description: 'Cancelled job', content: { 'application/json': { schema: backfillJob } } },
      404: notFound,
    },
  });
  registry.register('Chat', ChatSchema);
  registry.register('ChatParticipant', ChatParticipantSchema);
  registry.register('ChatMessage', ChatMessageSchema);
  registry.register('ChatCoverage', ChatCoverageSchema);

  registry.registerPath({
    method: 'get',
    path: '/chats',
    tags: ['Chats'],
    summary: 'List chats',
    description:
      'Chats and groups across the instances the key can read, filtered by instance, channel, type, name, label or state. sort=activity lists the most recent first.',
    request: { query: listQuerySchema },
    responses: {
      200: { description: 'A page of chats', content: { 'application/json': { schema: ChatListResponse } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/chats',
    tags: ['Chats'],
    summary: 'Create a chat',
    request: { body: { content: { 'application/json': { schema: createChatSchema } } } },
    responses: {
      201: chatData('The created chat'),
      400: { description: 'Invalid body', content: { 'application/json': { schema: ErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/chats/{id}',
    tags: ['Chats'],
    summary: 'Get a chat',
    request: { params: idParam },
    responses: { 200: chatData('The chat'), 404: notFound },
  });

  registry.registerPath({
    method: 'patch',
    path: '/chats/{id}',
    tags: ['Chats'],
    summary: 'Update a chat',
    request: { params: idParam, body: { content: { 'application/json': { schema: updateChatSchema } } } },
    responses: { 200: chatData('The updated chat'), 404: notFound },
  });

  registry.registerPath({
    method: 'delete',
    path: '/chats/{id}',
    tags: ['Chats'],
    summary: 'Delete a chat',
    description: 'Soft delete: the chat is hidden from lists and can be restored.',
    request: { params: idParam },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: SuccessSchema } } },
      404: notFound,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/chats/{id}/messages',
    tags: ['Chats'],
    summary: 'List the messages of a chat',
    description:
      'Newest first, up to limit; before/after bound the time window (both inclusive) and mediaOnly keeps media messages. ' +
      'Pass meta.cursor back as cursor for the next page: it continues after the last item, so messages sharing one time are never repeated or skipped. ' +
      'Deleted messages are left out unless includeDeleted=true.',
    request: { params: idParam, query: listMessagesQuerySchema },
    responses: {
      200: {
        description: 'A page of messages',
        content: { 'application/json': { schema: ChatMessagesPageSchema } },
      },
      400: {
        description: 'Invalid query, or a cursor this route did not issue',
        content: { 'application/json': { schema: ErrorSchema } },
      },
      404: notFound,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/chats/{id}/coverage',
    tags: ['Chats'],
    summary: 'What Omni holds for a chat',
    description:
      'Oldest and newest platform times, counts, media still missing a stored file, and the newest message each way. ' +
      'Uses the same rows as GET /chats/{id}/messages, so count is what paging the whole chat returns. Read-only.',
    request: { params: idParam, query: chatCoverageQuerySchema },
    responses: {
      200: {
        description: 'The coverage',
        content: { 'application/json': { schema: z.object({ data: ChatCoverageSchema }) } },
      },
      400: { description: 'Invalid query', content: { 'application/json': { schema: ErrorSchema } } },
      404: notFound,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/chats/{id}/participants',
    tags: ['Chats'],
    summary: 'List the participants of a chat',
    request: { params: idParam },
    responses: {
      200: {
        description: 'Participants',
        content: { 'application/json': { schema: z.object({ items: z.array(ChatParticipantSchema) }) } },
      },
      404: notFound,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/chats/{id}/participants',
    tags: ['Chats'],
    summary: 'Add a participant to a chat',
    request: { params: idParam, body: { content: { 'application/json': { schema: addParticipantSchema } } } },
    responses: {
      201: {
        description: 'The participant',
        content: { 'application/json': { schema: z.object({ data: ChatParticipantSchema }) } },
      },
      404: notFound,
    },
  });
}
