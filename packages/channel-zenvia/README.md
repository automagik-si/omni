# @omni/channel-zenvia

WhatsApp channel plugin for **Zenvia** (`https://api.zenvia.com/v2`), an
official Meta BSP with its own API format (not a Cloud API mirror).

## How it maps to the API

- **Outbound** — `POST /v2/channels/whatsapp/messages` with
  `{ from, to, contents: [...] }`. `from` is the instance's sender id; `to`
  is the contact's digits-only number.
- **Inbound** — Zenvia subscriptions (`POST /v2/subscriptions`) deliver JSON
  events to the per-instance webhook. Every event is validated with Zod
  (`src/types.ts`) before it reaches the plugin.
- **Auth** — the static `X-API-TOKEN` header on every call.
- **Normalization** — consumers should not need to know which BSP carried a
  message:
  - the contact profile name is `senderName` (and `rawPayload.pushName`);
  - inbound files surface as `mediaId` and are materialized by
    `downloadInboundMedia`, behind the SDK download guard. Redirects are
    followed by hand (at most 5): every hop must be https to a named host (no
    IP literal, no localhost), and the token goes only to Zenvia hosts and is
    dropped for good once a hop leaves them. Right before each request the
    host is resolved and the download is refused when any of its addresses is
    not public: loopback, private (RFC 1918), carrier-grade NAT, link-local
    (cloud metadata included), IPv6 unique local, multicast, unspecified,
    reserved ranges, or an IPv4 address mapped into IPv6. A host that does not
    resolve fails as a transient upstream error. The connection is pinned to
    the addresses that passed the check: the request goes to that IP (the next
    one when a connection fails), with the original `Host` header and the TLS
    server name set to the host, so the certificate is still verified against
    the name and a DNS answer that changes after the check (DNS rebinding)
    cannot redirect it. This relies on `fetch` of Bun 1.4.4 honoring
    `tls.serverName` for the certificate check, which was measured against a
    local TLS server (a wrong name is rejected) and against a public host with
    the system trust store. The timeout covers the body too;
  - a click-to-WhatsApp ad referral is exposed as `rawPayload.referral` in
    the Meta Cloud API shape (`source_type`, `source_id`, `source_url`,
    `headline`, `body`, `ctwa_clid`);
  - the original Zenvia message stays under `rawPayload.zenvia`.

## Instance config

| Key                     | Required | Notes                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `zenviaApiToken`        | yes      | `X-API-TOKEN` header of the Zenvia API v2. Sealed at rest.                                  |
| `zenviaSenderId`        | yes      | The sender registered at Zenvia (the WhatsApp number). A phone-like value (digits, `+`, spaces, parentheses, hyphens) or a JID is reduced to its digits; any other value is kept exactly as written. |
| `zenviaSalesApiKey`     | no       | Key of the Zenvia Sales APIs (`api-key` query parameter). **Not** the same token as above. Sealed at rest. With it a handoff transfers through the Sales API; without it, through the Conversations API with `zenviaApiToken`. |
| `zenviaHandoffGroupId`  | no       | Group dedicated to the chatbot that a handoff transfers to. Required for a transfer unless `zenviaHandoffRouting` is set; then it is the default group. |
| `zenviaHandoffRouting`  | no       | JSON `{ "field": "<handoffFields key>", "groups": { "<value>": "<groupId>" } }`: the value of that key picks the group (see Routing a handoff to a group). |
| `zenviaHandoffUserId`   | no       | A specific agent inside the chosen group.                                                   |
| `zenviaHandoffSolution` | no       | `conversion` \| `zenvia_chat` \| `nlu`. Fallback routing when there is no group to transfer to. |
| `webhookVerifyToken`    | yes      | Shared secret every webhook POST must carry, as the `x-webhook-token` header or the `token` query parameter. Zenvia signs nothing, so an instance does not connect without it. |

To wire up the webhook, create the subscriptions with that URL. Put the
verify token in the subscription's fixed headers:

```json
{
  "eventType": "MESSAGE",
  "webhook": {
    "url": "{OMNI_BASE_URL}/api/v2/channels/zenvia/{instanceId}/webhook",
    "headers": { "x-webhook-token": "<webhookVerifyToken>" }
  },
  "criteria": { "channel": "whatsapp", "direction": "IN" }
}
```

