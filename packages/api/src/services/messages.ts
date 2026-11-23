/**
 * Message service - manages unified message model (source of truth)
 *
 * Messages are the source of truth for all message data.
 * Event links are OPTIONAL - synced messages have no events.
 *
 * @see unified-messages wish
 */

import { type HistorySyncMutation, HistorySyncMutationSchema } from '@omni/channel-sdk';
import type { EventBus } from '@omni/core';
import { NotFoundError } from '@omni/core';
import type { Database } from '@omni/db';
import {
  type ChannelType,
  type DeliveryStatus,
  type EditHistoryEntry,
  type Message,
  type MessageSource,
  type MessageStatus,
  type MessageType,
  type NewMessage,
  type ReactionInfo,
  chats,
  messages,
} from '@omni/db';
import {
  type SQL,
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { scopedHandle } from '../tenancy/tenant-scope';

import { sanitizeText } from '../utils/utf8';

/** Where the next page of a chat's messages starts: the last item of the page before. */
export interface ChatMessagesCursor {
  at: Date;
  id: string;
}

export interface ChatMessagesPageOptions {
  limit?: number;
  before?: Date;
  after?: Date;
  mediaOnly?: boolean;
  includeDeleted?: boolean;
  cursor?: ChatMessagesCursor;
}

export interface ChatMessagesPage {
  items: Message[];
  hasMore: boolean;
  cursor: string | null;
}

export interface ChatCoverageOptions {
  from?: Date;
  to?: Date;
  includeDeleted?: boolean;
}

export interface ChatCoverage {
  oldest: Date | null;
  newest: Date | null;
  count: number;
  countInWindow: number;
  mediaMissing: number;
  deletedCount: number;
  lastInbound: Date | null;
  lastOutbound: Date | null;
}

const ChatMessagesCursorPayload = z.object({ t: z.string().datetime(), id: z.string().uuid() });

/**
 * The opaque cursor for the page after `last`: base64url of its platform time
 * and id. Platform times are written from JS Dates, so milliseconds hold them
 * exactly.
 */
export function encodeChatMessagesCursor(last: { platformTimestamp: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: last.platformTimestamp.toISOString(), id: last.id })).toString('base64url');
}

