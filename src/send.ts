import { DEFAULT_KAPSO_BASE_URL, KAPSO_API_PATH } from "./config-schema.js";
import type { KapsoAccountConfig, MediaKind, SendResult } from "./types.js";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000; // clamp upstream-suggested waits

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 * Supports both delta-seconds (`"30"`) and HTTP-date formats.
 * Returns null if the header is missing or malformed.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs;
    return Math.max(0, Math.min(delta, MAX_RETRY_AFTER_MS));
  }
  return null;
}

export interface SendTextOptions {
  to: string;
  text: string;
  replyToMessageId?: string;
}

export interface SendMediaOptions {
  to: string;
  kind: MediaKind;
  link: string;
  caption?: string;
  filename?: string;
  replyToMessageId?: string;
}

export interface MarkReadOptions {
  messageId: string;
  typing?: boolean;
}

export interface KapsoClientDeps {
  /** Injected for testing — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for testing — defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * Normalize a phone number to the bare-digits form Meta / Kapso expect
 * on the send endpoint. Accepts `+` prefix and spaces as tolerated input.
 */
export function toKapsoPhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/^\+/, "").replace(/\s+/g, "");
  if (!/^\d+$/.test(digits)) {
    throw new Error(`invalid phone number: ${raw}`);
  }
  return digits;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a Kapso API client bound to a specific account configuration.
 * The client is stateless beyond its config + retry policy; safe to share.
 */
export function createKapsoClient(
  account: KapsoAccountConfig,
  deps: KapsoClientDeps = {},
) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const baseUrl = (account.apiBaseUrl ?? DEFAULT_KAPSO_BASE_URL).replace(/\/+$/, "");
  const sendUrl = `${baseUrl}${KAPSO_API_PATH}/${encodeURIComponent(account.phoneNumberId)}/messages`;

  async function postJson(body: unknown): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(sendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": account.apiKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries) break;
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      const rawText = await res.text();
      if (res.ok) {
        if (!rawText) return {};
        try {
          return JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          throw new Error(`kapso: non-JSON response body: ${rawText.slice(0, 200)}`);
        }
      }
      if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const backoffMs = retryAfterMs ?? BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoffMs);
        continue;
      }
      throw new Error(`kapso: HTTP ${res.status} — ${rawText.slice(0, 500)}`);
    }
    throw lastError ?? new Error("kapso: exhausted retries");
  }

  function extractMessageId(parsed: Record<string, unknown>): string {
    const messages = parsed["messages"];
    if (Array.isArray(messages) && messages.length > 0) {
      const first = messages[0];
      if (first && typeof first === "object" && typeof (first as { id?: unknown }).id === "string") {
        return (first as { id: string }).id;
      }
    }
    throw new Error(`kapso: response missing messages[0].id — ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  async function sendText(opts: SendTextOptions): Promise<SendResult> {
    const to = toKapsoPhoneNumber(opts.to);
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: opts.text },
    };
    if (opts.replyToMessageId) {
      body.context = { message_id: opts.replyToMessageId };
    }
    const parsed = await postJson(body);
    return { channel: "whatsapp-kapso", messageId: extractMessageId(parsed), chatId: to };
  }

  async function sendMedia(opts: SendMediaOptions): Promise<SendResult> {
    const to = toKapsoPhoneNumber(opts.to);
    const mediaField: Record<string, unknown> = { link: opts.link };
    if (opts.caption && (opts.kind === "image" || opts.kind === "video" || opts.kind === "document")) {
      mediaField.caption = opts.caption;
    }
    if (opts.filename && opts.kind === "document") {
      mediaField.filename = opts.filename;
    }
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: opts.kind,
      [opts.kind]: mediaField,
    };
    if (opts.replyToMessageId) {
      body.context = { message_id: opts.replyToMessageId };
    }
    const parsed = await postJson(body);
    return { channel: "whatsapp-kapso", messageId: extractMessageId(parsed), chatId: to };
  }

  async function markRead(opts: MarkReadOptions): Promise<void> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: opts.messageId,
    };
    if (opts.typing) {
      body.typing_indicator = { type: "text" };
    }
    await postJson(body);
  }

  return { sendText, sendMedia, markRead, sendUrl };
}

export type KapsoClient = ReturnType<typeof createKapsoClient>;