Create one subscription per event type (`MESSAGE`, `MESSAGE_STATUS` and
`CONVERSATION_STATUS`).

Where Zenvia takes only a URL and no headers (the sandbox webhook of the
*Testes em Sandbox* screen), put the token in the URL instead:
`{OMNI_BASE_URL}/api/v2/channels/zenvia/{instanceId}/webhook?token=<webhookVerifyToken>`.
The header wins when both are present, and both are compared in constant
time. Prefer the header wherever it can be set: a query string can end up in
the access logs of a proxy in front of Omni (Omni itself logs only the path).
In the sandbox the inbound `message.to` is the sandbox keyword, not a number,
so set `zenviaSenderId` to that keyword: it is kept exactly as written and
matches.

To rotate the verify token, send the new one as `webhookVerifyToken` in the body
of `POST /instances/{id}/connect`: it replaces the stored token and is
persisted once the connect succeeds. Without the field the stored token is
kept and nothing is rewritten. The other route is `PATCH /instances/{id}`
followed by a restart. Either way the token is sealed at rest and never
returned, and the `x-webhook-token` header (or `token` query parameter) of
every subscription must be updated to the same value: the webhook answers 401
until the two match.

The webhook answers 200 to every authenticated event it processed or
deliberately ignores, 401 to a missing or wrong token and 503 while the
instance is not connected (during a restart), so Zenvia can redeliver. An
inbound `MESSAGE` that could not be published to the event bus also answers
503: the message is not acknowledged, its id is not kept as seen, and the
redelivery is processed. A `MESSAGE_STATUS` (delivered, read, failed) that could
not be published answers 503 as well, so Zenvia redelivers it; the failure is
logged first. The plugin keeps no seen-set for statuses, so a redelivery
publishes the receipt again. That is safe because the persistence consumers
are idempotent: a `delivered` or `read` receipt only moves a message forward
and the first `deliveredAt`/`readAt` is kept, and a `failed` receipt never
overwrites a message already reported delivered or read. A
`CONVERSATION_STATUS` whose event could not be published answers 503 too; its
redelivery is safe because a takeover on a chat already paused changes
nothing. A payload that fails
validation is still acknowledged with 200, since redelivering it cannot help.
An inbound `MESSAGE` addressed to a different sender
of the same Zenvia account is acknowledged and dropped, so two instances on
one account never answer each other's contacts.

## Handoff

`POST /messages/send/handoff` has three modes, chosen by the instance config.
A group (`zenviaHandoffGroupId` and/or `zenviaHandoffRouting`) turns on the
transfer: through the Sales API when `zenviaSalesApiKey` is set, through the
Conversations API otherwise. Without a group, `zenviaHandoffSolution` routes
the conversation instead.

**Transfer through the Sales API** (`zenviaSalesApiKey` + `zenviaHandoffGroupId`
and/or `zenviaHandoffRouting`). This is the ZCC flow. In order:

1. `GET /api/v1/prospect-by?phoneNumber=` finds the prospect of the contact,
   first with a leading `+` and then digits only (the second try also runs
   when the first format is rejected with a 4xx). No prospect means no
   conversation to transfer, and the handoff fails before anything is sent.
2. `POST /api/v1/prospect/{id}/transfer` moves the prospect to the group, or
   to `zenviaHandoffUserId` inside it. A refusal, or an explicit
   `success: false`, fails the handoff before anything is written or sent,
   so the agent keeps the chat. Any other 2xx counts as done: an empty body, a
   body that is not JSON, and a `success` that is not a boolean included. The
   answer is read through a Zod schema that keeps only `success` and ignores
   every other field. Error answers are read the same way: only a string `code`
   and `message` are used, and anything else falls back to the first 200
   characters of the raw body.
3. `POST /api/v1/prospect/{id}/interactions` writes a `note` with the context
   the agent needs: `motivoHandoff`, `dadosLead` and every `handoffFields`
   key. It runs after the transfer, so a retried handoff never leaves an
   orphan note; a note that fails is logged and the handoff stands.
4. The farewell text is sent through the API v2 as an ordinary message.
   If only this step fails, the handoff still counts as done, because the
   contact already belongs to a person.

