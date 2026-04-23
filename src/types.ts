/**
 * Internal type declarations for the Kapso WhatsApp plugin.
 */

export interface KapsoAccountConfig {
  apiKey: string;
  phoneNumberId: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  enabled?: boolean;
  name?: string;
}

export interface ResolvedKapsoAccount {
  accountId: string;
  config: KapsoAccountConfig;
}

export type InboundMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "interactive"
  | "button"
  | "reaction"
  | "unknown";

export interface NormalizedInboundMessage {
  channelId: "whatsapp-kapso";
  accountId: string;
  messageId: string;
  from: string;
  fromName?: string;
  timestamp: string;
  type: InboundMessageType;
  text?: string;
  /**
   * Fresh-at-delivery media URL from Kapso. EXPIRES IN 4-5 MINUTES.
   * Async consumers should ignore this and use `mediaId` + `fetchKapsoMedia`
   * / `downloadMediaBytes` to re-resolve a live URL.
   */
  mediaUrl?: string;
  mediaMimeType?: string;
  /**
   * Stable Kapso/Meta media id. Use this (not `mediaUrl`) for any work that
   * might run after the inbound HTTP request returns.
   */
  mediaId?: string;
  replyToMessageId?: string;
  raw: unknown;
}

export interface SendResult {
  channel: "whatsapp-kapso";
  messageId: string;
  chatId: string;
}

export type MediaKind = "image" | "audio" | "document" | "video" | "sticker";
