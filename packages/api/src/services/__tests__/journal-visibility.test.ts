import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { changeJournalVisibility, journalReader, journalVisibilityClause } from '../journal-visibility';

describe('journal full-access boundary (#1738)', () => {
  test('requires a literal wildcard and no instance restriction', () => {
    expect(journalReader({ scopes: ['*'], instanceIds: null }).fullAccess).toBe(true);
    for (const key of [
      { scopes: ['events:*'], instanceIds: null },
      { scopes: ['events:read', 'events:write'], instanceIds: null },
      { scopes: ['*'], instanceIds: [] },
      { scopes: ['*'], instanceIds: ['instance'] },
    ])
      expect(journalReader(key).fullAccess).toBe(false);
  });

  test('credential types and unknown new-family types cannot enter the journal', () => {
    for (const type of [
      'access.pairing_requested',
      'instance.qr_code',
      'access.allowed',
      'access.denied',
      'access.future_type',
    ])
      expect(changeJournalVisibility(type)).toBe('never');
    expect(changeJournalVisibility('custom.record_changed')).toBeUndefined();
  });

  test('SQL blocks sensitive rows even on the caller instance and blocks all rows for an empty allow-list', () => {
    const dialect = new PgDialect();
    const limited = dialect.sqlToQuery(journalVisibilityClause({ fullAccess: false, instanceIds: ['instance'] })!);
    expect(limited.params).toContain('access.key_minted');
    expect(limited.params).toContain('access.device_authorized');
    expect(limited.params).toContain('instance');
    const full = dialect.sqlToQuery(journalVisibilityClause({ fullAccess: true, instanceIds: null })!);
    expect(full.params).not.toContain('access.key_minted');
    expect(full.params).toContain('instance.qr_code');
    expect(dialect.sqlToQuery(journalVisibilityClause({ fullAccess: false, instanceIds: [] })!).sql).toContain('false');
  });
});
