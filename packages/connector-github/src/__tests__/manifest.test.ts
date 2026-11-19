/**
 * GitHub manifest tests.
 *
 * No test touches GitHub: deliveries are built here and signed with a
 * synthetic secret. Covered here:
 *   - the manifest is events only and validate() never calls fetch;
 *   - `X-Hub-Signature-256` (`sha256=` + hex) verifies through the SDK;
 *   - issues and pull_request parse to the provisional names with the
 *     `X-GitHub-Delivery` id and a projection of ids and facts, no body text;
 *   - ping, unlisted events and a missing event header are acknowledged only;
 *   - the published payload schemas refuse extra keys and missing fields.
 */

import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { ConnectorDeliveryParseError, validateManifest, verifyDelivery } from '@omni/connector-sdk';
import { githubManifest } from '../manifest';
import { GITHUB_EVENT_NAMES, GitHubIssueEventPayloadSchema, GitHubPullRequestEventPayloadSchema } from '../types';

const SECRET = 'synthetic-github-hook-secret';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const BODY_TEXT = 'Body text that must never be published';

function issuesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    issue: {
      number: 7,
      title: 'Crash on start',
      state: 'open',
      html_url: 'https://github.com/example-org/example-repo/issues/7',
      user: { login: 'example-user', id: 1 },
      labels: [{ name: 'bug' }, { name: 'triage' }],
      body: BODY_TEXT,
    },
    repository: { full_name: 'example-org/example-repo', id: 2 },
    sender: { login: 'example-user' },
    ...overrides,
  };
}

function pullRequestBody(): Record<string, unknown> {
  return {
    action: 'closed',
    number: 12,
    pull_request: {
      number: 12,
      title: 'Fix the crash',
      state: 'closed',
      html_url: 'https://github.com/example-org/example-repo/pull/12',
      user: { login: 'example-user' },
      labels: [],
      merged: true,
      body: BODY_TEXT,
    },
    repository: { full_name: 'example-org/example-repo' },
    sender: { login: 'example-user' },
  };
}

function headers(event: string | undefined, delivery: string | null = DELIVERY): Record<string, string> {
  return {
    ...(event === undefined ? {} : { 'x-github-event': event }),
    ...(delivery === null ? {} : { 'x-github-delivery': delivery }),
  };
}

function parse(body: unknown, requestHeaders: Record<string, string>) {
  const parseDelivery = githubManifest.parseDelivery;
  if (!parseDelivery) throw new Error('githubManifest.parseDelivery is missing');
  return parseDelivery(typeof body === 'string' ? body : JSON.stringify(body), requestHeaders);
}

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const ISSUE_PAYLOAD = {
  deliveryId: DELIVERY,
  action: 'opened',
  repository: 'example-org/example-repo',
  number: 7,
  title: 'Crash on start',
  state: 'open',
  htmlUrl: 'https://github.com/example-org/example-repo/issues/7',
  author: 'example-user',
  labels: ['bug', 'triage'],
};

describe('GitHub manifest structure', () => {
  test('the registry accepts it: events only, no actions', () => {
    expect(validateManifest(githubManifest)).toEqual([]);
    expect(githubManifest.actions).toEqual([]);
    expect(githubManifest.events.map((event) => event.key)).toEqual(['issues', 'pull_request']);
  });

  test('the one credential field is optional and validate() never calls fetch', async () => {
    expect(githubManifest.credentialFields.every((field) => field.optional === true)).toBe(true);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error('validate must not call GitHub');
    }) as unknown as typeof fetch;
    expect(await githubManifest.validate({ credentials: {}, config: {}, fetch: fetchImpl })).toEqual({ ok: true });
    expect(calls).toBe(0);
  });
});

describe('X-Hub-Signature-256 verification', () => {
  test('a sha256= digest over the raw body verifies', async () => {
    const raw = JSON.stringify(issuesBody());
    expect(await verifyDelivery(githubManifest.verification, raw, { 'x-hub-signature-256': sign(raw) }, SECRET)).toBe(
      true,
    );
  });

  test('a bad digest, a missing header and a digest without the prefix are refused', async () => {
    const raw = JSON.stringify(issuesBody());
    const bare = sign(raw).slice('sha256='.length);
    for (const candidate of [
      { 'x-hub-signature-256': sign(raw, 'another-secret') },
      {},
      { 'x-hub-signature-256': bare },
    ]) {
      expect(await verifyDelivery(githubManifest.verification, raw, candidate, SECRET)).toBe(false);
    }
  });
});