The route's default side effects then run (`agentPaused`, follow-up disarm,
audit row). Requirements on the Zenvia side: the WhatsApp number must have
its destination set to *Atendimento Comercial* and be assigned to a group
created exclusively for the chatbot. On connect the plugin lists the groups
visible to the Sales key and logs a warning when the group is not among them,
when the key is rejected or when the Sales API is down; none of that blocks
the connection, because messaging must not depend on an optional feature.
Setting the Sales key, or `zenviaHandoffUserId`, without a group
(`zenviaHandoffGroupId` or `zenviaHandoffRouting`) leaves the transfer off
(logged) instead of failing the connect.

**Transfer through the Conversations API** (`zenviaHandoffGroupId` and/or
`zenviaHandoffRouting`, no `zenviaSalesApiKey`). Every call carries the same
`X-API-TOKEN` as outbound messages. In order:

1. `GET /v2/conversations?search=<contact digits>&sort=createdAt,desc&size=100&page=N`
   finds the conversation. The search is free text, so the plugin keeps only
   the results that are really this contact on this sender: `channel` is
   `whatsapp`, `to` reduced to its digits is the contact, `from` is
   `zenviaSenderId` (compared the same way as on inbound messages) and the
   status is not `CLOSED`. Of those it takes the most recent by `createdAt`.
   It reads page after page, newest first, and stops at the first page that
   has a match, at a page shorter than the page size, or after 5 pages.
   None left means no conversation to transfer, and the handoff fails before
   anything is written or sent. Results it cannot read are skipped.
2. `POST /v2/conversations/{id}/notes` writes the same note as the Sales
   transfer (`motivoHandoff`, `dadosLead` and every `handoffFields` key) as
   an internal note, which the contact never sees. It runs before the transfer
   so whoever picks the conversation up finds it there; a note that fails is
   logged and the transfer still runs. A handoff retried after a failed
   transfer can therefore leave the note twice.
3. `POST /v2/conversations/{id}/actions/transfer` with
   `{ "type": "GROUP", "groupId" }`, or `{ "type": "USER", "groupId", "userId" }`
   when `zenviaHandoffUserId` is set. Any 2xx counts as done (Zenvia answers
   202 for a group and 200 for a user), even when its body cannot be read, so
   an accepted transfer is never retried. A refusal fails the handoff before the
   farewell, so the agent keeps the chat.
4. The farewell, exactly as in the Sales transfer.

On connect the plugin lists `GET /v2/groups` (enabled groups only) and warns
about the default group and every mapped group that is not among them, or
when the listing fails. None of that blocks the connection.

### What `data.messageId` tells the caller

On `POST /messages/send/handoff` and `POST /messages/send/close-contact`,
`data.messageId == null` means **no phrase reached the contact**. Read it that
way, not as an error:

- **Handoff by transfer, farewell failed.** The transfer already happened, so
  the contact belongs to a person and the call stays a success (201). Only the
  farewell is missing: `messageId` is `null`, the plugin logs an `error` with
  `instanceId` and `errorCode`, and a `message.failed` event is emitted. The
  caller must not resend the handoff; it can tell the contact itself.
- **Handoff by conversation routing, farewell failed.** The farewell is the
  handoff, so this is a failure (502 for a transient cause, see the table).
- **Close contact.** `canCloseContact` is `false`: the route sends nothing to
  Zenvia, applies its side effects and answers `messageId: null`. The caller
  must treat that as a farewell **not sent**.

### Routing a handoff to a group

By default every handoff goes to `zenviaHandoffGroupId`. When the emitter
chooses a queue, `zenviaHandoffRouting` sends each queue to its own group,
in either transfer mode:

```json
{
  "field": "queue_field",
  "groups": { "queue-a": "group-1", "queue-b": "group-2" }
}
```

- `field` is the key of `handoffFields` that carries the queue. It is plain
  per-instance config: the plugin has no built-in key name.
- The value of `handoffFields[field]` is compared with the keys of `groups`
  after trimming, collapsing inner whitespace and ignoring case, so
  `" Queue-A "` finds `"queue-a"`. Only string values match: a number, an
  object or a missing key never does. Two keys that become equal after that
  normalization are refused as a configuration error.
- No match, a missing key or a value that is not a string: the handoff goes to
  `zenviaHandoffGroupId` and a `warn` log names the key and, for a string, the
  value (nothing else from the lead). Without a default group the handoff is
  refused for good (422, see the "Failure to HTTP status" table below) before Zenvia is called.
