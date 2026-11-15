/**
 * The two-responder detector's rule (services/two-responders.ts): which instances an Omni agent and a
 * durable consumer's reader may both answer. Pure: rows in, flagged instances out.
 */

import { describe, expect, test } from 'bun:test';
import { ACTIVE_CONSUMER_WINDOW_MS, type DetectInput, detectTwoResponders } from '../two-responders';

type InstanceRow = DetectInput['instances'][number];
type ConsumerRow = DetectInput['consumers'][number];
type KeyRow = DetectInput['keys'] extends ReadonlyMap<string, infer K> ? K : never;

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

function instance(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: INSTANCE,
    name: 'support-line',
    channel: 'whatsapp-baileys',
    tenantId: null,
    agentId: AGENT,
    agentName: 'helper',
    agentActive: true,
    triggerEvents: null,
    ...overrides,
  };
}

function consumer(overrides: Partial<ConsumerRow> = {}): ConsumerRow {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'app-inbox',
    tenantId: null,
    eventType: 'message.received',
    excludeTypes: null,
    scoped: false,
    instanceIds: null,
    agentId: null,
    ownerKeyId: null,
    accessFilter: 'all',
    updatedAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

function key(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    status: 'active',
    expiresAt: null,
    scopes: ['events:consume', 'messages:send'],
    instanceIds: null,
    ...overrides,
  };
}

function detect(overrides: Partial<DetectInput> = {}) {
  return detectTwoResponders({
    instances: [instance()],
    consumers: [consumer()],
    keys: new Map(),
    agentActive: new Map(),
    caller: { tenantId: null, instanceIds: null },
    now: NOW,
    ...overrides,
  });
}

const flaggedNames = (result: ReturnType<typeof detect>) =>
  result.map((row) => [row.instanceName, row.consumers.map((c) => c.name)]);

describe('flagged', () => {
  test('an agent instance and a matching consumer with no recorded owner key', () => {
    expect(detect()).toEqual([
      {
        instanceId: INSTANCE,
        instanceName: 'support-line',
        channel: 'whatsapp-baileys',
        agentId: AGENT,
        agentName: 'helper',
        consumers: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            name: 'app-inbox',
            eventType: 'message.received',
            lastMovedAt: new Date(NOW - 60_000).toISOString(),
            reader: 'unrecorded',
            ownerKeyId: null,
            agentId: null,
            sameAgent: false,
          },
        ],
      },
    ]);
  });

  test('a scoped consumer of this instance whose owner key may send here', () => {
    const result = detect({
      consumers: [consumer({ scoped: true, instanceIds: [INSTANCE], ownerKeyId: KEY })],
      keys: new Map([[KEY, key({ instanceIds: [INSTANCE] })]]),
    });
    expect(result[0]?.consumers[0]).toMatchObject({ reader: 'owner-key', ownerKeyId: KEY });
  });

  for (const scopes of [['*'], ['messages:*'], ['messages:send']]) {
    test(`an owner key with ${scopes.join(',')} may send`, () => {
      const result = detect({
        consumers: [consumer({ ownerKeyId: KEY })],
        keys: new Map([[KEY, key({ scopes })]]),
      });
      expect(result).toHaveLength(1);
    });
  }

  for (const eventType of ['message.received', 'message.*', 'message*', '*']) {
    test(`a type filter of ${eventType} receives message.received`, () => {
      expect(detect({ consumers: [consumer({ eventType })] })).toHaveLength(1);
    });
  }

  test("the instance's own trigger types decide what the consumer must receive", () => {
    const result = detect({
      instances: [instance({ triggerEvents: ['reaction.received'] })],
      consumers: [consumer({ name: 'messages' }), consumer({ name: 'reactions', eventType: 'reaction.*' })],
    });
    expect(flaggedNames(result)).toEqual([['support-line', ['reactions']]]);
  });

  test("an agent-owned consumer of the instance's own agent: one agent, two paths", () => {
    const result = detect({
      consumers: [consumer({ agentId: AGENT })],
      agentActive: new Map([[AGENT, true]]),
    });
    expect(result[0]?.consumers[0]).toMatchObject({ reader: 'owning-agent', agentId: AGENT, sameAgent: true });
  });

  test('an agent-owned consumer of another active agent', () => {
    const result = detect({
      consumers: [consumer({ agentId: OTHER_AGENT })],
      agentActive: new Map([[OTHER_AGENT, true]]),
    });
    expect(result[0]?.consumers[0]).toMatchObject({ reader: 'owning-agent', sameAgent: false });
  });

  test('an allowed-only consumer', () => {
    expect(detect({ consumers: [consumer({ accessFilter: 'allowed' })] })).toHaveLength(1);
  });
});