describe('parseDelivery', () => {
  test('issues.opened is connector.github.issue.opened with the delivery id and ids and facts only', () => {
    expect(parse(issuesBody(), headers('issues'))).toEqual({
      eventKey: 'issues',
      eventType: 'connector.github.issue.opened',
      providerEventId: DELIVERY,
      data: ISSUE_PAYLOAD,
    });
  });

  test('a merged pull request is connector.github.pull_request.closed with merged true', () => {
    expect(parse(pullRequestBody(), headers('pull_request'))).toEqual({
      eventKey: 'pull_request',
      eventType: 'connector.github.pull_request.closed',
      providerEventId: DELIVERY,
      data: {
        deliveryId: DELIVERY,
        action: 'closed',
        repository: 'example-org/example-repo',
        number: 12,
        title: 'Fix the crash',
        state: 'closed',
        htmlUrl: 'https://github.com/example-org/example-repo/pull/12',
        author: 'example-user',
        labels: [],
        merged: true,
      },
    });
  });

  test('headers are matched case-insensitively', () => {
    const parsed = parse(issuesBody(), { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': DELIVERY });
    expect(parsed.eventType).toBe('connector.github.issue.opened');
    expect(parsed.providerEventId).toBe(DELIVERY);
  });

  test('body text never reaches the parsed delivery', () => {
    for (const [body, event] of [
      [issuesBody(), 'issues'],
      [pullRequestBody(), 'pull_request'],
    ] as const) {
      expect(JSON.stringify(parse(body, headers(event)))).not.toContain(BODY_TEXT);
    }
  });

  test('ping, an unlisted event and a missing X-GitHub-Event are acknowledged and never named', () => {
    const ping = { zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'Repository' } };
    expect(parse(ping, headers('ping'))).toEqual({ eventKey: 'ping', acknowledgeOnly: true, data: {} });
    expect(parse({ ref: 'refs/heads/main' }, headers('push'))).toEqual({
      eventKey: 'push',
      acknowledgeOnly: true,
      data: {},
    });
    expect(parse(issuesBody(), headers(undefined))).toEqual({ eventKey: 'unknown', acknowledgeOnly: true, data: {} });
  });

  test('a missing X-GitHub-Delivery, a malformed action and a non-JSON body are parse errors', () => {
    expect(() => parse(issuesBody(), headers('issues', null))).toThrow(ConnectorDeliveryParseError);
    expect(() => parse(issuesBody({ action: 'Opened Now' }), headers('issues'))).toThrow(ConnectorDeliveryParseError);
    expect(() => parse('payload=%7B%7D', headers('issues'))).toThrow(ConnectorDeliveryParseError);
  });

  test('a null author and missing labels are tolerated', () => {
    const body = issuesBody();
    const { labels: _labels, ...issue } = body.issue as Record<string, unknown>;
    expect(parse({ ...body, issue: { ...issue, user: null } }, headers('issues')).data).toMatchObject({
      author: null,
      labels: [],
    });
  });

  test('every published name is a GITHUB_EVENT_NAMES prefix plus the action', () => {
    for (const [body, event] of [
      [issuesBody(), 'issues'],
      [pullRequestBody(), 'pull_request'],
    ] as const) {
      const parsed = parse(body, headers(event));
      expect(parsed.eventType).toBe(`${GITHUB_EVENT_NAMES[event]}.${String(body.action)}`);
    }
  });
});

describe('published payload schemas', () => {
  test('the issue payload takes ids and facts and refuses body text or a missing field', () => {
    expect(GitHubIssueEventPayloadSchema.parse(ISSUE_PAYLOAD)).toEqual(ISSUE_PAYLOAD);
    const extra = GitHubIssueEventPayloadSchema.safeParse({ ...ISSUE_PAYLOAD, body: BODY_TEXT });
    expect(extra.success ? [] : extra.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
    const { title: _title, ...missing } = ISSUE_PAYLOAD;
    const absent = GitHubIssueEventPayloadSchema.safeParse(missing);
    expect(absent.success ? [] : absent.error.issues.map((issue) => issue.path.join('.'))).toEqual(['title']);
  });

  test('the pull-request payload requires merged and refuses body text', () => {
    const payload = { ...ISSUE_PAYLOAD, merged: false };
    expect(GitHubPullRequestEventPayloadSchema.parse(payload)).toEqual(payload);
    const noMerged = GitHubPullRequestEventPayloadSchema.safeParse(ISSUE_PAYLOAD);
    expect(noMerged.success ? [] : noMerged.error.issues.map((issue) => issue.path.join('.'))).toEqual(['merged']);
    const extra = GitHubPullRequestEventPayloadSchema.safeParse({ ...payload, body: BODY_TEXT });
    expect(extra.success ? [] : extra.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  });
});