- `zenviaHandoffUserId` is applied inside whichever group is chosen. An agent
  normally belongs to specific groups, so leave it unset when routing to
  several groups: whether Zenvia refuses a user that is not in the target group
  is an open question (below), and a refusal would be a 422.
- The note still carries the queue with the rest of `handoffFields`.
- An invalid map (not an object, blank `field`, empty `groups`, a group id that
  is not a non-empty string, unknown keys) is a 400 on `POST` and `PATCH` of
  the instance, and the plugin refuses to connect with it. The plugin reads the
  map on connect: restart the instance after changing it.
- On connect the plugin lists the groups visible to the Sales key, or to the
  API token without it, and warns about every mapped group that is not among
  them. It never blocks the connection.

```bash
omni instances update <id> \
  --zenvia-handoff-group-id <default-group> \
  --zenvia-handoff-routing '{"field":"queue_field","groups":{"queue-a":"group-1"}}'
```

**Conversation routing** (`zenviaHandoffSolution`, no group). The only
primitive of the API v2 is the `conversation` field on an outbound message,
`{ "solution": ..., "properties": { ... } }`. The farewell carries it and
Zenvia hands the conversation to the solution when the contact replies.
`properties` carries `handoffReason`, `leadData` and the `handoffFields`.

With neither configured the plugin refuses the handoff instead of pausing the
agent on a conversation no human will see. `canCloseContact` is `false`:
neither API has an operation to close a conversation from here.

### Failure to HTTP status

The plugin tells a **definitive refusal** (repeating the same request cannot
succeed, so the caller should keep the conversation) from a **transient
failure** (worth retrying, or worth treating as unknown). A definitive refusal
returns `SendResult.rejected = true`, which every `POST /messages/send*` route
answers as `422 CHANNEL_SEND_REJECTED` with `recoverable: false` and
`retryable: false` in the error details, whatever `retryable` the channel set.
Every other failed send, on every channel, keeps answering
`502 CHANNEL_SEND_FAILED`. Neither failure pauses the agent, writes an audit
row or disarms follow-ups.

This plugin sets `rejected` only on the handoff path (the rows marked `true`
below). A Zenvia 4xx on an ordinary send stays unflagged and answers 502.

| Failure                                                                   | `rejected` | `retryable` | HTTP                         |
| ------------------------------------------------------------------------- | ---------- | ----------- | ---------------------------- |
| Handoff not configured (no group, no routing solution)                    | `true`     | `false`     | 422 `CHANNEL_SEND_REJECTED`  |
| No Sales prospect for the contact's number                                | `true`     | `false`     | 422 `CHANNEL_SEND_REJECTED`  |
| No open conversation of the contact on this sender (Conversations API)    | `true`     | `false`     | 422 `CHANNEL_SEND_REJECTED`  |
| Sales or Conversations API refuses the lookup or the transfer with a 4xx other than 401, 403 and 429 | `true` | `false` | 422 `CHANNEL_SEND_REJECTED`  |
| Sales API answers the transfer with `success: false`                      | `true`     | `false`     | 422 `CHANNEL_SEND_REJECTED`  |
| `zenviaHandoffRouting` set, the queue maps to no group and there is no `zenviaHandoffGroupId` | `true` | `false` | 422 `CHANNEL_SEND_REJECTED`  |
| Sales key or API token refused (401, 403): a credential problem, not a refusal of the lead | absent | `false` | 502 `CHANNEL_SEND_FAILED` |
| Rate limit (429)                                                          | absent     | `true`      | 502 `CHANNEL_SEND_FAILED`    |
| Sales or Zenvia 5xx, timeout, network failure, unreadable conversation list | absent   | `true`      | 502 `CHANNEL_SEND_FAILED`    |
| Farewell fails in routing mode (no transfer)                              | absent     | by cause    | 502 `CHANNEL_SEND_FAILED`    |
| Zenvia 4xx other than 401, 403 and 429 on an ordinary send (not a handoff) | absent    | `false`     | 502 `CHANNEL_SEND_FAILED`    |

## v1 scope

**Outbound:**
- text, with Markdown converted to WhatsApp syntax;
- image, audio, video and document as a `file` content by public URL (a
  caption only on image and video, a file name only on documents);
- location;
- reply via `idRef`;
- template via `metadata.template = { id, fields }`. Zenvia templates take
  named fields, so positional `bodyParameters` are refused.

