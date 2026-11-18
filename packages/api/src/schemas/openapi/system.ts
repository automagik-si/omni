/**
 * OpenAPI schemas for this Omni's version and the updates its owner confirms
 * (routes/v2/system.ts, system/update.ts).
 */

import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../lib/zod-openapi';
import { ErrorSchema } from './common';

const error = (description: string) => ({ description, content: { 'application/json': { schema: ErrorSchema } } });
const ok = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { 'application/json': { schema: z.object({ data: schema }) } },
});

export const UpdateStatusSchema = z
  .object({
    current: z.string().openapi({ description: 'The version this Omni runs' }),
    channel: z.enum(['latest', 'next']).openapi({ description: 'The npm dist-tag this Omni follows' }),
    latest: z
      .string()
      .nullable()
      .openapi({ description: 'What the channel publishes now; null when the registry could not be read' }),
    updateAvailable: z.boolean(),
    mode: z.enum(['off', 'command']).openapi({ description: 'off: the operator has not set OMNI_UPDATE_COMMAND' }),
    confirm: z.enum(['whatsapp', 'app']).openapi({
      description:
        "Who says yes: whatsapp, the owner's `update <CODE>`; app, the request itself (a loopback-only Omni " +
        'whose operator set OMNI_UPDATE_CONFIRM=app, such as a sandbox)',
    }),
    pending: z
      .object({ version: z.string(), expiresAt: z.string().datetime() })
      .optional()
      .openapi({ description: 'An update waiting for the owner to confirm it on WhatsApp' }),
    inFlight: z
      .object({ version: z.string(), startedAt: z.string().datetime() })
      .optional()
      .openapi({ description: 'An update the owner confirmed that has not finished' }),
  })
  .openapi('UpdateStatus');

export const PairedAgentsStatusSchema = z
  .object({
    consumers: z.object({
      flag: z.literal('OMNI_PAIRED_AGENT_CONSUMERS'),
      enabled: z.boolean(),
      reason: z.enum(['flag_unset', 'multitenancy_enabled']).nullable(),
    }),
  })
  .openapi('PairedAgentsStatus');

const TwoResponderConsumerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  eventType: z.string().openapi({ description: 'The consumer type filter (exact type or trailing-* glob)' }),
  lastMovedAt: z.string().datetime().openapi({
    description: 'When the consumer updated_at last moved: an ack, a skipped page, a shared lease, or the create',
  }),
  reader: z.enum(['owner-key', 'owning-agent', 'unrecorded']).openapi({
    description:
      'owner-key: the stored owner key may send on the instance (active, unexpired, messages:send, instance ' +
      'allowed). owning-agent: an agent-owned consumer whose agent is active. unrecorded: no owner key is ' +
      'stored, so any instance-unrestricted key with events:write may pull it',
  }),
  ownerKeyId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable().openapi({ description: 'The agent that owns the consumer, if any' }),
  sameAgent: z.boolean().openapi({
    description: "The consumer belongs to the instance's own agent: that agent gets each message on both paths",
  }),
});

export const TwoRespondersSchema = z
  .object({
    activeWindowDays: z.number().int().positive().openapi({
      description: 'A consumer counts only when its updated_at moved within this many days',
    }),
    instances: z.array(
      z.object({
        instanceId: z.string().uuid(),
        instanceName: z.string(),
        channel: z.string(),
        agentId: z.string().uuid(),
        agentName: z.string(),
        consumers: z.array(TwoResponderConsumerSchema).min(1),
      }),
    ),
  })
  .openapi('TwoResponders');

export function registerSystemSchemas(registry: OpenAPIRegistry): void {
  registry.register('UpdateStatus', UpdateStatusSchema);
  registry.register('PairedAgentsStatus', PairedAgentsStatusSchema);
  registry.register('TwoResponders', TwoRespondersSchema);
  registry.registerPath({
    method: 'get',
    path: '/system/paired-agents',
    operationId: 'getPairedAgentsStatus',
    tags: ['System'],
    summary: 'Paired-agent feature status',
    description: 'Effective paired-agent consumer flag and OFF reason. Needs system:read.',
    responses: { 200: ok(PairedAgentsStatusSchema, 'Paired-agent status'), 403: error('Needs system:read') },
  });

  registry.registerPath({
    method: 'get',
    path: '/system/two-responders',
    operationId: 'getTwoResponders',
    tags: ['System'],
    summary: 'Instances two responders may answer',
    description:
      'Read-only. Lists each instance the caller key may see where an active instance agent is set (so Omni ' +
      'answers its trigger messages) and at least one active durable consumer receives those messages and has ' +
      'a reader that may send on the instance, so an attached app may answer the same person again. Writes ' +
      'nothing. Needs system:read.',
    responses: { 200: ok(TwoRespondersSchema, 'Flagged instances'), 403: error('Needs system:read') },
  });

  registry.registerPath({
    method: 'get',
    path: '/system/update',
    operationId: 'getUpdateStatus',
    tags: ['System'],
    summary: 'Version and update status',
    description:
      'What this Omni runs, what its update channel publishes, and any update waiting or running. Needs ' +
      'system:read (device keys carry it by default).',
    responses: { 200: ok(UpdateStatusSchema, 'Update status') },
  });

  registry.registerPath({
    method: 'post',
    path: '/system/update',
    operationId: 'requestUpdate',
    tags: ['System'],
    summary: 'Ask for an update the owner confirms',
    description:
      'Asks this Omni to update to the version its channel publishes now. Nothing changes yet: the owner gets ' +
      '"Update Omni from X to Y? Reply update <CODE>" in their own WhatsApp self chat, and only that reply, ' +
      "within ten minutes, runs the operator's OMNI_UPDATE_COMMAND. On an Omni that listens only on loopback and " +
      'whose operator set OMNI_UPDATE_CONFIRM=app (a sandbox), the request is the yes: the app asked the person ' +
      'on screen, and the update starts at once. Off unless the operator set OMNI_UPDATE_COMMAND. Needs ' +
      'system:update (device keys carry it by default) or system:admin.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              version: z.string().openapi({ description: 'Exactly the version the channel publishes now' }),
            }),
          },
        },
      },
    },
    responses: {
      202: ok(
        z.discriminatedUnion('status', [
          z.object({
            status: z.literal('awaiting-confirmation'),
            version: z.string(),
            expiresAt: z.string().datetime(),
          }),
          z.object({ status: z.literal('started'), version: z.string(), startedAt: z.string().datetime() }),
        ]),
        "Waiting for the owner's yes on WhatsApp, or started (confirm: app)",
      ),
      400: error('Malformed body'),
      409: error(
        'UPDATE_NOT_CONFIGURED, CONFIRM_CHANNEL_MISSING, UPDATE_PENDING, UPDATE_IN_PROGRESS, VERSION_MISMATCH or ALREADY_CURRENT',
      ),
      502: error('CONFIRM_SEND_FAILED: the owner could not be reached on WhatsApp'),
      503: error(
        'REGISTRY_UNAVAILABLE: the update channel could not be read; UPDATE_START_FAILED: the command could not start',
      ),
    },
  });
}
