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

The "required" column is for the Channels API mode. With `zenviaConnectorSlug`
set the instance runs in live chat mode instead, where only the connector keys
are required (see Live chat mode below).

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
   has a match or at a page shorter than the page size (counting every item
   Zenvia returned, readable or not). Results it cannot read are skipped. No
   match before a short page means no conversation to transfer, and the
   handoff fails for good before anything is written or sent. Five full pages
   without a match end the search with a retryable error instead, since that
   does not prove there is no conversation.
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

## Live chat mode (Zenvia NLU Agent Connector)

When the Zenvia account runs its own bot journey (Zenvia NLU, formerly ALTU)
and only hands the contact over at a step of that journey, the instance acts
as a **live chat platform** behind the bot instead of talking to the Channels
API. The bot calls `start_live_chat` with the integration; from then on Zenvia
NLU sends the conversation to Omni and relays what Omni answers. When the
agent hands off, Omni closes the live chat with the queue in `reason`, and the
bot transfers the contact to people itself. A contact who comes back later
starts again in the bot and reaches Omni as a new conversation. When Zenvia
NLU closes the live chat itself (the contact went idle past the integration's
inactivity time, or closed it), the agent can still write to the contact: the
send reopens the live chat with a WhatsApp template (see Reopen below).

The mode is selected by `zenviaConnectorSlug`. With it set, `zenviaApiToken`,
`zenviaSenderId` and `webhookVerifyToken` are optional and the Channels API is
never called (the connect does not ping it, the handoff groups are not checked
against it).

| Key                              | Required | Notes |
| -------------------------------- | -------- | ----- |
| `zenviaConnectorSlug`            | yes      | The account slug in `https://agent.altubots.com/altu-connector/{slug}/{integrationId}`. Selects this mode. |
| `zenviaConnectorIntegrationId`   | yes      | The live chat integration id. |
| `zenviaConnectorAccessToken`     | yes      | The integration's access token, carried as the `access_token` claim. Sealed at rest. |
| `zenviaConnectorAccessKey`       | yes      | The integration's access key, the HS256 signing key of every token. Sealed at rest. |
| `zenviaConnectorEnv`             | no       | `homol` \| `prod`, appended as `?env=` so Zenvia NLU answers on that environment's webhook. |
| `zenviaConnectorReopenExpirationMinutes` | no | Whole minutes, 1 to 10080: the `expirationTime` of a `REOPEN_CONVERSATION`. Setting it turns reopening on; unset, a send to a closed live chat is refused. |
| `zenviaHandoffGroupId`           | no       | Default queue value sent as the close `reason`. |
| `zenviaHandoffRouting`           | no       | Same map as above, but each value is the string the bot branches on, not a Zenvia group id. |

Configure the integration's webhook as
`{OMNI_BASE_URL}/api/v2/channels/zenvia/{instanceId}/webhook`.

The agent name sent in `parameters.agent.name` is the instance name (the API
passes it to the plugin as `zenviaConnectorAgentName`); without one it is
`Omni`. The agent id is the instance id.

**Auth.** Both directions use the same JWT: header
`{"alg":"HS256","typ":"JWT"}`, payload `{access_token, iat, exp}` with
`exp = iat + 60`, signed with the access key, a new token per request. Omni
sends it as the bare token, `Authorization: <jwt>`, with no scheme: measured
against the connector endpoint, the bare token passes authentication while the
same token behind `Bearer ` is answered 401 on both `env` values. Inbound
tokens are always verified as HS256 whatever `alg` they claim; the
`access_token` claim must equal the configured token (constant-time), `exp`
may be at most 30 s in the past, `iat` at most 30 s in the future, and the
lifetime at most 90 s. Both the bare token and `Bearer <jwt>` are accepted. A
failure answers 401 `{"requestId","message":"Unauthorized"}` and logs the
reason, the scheme and the claimed `alg` (never the token). The Channels API
verify token does not authorize a connector event; it still authorizes a
Channels API event (`type`) sent to the same URL.

**Inbound.** The webhook tells the two APIs apart by the body: `action` is a
connector event, `type` a Channels API event. Connector bodies may be up to
32 MB (a file arrives as a JSON byte array); Channels API bodies stay at 1 MB.
Every answer is JSON `{"requestId","message"}`: 200 `OK`, 400 for a malformed
event, 404 for an unknown file, 500 when the event could not be published.

| Action               | What Omni does |
| -------------------- | -------------- |
| `OPEN_CONVERSATION`  | Stores the session of the contact (replacing an older one), answers `ACCEPT_CONVERSATION` in the background (one retry on a transient failure), and publishes the lead's lines after the last bot line of `contact.history` as one `message.received`. Nothing is published when there are none. |
| `SEND_MESSAGE`       | `message.received` with `messages` joined by a newline, or a `location`. `requestId` is the message id and the dedupe key. |
| `UPLOAD_FILE`        | Decodes `file.buffer` (a Node Buffer `{type:"Buffer",data:[...]}` or base64), stores it for 24 h and answers `{fileId,requestId,message}`. |
| `SEND_FILE`          | `message.received` with the media typed by its MIME type and `mediaId` `zenvia-connector-file:<fileId>`, which `downloadInboundMedia` reads back from the store (or asks Zenvia NLU with `GET_FILE`). The caption is the text. |
| `GET_FILE`           | Returns the stored file in the spec's shape, 404 when it is gone. |
| `CLOSE_CONVERSATION` | Drops the session and remembers the conversation as closed by the platform (the contact closed it, went idle, or answered a reopen too late). Nothing is published: the agent is not paused and no handoff or takeover event is emitted. |
| `ACCEPT_CONVERSATION` | Answer to a reopen: the conversation is the contact's session again (see Reopen). Ignored without a pending reopen. |
| `REJECT_CONVERSATION` | Answer to a reopen: `message.failed` for the reopen message, with `parameters.status` as `errorCode`. Ignored without a pending reopen. |

