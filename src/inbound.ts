import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedInboundMessage, InboundMessageType } from "./types.js";

/**
 * LRU-ish idempotency cache. Backed by a Map (insertion-ordered in V8) so
 * we can evict the oldest entry when we exceed capacity without extra
 * bookkeeping. A Set would grow unbounded and leak memory under load.
 */
export class IdempotencyCache {
  private readonly store = new Map<string, number>();
  constructor(private readonly max: number = 1000) {}

  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Mark `key` as seen. Returns true if it was already known (caller should
   * skip processing) and false if this is the first time.
   */
  seen(key: string): boolean {
    if (this.store.has(key)) {
      // Refresh recency: re-insert so it moves to the end.
      this.store.delete(key);
      this.store.set(key, Date.now());
      return true;
    }
    this.store.set(key, Date.now());
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Verify Kapso's `X-Webhook-Signature` header. The signature is
 * HMAC-SHA256(secret, rawBody) encoded as lowercase hex.
 *
 * Uses `timingSafeEqual` to avoid leaking the secret via timing side-channels.
 * Returns false rather than throwing on malformed input so the caller can
 * handle all "rejected" cases uniformly.
 */
export function verifyWebhookSignature(params: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined | null;
  secret: string;
}): boolean {
  if (!params.signatureHeader) return false;
  // Tolerate a "sha256=" prefix (used by Meta-kind webhooks).
  const provided = params.signatureHeader.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const bodyBuffer = typeof params.rawBody === "string"
    ? Buffer.from(params.rawBody, "utf8")
    : params.rawBody;
  const expected = createHmac("sha256", params.secret).update(bodyBuffer).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided.toLowerCase(), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const KNOWN_TYPES: InboundMessageType[] = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "interactive",
  "button",
  "reaction",
];

function normalizeType(type: unknown): InboundMessageType {
  if (typeof type === "string" && (KNOWN_TYPES as string[]).includes(type)) {
    return type as InboundMessageType;
  }
  return "unknown";
}

function normalizeTimestamp(ts: unknown): string | undefined {
  if (typeof ts !== "string" && typeof ts !== "number") return undefined;
  const asNumber = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return undefined;
  const d = new Date(asNumber * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function toE164(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d+$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

type KapsoItem = {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  phone_number_id?: string;
};

/**
 * Split a raw Kapso webhook payload into the per-message items, handling
 * both v2 single (root-level `message`) and v2 batched (`data[]` with
 * `batch: true`) envelopes.
 */
export function extractItems(payload: unknown): KapsoItem[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("kapso webhook: payload must be a JSON object");
  }
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.data)) {
    return p.data.filter((i) => i && typeof i === "object") as KapsoItem[];
  }
  if (p.message && typeof p.message === "object") {
    return [p as KapsoItem];
  }
  throw new Error(
    "kapso webhook: payload must contain either a root-level 'message' or batched 'data[]'",
  );
}

/**
 * Translate a single Kapso item into an OpenClaw-native inbound message.
 * Returns null for events that should be silently dropped (outbound echoes,
 * origin `business_app` from the WhatsApp Business App UI, missing fields).
 */
export function normalizeItem(
  item: KapsoItem,
  accountId: string,
): NormalizedInboundMessage | null {
  const message = item.message;
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const kapso = (m.kapso && typeof m.kapso === "object" ? m.kapso : {}) as Record<string, unknown>;

  // Drop our own echoes and manual WA Business App sends.
  if (kapso.direction === "outbound") return null;
  if (kapso.origin === "business_app") return null;

  const from = toE164(m.from);
  const messageId = typeof m.id === "string" ? m.id : undefined;
  const timestamp = normalizeTimestamp(m.timestamp);
  if (!from || !messageId || !timestamp) return null;

  const type = normalizeType(m.type);

  // Text extraction with sensible fallbacks: text.body > transcript.text > kapso.content.
  let text: string | undefined;
  const textField = m.text;
  if (type === "text" && textField && typeof textField === "object") {
    const body = (textField as { body?: unknown }).body;
    if (typeof body === "string") text = body;
  }
  if (text === undefined) {
    const transcript = kapso.transcript as { text?: unknown } | undefined;
    if (transcript && typeof transcript.text === "string" && transcript.text.length > 0) {
      text = transcript.text;
    }
  }
  if (text === undefined && typeof kapso.content === "string" && kapso.content.length > 0) {
    text = kapso.content;
  }

  const mediaUrl = typeof kapso.media_url === "string" ? kapso.media_url : undefined;
  const mediaData = kapso.media_data as { content_type?: unknown } | undefined;
  const mediaMimeType = mediaData && typeof mediaData.content_type === "string"
    ? mediaData.content_type
    : undefined;

  // v2 path: conversation.kapso.contact_name. (The Limbo adapter had this wrong.)
  let fromName: string | undefined;
  const conversation = item.conversation;
  if (conversation && typeof conversation === "object") {
    const convKapso = (conversation as { kapso?: unknown }).kapso;
    if (convKapso && typeof convKapso === "object") {
      const cn = (convKapso as { contact_name?: unknown }).contact_name;
      if (typeof cn === "string") fromName = cn;
    }
    if (!fromName) {
      // Defensive: some older payloads flattened contact_name onto conversation.
      const flat = (conversation as { contact_name?: unknown }).contact_name;
      if (typeof flat === "string") fromName = flat;
    }
  }
  if (!fromName && typeof kapso.contact_name === "string") {
    fromName = kapso.contact_name;
  }

  const context = m.context as { id?: unknown; message_id?: unknown } | undefined;
  const replyToMessageId = context && typeof context === "object"
    ? (typeof context.id === "string"
      ? context.id
      : typeof context.message_id === "string"
        ? context.message_id
        : undefined)
    : undefined;

  const out: NormalizedInboundMessage = {
    channelId: "whatsapp-kapso",
    accountId,
    messageId,
    from,
    timestamp,
    type,
    raw: item,
  };
  if (text !== undefined) out.text = text;
  if (fromName !== undefined) out.fromName = fromName;
  if (mediaUrl !== undefined) out.mediaUrl = mediaUrl;
  if (mediaMimeType !== undefined) out.mediaMimeType = mediaMimeType;
  if (replyToMessageId !== undefined) out.replyToMessageId = replyToMessageId;
  return out;
}

export interface ParseWebhookInput {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  idempotency: IdempotencyCache;
  accountId: string;
}

export interface ParseWebhookResult {
  ok: boolean;
  reason?: "missing_signature" | "bad_signature" | "duplicate" | "bad_payload";
  messages: NormalizedInboundMessage[];
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

/**
 * End-to-end Kapso webhook parse: verify signature, dedupe by
 * X-Idempotency-Key, parse + normalize messages. Returns a structured result
 * so callers can respond with the right HTTP status (401 on bad sig, 200 on
 * duplicate, 200 on ok, 400 on bad payload).
 */
export function parseKapsoWebhook(input: ParseWebhookInput): ParseWebhookResult {
  const signature = headerValue(input.headers, "x-webhook-signature")
    ?? headerValue(input.headers, "x-hub-signature-256");
  if (!signature) return { ok: false, reason: "missing_signature", messages: [] };
  if (!verifyWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: signature,
    secret: input.secret,
  })) {
    return { ok: false, reason: "bad_signature", messages: [] };
  }

  const idempotencyKey = headerValue(input.headers, "x-idempotency-key");
  if (idempotencyKey && input.idempotency.seen(idempotencyKey)) {
    return { ok: true, reason: "duplicate", messages: [] };
  }

  let parsed: unknown;
  try {
    const bodyString = typeof input.rawBody === "string"
      ? input.rawBody
      : input.rawBody.toString("utf8");
    parsed = JSON.parse(bodyString);
  } catch {
    return { ok: false, reason: "bad_payload", messages: [] };
  }

  let items: KapsoItem[];
  try {
    items = extractItems(parsed);
  } catch {
    return { ok: false, reason: "bad_payload", messages: [] };
  }

  const messages: NormalizedInboundMessage[] = [];
  for (const item of items) {
    const normalized = normalizeItem(item, input.accountId);
    if (normalized) messages.push(normalized);
  }
  return { ok: true, messages };
}
