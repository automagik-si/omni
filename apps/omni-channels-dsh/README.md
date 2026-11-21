# Omni channels for DSH

`@automagik/omni-channels-dsh` brings your Omni into the Bot team for DeepSeek Harness
(DSH): link this DSH to an Omni, see its channels and chats, and let Omni, the Main Bot,
operate the platform and run your automations. It sits on the team plugin
(`@automagik/bots-dsh`, [apps/bots-dsh in automagik-si/automagik](https://github.com/automagik-si/automagik/tree/dev/apps/bots-dsh#three-plugins))
and needs it; the canvas plugin (`@automagik/omni-canvas-dsh`) sits on this one.

> Labs release. Features, tools and the saved data format can still change.

## What it adds

- **The link to an Omni**: the Channels page pairs this DSH with an Omni by a code you send
  yourself on WhatsApp, and keeps the key the Omni mints in `omni.json` (see below).
- **Channels and chats**: the Channels page (connect a channel, its health) and each chat as
  a main panel; the footer shows the connected channels and a dot when one needs attention.
- **Omni's tools**, for a Main Bot only: `omni_channels`, `omni_chats`, `omni_messages`,
  `omni_connect`, and `omni_endpoints` and `omni_call` for any other operation of the Omni
  API. Each call is drawn in the chat as a card. With an Omni named, a Main Bot's Sessions
  lose DSH's shell and file tools and the team's `start_task`: Omni has no computer, and
  says what such work needs so the user can give it to a Bot that has one.
- **Reading a chat's history**: `read_history` and `save_reading_note`, for a Bot that operates
  Omni: it reads one chat's whole history a page at a time and keeps a reading note of that chat
  as it reads (see below).
- **Automations**: `find_chats`, `list_automations`, `save_automation`, `pause_automation`
  and `delete_automation`; Omni's event streams start a run for each match. The board is a
  tab of DSH's right sidebar beside Omni's chat, and the account menu opens the Automations
  page. A run for an event only reads omni. A "thread" worker runs each event in the thread
  of the chat it came from, making that chat a thread first when it is none, so an
  automation over many chats works in one thread per chat, drawn under the Omni Bot's row.
- **Backfilling chats' history**: `propose_backfill` puts a card before the user, who ticks
  chats, sets the range and presses Start once; each chat's row moves live until it ends (see
  below). `backfill_status` and `cancel_backfill` let the Bot follow and stop one.
- **Omni's rules**: how to operate Omni, that it has no computer, and how to run automations,
  as a part of the Main Bot's rules inside the team's prompt section.
- **Connect Omni**, the onboarding step `omni-connect` (order −250), between the Omni AI
  plugin's welcome (−300) and Connect AI (−200). A skip is kept by `@automagik/welcome-dsh`
  when it is installed, else in this browser.

On a Bot team whose `bots-dsh` release passes the Session to step classifiers, an
`omni_call` post into a group or channel and a presence update with text count as hard
steps. Auto never lets one through by itself, every asking level asks, and a never-asking
level refuses. Sends to a person and deletes keep Omni's own confirmation card.
`omni_send`, reactions, automation event runs, and chat threads keep Omni's rules.

## Attach a Telegram bot from a wizard host

The host-only `omniChannels.omniTelegramAttach({ token, name, source?, answerBot? })`
accepts the wizard's hand-off. Call it **only after the person confirms and the old
Telegram listener's off receipt has arrived**, in that order. It does not check or stop
the old tool. Creating the Omni instance starts its connection immediately.

Pass the token directly from that hand-off; there is no attach page, HTTP route, model
tool, file, environment variable or setting that supplies it. The existing manual add
and clipboard flows are separate and are never fallbacks for this function. The host
uses its existing linked Omni key, sends the token through `POST /instances`'s write-only
`token` field, and reads `/instances/:id/status`. It creates no Omni agent or route.
The token must have Telegram's bot-token shape. Returned text, errors and the optional
`source` host log label redact the submitted token as `[REDACTED]`; the label is not saved
or returned.

The receipt is `{ channelId, channelName, connected, detail, botId? }`. `connected` uses
the same connection-state check as channel pairing; `detail` is `profileName` or `null`.
`botId` is the Telegram bot ID, included only when Omni's status reports it. There is no
`chatId`. A false `connected` value is a status snapshot, not proof that connection
will eventually succeed. Instance names are unique: retrying the same `name` receives
Omni's conflict instead of creating or reconnecting a second instance. If a later step
fails after creation, inspect the existing channel before retrying.

Optionally pass `answerBot`, the ID of the existing DSH channel bot the person picked.
The host reuses the owner-confirmation actions to give that bot the new channel. If
the bot already answers, or explicitly owns no other channel, answering is enabled with
its existing settings and defaults unchanged, including the new child's sending mode.
The receipt also includes `{ answerBot, answering: true }`. If answering is currently
off and the bot explicitly owns other channels, it stays off: the receipt includes
`{ answerBot, answering: false, reason: 'other-channels' }`, and the wizard should direct
the person to answer settings. This avoids silently enabling answers on other channels.
Without `answerBot`, the attach changes no DSH ownership or answer settings.

## Bind each answer child to its person

An answer bot's settings have **Bind each child to its person** (`personBinding`, off by
default; set in the settings panel only, never by a model tool). It needs isolated visibility,
and the file tools off or limited to a knowledge folder.