Both `conversationId` and `conversationID` are read; Omni sends
`conversationId`. The chat id is the contact's phone as digits with the
country code: a 10 or 11 digit `contact.phone` gets `55` in front (Zenvia NLU
sends Brazilian numbers without it), anything else keeps its digits, and with
no phone the `identifier` is used. That matches the chat id the Channels API
mode produces for the same contact.

The first `message.received` of each session carries `sessionStart: true`,
whether it comes from the `OPEN_CONVERSATION` history or from the first
message after it, and only that one. Omni's dispatcher uses it to resume an
agent the earlier handoff paused (see `MessageReceivedPayload.sessionStart`);
agent providers see it as `executionContext.source.sessionStart`.

Sessions live in plugin storage (database-backed, 7 days), keyed by instance
and contact, with the reverse map from conversation to contact, so a redeploy
keeps them. The last closed conversation of a contact, and who closed it
(the platform or a handoff), is kept 30 days for the reopen. A conversation that was closed or replaced by a newer
`OPEN_CONVERSATION` is remembered for the same 7 days: a late event of it is
acknowledged and ignored, while an event of a conversation never seen (an
`OPEN_CONVERSATION` that was missed) adopts the contact's session. Writes to
one contact's session are serialized within the process.

**Outbound.** A contact with an open session is written to directly. A
contact whose live chat is closed goes through Reopen below; a contact that
never had one fails with `no open Zenvia live chat for this contact`
(rejected, not retried). Text goes as `SEND_MESSAGE` with Markdown converted
to WhatsApp syntax. A template sends `metadata.template.fields.message` (or
`content.text`) as text, since the live chat has no templates of its own; a
template with neither is refused. Media is read from `content.localPath` (or
downloaded from `content.mediaUrl` behind the same guard as inbound media),
sent as `UPLOAD_FILE` and then `SEND_FILE` with the returned id; a caption
follows as a `SEND_MESSAGE`. Other content types are refused. Only HTTP 200 with `message: "OK"` is a
success; a 5xx or a network failure is retryable, 400 and 404 (and a 200 with
another message) are definitive refusals, 401 is a credential problem.

**Handoff.** The queue is resolved first with `zenviaHandoffRouting` and
`zenviaHandoffGroupId` (refused with nothing sent when neither yields one).
Then the farewell goes as `SEND_MESSAGE`, and `CLOSE_CONVERSATION` follows
with `reason` set to the queue (one retry on a transient failure). The session
is dropped and the result carries `pauseAgent: false`: the contact is with the
bot's people now and comes back only as a new `OPEN_CONVERSATION`, so pausing
the chat would make the agent ignore a returning contact. The handoff route
still disarms the follow-up. When the close fails the send fails too and the
session stays, so the handoff can be retried. No human takeover or release
event is published in this mode: the bot owns the human phase.

**Reopen.** Zenvia NLU closes a live chat on its own when the contact stays
silent past the integration's inactivity time, or when the contact closes it.
The agent may still need to write (a follow-up after a day of silence), so a
send to such a contact asks Zenvia NLU to reopen the conversation:

```
{"action":"REOPEN_CONVERSATION","conversationId":"<last conversation>",
 "parameters":{"expirationTime":"<minutes>","message":"<the text>"},"timestamp":<ms>}
```

Zenvia NLU sends the HSM template configured on the integration's outbound
settings (one variable, named `message`) with the text in it. The template is
chosen there, not by Omni; Omni only supplies the text. The send succeeds when
the request is accepted (`message.sent` carries the request id), and then:

- `ACCEPT_CONVERSATION` makes the conversation the contact's session again.
  Later sends go as `SEND_MESSAGE` on it and the contact's answer arrives as a
  `SEND_MESSAGE` of the same conversation, published without `sessionStart`
  (the agent wrote first, nothing was paused). A reply that arrives before
  the `ACCEPT` reopens it the same way.
- `REJECT_CONVERSATION` (`contact_not_found`, `invalid_channel`,
  `bad_integration_config`, `message_not_sent`, `contact_in_conversation`...)
  publishes `message.failed` for the request id, not retryable. A later send
  tries again.
- A `CLOSE_CONVERSATION` for it (the contact answered after the expiration)
  closes it again; the contact is back in the bot.
- If the expiration passes with no reply and no close, the next send counts
  the live chat as closed and reopens again.

While a reopen waits for its answer (2 minutes at most), another send to the
contact fails as retryable and nothing is sent. A failed `REOPEN_CONVERSATION`
call fails the send (retryable on a 5xx) and leaves the next send free to try
again.

A send to a closed live chat is refused, with nothing sent, when the live chat
was closed by a handoff (the contact is with people; this never reopens), when
it is itself a handoff, when it is not text (or a template with a message),
or when `zenviaConnectorReopenExpirationMinutes` is not set. A new
`OPEN_CONVERSATION` for the contact clears all of this. Zenvia NLU requires a
WhatsApp integration through LivePerson or Zenvia, its Outbound API enabled
and the reopen template set on the integration.

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
- Live chat mode: whether `contact.phone` ever carries the country code, and
  whether a `SEND_MESSAGE` after a reopen's `ACCEPT_CONVERSATION` but before
  the contact answers reaches WhatsApp (the reopen template opened the
  window only if the contact answers it). Answered: Zenvia NLU signs its calls
  with the same JWT it asks of us, `CLOSE_CONVERSATION` takes no field besides
  `reason`, and its endpoint validates `conversationId`.