describe('not flagged', () => {
  test('an agent instance with no consumer', () => {
    expect(detect({ consumers: [] })).toEqual([]);
  });

  test('a consumer on an instance with no agent bound (the loader reads only bound instances)', () => {
    expect(detect({ instances: [] })).toEqual([]);
  });

  test('an instance whose agent is inactive', () => {
    expect(detect({ instances: [instance({ agentActive: false })] })).toEqual([]);
  });

  test('an inactive consumer: updated_at older than the window', () => {
    const stale = new Date(NOW - ACTIVE_CONSUMER_WINDOW_MS - 1);
    const edge = new Date(NOW - ACTIVE_CONSUMER_WINDOW_MS);
    expect(detect({ consumers: [consumer({ updatedAt: stale })] })).toEqual([]);
    expect(detect({ consumers: [consumer({ updatedAt: edge })] })).toHaveLength(1);
  });

  test('a consumer scoped to another instance', () => {
    expect(
      detect({
        consumers: [consumer({ scoped: true, instanceIds: [OTHER_INSTANCE], ownerKeyId: KEY })],
        keys: new Map([[KEY, key()]]),
      }),
    ).toEqual([]);
  });

  test('a consumer whose type filter or exclude list misses the trigger type', () => {
    expect(detect({ consumers: [consumer({ eventType: 'reaction.received' })] })).toEqual([]);
    expect(detect({ consumers: [consumer({ eventType: 'message.*', excludeTypes: ['message.rec*'] })] })).toEqual([]);
  });

  test('a denied-only consumer: the dispatcher never answers a denied message', () => {
    expect(detect({ consumers: [consumer({ accessFilter: 'denied' })] })).toEqual([]);
  });

  describe('a consumer whose key cannot send on the instance', () => {
    const cases: [string, Partial<KeyRow>][] = [
      ['no messages:send', { scopes: ['events:consume', 'messages:write', 'messages:read'] }],
      ['restricted to another instance', { instanceIds: [OTHER_INSTANCE] }],
      ['revoked', { status: 'revoked' }],
      ['expired', { expiresAt: new Date(NOW - 1) }],
    ];
    for (const [name, overrides] of cases) {
      test(name, () => {
        const result = detect({
          consumers: [consumer({ ownerKeyId: KEY })],
          keys: new Map([[KEY, key(overrides)]]),
        });
        expect(result).toEqual([]);
      });
    }
    test('an owner key that no longer exists', () => {
      expect(detect({ consumers: [consumer({ ownerKeyId: KEY })] })).toEqual([]);
    });
  });

  test('an agent-owned consumer whose agent is inactive, with or without an owner key', () => {
    const agentActive = new Map([[OTHER_AGENT, false]]);
    expect(detect({ consumers: [consumer({ agentId: OTHER_AGENT })], agentActive })).toEqual([]);
    expect(
      detect({
        consumers: [consumer({ agentId: OTHER_AGENT, ownerKeyId: KEY })],
        keys: new Map([[KEY, key()]]),
        agentActive,
      }),
    ).toEqual([]);
  });
});

describe('tenant boundary and instance restriction', () => {
  const both = [
    instance({ id: INSTANCE, name: 'tenant-a-line', tenantId: TENANT_A }),
    instance({ id: OTHER_INSTANCE, name: 'tenant-b-line', tenantId: TENANT_B }),
  ];

  test('a legacy unrestricted caller sees every flagged instance', () => {
    expect(flaggedNames(detect({ instances: both }))).toEqual([
      ['tenant-a-line', ['app-inbox']],
      ['tenant-b-line', ['app-inbox']],
    ]);
  });

  test("a tenant caller sees only its own tenant's instances and consumers", () => {
    const result = detect({
      instances: both,
      consumers: [consumer({ name: 'unstamped' }), consumer({ name: 'stamped-a', tenantId: TENANT_A })],
      caller: { tenantId: TENANT_A, instanceIds: null },
    });
    expect(flaggedNames(result)).toEqual([['tenant-a-line', ['stamped-a']]]);
  });

  test("a consumer stamped with one tenant never pages another tenant's instance", () => {
    const result = detect({ instances: both, consumers: [consumer({ tenantId: TENANT_B })] });
    expect(flaggedNames(result)).toEqual([['tenant-b-line', ['app-inbox']]]);
  });

  test('an instance-restricted caller sees only the instances its key allows', () => {
    const result = detect({ instances: both, caller: { tenantId: null, instanceIds: [OTHER_INSTANCE] } });
    expect(flaggedNames(result)).toEqual([['tenant-b-line', ['app-inbox']]]);
    expect(detect({ instances: both, caller: { tenantId: null, instanceIds: [] } })).toEqual([]);
  });
});
