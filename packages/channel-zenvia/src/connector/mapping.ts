import type { ConnectorContact, ConnectorEvent, ConnectorHistoryEntry } from './types';

export const CONNECTOR_DEFAULT_COUNTRY_CODE = '55';

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(['sem nome']);

export function connectorConversationId(event: ConnectorEvent): string | undefined {
  const value = event.conversationId ?? event.conversationID;
  return value?.trim() || undefined;
}

export function connectorPhone(phone: string | undefined): string | undefined {
  const digits = phone?.replace(/\D/g, '') ?? '';
  if (!digits) return undefined;
  if (digits.length === 10 || digits.length === 11) return `${CONNECTOR_DEFAULT_COUNTRY_CODE}${digits}`;
  return digits;
}

export function connectorChatId(contact: ConnectorContact | undefined, identifier: string | undefined): string {
  return connectorPhone(contact?.phone) ?? identifier?.trim() ?? '';
}

export function connectorContactName(contact: ConnectorContact | undefined): string | undefined {
  const name = contact?.name?.trim();
  if (!name || PLACEHOLDER_NAMES.has(name.toLowerCase())) return undefined;
  return name;
}

export function joinConnectorTexts(values: readonly unknown[] | undefined): string {
  return (values ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function isUserEntry(entry: ConnectorHistoryEntry): boolean {
  return entry.sender?.toLowerCase() === 'user';
}

export function userTextsAfterLastBot(history: readonly ConnectorHistoryEntry[] | undefined): string {
  if (!history || history.length === 0) return '';
  let start = 0;
  history.forEach((entry, index) => {
    if (!isUserEntry(entry)) start = index + 1;
  });
  return joinConnectorTexts(history.slice(start).map((entry) => entry.message));
}

export function connectorTimestampMs(event: ConnectorEvent): number {
  const raw = typeof event.timestamp === 'string' ? Number(event.timestamp) : event.timestamp;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return Date.now();
  return raw < 1e12 ? raw * 1000 : raw;
}
