/**
 * Public API surface for consumers embedding / extending the plugin.
 */
export {
  listKapsoAccountIds,
  resolveDefaultKapsoAccountId,
  resolveKapsoAccount,
  DEFAULT_ACCOUNT_ID,
} from "./src/accounts.js";

export { kapsoPlugin } from "./src/channel.js";
export { kapsoSetupPlugin, kapsoWebhookUrl } from "./src/setup-core.js";
export {
  KapsoAccountSchema,
  KapsoConfigSchema,
  DEFAULT_KAPSO_BASE_URL,
  KAPSO_API_PATH,
} from "./src/config-schema.js";
export type { KapsoConfig, KapsoAccount } from "./src/config-schema.js";
export { createKapsoClient, toKapsoPhoneNumber, parseRetryAfter } from "./src/send.js";
export { fetchKapsoMedia, downloadMediaBytes } from "./src/media.js";
export type {
  KapsoMediaMetadata,
  KapsoMediaBytes,
  FetchKapsoMediaInput,
} from "./src/media.js";
export {
  parseKapsoWebhook,
  verifyWebhookSignature,
  IdempotencyCache,
  extractItems,
  normalizeItem,
} from "./src/inbound.js";
export type {
  KapsoAccountConfig,
  ResolvedKapsoAccount,
  NormalizedInboundMessage,
  SendResult,
  InboundMessageType,
  MediaKind,
} from "./src/types.js";
