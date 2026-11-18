/**
 * GitHub connector types: the provisional event names, the GitHub delivery
 * fields this connector reads, and the payloads it publishes.
 *
 * The delivery schemas read only the fields a payload carries; everything else
 * GitHub sends is left unread. Issue and pull-request body text is never read,
 * so it can never be published.
 */

import { z } from 'zod';

/**
 * PROVISIONAL event names: the event vocabulary has no owner yet. Every name
 * this connector publishes is `${GITHUB_EVENT_NAMES[X-GitHub-Event]}.${action}`,
 * so a rename is this one edit.
 */
export const GITHUB_EVENT_NAMES = {
  issues: 'connector.github.issue',
  pull_request: 'connector.github.pull_request',
} as const;

export type GitHubPublishedEvent = keyof typeof GITHUB_EVENT_NAMES;

/** GitHub actions are snake_case words (`opened`, `ready_for_review`); anything else is refused. */
const ActionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'GitHub action must be a snake_case word');

const LabelSchema = z.object({ name: z.string() }).passthrough();

/** The fields shared by an issue and a pull request in a delivery. */
const ItemSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string().min(1),
    html_url: z.string().url(),
    // GitHub can send a null user (for example a deleted account).
    user: z
      .object({ login: z.string().min(1) })
      .passthrough()
      .nullish(),
    labels: z.array(LabelSchema).nullish(),
  })
  .passthrough();

const RepositorySchema = z.object({ full_name: z.string().min(1) }).passthrough();

/** `X-GitHub-Event: issues` body, as far as this connector reads it. */
export const GitHubIssuesDeliverySchema = z
  .object({ action: ActionSchema, issue: ItemSchema, repository: RepositorySchema })
  .passthrough();

/** `X-GitHub-Event: pull_request` body, as far as this connector reads it. */
export const GitHubPullRequestDeliverySchema = z
  .object({
    action: ActionSchema,
    pull_request: ItemSchema.extend({ merged: z.boolean().nullish() }),
    repository: RepositorySchema,
  })
  .passthrough();

/** Published for `connector.github.issue.<action>`: ids and facts only. */
export const GitHubIssueEventPayloadSchema = z
  .object({
    /** `X-GitHub-Delivery`, also the idempotent provider event id. */
    deliveryId: z.string().min(1).max(128),
    action: ActionSchema,
    /** `owner/repo`. */
    repository: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string().min(1),
    htmlUrl: z.string().url(),
    /** The author's login, or null when GitHub sends no user. */
    author: z.string().min(1).nullable(),
    labels: z.array(z.string()),
  })
  .strict();

/** Published for `connector.github.pull_request.<action>`; a merge is `closed` with `merged: true`. */
export const GitHubPullRequestEventPayloadSchema = GitHubIssueEventPayloadSchema.extend({
  merged: z.boolean(),
}).strict();

export type GitHubIssueEventPayload = z.infer<typeof GitHubIssueEventPayloadSchema>;
export type GitHubPullRequestEventPayload = z.infer<typeof GitHubPullRequestEventPayloadSchema>;
