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
     * startAccount wires the inbound webhook handler. Because Kapso is push-based
     * (HTTP webhooks), we don't open a long-poll — instead we return a handler
     * the host can hang off its HTTP gateway, plus a promise that resolves when
     * the host aborts (shutdown).
     *
     * The host is expected to call `webhookHandler` with the raw request body
     * + headers; we do signature verification and idempotency dedupe inline.
     */
    startAccount: async (ctx: {
      account: ResolvedKapsoAccount;
      abortSignal?: AbortSignal;
      log?: { info?: (m: string) => void; error?: (m: string) => void };
      dispatch?: (message: unknown) => Promise<void> | void;
    }) => {
      const idempotency = new IdempotencyCache(1000);
      ctx.log?.info?.(`[${ctx.account.accountId}] kapso channel ready (webhook-based)`);

      const webhookHandler = async (
        rawBody: Buffer | string,
        headers: Record<string, string | string[] | undefined>,
      ) => {
        const result = parseKapsoWebhook({
          rawBody,
          headers,
          secret: ctx.account.config.webhookSecret,
          idempotency,
          accountId: ctx.account.accountId,
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

      // Keep the gateway "alive" until abort — matches VK's long-poll pattern.
      const done = new Promise<void>((resolve) => {
        if (!ctx.abortSignal) return;
        if (ctx.abortSignal.aborted) return resolve();
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      return { webhookHandler, done };
    },
    logoutAccount: async () => {
      // Stateless — nothing to revoke on our side. Kapso API keys are managed
      // in their dashboard.
    },
  },
};

export type KapsoPlugin = typeof kapsoPlugin;
