import type { CoreEventType } from '@omni/core';
import { omniEvents } from '@omni/db';
import { type SQL, and, inArray, not, or, sql } from 'drizzle-orm';
import { isAdminTierKey } from '../lib/key-agent';
import type { ApiKeyData } from '../types';

export const CHANGE_JOURNAL_FAMILIES = ['access', 'chat', 'identity', 'person', 'instance'] as const;
type Family = (typeof CHANGE_JOURNAL_FAMILIES)[number];
type FamilyEvent = Extract<CoreEventType, `${Family}.${string}`>;
type Visibility = 'never' | 'full-access' | 'normal';

/** Provisional vocabulary and conservative owner defaults (#1738). Change rulings here only. */
export const CHANGE_JOURNAL_POLICY = {
  'access.allowed': 'never',
  'access.denied': 'never',
  'access.pairing_requested': 'never', // Contains a credential.
  'access.pairing_approved': 'full-access',
  'access.owner_claimed': 'full-access',
  'access.owner_whatsapp_linked': 'full-access',
  'access.device_code_approved': 'full-access',
  'access.device_authorized': 'full-access',
  'access.connect_link_issued': 'full-access',
  'access.key_minted': 'full-access',
  'access.key_revoked': 'full-access',
  'access.key_updated': 'full-access',
  'access.rule_created': 'normal',
  'access.rule_updated': 'normal',
  'access.rule_deleted': 'normal',
  'chat.created': 'normal',
  'chat.updated': 'normal',
  'chat.deleted': 'normal',
  'chat.archived': 'normal',
  'chat.idle_timeout': 'full-access',
  'chat.handoff_activated': 'full-access',
  'chat.closed': 'full-access',
  'identity.created': 'full-access',
  'identity.linked': 'full-access',
  'identity.merged': 'full-access',
  'identity.unlinked': 'full-access',
  'person.created': 'normal',
  'person.updated': 'normal',
  'person.merged': 'normal',
  'instance.connected': 'full-access',
  'instance.disconnected': 'full-access', // Free-text reason.
  'instance.qr_code': 'never', // Contains a credential.
  'instance.updated': 'normal',
} as const satisfies Record<FamilyEvent, Visibility>;

export interface JournalReader {
  instanceIds: readonly string[] | null;
  fullAccess: boolean;
}

/** Full access uses the existing owner-tier rule: literal wildcard scope AND no instance restriction. */
export function journalReader(key: Pick<ApiKeyData, 'scopes' | 'instanceIds'> | undefined): JournalReader {
  return { instanceIds: key?.instanceIds ?? null, fullAccess: key ? isAdminTierKey(key) : true };
}

export function changeJournalVisibility(eventType: string): Visibility | undefined {
  if (!CHANGE_JOURNAL_FAMILIES.some((family) => eventType.startsWith(`${family}.`))) return undefined;
  // Unknown family types stay off the journal until explicitly classified.
  return CHANGE_JOURNAL_POLICY[eventType as FamilyEvent] ?? 'never';
}

/** Also excludes forbidden rows if one was journaled by an older writer. */
export function journalVisibilityClause(reader?: JournalReader): SQL | undefined {
  const excluded = Object.entries(CHANGE_JOURNAL_POLICY)
    .filter(
      ([, policy]) => policy === 'never' || (policy === 'full-access' && reader !== undefined && !reader.fullAccess),
    )
    .map(([type]) => type as FamilyEvent);
  return and(
    not(inArray(omniEvents.eventType, excluded)),
    reader?.instanceIds === null || reader?.instanceIds === undefined
      ? undefined
      : reader.instanceIds.length
        ? inArray(omniEvents.instanceId, [...reader.instanceIds])
        : sql`false`,
  );
}

/** New journal families are notifications, never replay commands. Custom/connector replay is unchanged. */
export function changeJournalReplayExclusion(): SQL {
  return not(or(...CHANGE_JOURNAL_FAMILIES.map((family) => sql`${omniEvents.eventType} like ${`${family}.%`}`)) as SQL);
}
