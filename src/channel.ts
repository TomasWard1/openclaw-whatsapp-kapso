import type { IncomingMessage, ServerResponse } from "node:http";

import { KapsoConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  listKapsoAccountIds,
  resolveDefaultKapsoAccountId,
  resolveKapsoAccount,
} from "./accounts.js";
import { createKapsoClient } from "./send.js";
import { IdempotencyCache, parseKapsoWebhook } from "./inbound.js";
import type { ResolvedKapsoAccount, SendResult } from "./types.js";

/**
 * OpenClaw plugin-sdk surface used to mount the webhook on the gateway. We
 * load it lazily via dynamic import so consumers that only use `outbound` (or
 * the plugin metadata) don't pay the cost or hard-require the host. If the
 * SDK is not available at runtime we fall back to the handler-only return
 * (legacy mode) so the plugin still works against older hosts.
 */
interface OpenclawWebhookIngressSdk {
  registerPluginHttpRoute: (params: {
    path?: string | null;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "public" | "bearer" | "plugin";
    match?: "exact" | "prefix";
    pluginId?: string;
    source?: string;
    accountId?: string;
    log?: (m: string) => void;
    replaceExisting?: boolean;
  }) => () => void;
  applyBasicWebhookRequestGuards: (params: {
    req: IncomingMessage;
    res: ServerResponse;
    allowMethods?: readonly string[];
    rateLimiter?: unknown;
    rateLimitKey?: string;
    requireJsonContentType?: boolean;
  }) => boolean;
  readRequestBodyWithLimit: (
    req: IncomingMessage,
    options: { maxBytes: number; timeoutMs?: number; encoding?: BufferEncoding },
  ) => Promise<string>;
  isRequestBodyLimitError: (err: unknown) => boolean;
  requestBodyErrorToText: (err: unknown) => string;
  createFixedWindowRateLimiter: (options: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
  }) => unknown;
  WEBHOOK_RATE_LIMIT_DEFAULTS: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
  };
}

let sdkPromise: Promise<OpenclawWebhookIngressSdk | null> | null = null;
async function loadWebhookIngressSdk(): Promise<OpenclawWebhookIngressSdk | null> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    try {
      // Prefer the public SDK entry. Older hosts may not ship it — in that case
      // we return null and let the caller keep the handler-only return path.
      const mod = (await import(
        // @ts-expect-error — host-provided, resolved at runtime
        "openclaw/plugin-sdk/webhook-ingress"
      )) as unknown as OpenclawWebhookIngressSdk;
      if (typeof mod?.registerPluginHttpRoute !== "function") return null;
      return mod;
    } catch {
      return null;
    }
  })();
  return sdkPromise;
}

// Shared across all accounts — one bucket of IP-scoped tokens. Using the
// host SDK defaults keeps this aligned with Zalo/Mattermost/etc.
let sharedRateLimiter: unknown | null = null;

