/**
 * GitHub connector manifest: events only.
 *
 * A GitHub webhook posts to the per-connector hook route
 * (`POST /api/v2/connectors/hooks/:connectorId`, RFC-0003) and signs the raw
 * body with the connector hook secret in `X-Hub-Signature-256`. `issues` and
 * `pull_request` deliveries are published under the provisional names in
 * `GITHUB_EVENT_NAMES`; `ping` and every other event are acknowledged with a
 * 2xx and never published. Omni makes no GitHub API call, so the manifest has
 * no actions and validate() touches no network.
 */

import { ConnectorDeliveryParseError, type ConnectorManifest, type ConnectorParsedDelivery } from '@omni/connector-sdk';
import { z } from 'zod';
import {
  GITHUB_EVENT_NAMES,
  GitHubIssueEventPayloadSchema,
  GitHubIssuesDeliverySchema,
  type GitHubPublishedEvent,
  GitHubPullRequestDeliverySchema,
  GitHubPullRequestEventPayloadSchema,
} from './types';

const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value.length > 0) return value;
  }
  return undefined;
}

function isPublished(event: string | undefined): event is GitHubPublishedEvent {
  return event !== undefined && Object.hasOwn(GITHUB_EVENT_NAMES, event);
}

function bodyOf<T>(schema: z.ZodType<T>, rawBody: string, event: GitHubPublishedEvent): T {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ConnectorDeliveryParseError(
      'GitHub delivery body is not JSON; set the webhook content type to application/json.',
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ConnectorDeliveryParseError(
      `GitHub ${event} delivery is missing fields: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** The facts an issue and a pull request share; never the body text. */
function facts(item: z.infer<typeof GitHubIssuesDeliverySchema>['issue']) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    htmlUrl: item.html_url,
    author: item.user?.login ?? null,
    labels: (item.labels ?? []).map((label) => label.name),
  };
}

export const githubManifest: ConnectorManifest = {
  id: 'github',
  label: 'GitHub',
  version: '1.0.0',
  // Unused: the connector makes no GitHub API call. It exists only because
  // validateManifest requires at least one credential field. The delivery
  // secret is the connector hook secret, not a credential.
  credentialFields: [
    {
      key: 'token',
      label: 'Unused (events only)',
      secret: true,
      optional: true,
      help: 'Leave empty. This connector only receives webhook deliveries and never calls the GitHub API.',
    },
  ],
  configSchema: z.object({}).strict(),

  async validate() {
    return { ok: true as const };
  },

  events: [
    {
      key: 'issues',
      label: 'Issues (connector.github.issue.<action>)',
      sample: {
        action: 'opened',
        issue: {
          number: 7,
          title: 'Crash on start',
          state: 'open',
          html_url: 'https://github.com/example-org/example-repo/issues/7',
          user: { login: 'example-user' },
          labels: [{ name: 'bug' }],
        },
        repository: { full_name: 'example-org/example-repo' },
      },
    },
    {
      key: 'pull_request',
      label: 'Pull requests (connector.github.pull_request.<action>)',
      sample: {
        action: 'closed',
        pull_request: {
          number: 12,
          title: 'Fix the crash',
          state: 'closed',
          html_url: 'https://github.com/example-org/example-repo/pull/12',
          user: { login: 'example-user' },
          labels: [],
          merged: true,
        },
        repository: { full_name: 'example-org/example-repo' },
      },
    },
  ],

  actions: [],

  verification: {
    kind: 'hmac-sha256',
    header: 'X-Hub-Signature-256',
    encoding: 'hex',
    prefix: 'sha256=',
  },

  parseDelivery(rawBody, headers): ConnectorParsedDelivery {
    const event = header(headers, EVENT_HEADER);
    if (!isPublished(event)) {
      // `ping`, every unlisted event and a delivery with no event header.
      return { eventKey: event ?? 'unknown', acknowledgeOnly: true, data: {} };
    }
    const deliveryId = header(headers, DELIVERY_HEADER);
    if (!deliveryId) throw new ConnectorDeliveryParseError('GitHub delivery has no X-GitHub-Delivery id.');

    if (event === 'issues') {
      const body = bodyOf(GitHubIssuesDeliverySchema, rawBody, event);
      return {
        eventKey: event,
        eventType: `${GITHUB_EVENT_NAMES.issues}.${body.action}`,
        providerEventId: deliveryId,
        data: GitHubIssueEventPayloadSchema.parse({
          deliveryId,
          action: body.action,
          repository: body.repository.full_name,
          ...facts(body.issue),
        }),
      };
    }

    const body = bodyOf(GitHubPullRequestDeliverySchema, rawBody, event);
    return {
      eventKey: event,
      eventType: `${GITHUB_EVENT_NAMES.pull_request}.${body.action}`,
      providerEventId: deliveryId,
      data: GitHubPullRequestEventPayloadSchema.parse({
        deliveryId,
        action: body.action,
        repository: body.repository.full_name,
        ...facts(body.pull_request),
        merged: body.pull_request.merged === true,
      }),
    };
  },

  guide: {
    connect:
      'Create the connector with a hook secret (8-512 characters) and no credentials. Omni makes no GitHub API call, so nothing is validated against GitHub.',
    webhook:
      'In GitHub: Settings → Webhooks → Add webhook. Payload URL: the connector hook URL (/api/v2/connectors/hooks/<connectorId>). Content type: application/json. Secret: the same hook secret. Events: Issues and Pull requests.',
    events:
      'issues → connector.github.issue.<action>; pull_request → connector.github.pull_request.<action>. A merge is pull_request.closed with merged: true. These names are provisional.',
    ping: 'GitHub’s ping and every other event are answered 202 and never published; the connector records them as unmatched.',
    replay: 'Omni dedupes redeliveries by X-GitHub-Delivery.',
    error401: '401 means the signature did not verify: the GitHub webhook secret and the connector hook secret differ.',
  },
};