While it is on, the first message for a chat that an Omni access rule naming one person admits
(an allow rule with a `platformUserId`, or a `phonePattern` with no `*`) binds that chat's child
to the rule, once. A later message for that chat admitted by another rule, or by none, is held:
it reaches no child, and the host warns once. A message that access control lets in without such
a rule (access off, a wildcard) binds nothing.

The rule is the person's only record. Staff write its `metadata` (`POST`/`PATCH
/access/rules`, a JSON object of at most 16 KB):

```json
{
  "context": "Text about this person, for their child only.",
  "capability": { "name": "orders-for-this-person", "secrets": ["ORDERS_TOKEN_FOR_THIS_PERSON"] }
}
```

- `context`: text (up to 8000 characters) that only this person's child reads, in its own
  section of its instructions. A change is read again within 30 seconds.
- `capability`: an MCP capability saved in the team's Settings > Capabilities, as its name or as
  `{ name, secrets }` with exactly the secrets it uses (each saved for no Bot). The Bot team
  mounts it into this child's Session only, and the child's guard admits its tools by their
  `mcp__<name>__` prefix in that Session alone. Its calls run without a staff card. On a Bot team
  that cannot mount one, or when the mount needs approval or fails, the child answers without it
  and the host warns once. It leaves the Session when the rule stops naming it, when binding is
  switched off, or when the child is removed.

Context and capability are kept in memory only: after a restart they return with the person's
next admitted message.

## A first message before Omni knows the phone

A WhatsApp sender can first arrive by their lid alone, before Omni has looked up their phone, so
an access rule by phone cannot match them yet. Answer mode keeps such a message (in the plugin's
saved state, so a restart keeps it) and checks it again about 2, 10 and 30 seconds later, then
each minute, with the phone Omni has learned for the chat by then (the chat's `canonicalId`).
When a rule admits the person, or a later message of theirs in that chat is admitted, the kept
messages reach the child once, oldest first, bound by that rule. A kept message is dropped once
it is older than the channel's `inboundMaxAgeMinutes`, by its platform time.

If the sender is still not matched after 30 seconds and the channel has an allow rule by phone,
the host warns once and the bot's sidebar shows "1 message waiting: sender not matched yet". A
sender whose phone is known and matches no rule is refused as before, without a marker.

## A reply for people who are not let in

By default a sender that no allow rule matches gets no answer. Staff can set one reply under
**Reply to people who are not let in** (`strangerReply`, at most 1000 characters, settings panel
only; empty turns it off). With a reply set, such a sender gets it once a day per chat, in the
chat they wrote from, through Omni's send for that chat, and only after their own message. No
answer child is made or woken for them. A sender known only by their lid gets it once the
30-second check still finds no rule, or as soon as a check finds a phone no rule allows. Their
message then leaves the kept messages, with no warning and no marker. A rule that matches at an
earlier check admits them as before. Only the allowlist's default refusal gets the reply: a
sender that a rule of its own refuses (block or silent_block, on any of their ids) gets nothing
and is not listed. A check that failed, a message that is too old, a group, history and the
number's own messages get nothing. A failed send takes the day's mark back, so the person's next
message tries again; nothing tries on a timer, and the failure is warned once per chat until a
send there works.

Each such sender is listed under **Requests** in the answer settings, whether or not a reply is
set: one row per chat, with the ids they wrote from, their first text (500 characters), when they
last wrote and how many messages they sent. With no reply set, nothing is sent and a sender known
only by their lid stays kept as before; their message is listed once, at the 30-second check. A
row whose chat a code from a list later lets in is marked `admitted`. A save that fails takes the
row's change back. The list keeps the newest 500 rows per bot, and the day's marks keep the
newest 5000 chats. Both are saved, so they outlive a restart. Only staff read the list, on the
`omni-answer-requests` route; no tool reads it.

## When a person needs someone from the team

An answer child that cannot help its person calls `thread_needs_staff` with a one-line reason
(1 to 200 characters), then tells the person the team has been told; its fixed instructions say
so, whatever the bot's own instructions say. The tool sends nothing to the person and raises no
card, in training and in sending mode alike. Only answer children may call it, and a child that
staff took over is refused: staff are in its chat already.

The team is told once: the owning bot gets a note in its own chat naming the chat and the
reason, the child's row in the sidebar shows **Needs a person** with the reason and a
**Dismiss** button, and, when staff pick one under **Staff chat when a person is needed**
(`needsStaffChatId`, settings panel only), that chat gets a short message on the bot's channel.
The staff chat can never be a chat an answer child answers. The mark is saved, so it outlives a
restart; calls while it is set tell no one again. It clears when staff answer in that chat from
their own phone, or when they press **Dismiss**. DeepSeek Harness has no app notification a plugin
can raise, so the sidebar row is the app's own sign.

## Let a person in by a code from a list

Staff can let people in with single-use codes they hand out, for example in a link that opens the
chat with a message typed. Under **Code lists** in the answer settings, staff fill a list:

- a **name**;
- its **code pattern**: an optional prefix, the letters and digits a code may have after it, and
  how many (4 to 64). Case never matters. With **Read look-alike characters as one** on, a
  character the set lacks is read as its twin in the set (O and 0; I, L and 1), after the prefix
  only. A code stands alone in the text: the character before it and the one after are not
  letters, digits or `_`. The plugin scans for codes itself and never turns staff text into a
  regular expression;
- its **rule details**: a key/value map (`key = value` lines, or a JSON object) copied into the
  allow rule of each person a code from the list lets in;
- its codes, one a line, `code, expires YYYY-MM-DD`, or a JSON array of
  `{ code, expiresAt, inviteId? }`.

A list's pattern is set when it is first filled; codes added later must fit it. The rule details
of a later upload replace the list's, and an upload that leaves them out keeps them. The lists
are the install's and saved: at most 50 lists and the newest 5000 codes over all of them; a list
whose codes all go is removed. Each code is used once, before its expiry: the same code again from
the same sender (any id they share) admits them again, and from anyone else it is used. The used
mark is saved before the person is let in. With no list there is no pattern, and nothing in a
message is read as a code. Only staff read or add codes, on the `omni-code-lists` and
`omni-code-lists-add` routes; no tool reaches them, and no code appears in a warning.

When a sender that the allowlist refuses by default, or one Omni knows only by their lid, sends a
message with an open code, the plugin writes one allow rule for the sender's primary id (their lid
when Omni knows only that) and admits the message in the same pass, as if that rule had matched.
The rule has `reason: invite` and `metadata: { ...rule details, source: 'invite', inviteId }`; the
rule details cannot set `source` or `inviteId`. Person binding reads `context` and `capability`
from the rule details like any other rule. A sender that a rule of its own refuses, and an admitted
sender, are never checked. At most 2 codes are read from a message, over all lists (a code a list
holds first), and a chat gets at most 5 code checks an hour. With no prefix, any word of the
pattern's length is read as a code, so each such word counts as a check.

With **Message when a code admits someone** set (`codeWelcome`, at most 1000 characters), the
person gets it in their chat once the code lets them in, and the child answers from their next
message. Unset, the child answers the code message. A code that is unknown, used or expired, or a
check that fails, sends nothing: the message goes on as refused. Omni publishes no event when a
rule is written, so the rules themselves are the count: allow rules whose `metadata.source` is
`invite` (`GET /access/rules?type=allow`).

## Check a code with an outside service

Under **Outside code check** in the answer settings, staff name an HTTPS service of their own
that checks codes for one bot, on the `omni-outside-check` route (`{ botId, url?, secret?,
pattern?, label?, tier? }`; null or empty clears a field, a field left out is kept):

- the service's **URL** (https only) and a **secret**, written only: the route and the settings
  answer everything but the secret (`secretSet` says whether one is set), and the secret is never
  shown, logged or warned;
- a **code pattern**, the same shape as a code list's, except that the prefix is required here,
  so ordinary words never go out to the service. There is no default: until the URL, the secret
  and the pattern are all set, nothing changes;
- optional steps, each skipped when empty: the **label** staff see on a request row the service
  confirmed, and a **tier** name written on that row.

When a sender that the allowlist refuses by default, or one Omni knows only by their lid, sends a
message with a code of the pattern, and no code list let them in first, the plugin posts Omni's
own event for that message to the service: `{ id, type: 'message.received', timestamp, metadata,
payload: { externalId, chatId, from, senderName?, content: { text } } }`, with the raw text, a
10-second timeout, no redirects, `Authorization: Bearer <secret>`, `X-Omni-Event-Id` (the same on
every try) and a new `X-Omni-Delivery-Id` each try. The service matches the code itself; the
pattern only decides whether to call, and one message is one call. Only an HTTP 200 with a `reply`
(at most 1000 characters) is an answer: the reply goes word for word to the person's chat, once
per message id (the newest 5000 ids are saved), and the chat's row under **Requests** is marked
`confirmed` (with the tier, when one is set). The person stays not let in; no rule is written.
Any other answer sends the person nothing.

The event waits only for the first try. A timeout, a network error or a 503 is tried again twice
in the background, after about 2 and 10 seconds; after 3 such failures in a row the service is not
called for 5 minutes. Whatever the answer, a message with such a code never gets the stranger
reply; it is listed under **Requests**, and a sender known only by their lid is kept as before.
The plugin makes at most 30 calls a minute, and a chat's calls share the code lists' 5 an hour. A
blocked or admitted sender is never checked. A failure is warned once per bot, with its status
only.

## Reading a chat's history

A Bot that operates Omni (a Main Bot or an Omni Bot) reads one chat's history, page by page,
within an optional date window, and keeps what it learns in a reading note of that chat. Answer
children never use these tools; they keep `thread_history`. A Bot reads, and keeps a note of,
only a chat on a channel it may read (`rt.canChannel(bot, channel, 'read')`), so a dedicated
channel bot stays on its own lines. Reading only reads: nothing is sent, no child wakes, and old
messages never start an answer.

- `read_history { chat, from?, to?, cursor?, size? }` (size 1-200, default 50) calls
  `GET /chats/:id/messages` with Omni's page cursor and `includeDeleted=true`, and
  `GET /chats/:id/coverage`. Pages go back from the newest; each page reads oldest first, one
  line per message: platform time, sender, text, the media kind with its transcript or
  description, reactions, and `edited`, `deleted` and `history` (rows Omni took from the
  channel's history) marks. The header gives the coverage (oldest, newest, count, count in the
  window, deleted, media without a file), the last contact each way, "page N of about M", the
  next cursor (which keeps its window, and its size unless another is given) and the chat's
  reading note and conversation summary. When Omni holds nothing for the window, it says to ask the user for a backfill
  first. A page stays under the size DSH keeps whole in a tool result (about 46,000
  characters): a page that fits keeps every text whole; one that does not cuts its texts
  shorter, never its lines, and its header says to read it again (same cursor, none on a first
  page) with a smaller size to have them whole. A page that does not fit even at the shortest
  cut is never returned: the same cursor and window are read again with half as many messages
  (at most 8 times), the header says "fewer messages than asked, to fit", and the next cursor
  is Omni's own after the last message shown. A chat Omni does not have, or that this link may
  not read, is said plainly.
- `save_reading_note { chat, note, readThrough, summary? }` keeps the note (at most 8,000 characters: who
  the person is to the user, what is open, the last contact, how the user talks to them), the
  newest message time it covers (`readThrough`, where a later reading of what is new starts),
  and when it was updated. Pages go back from the newest, so until a reading reaches its last
  page the note itself says how far back it has read. Supply a summary of 1–300 characters
  for conversation review. Leaving it out keeps the previous summary.

Notes and summaries live in `omni-reading-notes.json` and `omni-reading-summaries.json`
beside `omni.json` (0600), keyed by Omni chat id. Each save rewrites the file through a
temporary file and a rename, one at a time in this host; there is no lock across hosts, and a
host that only reads the team does not save. The tools need an Omni with the page cursor and
the coverage read, so `engines.omni` names the release this change is cut in.

The shared kit's person card reads one chat's note and coverage through the endpoint
`omni-reading-note` (a read, so a host that only reads the team serves it too):

```text
request:  { chat: "<Omni chat id>" }
response: {
  chat: { id, name?, channelId? },
  note: { text, readThrough, updatedAt, summary: string | null } | null,
  coverage: { oldest, newest, count, mediaMissing, deletedCount, lastInbound, lastOutbound } | null
}
```

The note and the coverage come back only when the Omni finds the chat and some Bot that
operates Omni may read its channel (`rt.canChannel(bot, channel, 'read')`, as the tools decide).
Otherwise the answer is `{ chat: { id }, note: null, coverage: null }`, never a saved note.
`note` is null until a Bot saves one; `coverage` is null when the Omni cannot give it. Times are
ISO strings.

## Backfill a chat's history

The user asks the Bot that operates Omni for history ("my chats since March"). The Bot calls
`propose_backfill { chats?, from?, to? }`; any Bot that operates Omni may, never an answer
child. It saves a proposal the shared kit draws as one card:

- the chats the Bot may read (the 200 most active, then any it named), pre-ticked only when
  the user named them;
- the range, only when the user gave one;
- nothing else: it starts nothing and carries no authority. A new proposal from the same Bot
  replaces its open one, so the next card starts empty.

The user ticks chats, sets the range and presses Start once. That owner action alone starts
the work, one Omni backfill job per ticked chat (`POST /chats/:id/backfill`):

- each chat is read again at Start and must be on a channel the proposing Bot may read;
- the proposal is used once;
- `omni_call` refuses that route, so no model's call stands in for it.

Cancel really stops a job, from the card (`cancel_backfill`) or by the Bot's `cancel_backfill`
tool when the user asks; Omni's worker stops after the round it is in. Omni stores what a
backfill fetches without publishing it as new messages, so old messages never wake an answer.

Each job is a row in every state answer (the chat asks every 1.5 s), fed by Omni's `sync.*`
events, which Omni journals for durable consumers. This plugin streams its `sync.*` consumer
only while a job is unfinished. The job's route is the fallback read: after Start, on
`backfill_status`, on cancel, and each time the stream connects (so after a restart too).
Rows carry labels and counts, never message text.

For ended rows the calling Bot can still read, `backfill_status` gives the run ID, exact
window, chat IDs, outcomes and the number of messages Omni holds in that window. The Bot
can read those chats with `read_history` and save a summary before the user chooses chats
for Answer Mode training.

### For the shared kit

The picker card reads `omniBackfillProposals` in the team view:

```text
{ id, botId, from: ISO | null, to: ISO | null, createdAt: ms,
  chats: [{ id, name, kind: 'dm' | 'group' | … | null, channelId, channel: name | null, ticked }] }
