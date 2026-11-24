import type { ZenviaListedConversation } from '../types';
import { toSenderId, toZenviaPhone } from './identity';

export function normalizeConversationStatus(status: string): string {
  return status
    .trim()
    .toUpperCase()
    .replace(/^CONVERSATION_/, '');
}

function createdAtMs(conversation: ZenviaListedConversation): number {
  const parsed = Date.parse(conversation.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isOpenConversationOf(conversation: ZenviaListedConversation, contact: string, senderId: string): boolean {
  if (normalizeConversationStatus(conversation.status) === 'CLOSED') return false;
  if (conversation.channel?.toLowerCase() !== 'whatsapp') return false;
  if (!conversation.to || !conversation.from) return false;
  return toZenviaPhone(conversation.to) === contact && toSenderId(conversation.from) === senderId;
}

export function pickOpenConversation(
  conversations: readonly ZenviaListedConversation[],
  contact: string,
  senderId: string,
): ZenviaListedConversation | undefined {
  let picked: ZenviaListedConversation | undefined;
  for (const conversation of conversations) {
    if (!isOpenConversationOf(conversation, contact, senderId)) continue;
    if (!picked || createdAtMs(conversation) > createdAtMs(picked)) picked = conversation;
  }
  return picked;
}
