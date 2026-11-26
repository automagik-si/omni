-- Zenvia channel — live chat (Zenvia NLU Agent Connector) configuration.
--
-- Adds the five instance columns the `@omni/channel-zenvia` plugin reads when
-- an instance runs as a live chat behind a Zenvia NLU bot instead of talking
-- to the Channels API (PR #1824):
--   * zenvia_connector_slug            — account slug of the connector
--                                        endpoint; setting it selects the mode
--   * zenvia_connector_integration_id  — live chat integration id
--   * zenvia_connector_access_token    — integration access token (the JWT
--                                        `access_token` claim); sealed at rest
--   * zenvia_connector_access_key      — integration access key (the HS256
--                                        signing key); sealed at rest
--   * zenvia_connector_env             — optional `homol` | `prod` webhook
--
-- Hand-written following the 0043/0044/0052 precedent (additive, idempotent,
-- no rewrite: ADD COLUMN with no default does not rewrite the table).

ALTER TABLE "instances"
  ADD COLUMN IF NOT EXISTS "zenvia_connector_slug" varchar(128),
  ADD COLUMN IF NOT EXISTS "zenvia_connector_integration_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "zenvia_connector_access_token" text,
  ADD COLUMN IF NOT EXISTS "zenvia_connector_access_key" text,
  ADD COLUMN IF NOT EXISTS "zenvia_connector_env" varchar(16);
