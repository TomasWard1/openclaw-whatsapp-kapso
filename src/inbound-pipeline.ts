/**
 * Native inbound pipeline — constructs the envelope, records the session,
 * and dispatches through OpenClaw's channel runtime so cron "announce to
 * last channel" (and everything else that consults the session store)
 * knows a `whatsapp-kapso:<phone>` conversation exists.
 *
 * This replaces the older HTTP-bridge approach (POST to /v1/chat/completions
 * then fan the reply back out via Kapso). Keeping this small — only the
 * glue needed to hand a text message to the agent and deliver its reply.
 */

import { createKapsoClient, type KapsoClient } from "./send.js";
import type { KapsoAccountConfig, NormalizedInboundMessage } from "./types.js";

const CHANNEL_ID = "whatsapp-kapso";
const WHATSAPP_TEXT_LIMIT = 4096;

interface ChannelRuntime {
  reply: {
    finalizeInboundContext: (payload: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: Record<string, unknown>;
      cfg: unknown;
      dispatcherOptions: Record<string, unknown>;
      replyOptions?: Record<string, unknown>;
    }) => Promise<void>;
  };
  session: {
    recordInboundSession: (params: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, unknown>;
      onRecordError?: (err: unknown) => void;
    }) => Promise<void>;
  };
  text?: {
    chunkMarkdownTextWithMode?: (text: string, limit: number, mode?: string) => string[];
    resolveChunkMode?: (cfg: unknown, channel: string, accountId: string) => string;
  };
}

interface DispatchParams {
  cfg: unknown;
  account: { accountId: string; config: KapsoAccountConfig };
  channelRuntime: ChannelRuntime;
  log?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
  };
  message: NormalizedInboundMessage;
  /**
   * Optional factory to build the Kapso HTTP client — injected by tests. In
   * production we always build a fresh client from `account.config`.
   */
  kapsoClientFactory?: (config: KapsoAccountConfig) => KapsoClient;
}

export async function dispatchInboundMessage(params: DispatchParams): Promise<void> {
  const { cfg, account, channelRuntime, log, message } = params;
  const clientFactory = params.kapsoClientFactory ?? createKapsoClient;

  // Only text is wired for now — media needs a fetch step before we can
  // hand it to the agent. Log and skip.
  if (message.type !== "text" || !message.text?.trim()) {
    log?.info?.(
      `[${account.accountId}] inbound skipped (type=${message.type}, hasText=${Boolean(message.text)})`,
    );
    return;
  }

  const kapso = clientFactory(account.config);

  // Fire the mark-as-read + typing indicator as soon as we know we'll
  // actually dispatch this message to the agent. This gives the end user
  // immediate feedback (two blue checks + "typing…") while the agent
  // thinks. The indicator auto-clears after 25s or when our reply is
  // sent, whichever comes first. It's a nice-to-have: any failure is
  // logged and swallowed — we must not block the inbound pipeline.
  try {
    await kapso.markRead({ messageId: message.messageId, typing: true });
  } catch (err) {
    log?.warn?.(`[${account.accountId}] mark-as-read+typing failed: ${String(err)}`);
  }

  // Lazy-load the SDK helpers so old hosts that don't ship them still let
  // the plugin boot; if the helpers are unavailable we fall back to a
  // no-op (the message is accepted, logged, not delivered) rather than
  // crashing the channel.
  let inboundEnvelopeSdk: {
    resolveInboundRouteEnvelopeBuilderWithRuntime: (p: Record<string, unknown>) => {
      route: { agentId: string; sessionKey: string };
      buildEnvelope: (p: Record<string, unknown>) => { storePath: string; body: string };
    };
  };
  let pipelineSdk: {
    createChannelReplyPipeline: (p: Record<string, unknown>) => Record<string, unknown>;
  };
  try {
    // @ts-expect-error — host-provided at runtime
    inboundEnvelopeSdk = (await import("openclaw/plugin-sdk/inbound-envelope")) as typeof inboundEnvelopeSdk;
    // @ts-expect-error — host-provided at runtime
    pipelineSdk = (await import("openclaw/plugin-sdk/channel-reply-pipeline")) as typeof pipelineSdk;
  } catch (err) {
    log?.error?.(
      `[${account.accountId}] inbound pipeline SDK unavailable (${String(err)}) — dropping message`,
    );
    return;
  }

  const phone = message.from;
  const sessionStore = (cfg as { session?: { store?: string } } | undefined)?.session?.store;

  const { route, buildEnvelope } = inboundEnvelopeSdk.resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: phone },
    runtime: channelRuntime,
    sessionStore,
  });

  const fromLabel = message.fromName || phone;
  const { storePath, body } = buildEnvelope({
    channel: "WhatsApp (Kapso)",
    from: fromLabel,
    timestamp: Date.parse(message.timestamp) || undefined,
    body: message.text,
  });

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.text,
    RawBody: message.text,
    CommandBody: message.text,
    From: `${CHANNEL_ID}:${phone}`,
    To: `${CHANNEL_ID}:${phone}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: message.fromName,
    SenderId: phone,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${phone}`,
  });

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: (ctxPayload.SessionKey as string) ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => log?.error?.(`[${account.accountId}] recordInboundSession: ${String(err)}`),
  });

  const replyPipeline = pipelineSdk.createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload: { text?: string }) => {
        const text = payload.text?.trim();
        if (!text) return;
        const chunks = chunkForWhatsApp(text);
        for (const chunk of chunks) {
          try {
            await kapso.sendText({ to: phone, text: chunk });
          } catch (err) {
            log?.error?.(`[${account.accountId}] kapso send failed: ${String(err)}`);
          }
        }
      },
      onError: (err: unknown) => log?.error?.(`[${account.accountId}] reply dispatch: ${String(err)}`),
    },
  });
}

function chunkForWhatsApp(text: string): string[] {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += WHATSAPP_TEXT_LIMIT) {
    chunks.push(text.slice(i, i + WHATSAPP_TEXT_LIMIT));
  }
  return chunks;
}
