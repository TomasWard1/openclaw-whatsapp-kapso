import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchInboundMessage } from "../src/inbound-pipeline.ts";
import type { KapsoAccountConfig, NormalizedInboundMessage } from "../src/types.ts";
import type { KapsoClient } from "../src/send.ts";

const account = {
  accountId: "default",
  config: {
    apiKey: "k",
    phoneNumberId: "123",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
  } satisfies KapsoAccountConfig,
};

function makeMessage(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    channelId: "whatsapp-kapso",
    accountId: "default",
    messageId: "wamid.abc",
    from: "+15551234567",
    timestamp: new Date().toISOString(),
    type: "text",
    text: "hola",
    raw: {},
    ...overrides,
  };
}

interface MarkReadSpy {
  markReadCalls: Array<{ messageId: string; typing?: boolean }>;
  sendTextCalls: Array<{ to: string; text: string }>;
  client: KapsoClient;
}

function spyKapsoClient(opts: { markReadRejects?: Error } = {}): MarkReadSpy {
  const markReadCalls: Array<{ messageId: string; typing?: boolean }> = [];
  const sendTextCalls: Array<{ to: string; text: string }> = [];
  const client: KapsoClient = {
    markRead: async (o) => {
      markReadCalls.push(o);
      if (opts.markReadRejects) throw opts.markReadRejects;
    },
    sendText: async (o) => {
      sendTextCalls.push({ to: o.to, text: o.text });
      return { channel: "whatsapp-kapso", messageId: "wamid.out", chatId: o.to };
    },
    sendMedia: async (o) => ({
      channel: "whatsapp-kapso",
      messageId: "wamid.m",
      chatId: o.to,
    }),
    sendUrl: "https://api.kapso.ai/fake",
  };
  return { markReadCalls, sendTextCalls, client };
}

/**
 * Minimal stub channel runtime that captures the delivered text. The SDK
 * helpers (inbound-envelope / channel-reply-pipeline) are lazy-imported in
 * the pipeline and absent in this test env — the pipeline logs an error
 * and returns early. That's fine: we only care about the markRead call
 * that happens BEFORE that import step.
 */
function makeRuntime() {
  return {
    reply: {
      finalizeInboundContext: (p: Record<string, unknown>) => p,
      dispatchReplyWithBufferedBlockDispatcher: async () => {},
    },
    session: {
      recordInboundSession: async () => {},
    },
  };
}

test("pipeline calls markRead+typing before dispatch when message has text", async () => {
  const spy = spyKapsoClient();
  await dispatchInboundMessage({
    cfg: {},
    account,
    channelRuntime: makeRuntime(),
    message: makeMessage(),
    kapsoClientFactory: () => spy.client,
  });
  assert.equal(spy.markReadCalls.length, 1);
  assert.equal(spy.markReadCalls[0].messageId, "wamid.abc");
  assert.equal(spy.markReadCalls[0].typing, true);
});

test("pipeline does NOT call markRead when message has no dispatchable text", async () => {
  const spy = spyKapsoClient();
  await dispatchInboundMessage({
    cfg: {},
    account,
    channelRuntime: makeRuntime(),
    message: makeMessage({ type: "image", text: undefined }),
    kapsoClientFactory: () => spy.client,
  });
  assert.equal(spy.markReadCalls.length, 0);
});

test("pipeline swallows markRead errors and continues", async () => {
  const spy = spyKapsoClient({ markReadRejects: new Error("boom") });
  const warnings: string[] = [];
  // Should NOT throw.
  await dispatchInboundMessage({
    cfg: {},
    account,
    channelRuntime: makeRuntime(),
    log: { warn: (m) => warnings.push(m) },
    message: makeMessage(),
    kapsoClientFactory: () => spy.client,
  });
  assert.equal(spy.markReadCalls.length, 1);
  assert.ok(
    warnings.some((w) => w.includes("mark-as-read+typing failed")),
    "expected a warn log for markRead failure",
  );
});
