-- Zenvia channel — live chat (Zenvia NLU Agent Connector) reopen window.
--
-- Adds the instance column the `@omni/channel-zenvia` plugin reads to reopen
-- a live chat that Zenvia NLU closed (contact inactivity or the contact):
--   * zenvia_connector_reopen_expiration_minutes — expirationTime, in minutes,
--     of the REOPEN_CONVERSATION a send to a closed live chat issues. NULL
--     keeps reopening off, so such a send is refused.
--
-- Hand-written following the 0043/0044/0052 precedent (additive, idempotent,
-- no rewrite: ADD COLUMN with no default does not rewrite the table).

ALTER TABLE "instances"
  ADD COLUMN IF NOT EXISTS "zenvia_connector_reopen_expiration_minutes" integer;
