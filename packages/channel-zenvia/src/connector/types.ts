import { z } from 'zod';

export const ZENVIA_CONNECTOR_ENVS = ['homol', 'prod'] as const;
export type ZenviaConnectorEnv = (typeof ZENVIA_CONNECTOR_ENVS)[number];

export interface ZenviaConnectorConfig {
  slug: string;
  integrationId: string;
  accessToken: string;
  accessKey: string;
  env?: ZenviaConnectorEnv;
}

const looseId = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .optional()
  .catch(undefined);

const looseString = z.string().optional().catch(undefined);

export const ConnectorHistoryEntrySchema = z
  .object({
    sender: looseString,
    time: looseString,
    message: z.unknown().optional(),
  })
  .passthrough();
export type ConnectorHistoryEntry = z.infer<typeof ConnectorHistoryEntrySchema>;

export const ConnectorContactSchema = z
  .object({
    id: looseId,
    name: looseString,
    phone: looseId,
    channel: looseString,
    extra: z.record(z.unknown()).optional().catch(undefined),
    history: z.array(ConnectorHistoryEntrySchema).optional().catch(undefined),
  })
  .passthrough();
export type ConnectorContact = z.infer<typeof ConnectorContactSchema>;

export const ConnectorEventSchema = z
  .object({
    action: z.string().min(1),
    conversationId: looseString,
    conversationID: looseString,
    requestId: looseString,
    identifier: looseString,
    fileId: looseString,
    timestamp: z.union([z.number(), z.string()]).optional().catch(undefined),
    parameters: z.record(z.unknown()).optional().catch(undefined),
    file: z.record(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>;

export const ConnectorOpenParametersSchema = z
  .object({
    contact: ConnectorContactSchema.optional().catch(undefined),
    extraInfo: z.unknown().optional(),
  })
  .passthrough();

export const ConnectorMessageParametersSchema = z
  .object({
    contact: ConnectorContactSchema.optional().catch(undefined),
    messages: z.array(z.unknown()).optional().catch(undefined),
    location: z.object({ latitude: z.number(), longitude: z.number() }).passthrough().optional().catch(undefined),
    type: looseString,
  })
  .passthrough();

const ConnectorSentFileSchema = z
  .object({
    id: looseId,
    name: looseString,
    contentType: looseString,
    type: looseString,
    size: z.number().optional().catch(undefined),
    caption: looseString,
  })
  .passthrough();

export const ConnectorSendFileParametersSchema = z
  .object({
    contact: ConnectorContactSchema.optional().catch(undefined),
    file: ConnectorSentFileSchema.optional().catch(undefined),
  })
  .passthrough();

export const ConnectorUploadedFileSchema = z
  .object({
    contentType: looseString,
    name: looseString,
    buffer: z.unknown(),
  })
  .passthrough();

export const ConnectorResponseSchema = z
  .object({
    requestId: looseString,
    message: looseString,
    fileId: looseId,
    file: z.record(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
export type ConnectorResponse = z.infer<typeof ConnectorResponseSchema>;

export interface ConnectorAgent {
  id: string;
  name: string;
}
