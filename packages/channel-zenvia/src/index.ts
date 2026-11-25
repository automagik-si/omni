import { ZenviaPlugin } from './plugin';

const plugin = new ZenviaPlugin();
export default plugin;

export { ZenviaPlugin } from './plugin';

export { ZENVIA_CAPABILITIES } from './capabilities';

export { ZenviaClient, DEFAULT_ZENVIA_BASE_URL } from './client';
export type { ZenviaClientOptions } from './client';
export { ZenviaSalesClient, DEFAULT_ZENVIA_SALES_BASE_URL } from './sales-client';
export type { ZenviaSalesClientOptions, ZenviaTransferTarget } from './sales-client';

export { handleZenviaEvent, handleZenviaWebhookRequest } from './handlers/webhook';
export { handleZenviaConnectorWebhookRequest, MAX_CONNECTOR_BODY_BYTES } from './handlers/connector-webhook';

export { ZenviaConnectorClient, DEFAULT_ZENVIA_CONNECTOR_BASE_URL } from './connector/client';
export type { ZenviaConnectorClientOptions } from './connector/client';
export { signConnectorToken, verifyConnectorToken } from './connector/jwt';
export type { ConnectorTokenCheck, ConnectorTokenFailure } from './connector/jwt';
export { ZENVIA_CONNECTOR_ENVS } from './connector/types';
export type { ZenviaConnectorConfig, ZenviaConnectorEnv } from './connector/types';
export { connectorPhone } from './connector/mapping';
export { NO_OPEN_LIVE_CHAT_ERROR } from './connector/runtime';

export {
  normalizeRoutingValue,
  parseHandoffRouting,
  resolveHandoffGroup,
  zenviaHandoffRoutingSchema,
} from './handoff-routing';
export type { HandoffGroupResolution, HandoffRoutingMiss, ZenviaHandoffRouting } from './handoff-routing';

export {
  buildHandoffNote,
  buildHandoffRouting,
  resolveHandoffMode,
  HANDOFF_NOT_CONFIGURED_ERROR,
} from './utils/handoff';
export type { ZenviaHandoffMode } from './utils/handoff';

export { ZenviaApiError, ZenviaErrorCode, mapHttpStatusToZenviaError, isRetryable } from './utils/errors';
export type { ZenviaErrorCodeType, ZenviaApiErrorContext } from './utils/errors';

export { toZenviaPhone } from './utils/identity';

export { ZENVIA_HANDOFF_SOLUTIONS } from './types';
export type {
  ZenviaConfig,
  ZenviaConversationRouting,
  ZenviaHandoffSolution,
  ZenviaInboundMessage,
  ZenviaOutboundContent,
  ZenviaOutboundMessage,
  ZenviaSendResponse,
} from './types';