const WEBHOOK_MAX_BODY_BYTES = 1_048_576; // 1 MiB — generous for Kapso v2 payloads (media pointers only)
const WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function normalizeAccountIdForPath(accountId: string): string {
  // Only allow [a-z0-9-_] in the URL segment; anything else collapses to "_"
  // so two distinct raw ids never collide inside a single url.
  return accountId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function webhookPathForAccount(accountId: string): string {
  return `/webhooks/whatsapp-kapso/${normalizeAccountIdForPath(accountId)}`;
}

const CHANNEL_ID = "whatsapp-kapso";

const meta = {
  id: CHANNEL_ID,
  label: "WhatsApp (Kapso)",
  selectionLabel: "WhatsApp via Kapso",
  detailLabel: "WhatsApp (Kapso)",
  docsPath: "/channels/whatsapp-kapso",
  docsLabel: "whatsapp-kapso",
  blurb: "WhatsApp Business Cloud API via Kapso — webhooks, media, and sandbox support.",
  systemImage: "message.fill",
};

const capabilities = {
  chatTypes: ["direct"] as const,
  reactions: true,
  threads: false,
  media: true,
  nativeCommands: false,
  // WhatsApp has no streaming edit API — hosts should buffer the full reply
  // before sending, same as Telegram/VK.
  blockStreaming: true,
} as const;

/**
 * The ChannelPlugin shape is structural by design — we describe the adapters
 * the plugin provides; the host's SDK types may evolve, but as long as this
 * object satisfies them at registration time we stay decoupled.
 */
export const kapsoPlugin = {
  id: CHANNEL_ID,
  meta,
  capabilities,
  configSchema: KapsoConfigSchema,

  config: {
    sectionKey: CHANNEL_ID,
    listAccountIds: (cfg: unknown) => {
      const parsed = KapsoConfigSchema.safeParse(cfg);
      return parsed.success ? listKapsoAccountIds(parsed.data) : [];
    },
    resolveAccount: (params: { cfg: unknown; accountId?: string }): ResolvedKapsoAccount | undefined => {
      const parsed = KapsoConfigSchema.safeParse(params.cfg);
      if (!parsed.success) return undefined;
      return resolveKapsoAccount(parsed.data, params.accountId ?? DEFAULT_ACCOUNT_ID);
    },
    defaultAccountId: (cfg: unknown) => {
      const parsed = KapsoConfigSchema.safeParse(cfg);
      return parsed.success ? resolveDefaultKapsoAccountId(parsed.data) : undefined;
    },
    isConfigured: (account: ResolvedKapsoAccount | undefined) =>
      Boolean(account?.config.apiKey && account.config.phoneNumberId && account.config.webhookSecret),
    describeAccount: (account: ResolvedKapsoAccount) => ({
      accountId: account.accountId,
      name: account.config.name ?? account.accountId,
      enabled: account.config.enabled !== false,
      configured: true,
      phoneNumberId: account.config.phoneNumberId,
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,
    sendText: async (params: {
      account: ResolvedKapsoAccount;
      to: string;
      text: string;
      replyToId?: string | null;
    }): Promise<SendResult> => {
      const client = createKapsoClient(params.account.config);
      return client.sendText({
        to: params.to,
        text: params.text,
        replyToMessageId: params.replyToId ?? undefined,
      });
    },
    sendMedia: async (params: {
      account: ResolvedKapsoAccount;
      to: string;
      kind: "image" | "audio" | "video" | "document" | "sticker";
      mediaUrl: string;
      caption?: string;
      filename?: string;
      replyToId?: string | null;
    }): Promise<SendResult> => {
      const client = createKapsoClient(params.account.config);
      return client.sendMedia({
        to: params.to,
        kind: params.kind,
        link: params.mediaUrl,
        caption: params.caption,
        filename: params.filename,
        replyToMessageId: params.replyToId ?? undefined,
      });
    },
  },

  gateway: {
    /**
     * startAccount mounts the inbound webhook route on the host's gateway via
     * the OpenClaw plugin-sdk `registerPluginHttpRoute` API. Kapso POSTs
     * webhooks directly to `/webhooks/whatsapp-kapso/<accountId>` on the
     * gateway's public HTTP port.
     *
     * Security posture:
     *   - Method restriction (POST only) and JSON content-type check via the
     *     host's shared `applyBasicWebhookRequestGuards`.
     *   - Shared rate limiter (per-account-path × client IP) to bound abuse.
     *   - Body size cap at 1 MiB with a 30s read timeout so slow-loris requests
     *     don't hold connections open.
     *   - HMAC signature verification via `parseKapsoWebhook` (timing-safe
     *     compare inside `verifyWebhookSignature`). Requests without a valid
     *     `x-webhook-signature` / `x-hub-signature-256` header are rejected
     *     with 401 before any dispatch happens.
     *   - Idempotency dedupe (bounded LRU) so Kapso retries don't double-dispatch.
     *   - Per-account path isolation prevents account A's secret from being
     *     used to forge events for account B.
     *
     * Backwards-compat: if the host is an older OpenClaw that doesn't export
     * `openclaw/plugin-sdk/webhook-ingress`, we fall back to returning the
     * legacy `{ webhookHandler, done }` shape so hosts that already drive the
     * handler directly keep working.
     */
    startAccount: async (ctx: {
      account: ResolvedKapsoAccount;
      abortSignal?: AbortSignal;
      log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
      dispatch?: (message: unknown) => Promise<void> | void;
    }) => {
      const idempotency = new IdempotencyCache(1000);
      const accountId = ctx.account.accountId;
      const path = webhookPathForAccount(accountId);

      const webhookHandler = async (
        rawBody: Buffer | string,
        headers: Record<string, string | string[] | undefined>,
      ) => {
        const result = parseKapsoWebhook({
          rawBody,
          headers,
          secret: ctx.account.config.webhookSecret,
          idempotency,
          accountId,
        });
        if (!result.ok) {
          return { status: result.reason === "bad_signature" || result.reason === "missing_signature" ? 401 : 400 };
        }
        if (ctx.dispatch) {
          for (const m of result.messages) {
            try {
              await ctx.dispatch(m);
            } catch (err) {
              ctx.log?.error?.(`dispatch failed: ${String(err)}`);
            }
          }
        }
        return { status: 200, delivered: result.messages.length };
      };

      const sdk = await loadWebhookIngressSdk();
      let unregisterHttpRoute: (() => void) | null = null;

      if (sdk) {
        if (!sharedRateLimiter) {
          sharedRateLimiter = sdk.createFixedWindowRateLimiter({
            windowMs: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
            maxRequests: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
            maxTrackedKeys: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
          });
        }

        const httpHandler = async (req: IncomingMessage, res: ServerResponse) => {
          const remoteAddr = req.socket.remoteAddress ?? "unknown";
          const rateLimitKey = `${path}:${remoteAddr}`;

          if (!sdk.applyBasicWebhookRequestGuards({
            req,
            res,
            allowMethods: ["POST"],
            rateLimiter: sharedRateLimiter ?? undefined,
            rateLimitKey,
            requireJsonContentType: true,
          })) {
            return true;
          }

          let rawBody: string;
          try {
            rawBody = await sdk.readRequestBodyWithLimit(req, {
              maxBytes: WEBHOOK_MAX_BODY_BYTES,
              timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
              encoding: "utf8",
            });
          } catch (err) {
            if (res.headersSent) return true;
            if (sdk.isRequestBodyLimitError(err)) {
              res.statusCode = 413;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end(sdk.requestBodyErrorToText(err));
              return true;
            }
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("bad request");
            return true;
          }

          const parsed = parseKapsoWebhook({
            rawBody,
            headers: req.headers,
            secret: ctx.account.config.webhookSecret,
            idempotency,
            accountId,
          });

          if (!parsed.ok) {
            const status =
              parsed.reason === "bad_signature" || parsed.reason === "missing_signature"
                ? 401
                : 400;
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: parsed.reason }));
            return true;
          }

          // ACK fast, then dispatch in the background. Kapso enforces short
          // webhook timeouts; agent latency can be minutes under tool chains.
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, delivered: parsed.messages.length }));

          if (ctx.dispatch) {
            for (const m of parsed.messages) {
              Promise.resolve()
                .then(() => ctx.dispatch!(m))
                .catch((err) => ctx.log?.error?.(`[${accountId}] dispatch failed: ${String(err)}`));
            }
          }

          return true;
        };

        unregisterHttpRoute = sdk.registerPluginHttpRoute({
          path,
          auth: "public",
          pluginId: "whatsapp-kapso",
          source: "whatsapp-kapso-inbound",
          accountId,
          log: (m) => ctx.log?.info?.(m),
          handler: httpHandler,
        });

        ctx.log?.info?.(
          `[${accountId}] kapso channel ready — webhook mounted at ${path}`,
        );
      } else {
        ctx.log?.info?.(
          `[${accountId}] kapso channel ready (legacy handler-only mode — host did not expose plugin-sdk/webhook-ingress)`,
        );
      }

      // Resolves when the host aborts — triggers HTTP route cleanup.
      const done = new Promise<void>((resolve) => {
        const finish = () => {
          if (unregisterHttpRoute) {
            try { unregisterHttpRoute(); } catch (err) {
              ctx.log?.warn?.(`[${accountId}] unregister webhook route failed: ${String(err)}`);
            }
            unregisterHttpRoute = null;
          }
          resolve();
        };
        if (!ctx.abortSignal) return;
        if (ctx.abortSignal.aborted) return finish();
        ctx.abortSignal.addEventListener("abort", finish, { once: true });
      });

      return { webhookHandler, done, webhookPath: path };
    },
    logoutAccount: async () => {
      // Stateless — nothing to revoke on our side. Kapso API keys are managed
      // in their dashboard.
    },
  },
};

export type KapsoPlugin = typeof kapsoPlugin;
