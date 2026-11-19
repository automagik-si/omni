/**
 * GitHub deliveries through the per-connector hook route, on the in-memory
 * connector harness and the shipped registry. No test touches GitHub: every
 * delivery is built and signed here with a synthetic hook secret.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { GITHUB_EVENT_NAMES } from '@omni/connector-github';
import { getTableName } from 'drizzle-orm';
import { connectorRegistry } from '../services/connector-registry';
import { ConnectorService } from '../services/connectors';
import { type ConnectorTestRow, createConnectorTestDb } from './connector-test-harness';
import { connectorHookBus } from './fixtures/events-only-connector';

const SECRET = 'synthetic-github-hook-secret';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const ISSUE_OPENED = `${GITHUB_EVENT_NAMES.issues}.opened`;
const BODY_TEXT = 'Body text that must never be published';

const ISSUES_BODY = JSON.stringify({
  action: 'opened',
  issue: {
    number: 7,
    title: 'Crash on start',
    state: 'open',
    html_url: 'https://github.com/example-org/example-repo/issues/7',
    user: { login: 'example-user' },
    labels: [{ name: 'bug' }],
    body: BODY_TEXT,
  },
  repository: { full_name: 'example-org/example-repo' },
  sender: { login: 'example-user' },
});

function signed(rawBody: string, event: string, secret = SECRET): Record<string, string> {
  return {
    'x-github-event': event,
    'x-github-delivery': DELIVERY,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  };
}

/**
 * The shared harness never conflicts on insert, while the real journal has a
 * unique idempotency index (proven on PostgreSQL in connector-hooks-postgres).
 * Mirror that one index here so a redelivery takes the duplicate branch.
 */
function uniqueJournalKeys(fixture: ReturnType<typeof createConnectorTestDb>): void {
  type Insert = (table: unknown) => { values: (row: ConnectorTestRow) => unknown };
  const db = fixture.db as unknown as { insert: Insert };
  const insert = db.insert;
  db.insert = (table) => {
    const builder = insert(table);
    if (getTableName(table as never) !== 'omni_events') return builder;
    return {
      values(row: ConnectorTestRow) {
        const taken = fixture.tables.omni_events.some((existing) => existing.idempotencyKey === row.idempotencyKey);
        if (!taken) return builder.values(row);
        const none = Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) });
        return Object.assign(none, { onConflictDoNothing: () => none });
      },
    };
  };
}

function setup(subscriptionKeys: readonly string[]) {
  const connectorId = crypto.randomUUID();
  const subscriptionIds = subscriptionKeys.map(() => crypto.randomUUID());
  const fixture = createConnectorTestDb({
    connectors: [{ id: connectorId, provider: 'github', hookSecret: SECRET, tenantId: null }],
    connector_event_subscriptions: subscriptionKeys.map((key, index) => ({
      id: subscriptionIds[index],
      connectorId,
      providerEventKey: key,
      ingress: 'connector',
      status: 'active',
      targetAutomationId: null,
      tenantId: null,
      filters: {},
      consecutiveFailures: 0,
    })),
  });
  uniqueJournalKeys(fixture);
  const transport = connectorHookBus();
  const service = new ConnectorService(fixture.db, transport.bus, connectorRegistry);
  const post = (rawBody: string, requestHeaders: Record<string, string>) =>
    service.receiveForConnector(connectorId, rawBody, requestHeaders);
  return { connectorId, subscriptionIds, fixture, transport, post };
}

describe('GitHub on the per-connector hook route', () => {
  test('a signed issues delivery publishes once, under the typed name, with ids and facts only', async () => {
    const { connectorId, subscriptionIds, fixture, transport, post } = setup([ISSUE_OPENED, 'connector.github.*']);
    const result = await post(ISSUES_BODY, signed(ISSUES_BODY, 'issues'));

    expect(result.status).toBe(202);
    expect(transport.events).toHaveLength(1);
    expect(transport.events[0]?.type).toBe('connector.github.issue.opened');
    expect(transport.events[0]?.payload).toEqual({
      deliveryId: DELIVERY,
      action: 'opened',
      repository: 'example-org/example-repo',
      number: 7,
      title: 'Crash on start',
      state: 'open',
      htmlUrl: 'https://github.com/example-org/example-repo/issues/7',
      author: 'example-user',
      labels: ['bug'],
      connectorId,
      subscriptionIds,
      targetAutomationIds: [],
    });
    expect(fixture.tables.omni_events).toHaveLength(1);
    expect(fixture.tables.omni_events[0]?.idempotencyKey).toBe(`connector:${connectorId}:${DELIVERY}`);
    expect(JSON.stringify(transport.events)).not.toContain(BODY_TEXT);
    expect(JSON.stringify(transport.events)).not.toContain(SECRET);
  });

  test('a bad or missing signature is the uniform 401 and nothing is journaled or published', async () => {
    const { fixture, transport, post } = setup(['connector.github.*']);
    const { 'x-hub-signature-256': _signature, ...unsigned } = signed(ISSUES_BODY, 'issues');

    for (const requestHeaders of [signed(ISSUES_BODY, 'issues', 'another-secret'), unsigned]) {
      expect((await post(ISSUES_BODY, requestHeaders)).status).toBe(401);
    }
    expect(fixture.tables.omni_events).toHaveLength(0);
    expect(transport.events).toHaveLength(0);
  });

  test('a redelivery with the same X-GitHub-Delivery is a 200 duplicate and publishes nothing', async () => {
    const { fixture, transport, post } = setup([ISSUE_OPENED]);
    const first = await post(ISSUES_BODY, signed(ISSUES_BODY, 'issues'));
    const replay = await post(ISSUES_BODY, signed(ISSUES_BODY, 'issues'));

    expect(first.status).toBe(202);
    expect(replay).toEqual({
      status: 200,
      body: { received: true, eventId: (first.body as { eventId: string }).eventId, duplicate: true },
    });
    expect(transport.events).toHaveLength(1);
    expect(fixture.tables.omni_events).toHaveLength(1);
  });

  test('ping is answered 2xx and never published, even under a connector.github.* glob', async () => {
    const { fixture, transport, post } = setup(['connector.github.*']);
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'Repository' } });

    expect(await post(ping, signed(ping, 'ping'))).toEqual({ status: 202, body: { received: true, ignored: true } });
    expect(fixture.tables.connectors[0]?.lastUnmatchedEventType).toBe('connector.github.ping');
    expect(fixture.tables.omni_events).toHaveLength(0);
    expect(transport.events).toHaveLength(0);
  });

  test('an unlisted event is acknowledged and never published, even under the glob', async () => {
    const { fixture, transport, post } = setup(['connector.github.*']);
    const push = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'example-org/example-repo' } });

    expect(await post(push, signed(push, 'push'))).toEqual({ status: 202, body: { received: true, ignored: true } });
    expect(fixture.tables.connectors[0]?.lastUnmatchedEventType).toBe('connector.github.push');
    expect(fixture.tables.omni_events).toHaveLength(0);
    expect(transport.events).toHaveLength(0);
  });
});