/** The position a cursor from `encodeChatMessagesCursor` names, or null for anything else. */
export function decodeChatMessagesCursor(raw: string): ChatMessagesCursor | null {
  try {
    const parsed = ChatMessagesCursorPayload.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? { at: new Date(parsed.data.t), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a `textContent`-style value without changing its shape.
 *
 * `sanitizeText` maps `''` (and `undefined`/`null`) to `undefined`, which the
 * media-text writers absorb with `?? ''`. Message text has no such fallback —
 * `create()` and `update()` must persist exactly what the caller passed — so
 * an empty string stays an empty string, `undefined` stays `undefined`, and
 * only the bytes Postgres rejects (NUL, lone surrogates) are stripped.
 */
export function sanitizeMessageText<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string' || value === '') return value;
  return (sanitizeText(value) ?? '') as T;
}

// Pre-processed media text (extraction / vision / transcription) can carry NUL
// bytes; Postgres text columns reject 0x00, so strip them before any write.
// `textContent` rides the same paths (PATCH /messages/:id) and is just as
// capable of carrying a NUL — see the 0x00 write failure fixed in a0800e2f.
export function sanitizeMediaText(data: Partial<NewMessage>): Partial<NewMessage> {
  const out: Partial<NewMessage> = { ...data };
  if (typeof out.textContent === 'string') out.textContent = sanitizeMessageText(out.textContent);
  if (typeof out.transcription === 'string') out.transcription = sanitizeText(out.transcription) ?? '';
  if (typeof out.imageDescription === 'string') out.imageDescription = sanitizeText(out.imageDescription) ?? '';
  if (typeof out.videoDescription === 'string') out.videoDescription = sanitizeText(out.videoDescription) ?? '';
  if (typeof out.documentExtraction === 'string') {
    out.documentExtraction = sanitizeText(out.documentExtraction) ?? '';
  }
  return out;
}

export interface ListMessagesOptions {
  chatId?: string;
  instanceIds?: string[];
  source?: MessageSource[];
  messageType?: MessageType[];
  status?: MessageStatus[];
  hasMedia?: boolean;
  senderPersonId?: string;
  externalId?: string;
  since?: Date;
  until?: Date;
  search?: string;
  includeHidden?: boolean;
  limit?: number;
  cursor?: string;
}

export interface CreateMessageOptions {
  chatId: string;
  externalId: string;
  source: MessageSource;
  messageType: MessageType;
  textContent?: string;
  platformTimestamp: Date;
  // Sender info
  senderPersonId?: string;
  senderPlatformIdentityId?: string;
  senderPlatformUserId?: string;
  senderDisplayName?: string;
  isFromMe?: boolean;
  // Media
  hasMedia?: boolean;
  mediaMimeType?: string;
  mediaUrl?: string;
  mediaLocalPath?: string;
  mediaMetadata?: Record<string, unknown>;
  // Pre-processed content
  transcription?: string;
  imageDescription?: string;
  videoDescription?: string;
  documentExtraction?: string;
  // Reply/Forward
  replyToMessageId?: string;
  replyToExternalId?: string;
  quotedText?: string;
  quotedSenderName?: string;
  isForwarded?: boolean;
  forwardedFromExternalId?: string;
  // Thread (#889) — a reply points at ONE message; a thread is a
  // sub-conversation. Slack `thread_ts`, Discord sub-channel, Telegram forum
  // topic all land here instead of being collapsed into replyToExternalId.
  threadExternalId?: string;
  /** Slack `reply_broadcast`: posted in the thread AND surfaced in the channel. */
  isThreadBroadcast?: boolean;
  // Actor FK
  senderAgentId?: string | null;
  // Raw data
  rawPayload?: Record<string, unknown>;
  // Event links (optional - only for realtime)
  originalEventId?: string;
}

/** Media type badges for message previews */
const MEDIA_BADGES: Record<string, string> = {
  image: '[Image]',
  audio: '[Audio]',
  video: '[Video]',
  document: '[Document]',
  sticker: '[Sticker]',
  contact: '[Contact]',
  location: '[Location]',
  poll: '[Poll]',
};

/** Build a rich preview string for the chat's lastMessagePreview */
function buildMessagePreview(options: CreateMessageOptions): string {
  const sender = options.isFromMe ? 'You' : (options.senderDisplayName ?? null);

  // Build content part
  let content: string;
  const mediaDesc =
    options.transcription ?? options.imageDescription ?? options.videoDescription ?? options.documentExtraction;
  const badge = MEDIA_BADGES[options.messageType];

  if (options.textContent && !badge) {
    // Pure text message
    content = options.textContent;
  } else if (badge) {
    // Media message — show badge + description or caption
    content = mediaDesc ? `${badge} ${mediaDesc}` : options.textContent ? `${badge} ${options.textContent}` : badge;
  } else {
    content = options.textContent ?? '[Media]';
  }

  // Prefix with sender name
  const preview = sender ? `${sender}: ${content}` : content;
  // `chats.lastMessagePreview` is written in the same transaction as the
  // message row, so an unsanitized preview would fail the insert just as an
  // unsanitized `textContent` would.
  return sanitizeMessageText(preview.substring(0, 500));
}

/**
 * Channels where a user holds at most one reaction per message: a new emoji
 * from the same user replaces the previous one (WhatsApp semantics). Every
 * other channel lets a user stack several reactions on one message.
 */
const SINGLE_REACTION_PER_USER_CHANNELS: ReadonlySet<ChannelType> = new Set<ChannelType>([
  'whatsapp-baileys',
  'whatsapp-business',
]);

/**
 * Delivery receipts only move forward: `pending < sent < delivered < read`.
 * For each status, the statuses a message must not already hold for it to
 * apply. `failed` is outside the order (`markDeliveryFailed` owns its guard).
 */
const DELIVERY_STATUS_AT_OR_PAST: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[] | null>> = {
  pending: ['pending', 'sent', 'delivered', 'read'],
  sent: ['sent', 'delivered', 'read'],
  delivered: ['delivered', 'read'],
  read: ['read'],
  failed: null,
};

/**
 * Drop `platformUserId`'s reactions whose emoji differs from `emoji`, and
 * decrement their counts (deleting a key that reaches zero).
 */
function dropOtherEmojisOfUser(
  reactions: ReactionInfo[],
  counts: Record<string, number>,
  platformUserId: string,
  emoji: string,
): { kept: ReactionInfo[]; counts: Record<string, number>; dropped: number } {
  const kept = reactions.filter((r) => !(r.platformUserId === platformUserId && r.emoji !== emoji));
  const newCounts = { ...counts };
  for (const removed of reactions.filter((r) => !kept.includes(r))) {
    const count = (newCounts[removed.emoji] ?? 0) - 1;
    if (count > 0) {
      newCounts[removed.emoji] = count;
    } else {
      delete newCounts[removed.emoji];
    }
  }
  return { kept, counts: newCounts, dropped: reactions.length - kept.length };
}

export class MessageService {
  /**
   * The handle every query in this service uses.
   *
   * Inside a tenant-scoped request this is the request's tenant-stamped
   * transaction (wish: omni-full-multitenancy, G4 — see `tenancy/tenant-scope.ts`);
   * for a legacy credential, a worker, or the CLI it is the ambient pool and
   * the query issued is byte-for-byte the one issued before the conversion.
   */
  private get db(): Database {
    return scopedHandle(this.pool);
  }

  constructor(
    private readonly pool: Database,
    private eventBus: EventBus | null,
  ) {}

  /**
   * List messages with filtering and pagination
   */
  private buildListConditions(options: ListMessagesOptions) {
    const {
      chatId,
      instanceIds,
      source,
      messageType,
      status,
      hasMedia,
      senderPersonId,
      externalId,
      since,
      until,
      search,
      includeHidden = false,
      cursor,
    } = options;

    const conditions = [];
    if (chatId) conditions.push(eq(messages.chatId, chatId));
    // undefined = no scoping, [] = deny-all, [...ids] = filter to those
    if (Array.isArray(instanceIds)) {
      conditions.push(instanceIds.length > 0 ? inArray(chats.instanceId, instanceIds) : sql`1 = 0`);
    }
    if (!includeHidden) conditions.push(sql`chats.visibility = 'visible'`);
    if (source?.length) conditions.push(inArray(messages.source, source));
    if (messageType?.length) conditions.push(inArray(messages.messageType, messageType));
    if (status?.length) conditions.push(inArray(messages.status, status));
    if (hasMedia !== undefined) conditions.push(eq(messages.hasMedia, hasMedia));
    if (senderPersonId) conditions.push(eq(messages.senderPersonId, senderPersonId));
    if (externalId) conditions.push(eq(messages.externalId, externalId));
    if (since) conditions.push(gte(messages.platformTimestamp, since));
    if (until) conditions.push(lte(messages.platformTimestamp, until));
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(
        or(
          ilike(messages.textContent, searchPattern),
          ilike(messages.transcription, searchPattern),
          ilike(messages.imageDescription, searchPattern),
          ilike(messages.documentExtraction, searchPattern),
        ),
      );
    }
    conditions.push(sql`${messages.deletedAt} IS NULL`);
    if (cursor) conditions.push(sql`${messages.platformTimestamp} < ${cursor}`);

    return conditions;
  }

  async list(options: ListMessagesOptions = {}): Promise<{
    items: Message[];
    hasMore: boolean;
    cursor?: string;
  }> {
    const { instanceIds, includeHidden = false, limit = 50 } = options;
    const needsJoin = Array.isArray(instanceIds) || !includeHidden;
    const conditions = this.buildListConditions(options);

    const baseQuery = this.db.select({ messages }).from(messages);
    const query = needsJoin ? baseQuery.innerJoin(chats, eq(messages.chatId, chats.id)) : baseQuery;

    const rows = await query
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(messages.platformTimestamp))
      .limit(limit + 1);

    const items = rows.map((row) => row.messages);

    const hasMore = items.length > limit;
    if (hasMore) {
      items.pop();
    }

    const lastItem = items[items.length - 1];
    return {
      items,
      hasMore,
      cursor: lastItem?.platformTimestamp.toISOString(),
    };
  }

  /**
   * Count total messages matching filters
   */
  async count(options: Omit<ListMessagesOptions, 'limit' | 'cursor'> = {}): Promise<number> {
    const { instanceIds, includeHidden = false } = options;
    const needsJoin = Array.isArray(instanceIds) || !includeHidden;
    const conditions = this.buildListConditions(options as ListMessagesOptions);

    const baseQuery = this.db.select({ count: count() }).from(messages);
    const query = needsJoin ? baseQuery.innerJoin(chats, eq(messages.chatId, chats.id)) : baseQuery;

    const result = await query.where(conditions.length ? and(...conditions) : undefined);

    return result[0]?.count ?? 0;
  }

  /**
   * Get messages for a chat, newest first. One page of `pageChatMessages`.
   */
  async getChatMessages(chatId: string, options: ChatMessagesPageOptions = {}): Promise<Message[]> {
    return (await this.pageChatMessages(chatId, options)).items;
  }

  /**
   * One page of a chat's messages, ordered `(platformTimestamp desc, id desc)`.
   *
   * `before` and `after` bound the window, both inclusive. `cursor` continues
   * after the last item of the page before, exclusive on the same order, so
   * messages that share one platform time are never repeated or skipped.
   * Deleted messages stay out unless `includeDeleted` is set.
   *
   * `cursor` in the answer is null when no further page exists.
   */
  async pageChatMessages(chatId: string, options: ChatMessagesPageOptions = {}): Promise<ChatMessagesPage> {
    const { limit = 100, before, after, mediaOnly, includeDeleted = false, cursor } = options;
    const conditions: (SQL | undefined)[] = [eq(messages.chatId, chatId)];

    if (!includeDeleted) {
      conditions.push(isNull(messages.deletedAt));
    }

    if (before) {
      conditions.push(lte(messages.platformTimestamp, before));
    }

    if (after) {
      conditions.push(gte(messages.platformTimestamp, after));
    }

    if (mediaOnly) {
      conditions.push(eq(messages.hasMedia, true));
    }

    if (cursor) {
      conditions.push(
        or(
          lt(messages.platformTimestamp, cursor.at),
          and(eq(messages.platformTimestamp, cursor.at), lt(messages.id, cursor.id)),
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.platformTimestamp), desc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, hasMore, cursor: hasMore && last ? encodeChatMessagesCursor(last) : null };
  }

  /**
   * What Omni holds for one chat: the platform times of its oldest and newest
   * messages, how many there are (in all, and between `from` and `to`, both
   * inclusive), how many media messages have no stored file, how many are
   * deleted, and the newest message not sent from the account and sent from it.
   *
   * Every figure but `deletedCount` uses the row filter of `pageChatMessages`
   * (deleted messages out unless `includeDeleted`), so `count` is what paging
   * the whole chat returns. `deletedCount` counts the deleted messages whatever
   * `includeDeleted` says.
   */
  async getChatCoverage(chatId: string, options: ChatCoverageOptions = {}): Promise<ChatCoverage> {
    const { from, to, includeDeleted = false } = options;
    const kept = includeDeleted ? sql`true` : isNull(messages.deletedAt);
    const inWindow = and(
      kept,
      from ? gte(messages.platformTimestamp, from) : undefined,
      to ? lte(messages.platformTimestamp, to) : undefined,
    );
    const latest = (condition: SQL | undefined) =>
      sql<Date | null>`max(${messages.platformTimestamp}) filter (where ${condition})`.mapWith(
        messages.platformTimestamp,
      );
    const tally = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

    const [row] = await this.db
      .select({
        oldest: sql<Date | null>`min(${messages.platformTimestamp}) filter (where ${kept})`.mapWith(
          messages.platformTimestamp,
        ),
        newest: latest(kept),
        count: tally(kept),
        countInWindow: tally(inWindow),
        mediaMissing: tally(and(kept, eq(messages.hasMedia, true), isNull(messages.mediaLocalPath))),
        deletedCount: tally(isNotNull(messages.deletedAt)),
        lastInbound: latest(and(kept, eq(messages.isFromMe, false))),
        lastOutbound: latest(and(kept, eq(messages.isFromMe, true))),
      })
      .from(messages)
      .where(eq(messages.chatId, chatId));

    return {
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
      count: row?.count ?? 0,
      countInWindow: row?.countInWindow ?? 0,
      mediaMissing: row?.mediaMissing ?? 0,
      deletedCount: row?.deletedCount ?? 0,
      lastInbound: row?.lastInbound ?? null,
      lastOutbound: row?.lastOutbound ?? null,
    };
  }

  /**
   * Get message by ID
   */
  async getById(id: string): Promise<Message> {
    const [result] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);

    if (!result) {
      throw new NotFoundError('Message', id);
    }

    return result;
  }

  /**
   * Check if the bot has participated in a specific thread.
   * Matches three cases:
   *  1. Bot replied in the thread (threadExternalId == threadTs) — since #889
   *  2. Bot replied in the thread (replyToExternalId == threadTs) — rows
   *     written before #889, when Slack collapsed thread into reply. Kept so
   *     the check keeps working against history without a backfill.
   *  3. Bot started the thread (externalId == threadTs, root message)
   */
  async hasBotRepliedInThread(chatId: string, threadExternalId: string): Promise<boolean> {
    const [result] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          eq(messages.isFromMe, true),
          or(
            eq(messages.threadExternalId, threadExternalId),
            eq(messages.replyToExternalId, threadExternalId),
            eq(messages.externalId, threadExternalId),
          ),
        ),
      )
      .limit(1);
    return !!result;
  }

  /** Get message by external ID and chat */
  async getByExternalId(chatId: string, externalId: string): Promise<Message | null> {
    const [result] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.externalId, externalId)))
      .limit(1);

    return result ?? null;
  }

  /** The Slack adapter stores each upload under <message ts>-file-<file id>. */
  async getSlackMessageParts(chatId: string, ts: string): Promise<Pick<Message, 'id' | 'deletedAt'>[]> {
    return this.db
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          or(eq(messages.externalId, ts), sql`starts_with(${messages.externalId}, ${`${ts}-file-`})`),
        ),
      )
      .orderBy(messages.id)
      .for('update');
  }

  /**
   * Get an outbound message by provider alias captured in raw_payload.
   *
   * Gupshup native replies may reference provider-generated ids
   * (replyContext.id / gsId / internalId) instead of Omni's external_id. When
   * the send path preserved the provider response, search those aliases before
   * giving up on quoted-message context.
   */
  async findByProviderAlias(chatId: string, aliases: string[]): Promise<Message | null> {
    const candidates = [
      ...new Set(
        aliases.filter((alias) => typeof alias === 'string' && alias.length > 0).map((alias) => alias.slice(0, 255)),
      ),
    ].slice(0, 8);
    if (candidates.length === 0) return null;

    const aliasConditions = candidates.flatMap((alias) => [
      eq(messages.externalId, alias),
      sql`${messages.rawPayload}->'gupshupResponse'->>'messageId' = ${alias}`,
      sql`${messages.rawPayload}->'gupshupResponse'->>'gsId' = ${alias}`,
      sql`${messages.rawPayload}->'gupshupResponse'->>'id' = ${alias}`,
      sql`${messages.rawPayload}->'gupshupResponse'->'messageIds' @> ${JSON.stringify([alias])}::jsonb`,
      sql`${messages.rawPayload}->'gupshupProviderAliases' @> ${JSON.stringify([alias])}::jsonb`,
    ]);

    const [result] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.isFromMe, true), or(...aliasConditions)))
      .orderBy(desc(messages.platformTimestamp))
      .limit(1);

    return result ?? null;
  }

  /**
   * Best-effort fallback for providers that expose native reply ids on inbound
   * replies but do not return those ids on outbound sends. This is deliberately
   * scoped to recent outbound bot messages in the same chat and is used only
   * after exact external-id and provider-alias lookup fail.
   */
  async findRecentOutboundBefore(chatId: string, before: Date, inboundText?: string): Promise<Message | null> {
    // Gupshup's native reply payload timestamp is second-precision while our
    // outbound rows retain millisecond precision. A customer can reply in the
    // same second as the outbound send; allow a tiny future grace window so the
    // just-quoted outbound is not accidentally excluded in favor of older plans.
    const upperBound = new Date(before.getTime() + 2000);

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          eq(messages.isFromMe, true),
          lte(messages.platformTimestamp, upperBound),
          sql`${messages.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(messages.platformTimestamp))
      .limit(8);

    if (rows.length === 0) return null;

    const hint = (inboundText ?? '').toLocaleLowerCase('pt-BR');
    const wantsPlanLikeTarget = /\b(esse|essa|este|esta|op[cç][aã]o|plano|quero|gostei)\b/i.test(hint);
    if (!wantsPlanLikeTarget) return rows[0] ?? null;

    const score = (message: Message): number => {
      const text = (message.textContent ?? '').toLocaleLowerCase('pt-BR');
      let value = 0;
      if (/op[cç][aã]o|plano/.test(text)) value += 4;
      if (/r\$|mensal|coparticipa|enfermaria|apartamento|ambulatorial|notrelife|hapvida/.test(text)) value += 3;
      if (/\?\s*$/.test(text) && !/r\$/.test(text)) value -= 2;
      return value;
    };

    const ranked = rows
      .map((message) => ({ message, score: score(message) }))
      .sort(
        (a, b) => b.score - a.score || b.message.platformTimestamp.getTime() - a.message.platformTimestamp.getTime(),
      );

    // Ambiguity guard: when two or more candidates tie at the top score AND
    // were sent moments apart (same burst — e.g. two product cards delivered
    // back to back), picking the newest is a coin flip: quoting the WRONG card
    // silently corrupts the reply context downstream (the agent locks onto an
    // option the customer never chose). Returning null is strictly safer — the
    // agent sees no quote and asks which option was meant. Ties against much
    // OLDER messages keep the recency preference (an hours-old duplicate is
    // almost never the quote target; see the second-precision grace test).
    const AMBIGUOUS_TIE_WINDOW_MS = 5 * 60_000;
    const top = ranked[0];
    if (!top) return null;
    const ambiguousTie =
      top.score > 0 &&
      ranked.some(
        (entry, index) =>
          index > 0 &&
          entry.score === top.score &&
          Math.abs(top.message.platformTimestamp.getTime() - entry.message.platformTimestamp.getTime()) <=
            AMBIGUOUS_TIE_WINDOW_MS,
      );
    if (ambiguousTie) return null;
    return top.message;
  }

  /** Get multiple messages by external IDs in a single query */
  async getByExternalIds(chatId: string, externalIds: string[]): Promise<Message[]> {
    if (externalIds.length === 0) return [];
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), inArray(messages.externalId, externalIds)));
  }

  /**
   * Create a new message
   */
  async create(options: CreateMessageOptions): Promise<Message> {
    return this.db.transaction(async (tx) => {
      // Insert message
      const [created] = await tx
        .insert(messages)
        .values({
          chatId: options.chatId,
          externalId: options.externalId,
          source: options.source,
          messageType: options.messageType,
          textContent: sanitizeMessageText(options.textContent),
          platformTimestamp: options.platformTimestamp,
          // Sender
          senderPersonId: options.senderPersonId,
          senderPlatformIdentityId: options.senderPlatformIdentityId,
          senderPlatformUserId: options.senderPlatformUserId,
          senderDisplayName: options.senderDisplayName,
          senderAgentId: options.senderAgentId ?? undefined,
          isFromMe: options.isFromMe ?? false,
          // Media
          hasMedia: options.hasMedia ?? false,
          mediaMimeType: options.mediaMimeType,
          mediaUrl: options.mediaUrl,
          mediaLocalPath: options.mediaLocalPath,
          mediaMetadata: options.mediaMetadata,
          // Pre-processed content
          transcription: sanitizeText(options.transcription),
          imageDescription: sanitizeText(options.imageDescription),
          videoDescription: sanitizeText(options.videoDescription),
          documentExtraction: sanitizeText(options.documentExtraction),
          // Reply/Forward
          replyToMessageId: options.replyToMessageId,
          replyToExternalId: options.replyToExternalId,
          quotedText: options.quotedText,
          quotedSenderName: options.quotedSenderName,
          isForwarded: options.isForwarded ?? false,
          forwardedFromExternalId: options.forwardedFromExternalId,
          // Thread (#889)
          threadExternalId: options.threadExternalId,
          isThreadBroadcast: options.isThreadBroadcast ?? false,
          // Raw data
          rawPayload: options.rawPayload,
          // Event links
          originalEventId: options.originalEventId,
          latestEventId: options.originalEventId,
        })
        .returning();

      if (!created) {
        throw new Error('Failed to create message');
      }

      // Update chat stats (in same transaction - ATOMIC)
      const preview = buildMessagePreview(options);
      const timestamp = options.platformTimestamp.toISOString();
      const newer = sql`${chats.lastMessageAt} IS NULL OR ${chats.lastMessageAt} < ${timestamp}`;
      await tx
        .update(chats)
        .set({
          // History arrives backwards. Compare against the row being updated so
          // an older insert cannot replace a concurrent live message's summary.
          lastMessageAt:
            options.source === 'sync'
              ? sql`CASE WHEN ${newer} THEN ${timestamp} ELSE ${chats.lastMessageAt} END`
              : options.platformTimestamp,
          lastMessagePreview:
            options.source === 'sync'
              ? sql`CASE WHEN ${newer} THEN ${preview} ELSE ${chats.lastMessagePreview} END`
              : preview,
          messageCount: sql`${chats.messageCount} + 1`,
          // Unread count is managed by platform-native events (chat.unread-updated)
          updatedAt: new Date(),
        })
        .where(eq(chats.id, options.chatId));

      return created;
    });
  }

  /**
   * Build update data for missing fields from Baileys (source of truth)
   */
  private buildMissingFieldsUpdate(
    existing: Message,
    defaults: Omit<CreateMessageOptions, 'chatId' | 'externalId'>,
  ): Partial<NewMessage> | null {
    const updateData: Partial<NewMessage> = {};
    let hasUpdates = false;

    if (!existing.mediaUrl && defaults.mediaUrl) {
      updateData.mediaUrl = defaults.mediaUrl;
      hasUpdates = true;
    }
    if (!existing.mediaLocalPath && defaults.mediaLocalPath) {
      updateData.mediaLocalPath = defaults.mediaLocalPath;
      hasUpdates = true;
    }
    if (!existing.mediaMimeType && defaults.mediaMimeType) {
      updateData.mediaMimeType = defaults.mediaMimeType;
      hasUpdates = true;
    }
    if (!existing.transcription && defaults.transcription) {
      updateData.transcription = defaults.transcription;
      hasUpdates = true;
    }
    if (!existing.imageDescription && defaults.imageDescription) {
      updateData.imageDescription = defaults.imageDescription;
      hasUpdates = true;
    }
    if (!existing.videoDescription && defaults.videoDescription) {
      updateData.videoDescription = defaults.videoDescription;
      hasUpdates = true;
    }
    if (!existing.documentExtraction && defaults.documentExtraction) {
      updateData.documentExtraction = defaults.documentExtraction;
      hasUpdates = true;
    }

    return hasUpdates ? updateData : null;
  }

  /**
   * Find or create a message by external ID
   *
   * IMPORTANT: If message exists but has missing fields (e.g. mediaUrl was null in old sync),
   * this will UPDATE the existing message with data from Baileys (source of truth).
   * This ensures resyncs can recover incomplete messages.
   */
  async findOrCreate(
    chatId: string,
    externalId: string,
    defaults: Omit<CreateMessageOptions, 'chatId' | 'externalId'>,
  ): Promise<{ message: Message; created: boolean }> {
    const existing = await this.getByExternalId(chatId, externalId);

    if (existing) {
      // Check if Baileys has data that's missing in our DB (Baileys is source of truth)
      const updateData = this.buildMissingFieldsUpdate(existing, defaults);

      if (updateData) {
        const updated = await this.update(existing.id, updateData);
        return { message: updated, created: false };
      }

      return { message: existing, created: false };
    }

    const message = await this.create({
      chatId,
      externalId,
      ...defaults,
    });

    return { message, created: true };
  }

  /**
   * Update a message
   */
  async update(id: string, data: Partial<NewMessage>): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ ...sanitizeMediaText(data), updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  // =========================================================================
  // Edit Tracking
  // =========================================================================

  /**
   * Record a message edit
   */
  async recordEdit(
    id: string,
    newText: string,
    editedAt: Date,
    editedBy?: string,
    latestEventId?: string,
    history = false,
  ): Promise<Message> {
    const message = await this.getById(id);

    // Build edit history entry
    const editEntry: EditHistoryEntry = {
      text: newText,
      at: editedAt.toISOString(),
      by: editedBy,
    };

    // Get current edit history or initialize
    const currentHistory = (message.editHistory as EditHistoryEntry[]) ?? [];
    if (history && currentHistory.some((entry) => entry.at === editEntry.at && entry.text === newText)) return message;
    const newHistory = [...currentHistory, editEntry];
    if (history) newHistory.sort((a, b) => a.at.localeCompare(b.at));
    const keepLatest = history && message.editedAt && message.editedAt > editedAt;

    // If this is the first edit, save original text
    const originalText = message.editCount === 0 ? message.textContent : message.originalText;

    const [updated] = await this.db
      .update(messages)
      .set({
        textContent: keepLatest ? message.textContent : newText,
        status: (history && message.deletedAt ? 'deleted' : 'edited') as MessageStatus,
        editCount: message.editCount + 1,
        originalText,
        editHistory: newHistory,
        editedAt: keepLatest ? message.editedAt : editedAt,
        latestEventId: latestEventId ?? message.latestEventId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  // =========================================================================
  // Reactions
  // =========================================================================

  /**
   * Add a reaction to a message.
   *
   * On a WhatsApp channel (`whatsapp-baileys`, `whatsapp-business`) a user holds
   * one reaction per message, so the user's other emojis are dropped in the same
   * write that adds the new one. Every other channel (or no channel) keeps
   * stacking reactions per user.
   */
  async addReaction(
    id: string,
    reaction: Omit<ReactionInfo, 'at'>,
    latestEventId?: string,
    channel?: ChannelType,
    at?: Date,
  ): Promise<Message> {
    const message = await this.getById(id);

    const reactionEntry: ReactionInfo = {
      ...reaction,
      at: (at ?? new Date()).toISOString(),
    };

    // Get current reactions or initialize
    const storedReactions = (message.reactions as ReactionInfo[]) ?? [];
    const storedCounts = (message.reactionCounts as Record<string, number>) ?? {};

    // One reaction per user per message: the user's other emojis go away.
    const replacesPrevious = channel !== undefined && SINGLE_REACTION_PER_USER_CHANNELS.has(channel);
    const {
      kept: currentReactions,
      counts: currentCounts,
      dropped,
    } = replacesPrevious
      ? dropOtherEmojisOfUser(storedReactions, storedCounts, reaction.platformUserId, reaction.emoji)
      : { kept: storedReactions, counts: storedCounts, dropped: 0 };

    // Check if this user already has this reaction
    const existingIndex = currentReactions.findIndex(
      (r) => r.platformUserId === reaction.platformUserId && r.emoji === reaction.emoji,
    );

    if (existingIndex >= 0 && dropped === 0) {
      // Already exists, no change needed
      return message;
    }

    const newReactions = existingIndex >= 0 ? currentReactions : [...currentReactions, reactionEntry];

    // Update reaction counts
    const newCounts = { ...currentCounts };
    if (existingIndex < 0) {
      newCounts[reaction.emoji] = (newCounts[reaction.emoji] ?? 0) + 1;
    }

    const [updated] = await this.db
      .update(messages)
      .set({
        reactions: newReactions,
        reactionCounts: newCounts,
        latestEventId: latestEventId ?? message.latestEventId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  /**
   * Remove a reaction from a message.
   *
   * An empty `emoji` removes every reaction by that user — WhatsApp reports a
   * removal without saying which emoji went away.
   */
  async removeReaction(id: string, platformUserId: string, emoji: string, latestEventId?: string): Promise<Message> {
    const message = await this.getById(id);

    const currentReactions = (message.reactions as ReactionInfo[]) ?? [];
    const newReactions = currentReactions.filter(
      (r) => !(r.platformUserId === platformUserId && (emoji === '' || r.emoji === emoji)),
    );

    // Update reaction counts
    const currentCounts = (message.reactionCounts as Record<string, number>) ?? {};
    const newCounts = { ...currentCounts };
    for (const removed of currentReactions.filter((r) => !newReactions.includes(r))) {
      const count = (newCounts[removed.emoji] ?? 0) - 1;
      if (count > 0) {
        newCounts[removed.emoji] = count;
      } else {
        delete newCounts[removed.emoji];
      }
    }

    const [updated] = await this.db
      .update(messages)
      .set({
        reactions: newReactions,
        reactionCounts: Object.keys(newCounts).length > 0 ? newCounts : null,
        latestEventId: latestEventId ?? message.latestEventId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  // =========================================================================
  // Status Updates
  // =========================================================================

  /**
   * Move a message's delivery status forward along
   * `pending < sent < delivered < read`, in one guarded UPDATE.
   *
   * The guard lives in the WHERE clause, so two receipt consumers (delivered
   * and read run on separate durables) cannot race: a late, out-of-order or
   * redelivered receipt at or below the current status matches no row and
   * changes nothing, including `latestEventId`. `failed` sits outside the
   * order and keeps today's rules: `markDeliveryFailed` guards failures, and
   * a later receipt may still replace a `failed` status.
   *
   * @returns the updated message, or null when it is missing or already at or past `status`
   */
  async advanceDeliveryStatus(id: string, status: DeliveryStatus, latestEventId?: string): Promise<Message | null> {
    const atOrPast = DELIVERY_STATUS_AT_OR_PAST[status];
    const [updated] = await this.db
      .update(messages)
      .set({
        deliveryStatus: status,
        latestEventId,
        updatedAt: new Date(),
      })
      .where(
        atOrPast
          ? and(
              eq(messages.id, id),
              or(isNull(messages.deliveryStatus), notInArray(messages.deliveryStatus, [...atOrPast])),
            )
          : eq(messages.id, id),
      )
      .returning();

    return updated ?? null;
  }

  /**
   * Update delivery status (PATCH /messages/:id/delivery-status).
   *
   * Same monotonic rule as `advanceDeliveryStatus`. When the message is
   * already at or past `status` it is returned unchanged; that extra read
   * runs only on this manual path, never on the receipt consumers.
   */
  async updateDeliveryStatus(id: string, status: DeliveryStatus, latestEventId?: string): Promise<Message> {
    return (await this.advanceDeliveryStatus(id, status, latestEventId)) ?? this.getById(id);
  }

  /**
   * Mark an outbound message as failed (#1277).
   *
   * Only a message still `pending` / `sent` (or without a status) becomes
   * `failed`: a late or replayed failure never hides a `delivered` / `read`
   * the platform already reported. `latestEventId` points at the
   * `message.failed` event, which carries the error and error code.
   *
   * @returns the updated message, or null when its status was already past `sent`
   */
  async markDeliveryFailed(id: string, latestEventId?: string): Promise<Message | null> {
    const [updated] = await this.db
      .update(messages)
      .set({
        deliveryStatus: 'failed',
        latestEventId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.id, id),
          or(inArray(messages.deliveryStatus, ['pending', 'sent']), isNull(messages.deliveryStatus)),
        ),
      )
      .returning();

    return updated ?? null;
  }

  /**
   * Mark message as deleted
   */
  async markDeleted(id: string, latestEventId?: string, deletedAt = new Date()): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({
        status: 'deleted' as MessageStatus,
        deletedAt,
        latestEventId,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  /** Apply a history state change and its replay receipt in ONE row-locked transaction; no events. */
  async applyHistoryMutation(
    chatId: string,
    input: HistorySyncMutation,
    channel: ChannelType,
  ): Promise<'applied' | 'duplicate' | 'unmatched'> {
    const mutation = HistorySyncMutationSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.externalId, mutation.targetExternalId)))
        .limit(1)
        .for('update');
      if (!target) return 'unmatched';
      const raw = target.rawPayload ?? {};
      const receipts = Array.isArray(raw.historyMutationIds)
        ? raw.historyMutationIds.filter((id): id is string => typeof id === 'string')
        : [];
      const receipt = `${mutation.kind}:${mutation.id}:${mutation.actor}:${mutation.at.toISOString()}`;
      if (receipts.includes(receipt)) return 'duplicate';
      const parsedTimes = z.record(z.string().datetime()).safeParse(raw.historyReactionTimes);
      const times = parsedTimes.success ? parsedTimes.data : {};
      const currentReaction = (target.reactions ?? []).find((reaction) => reaction.platformUserId === mutation.actor);
      const latestReaction = times[mutation.actor] ?? currentReaction?.at;
      const stale = mutation.kind === 'reaction' && latestReaction && new Date(latestReaction) > mutation.at;
      const service = new MessageService(tx as unknown as Database, null);
      if (!stale) await service.applyHistoryChange(target, mutation, channel);
      const reactionTimes =
        mutation.kind === 'reaction' && !stale
          ? { historyReactionTimes: { ...times, [mutation.actor]: mutation.at.toISOString() } }
          : {};
      await tx
        .update(messages)
        .set({ rawPayload: { ...raw, ...reactionTimes, historyMutationIds: [...receipts, receipt] } })
        .where(eq(messages.id, target.id));
      return stale ? 'duplicate' : 'applied';
    });
  }

  private async applyHistoryChange(
    target: Message,
    mutation: HistorySyncMutation,
    channel: ChannelType,
  ): Promise<void> {
    if (mutation.kind === 'edit') {
      await this.recordEdit(target.id, mutation.text, mutation.at, mutation.actor, undefined, true);
    } else if (mutation.kind === 'deletion') {
      if (!target.deletedAt) await this.markDeleted(target.id, undefined, mutation.at);
    } else if (mutation.emoji) {
      await this.addReaction(
        target.id,
        { emoji: mutation.emoji, platformUserId: mutation.actor },
        undefined,
        channel,
        mutation.at,
      );
    } else {
      await this.removeReaction(target.id, mutation.actor, '');
    }
  }

  // =========================================================================
  // Pre-processed Content
  // =========================================================================

  /**
   * Update transcription for an audio message
   */
  async updateTranscription(id: string, transcription: string): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ transcription: sanitizeText(transcription) ?? '', updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  /**
   * Update image description
   */
  async updateImageDescription(id: string, description: string): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ imageDescription: sanitizeText(description) ?? '', updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  /**
   * Update video description
   */
  async updateVideoDescription(id: string, description: string): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ videoDescription: sanitizeText(description) ?? '', updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  /**
   * Update document extraction
   */
  async updateDocumentExtraction(id: string, extraction: string): Promise<Message> {
    const [updated] = await this.db
      .update(messages)
      .set({ documentExtraction: sanitizeText(extraction) ?? '', updatedAt: new Date() })
      .where(eq(messages.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError('Message', id);
    }

    return updated;
  }

  // =========================================================================
  // Reply Resolution
  // =========================================================================

  /**
   * Resolve reply-to message ID from external ID
   */
  async resolveReplyToMessage(chatId: string, replyToExternalId: string): Promise<string | null> {
    const [replyToMessage] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.externalId, replyToExternalId)))
      .limit(1);

    return replyToMessage?.id ?? null;
  }

  /**
   * Record that a message was starred / unstarred (#889).
   *
   * Called after the channel accepted the change, so the row reflects the
   * platform rather than an intent that may have failed.
   */
  async setStarred(chatId: string, externalId: string, starred: boolean): Promise<void> {
    await this.db
      .update(messages)
      .set({ starredAt: starred ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(messages.chatId, chatId), eq(messages.externalId, externalId)));
  }

  /** Record that a message was pinned / unpinned (#889). */
  async setPinned(chatId: string, externalId: string, pinned: boolean, pinnedBy?: string): Promise<void> {
    await this.db
      .update(messages)
      .set({
        pinnedAt: pinned ? new Date() : null,
        pinnedBy: pinned ? (pinnedBy ?? null) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(messages.chatId, chatId), eq(messages.externalId, externalId)));
  }

  /**
   * Cache a resolved permalink (#889).
   *
   * Permalinks are resolved lazily — one API call each, and almost no message
   * is ever linked to — so this is called on first use rather than at ingest.
   */
  async setPermalink(chatId: string, externalId: string, permalink: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ permalink, updatedAt: new Date() })
      .where(and(eq(messages.chatId, chatId), eq(messages.externalId, externalId)));
  }

  /**
   * Update reply-to message reference (when we later find the referenced message)
   */
  async updateReplyToReference(id: string, replyToMessageId: string): Promise<void> {
    await this.db.update(messages).set({ replyToMessageId, updatedAt: new Date() }).where(eq(messages.id, id));
  }

  /**
   * Point a thread reply at its root row (#889).
   *
   * 0048 added `thread_root_message_id` with nothing writing it — replies
   * carried only the platform `threadExternalId`, so joining a thread to its
   * root needed a second lookup by external id.
   */
  async setThreadRoot(id: string, threadRootMessageId: string): Promise<void> {
    await this.db.update(messages).set({ threadRootMessageId, updatedAt: new Date() }).where(eq(messages.id, id));
  }

  /**
   * Bump the denormalized reply bookkeeping on a thread root (#889).
   *
   * GREATEST guards out-of-order arrival: history sync can deliver an old
   * reply after a newer one, and it must not drag latestReplyAt backwards.
   */
  async recordThreadReply(rootMessageId: string, repliedAt: Date): Promise<void> {
    await this.db
      .update(messages)
      .set({
        replyCount: sql`${messages.replyCount} + 1`,
        latestReplyAt: sql`GREATEST(COALESCE(${messages.latestReplyAt}, ${repliedAt}), ${repliedAt})`,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, rootMessageId));
  }
}
