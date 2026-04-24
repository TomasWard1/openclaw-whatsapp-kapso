/**
 * Native inbound pipeline — constructs the envelope, records the session,
 * and dispatches through OpenClaw's channel runtime so cron "announce to
 * last channel" (and everything else that consults the session store)
 * knows a `whatsapp-kapso:<phone>` conversation exists.
 *
 * Media-bearing messages (image, audio, video, document, sticker) are
 * downloaded via Kapso's mediaId endpoint — mediaUrl from the webhook
 * expires in 4-5 minutes, so we always re-resolve — and handed to the
 * host's media store via `channelRuntime.media.saveMediaBuffer`. The
 * resulting local path is passed as MediaPath/MediaUrl in the envelope;
 * vision-capable models read images directly, and OpenClaw's transcription
 * provider (Groq Whisper by default when VOICE_ENABLED=true) picks up
 * audio attachments automatically.
 */

import { createKapsoClient, type KapsoClient } from "./send.js";
import { downloadMediaBytes } from "./media.js";
import type { KapsoAccountConfig, NormalizedInboundMessage } from "./types.js";

const CHANNEL_ID = "whatsapp-kapso";
const WHATSAPP_TEXT_LIMIT = 4096;
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB — matches Meta's inbound cap

interface SavedMedia {
  id: string;
  path: string;
  size: number;
  contentType?: string;
}

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
  media?: {
    saveMediaBuffer?: (
      buffer: Buffer,
      contentType?: string,
      subdir?: string,
      maxBytes?: number,
      originalFilename?: string,
    ) => Promise<SavedMedia>;
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

  const hasText = Boolean(message.text?.trim());
  const hasMedia = Boolean(message.mediaId);

  // Nothing we can hand to the agent.
  if (!hasText && !hasMedia) {
    log?.info?.(
      `[${account.accountId}] inbound skipped (type=${message.type}, no text or media)`,
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

  // Download + host-store media up front so the envelope carries a local path
  // the agent (or its transcription runner) can read. A failure here is
  // non-fatal: if the message has a caption we still dispatch as text.
  let savedMedia: SavedMedia | undefined;
  if (hasMedia) {
    savedMedia = await fetchAndStoreMedia({
      message,
      accountConfig: account.config,
      channelRuntime,
      log,
      accountId: account.accountId,
    });
  }

  // Body the agent sees:
  //   - media + caption  → "<caption>" (media is inlined via MediaPath)
  //   - media, no caption → placeholder tag so the model knows media arrived
  //   - text only        → the text
  const bodyForAgent =
    message.text?.trim() ||
    (savedMedia ? `<${message.type} attached>` : "");

  if (!bodyForAgent) {
    log?.warn?.(
      `[${account.accountId}] inbound produced empty body (type=${message.type}, mediaSaved=${Boolean(savedMedia)}) — dropping`,
    );
    return;
  }

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
    body: bodyForAgent,
  });

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: bodyForAgent,
    CommandBody: bodyForAgent,
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
    MediaPath: savedMedia?.path,
    MediaType: savedMedia?.contentType ?? message.mediaMimeType,
    MediaUrl: savedMedia?.path,
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

async function fetchAndStoreMedia(params: {
  message: NormalizedInboundMessage;
  accountConfig: KapsoAccountConfig;
  channelRuntime: ChannelRuntime;
  log?: DispatchParams["log"];
  accountId: string;
}): Promise<SavedMedia | undefined> {
  const { message, accountConfig, channelRuntime, log, accountId } = params;
  const saveMediaBuffer = channelRuntime.media?.saveMediaBuffer;
  if (!saveMediaBuffer) {
    log?.warn?.(
      `[${accountId}] channelRuntime.media.saveMediaBuffer unavailable — skipping media for ${message.messageId}`,
    );
    return undefined;
  }
  if (!message.mediaId) return undefined;

  try {
    const downloaded = await downloadMediaBytes({
      mediaId: message.mediaId,
      account: accountConfig,
    });
    const buffer = Buffer.from(
      downloaded.bytes.buffer,
      downloaded.bytes.byteOffset,
      downloaded.bytes.byteLength,
    );
    const saved = await saveMediaBuffer(
      buffer,
      downloaded.mimeType ?? message.mediaMimeType,
      "inbound",
      DEFAULT_MEDIA_MAX_BYTES,
    );
    log?.info?.(
      `[${accountId}] saved ${message.type} ${message.messageId} → ${saved.path} (${saved.size} bytes, ${saved.contentType ?? "unknown mime"})`,
    );
    return saved;
  } catch (err) {
    log?.error?.(
      `[${accountId}] media fetch/save failed for ${message.messageId}: ${String(err)}`,
    );
    return undefined;
  }
}

function chunkForWhatsApp(text: string): string[] {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += WHATSAPP_TEXT_LIMIT) {
    chunks.push(text.slice(i, i + WHATSAPP_TEXT_LIMIT));
  }
  return chunks;
}
