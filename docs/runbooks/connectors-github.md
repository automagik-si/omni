# GitHub connector runbook

This is the **connector** path for GitHub: events only, received on the
per-connector hook route (RFC-0003). Omni makes no GitHub API call, holds no
GitHub credential and has no GitHub actions. It coexists with
[`github-webhook-source.md`](./github-webhook-source.md), the credential-less
webhook-source preset that publishes `custom.github.*`; that preset is
unchanged.

## 1. Create the connector with a hook secret

Pick a random secret (8-512 characters). GitHub and Omni must hold the same
value. Pass it on stdin so it stays out of shell history:

```bash
printf '%s' "$GITHUB_HOOK_SECRET" | omni connectors create \
  --provider github \
  --name "GitHub" \
  --hook-secret-stdin
```

No credentials are needed and nothing is validated against GitHub. The
manifest declares one optional `token` field only because the connector registry
requires at least one credential field; leave it empty.

The secret is sealed and never returned. To rotate it, run
`omni connectors update <connector-id> --hook-secret-stdin`, then update the
GitHub copy. Deliveries signed with the old secret get `401` until both match.

## 2. Add the webhook in GitHub

Repository or organization **Settings → Webhooks → Add webhook**:

| Field | Value |
| --- | --- |
| Payload URL | `<public-url>/api/v2/connectors/hooks/<connector-id>` |
| Content type | `application/json` |
| Secret | the hook secret from step 1 |
| Events | "Let me select individual events": **Issues** and **Pull requests** |

Use `application/json`. A form-encoded body still verifies, but it is not
parsed: it is acknowledged and counted as `connector.github.unparsed`.

Use the per-connector hook route only. The per-subscription route
(`/api/v2/connectors/events/<subscription-id>`) publishes the legacy
`connector.event` envelope and is not supported for GitHub.

When the webhook is saved, GitHub sends a `ping`. Omni answers `202` and
publishes nothing.

## 3. Events and their provisional names

| `X-GitHub-Event` | Published name |
| --- | --- |
| `issues` | `connector.github.issue.<action>` (for example `connector.github.issue.opened`) |
| `pull_request` | `connector.github.pull_request.<action>` (for example `connector.github.pull_request.closed`) |

**These names are provisional.** The event vocabulary has no owner yet, so
they may be renamed. Every name comes from the one exported map
`GITHUB_EVENT_NAMES` in `packages/connector-github/src/types.ts`, so a rename
is one edit there. Automations and subscriptions that name them then need the
same update.

`<action>` is GitHub's own action (`opened`, `closed`, `labeled`,
`ready_for_review`, ...). A merged pull request is `pull_request.closed` with
`merged: true`; GitHub has no `merged` action.

Every other event (`ping`, `push`, `release`, ...) is answered
`202 {received: true, ignored: true}` and never published, even under a
`connector.github.*` glob subscription. The connector records it as unmatched:
`totalUnmatched` goes up and `lastUnmatchedEventType` names it (for example
`connector.github.push`).

Each published payload carries ids and facts only, never body text:
`deliveryId`, `action`, `repository` (`owner/repo`), `number`, `title`,
`state`, `htmlUrl`, `author` (login, or `null`), `labels` (names), plus
`merged` for pull requests. Ingress adds `connectorId`, `subscriptionIds` and
`targetAutomationIds`.

## 4. Subscribe

A delivery is published only when at least one subscription on the connector
matches its name.

Target one automation with an exact name. The automation's trigger must be the
same name:

```bash
omni connectors subscriptions add <connector-id> \
  --ingress connector \
  --event connector.github.pull_request.closed \
  --automation <automation-id>
```

Or record every typed GitHub event with a glob and no target:

```bash
omni connectors subscriptions add <connector-id> --ingress connector --event 'connector.github.*'
```

Filters match payload fields, for example
`--filters-json '{"repository":"example-org/example-repo","merged":true}'`.

## 5. Replay and redelivery

`X-GitHub-Delivery` is the idempotent id. A GitHub redelivery ("Redeliver" in
the webhook's Recent Deliveries) is a `200` duplicate: no second journal row,
no second publish.

## Failure legend

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `401` on delivery | bad or missing `X-Hub-Signature-256`, or an unknown connector | make the GitHub secret and the connector hook secret equal |
| `202 ignored` | ping, an event this connector does not publish, an unparsable body, or no matching subscription | read `lastUnmatchedEventType` on the connector |
| `lastUnmatchedEventType` is `connector.github.unparsed` | the body was not JSON or lacked a required field or `X-GitHub-Delivery` | set the content type to `application/json` |
| `200 duplicate` | the same `X-GitHub-Delivery` arrived again | nothing to fix |
| `500` on delivery | publishing failed; the claim was released | redeliver from GitHub once the bus is healthy |