**Inbound:**
- text;
- file mapped to image/audio/video/document by MIME type;
- location;
- contacts (as text);
- quoted replies (`idRef`);
- statuses: `DELIVERED`, `READ`, and `REJECTED`/`NOT_DELIVERED`, which map
  to failed. When a status event carries no `message.to`, the chat comes from
  an in-memory map of `messageId -> recipient` recorded on every successful
  send (at most 5000 entries per instance, 24 hours each, oldest dropped first).
  A status for a message the map does not know (sent before a restart, or by
  another system) logs a `warn` with its `externalId` and is emitted with an
  empty chat id;
- dedupe by message id: an id is claimed when its delivery starts, so a
  concurrent duplicate is dropped, and is released again if publishing fails,
  so the redelivery is not mistaken for a duplicate.

Files Zenvia itself marks as `REJECTED` are dropped. `MESSAGE` events with
`direction: OUT` are echoes of messages sent from the number and are
ignored.

**Out of scope:**
- interactive buttons and lists, contacts send, WhatsApp Flows, products;
- template CRUD (the Zenvia API has it; this plugin only sends);
- typing indicator (the API has none);
- reactions.

## Conversation status: a person takes over

Zenvia reports the lifecycle of a conversation through `CONVERSATION_STATUS`
events. The subscription covers the whole organization, not one number, so
the plugin keeps only the events of its own sender: one of `from` and `to`
must be `zenviaSenderId` (compared the same way as on inbound messages) and
the other is the contact, reduced to its digits like the chat id of an
inbound message. A status on another channel than `whatsapp`, on another
sender, or with no contact is acknowledged and dropped. Both spellings of the
status are accepted: the webhook sends `CONVERSATION_CLAIMED`, the
Conversations API answers `CLAIMED`.

| Status                                                    | Published             |
| --------------------------------------------------------- | --------------------- |
| `DISTRIBUTED_TO_USER`                                     | `chat.human_takeover` |
| `CLAIMED` with a `userId`                                 | `chat.human_takeover` |
| `TRANSFERRED` to a user (`TRANSFER_TO_USER` or a `newUserId`) | `chat.human_takeover` |
| `CLOSED`                                                  | `chat.human_released` |
| everything else (created, queued, started, snoozed, unsnoozed, a transfer to a group) | nothing |

`chat.human_takeover` carries `chatExternalId` (the contact), the
`providerConversationId`, the `providerStatus` and the `attendantId` when
Zenvia names one. Omni applies it the way the handoff route does: the stored
chat of that contact gets `agentPaused: true` (merged into its settings), which
publishes `chat.handoff_activated`, and its follow-up is disarmed with reason
`handoff`. A chat already paused is left alone, and a contact with no stored
chat yet has nothing to pause.

`chat.human_released` carries who closed the conversation (`releasedBy`:
`attendant` or `system`, and `releasedById`) and the close reason (`reason`,
`reasonLabel`). Omni does not resume the agent on its own: no channel resumes
it today, and resuming stays with the session reset and the chats routes. An
app that wants the agent back once the person is done listens for this event.

## Pending for follow-up PRs

- Template management (create, list, sync): this plugin only sends templates.
- An allowlist of hosts for inbound media: it waits for Zenvia's answer on
  which hosts serve `fileUrl` (open questions below).

## Open questions for the vendor

- The exact payload of the ZCC *Conversation Message* webhook: the event name
  (the ZCC guide says `MESSAGE_RECEIVED`, this plugin validates `MESSAGE`)
  and whether it carries the prospect id, which would save the lookup by phone.
- The phone format `prospect-by` expects (the plugin tries `+55...` and then
  digits only).
- Whether `conversation.solution` is still meaningful for a ZCC account, or
  the Sales transfer replaces it.
- Whether inbound `fileUrl`s require authentication, on which hosts they live
  and how long they stay valid.
- Whether a transfer to a `user` that does not belong to the target `group` is
  refused, and with which status.
- Whether the Sales `/groups` listing is paginated (the connect check only
  warns, so a missing page does not block anything).
- Which number format the `search` of `GET /v2/conversations` matches. The
  plugin searches by the digits and checks `to`/`from` on every result, so a
  format it does not match ends in a 422, never in a transfer of the wrong
  conversation.
- Rate limits for `POST /channels/whatsapp/messages` and for the Sales APIs.