```

The owner actions are write endpoints of `POST /api/omni-ui`. They require a writable host.

```text
start_backfill  { proposalId, chats: [chat id, 1-200, all on the card], from, to }
                → { runId, jobs: [{ chatId, jobId | null, state }] }
cancel_backfill { jobId } → { jobId, state, outcome }
select_conversation_training { chats: [chat id, 1–50], selected: boolean }
                             → { results: [{ chatId, selected, threadId | null, sendingMode | null, refusal | null }] }
```

`from` and `to` are ISO times, or dates for that whole day (`from` before `to`, `from` not in
the future). A refusal comes back as the endpoint's error message.

`omni-conversations { runId? }` reads the newest run by default. Unknown or pruned runs
return `{ run: null, chats: [] }`. Each row must resolve on the current Omni link to a
channel a Bot that operates Omni can read. The response includes the run's exact window,
visible chats and their outcome, coverage, last activity, summary, reading-note status and
training selection. `inWindow` counts messages Omni holds in the window, and `stored`
counts messages stored by the job. The totals reflect the visible rows.

The owner can select direct chats on channels explicitly owned by a Bot with Answer Mode
and channel write access. A new answer child starts in training mode. If live intake
created the child first, selection reuses it and returns its existing sending mode, which
may be `sending`. Deselecting clears the selection and keeps the child available for the
existing pause and remove controls. Conversation review and selection create no sends,
cards, deliveries, runs or follow-ups.

Answer children can read their own chat, including imported messages, with
`thread_history`. Staff can add approved context with `set_child_notes`. Reading notes
and summaries stay in their private files and authorized reads.

Training selection and summary changes are published through Omni as
`custom.omni-channels.training.selected`, `custom.omni-channels.training.deselected` and
`custom.omni-channels.conversation.summarized`. The team's outbox retains pending events
with IDs, timestamps and selection status for retry.

The live rows are `omniBackfills` in every state answer, newest run first, the last 10 runs
(an unfinished one is never dropped):

```text
{ id (the proposal's), botId, from, to, startedAt,
  summary: { total, running, done, phoneDidNotAnswer, stopped, failed },
  rows: [{ chatId, chat (its name), channelId, jobId | null,
           state: 'queued' | 'fetching' | 'done' | 'phone-did-not-answer' | 'cancelled' | 'failed',
           outcome: null | 'done' | 'phone-did-not-answer' | 'stopped' | 'failed' | 'not-started',
           counts: { fetched, stored, duplicates, mediaDownloaded, mediaMissing, reactions, edits, deletions, unmatched },
           round, oldestReached: ISO | null,
           coverage: null | { oldest, newest, count, countInWindow, deletedCount, mediaMissing, lastInbound, lastOutbound },
           startedAt, updatedAt }] }
```

`outcome` is null while the job runs, and set only when it ends (Omni's sync.completed,
sync.cancelled or sync.failed, or the job route's status). `state` can read
`phone-did-not-answer` or `done` a little before that, while Omni reads the chat's coverage.
`coverage` is what Omni holds of the chat once its job ends, and null before then and on a
failure. `not-started` means Omni refused to queue that chat's job at Start.

## Existing channel settings

Open an existing channel to read its configuration groups, derived provider and assigned
agent. Changes use the linked key and the existing `instances:write`/`canWrite` gate;
read-only devices can inspect settings but cannot save or reconnect. The agent picker
lists up to 200 agents; the UUID field also accepts another accessible agent or an empty
value to unassign it. Agent assignment keeps Omni's existing routing/key provisioning.

Settings load with `GET /instances/{id}` and save only edited fields with `PATCH` on that
same id. JSON fields accept structured values; **Clear override** sends null only for
nullable fields. Provider is derived from the agent, never written here. Some transport
settings apply at next connection. Older Omni versions may reject newly added fields;
update Omni rather than recreating a channel when it reports an unsupported setting.

For WhatsApp Business, repair the Meta identifiers and re-enter the access token under
**Repair and reconnect**. This calls the existing instance's Business connect route,
never creates/deletes an instance, and never reads back or persists a token in the browser.
Save any identifier clears first. Connection failure may still have saved credentials;
retry on the same channel. Meta display-number lookup is best effort, so it can stay null.
The Meta API version is a provisioning snapshot; runtime environment takes precedence.

### Reproduce the scoped SDK update for #1403

The base SDK predates unrelated auth routes. Refresh only the five affected members below,
using **exact bytes** from a full OpenAPI generation, rather than pulling that drift into
this feature. Run from the repository root with installed dependencies. This keeps every
old request key and response requirement; `audioTranscription` and `inboundReplyContext`
become required in SDK responses because they were already required in the base API
(the stale SDK had 14 required fields, the API has 16). No types are handwritten.

```sh
mkdir -p .git/local-isolation/sdk-scope
bun -e 'import {openApiSpec} from "./packages/api/src/routes/openapi"; await Bun.write(".git/local-isolation/sdk-scope/openapi.json", JSON.stringify(openApiSpec))'
bunx openapi-typescript@7.13.0 .git/local-isolation/sdk-scope/openapi.json -o .git/local-isolation/sdk-scope/full.ts
node --input-type=module <<'JS'
import fs from 'node:fs'; import cp from 'node:child_process'; import assert from 'node:assert/strict'; import ts from 'typescript';
const file = 'packages/sdk/src/types.generated.ts', scratch = '.git/local-isolation/sdk-scope/';
const base = cp.execFileSync('git', ['show', '5443fb744c9b022530360b23dc49f8988906eb0e:' + file], {encoding:'utf8', maxBuffer:16*1024*1024});
const full = fs.readFileSync(scratch + 'full.ts', 'utf8');
const parse = text => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const iface = (s,n) => s.statements.find(x => ts.isInterfaceDeclaration(x) && x.name.text === n);
const prop = (s,n) => s.members.find(x => x.name?.getText().replace(/^["']|["']$/g,'') === n);
const selectors = [s => prop(prop(iface(s,'components'),'schemas').type,'Instance'), ...['listInstances','createInstance','getInstance','updateInstance'].map(n => s => prop(iface(s,'operations'),n))];
const before = parse(base), after = parse(full), bytes = (text,node) => text.slice(node.getFullStart(),node.end);
const edits = selectors.map(get => ({old:get(before), next:get(after)}));
let scoped = base;
for (const e of [...edits].sort((a,b) => b.old.pos-a.old.pos)) scoped = scoped.slice(0,e.old.getFullStart()) + bytes(full,e.next) + scoped.slice(e.old.end);
const result = parse(scoped); assert.equal(result.parseDiagnostics.length,0);
for (const get of selectors) assert.equal(bytes(scoped,get(result)),bytes(full,get(after)));
const outside = (text,s) => { for (const n of selectors.map(get => get(s)).sort((a,b) => b.pos-a.pos)) text = text.slice(0,n.getFullStart()) + '<selected>' + text.slice(n.end); return text; };
assert.equal(outside(scoped,result),outside(base,before));
for (const ref of scoped.matchAll(/components\["([^"]+)"\]\["([^"]+)"\]/g)) assert.ok(prop(prop(iface(result,'components'),ref[1]).type,ref[2]));
fs.writeFileSync(file,scoped);
JS
```

Repeat the pinned full-generation command and AST splice: the SDK SHA-256 must stay
identical. The API settings test checks the 16 required response fields and documented
field coverage; run it plus SDK typecheck/build/tests and the normal repository gates.
The AST oracle checks dependency closure and unchanged bytes outside the five selectors.

## Install

The plugin needs DSH `>=0.2.2-rc.1 <0.2.3-0` (from 0.2.2-rc.1 up to the next patch, so rc.1 and rc.2
both load; its tests run on 0.2.2-rc.2; DSH turns the plugin off outside the range), the Bot team
plugin (`@automagik/bots-dsh`
`>=3.87.0 <3.261000.0`: Automagik's 3.N releases from the first that admits DSH 0.2.2) and an Omni no older than its `engines.omni`
minimum. Its version is the Omni release of its last change: an Omni release moves it only when
this folder changed, so it can trail the newest Omni. Add the Automagik
marketplace index to DSH's plugin market ([marketplace/README.md](../../marketplace/README.md)
has the URL and the steps) and install `@automagik/omni-channels-dsh` from it. DSH applies
the bundle patch (`cordis.patch.yml`), which adds one row, `id: omni-channels`, and changes
nothing else. Restart DSH.

From a checkout, link it into a profile next to the team plugin; the team's
[README](https://github.com/automagik-si/automagik/tree/dev/apps/bots-dsh#install) has the profile.

## Connect to an Omni

On the Channels page, type the address of an Omni (for example `omni.example.com`) and
choose **Get a code**. Omni answers with a short code; send it to yourself from WhatsApp
("Message yourself"; **Open WhatsApp** or the QR opens the chat with the code typed). The
page goes live as soon as the code arrives. The Omni must have pairing turned on.

The key Omni mints is saved in `omni.json` in the Bot team's home (`$AUTOMAGIK_BOTS_HOME`, else
`~/.automagik/bots`; `~/.automagik/desktop/bots` in the Automagik app), readable by you only, with its
scopes and expiry; it never reaches the browser. Delete that file to
disconnect; revoke the key in Omni to cut it off from the server side.

Without an Omni, the Connect step can run one on this computer (`omni install --sandbox`). It
installs the newest Omni release that meets the minimum, read from npm's `latest` tag (else
`next`) as one exact version that the step shows before anything runs; offline, the plugin's
own version. A sandboxed Omni below the minimum is offered that release, and one the Omni CLI
runs is offered `omni update`.

A profile can still name an Omni the older way: `omni.url` (the API, without `/api/v2`) in
this row's config, or on the team's `omni-ui` row where it lived before this plugin, and the
`OMNI_API_KEY` credential in DSH's store. A saved link wins over both.

```yaml
- id: omni-channels
  name: '@automagik/omni-channels-dsh'
  config:
    omni:
      url: https://omni.example.com
```

## Delete an instance

A live channel's detail page offers **Delete instance** for every channel type and state.
It uses the existing channel-write ability (read-only keys see a disabled action). The first
click names the instance and its ID and offers **Cancel**; only **Permanently delete instance**
sends a request. Preview **Disconnect** stays local and never calls the API.

The host's standard write endpoint, `omni-channel-act` with `action: 'delete'`, calls the
supported `DELETE /api/v2/instances/{id}` through `rt.omniRequest('DELETE', '/instances/{id}')`.
It does not add a backend permission or deletion policy. Pairing's `omni-channel-cancel`
remains limited to channels created by that unfinished flow
([host actions](<src/host/omni-channel-actions.js>)).

Verified backend semantics: the route attempts runtime disconnect, deletes the instance,
then attempts plugin logout/session cleanup; disconnect and logout failures are best effort
([API route](<../../packages/api/src/routes/v2/instances.ts#L1390-L1420>)). The instance
configuration and its local chats/messages are permanently deleted through the database
cascades ([chats](<../../packages/db/src/schema.ts#L1608-L1612>),
[messages](<../../packages/db/src/schema.ts#L1809-L1815>)). This does **not** guarantee
external token revocation or external account unlinking. Events are not all erased: event
rows retain their data with a null instance reference
([events](<../../packages/db/src/schema.ts#L1981-L1987>)), and the service publishes
`instance.disconnected` with reason `deleted`
([instance service](<../../packages/api/src/services/instances.ts#L489-L516>)).

The page keeps the instance and its chats until the delete succeeds. Failure keeps its
details and gives an error with a retry; success clears only its cached chats/messages,
seen state and matching selection, including cached chats omitted by the recent-chat overview.
A bounded ownership map remembers only current chats or IDs with retained data/selection;
late send callbacks from the deleted instance cannot recreate caches or errors. Sends from
other instances still finish even if their chats leave the recent list.
Navigation to another channel is preserved. Duplicate
submissions are blocked across redraws, and a generation guard discards reads overlapping
deletion so stale polls cannot restore removed data. A refresh failure after successful
deletion is reported separately, without treating deletion as failed
([client store](<src/client/omni-store.js>), [detail view](<src/client/channels.js>)).

## How it plugs into the team

- **Host**: it injects the team's runtime (`omniTeam`) and installs `subscriptions`,
  `omni-api`, `omni-link`, `omni` and `omni-events` on a runtime of its own whose prototype is
  the team's, so they call the team's functions while their tools and effects stay on this
  plugin's fiber. It adds to the team only through `rt.hooks` and, on a Bot team that has it,
  `rt.noteStop`. The hooks add the `omni-*` and
  `automation-*` endpoints of `POST /api/omni-ui` (the reads also on a host that only reads
  the team), the automations in the team view, the events Omni listens to in every state
  answer, and the operator rules. It provides its runtime as `omniChannels`.
  On a Bot team that has `rt.hooks.sessionOwner`, it names
  its chat threads' and ask runs' Sessions with that hook (a thread as the Bot it acts as,
  an ask run as the Omni Bot, each labelled with the chat), so its DSH card is noted under
  that Bot in the sidebar,
  the Live rail and notifications. When `rt.noteStop` is available, it notes stopped steps
  for the person, and the team keeps those notes in memory for a while:
  `rule` when one of Omni's own rules refused one (an ask run's non-read, an automation event
  run's write, `start_task` for a Bot that operates Omni), and `level` when a thread cannot
  leave Auto review once it is gone (DSH then refuses its Session). A thread that keeps DSH's
  default permissions, because Auto review is off or could not be set, is not a stop: none of
  its steps was refused. These are notes only: no answer, level or policy changes.
- **Browser**: `client.js` names `@automagik/bots-dsh/client` in `dsh.client.external`, so
  DSH loads the team's bundle
  first and this one shares it: the host call, the interface
  copy (this plugin's Chinese copy joins it with `addStrings`), and the registries it adds
  its tool cards, account-menu row, row badge, header button and Bot-surface panels to. It
  exports `channels`, the live views of omni the canvas plugin draws with.
- **Data**: the automations and their runs (`subscriptions`, `subscriptionRuns`,
  `omniEventCursors`), and the backfill proposals and runs (`omniBackfillProposals`,
  `omniBackfillRuns`), stay in the team's `state.json`, saved through the team's lock; a DSH
  that only reads the team does not change them.

## Meta webhook setup

After WhatsApp Business connects, the setup panel shows the deployment's public HTTPS
callback URL and a **Verify token**, masked until **Reveal verify token** is selected.
Each value has its own copy button. Reopen it from the existing Business channel's
**Channel settings → Show webhook setup**; this does not create or reconnect a channel.
Paste the two values into the matching Meta Developers WhatsApp webhook fields, then
verify and save. The Verify token is separate from the Graph API access token.

Retrieval requires an unlocked global Omni key with `settings:write` (or `settings:*`
or `*`) and a writable DSH host. Tenant-bound keys and keys with instance, chat or
outbound locks are refused. Other callers see an unavailable URL state and **ask an
admin**. No callback is inferred from a local API address or request headers.
DSH apps linked through pairing never show the verify token; only the admin keys
described above can retrieve it.

An administrator must configure `server.public_url` (with `OMNI_PUBLIC_URL` as fallback),
`META_VERIFY_TOKEN` and `META_APP_SECRET` on the server. Missing configuration is shown
explicitly. The endpoint returns only whether the app secret is configured, never its
value or a Graph API access token. The verify token is shared across Meta instances,
kept only in the open panel's memory, and the response is `Cache-Control: no-store`.
Connection alone does not prove Meta can reach or verify the webhook. No automatic
Meta registration or credential rotation is performed.

## Own-device voice and media automations

Voice/media triggers are inbound-only by default. When the owner explicitly asks to
include their own outbound media, use `save_automation` with `allow_outbound: true`
(`trigger: "voice"` for audio; `"media"` for photos, videos, documents and stickers).
The saved trigger records `allowOutbound`; later edits retain it unless explicitly
changed or the trigger kind changes. Set `allow_outbound: false` to turn it off.
The board and automation summary show when own-device media is included.

Admission also reads the canonical message through the configured Omni credentials:
it must match the watched chat and external ID, have a live `notify` own-device receipt
on both the journal and stored message, not be history sync, and have no agent
attribution. API-send records, `append` echoes, history replays and `message.sent`
never trigger it. Missing, forbidden, malformed or mismatched lookups are refused
with a warning and acknowledged, so later events can continue. Network errors and
HTTP 408/429/5xx responses share at most three attempts per row, with backoff that
survives stream reconnects. Exhaustion warns, refuses and acknowledges the row. This
currently admits WhatsApp Baileys own-device receipts; other channels without that
receipt shape remain excluded. The existing channel echo guard stays in place.
A second bot linked to the same WhatsApp number can look like the owner's phone;
enabling own-device media may then create a reply loop.

The worker gets the source chat/instance, a message/media reference and available
transcription or processed content, under its existing permissions. If processing is
disabled or still pending but a media URL exists, it receives that reference without
inventing a transcript: the text may be empty, and dispatch does not wait for
transcription. A record with neither usable text nor a media reference is warned,
refused and acknowledged; it is not replayed when processing finishes.

Inbound media and reactions also perform an uncached scoped message read per event,
instead of using the ten-minute name cache. Workers receive the available processed
text and media reference. Reaction triggers retain “you react” semantics and resolve
the referenced message, including its available transcription. This does not replay already-acknowledged
outbound events or change the stream's existing at-least-once delivery contract.

Enabling `allow_outbound` uses the existing trigger-widening permission card for
act-without-asking automations. New and ask-first automations keep their existing
permission flow; the tool instruction to ask before enabling does not add a new card.

## Quiesce automation ingress before unloading

The `omniChannels` host runtime exposes `await rt.quiesceOmniEvents()`. Call and await
this **before** initiating plugin unload or a controlled host restart, while the rest of
the plugin (including subscription permission hooks) remains installed. It permanently
stops this runtime's Omni event ingress; resuming requires a new runtime installation.
It does not disable subscriptions or delete server consumers.

Stopping is synchronous; the returned promise settles after pending load/configuration,
sync, stream and enrichment operations, entered subscription dispatches, acknowledgments
and cursor saves have settled. Repeated calls and the event effect's disposer return the
same promise. Whole-plugin unload may dispose other hooks concurrently: the async event
disposer alone is **not** the safe ingress-only boundary. `omniEventsView().listening: []`
means no active listeners, **not** that pending ingress work has drained.

Rows cancelled before their first subscription dispatch are not acknowledged and do not
advance the local cursor. Buffered rows are discarded and that stream exits. Once a row
has entered its first dispatch, it finishes its captured matching subscriptions (retaining
the existing warn-and-continue dispatch-error policy), then acknowledges and saves before
drain completes. Replacement listeners wait for the previous run of the same consumer to
settle. Failed acknowledgments do not advance the local cursor; a rejected local save
restores its previous in-memory cursor, allowing replay even if the server ack succeeded.
Drain completion means these operations settled, not that persistence succeeded.
The server's validated
monotonic-cursor 400 (this exact row is already behind its durable cursor) is treated as
already acknowledged, allowing a stale local cursor to catch up one processed row at a
time; generic 400s and other HTTP failures are not. Delivery is **at least once**, not
exactly once: cancellation or a failure before acknowledgment can replay a
row, including subscriptions that already dispatched. SSE reads alone do not acknowledge
rows; reconnects use the last locally acknowledged cursor via `Last-Event-ID`.

This is an ingress boundary, **not** a drain of downstream worker turns, bot tasks or
session followups already enqueued by a dispatch. It provides no forced-exit guarantee.
An external request or stream implementation that ignores abort must settle before the
promise can resolve; no deadline silently declares such work drained.

## Develop

```sh
npm ci               # esbuild and qrcode-generator, for the client bundle (see below)
bun run harness      # the pinned DSH release the tests and the linter run against
bun run test         # composes the team (the Automagik release apps/automagik.json pins) with this plugin, on Node
bun run lint
bun run build        # rewrites client.js and src/host/omni-routes.js; commit them
node scripts/build-client.mjs --check
```

The folder's own lockfile is npm's: Bun resolves every peer from the registry, and this plugin
peers on the Omni plugins, which ship through the Automagik market rather than npm.

`client.js` is generated from `src/client` and committed, so git and `link:` installs need
no build step. The tests load the team plugin from automagik-si/automagik at the release
`apps/automagik.json` pins (`node ../automagik.mjs source` fetches its `apps/bots-dsh` into
`apps/.automagik`; or `OMNI_DSH_CORE`): its `index.js`, its test context, and its committed
`client.js`.

| Path | Purpose |
|---|---|
| `index.js` | Host entry: the runtime on the team's, its modules in order |
| `src/host/` | The link (`omni-link`), reads (`omni`), Omni's tools (`omni-api`, `omni-routes`), events (`omni-events`), automations (`subscriptions`), rules (`omni-rules`) |
| `src/client/` | The Channels page, chats, automations page and board, call cards, Connect Omni; `core.js` is what it takes from the team's client |
| `client.js` | Built from `src/client/` by `scripts/build-client.mjs`; committed |
| `test/` | Unit tests; `team.js` composes the team with this plugin |

## License

[Apache-2.0](LICENSE)
