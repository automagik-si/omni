# @omni/connector-github

GitHub connector for Omni, **events only**: GitHub webhook deliveries for issues
and pull requests become typed `connector.github.*` events. Omni makes no GitHub
API call, so the manifest has no actions and no egress. **GitHub is not a
channel and does not send or receive chat messages.**

This connector is separate from the credential-less GitHub webhook-source preset
(`custom.github.*`, see `docs/runbooks/github-webhook-source.md`), which stays as
it is.

## Connect

1. Create the connector with a hook secret and no credentials. The secret is
   read from stdin, so it stays out of shell history:

   ```bash
   printf '%s' "$HOOK_SECRET" | omni connectors create --provider github --name "GitHub" --hook-secret-stdin
   ```

2. In GitHub, add a webhook on the repository or organization:
   - **Payload URL:** `https://<omni-host>/api/v2/connectors/hooks/<connectorId>`
   - **Content type:** `application/json`
   - **Secret:** the same hook secret
   - **Events:** Issues and Pull requests

The manifest declares one optional `token` credential field. It is unused: the
connector registry requires at least one credential field, and this connector
never calls GitHub. Leave it empty.

Use the per-connector hook route only. The per-subscription route
(`/connectors/events/:subscriptionId`) publishes the legacy `connector.event`
envelope and is not supported for GitHub.

## Events

| `X-GitHub-Event` | Published name                              |
| ---------------- | ------------------------------------------- |
| `issues`         | `connector.github.issue.<action>`           |
| `pull_request`   | `connector.github.pull_request.<action>`    |

**The names are provisional.** They all come from the one exported map
`GITHUB_EVENT_NAMES`, so a rename is one edit. A merged pull request is
`connector.github.pull_request.closed` with `merged: true`; GitHub has no
`merged` action.

`ping` and every other event are answered `202 {received: true, ignored: true}`
and never published. The connector records them as unmatched under their name
(`connector.github.ping`, `connector.github.push`).

## Payload

Ids and facts only, validated with Zod (`GitHubIssueEventPayloadSchema`,
`GitHubPullRequestEventPayloadSchema`). Issue and pull-request body text is
never read.

```json
{
  "deliveryId": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  "action": "opened",
  "repository": "example-org/example-repo",
  "number": 7,
  "title": "Crash on start",
  "state": "open",
  "htmlUrl": "https://github.com/example-org/example-repo/issues/7",
  "author": "example-user",
  "labels": ["bug"]
}
```

Pull requests add `merged` (boolean). `author` is `null` when GitHub sends no
user. Ingress adds `connectorId`, `subscriptionIds` and `targetAutomationIds`.

## Verification and replay

GitHub signs the raw body with HMAC-SHA256 in `X-Hub-Signature-256`
(`sha256=` + lowercase hex). A bad or missing signature is a `401` and nothing
is journaled. `X-GitHub-Delivery` is the idempotent id: a redelivery is a `200`
duplicate with no second publish.
