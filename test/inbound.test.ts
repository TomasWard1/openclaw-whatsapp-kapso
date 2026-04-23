import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  IdempotencyCache,
  verifyWebhookSignature,
  extractItems,
  normalizeItem,
  parseKapsoWebhook,
} from "../src/inbound.ts";

const SECRET = "this-is-thirty-two-chars-fine!!!";

function signBody(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// --- IdempotencyCache ---------------------------------------------------

test("IdempotencyCache: first seen is false, repeat is true", () => {
  const c = new IdempotencyCache(10);
  assert.equal(c.seen("a"), false);
  assert.equal(c.seen("a"), true);
});

test("IdempotencyCache: evicts oldest when over capacity", () => {
  const c = new IdempotencyCache(3);
  c.seen("a"); c.seen("b"); c.seen("c"); c.seen("d");
  assert.equal(c.size, 3);
  assert.equal(c.has("a"), false); // evicted
  assert.equal(c.has("d"), true);
});

test("IdempotencyCache: re-seeing refreshes recency so it survives eviction", () => {
  const c = new IdempotencyCache(3);
  c.seen("a"); c.seen("b"); c.seen("c");
  c.seen("a"); // bumps a to end
  c.seen("d");
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
});

// --- HMAC verify --------------------------------------------------------

test("verifyWebhookSignature: accepts a correct hex signature", () => {
  const body = '{"hello":"world"}';
  const sig = signBody(body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signatureHeader: sig, secret: SECRET }), true);
});

test("verifyWebhookSignature: rejects tampered body", () => {
  const body = '{"hello":"world"}';
  const sig = signBody(body);
  assert.equal(
    verifyWebhookSignature({
      rawBody: '{"hello":"evil"}',
      signatureHeader: sig,
      secret: SECRET,
    }),
    false,
  );
});

test("verifyWebhookSignature: rejects missing header", () => {
  assert.equal(verifyWebhookSignature({ rawBody: "{}", signatureHeader: undefined, secret: SECRET }), false);
});

test("verifyWebhookSignature: rejects malformed header", () => {
  assert.equal(verifyWebhookSignature({ rawBody: "{}", signatureHeader: "not-hex!!", secret: SECRET }), false);
});

test("verifyWebhookSignature: tolerates sha256= prefix (Meta-kind)", () => {
  const body = '{"x":1}';
  const sig = "sha256=" + signBody(body);
  assert.equal(verifyWebhookSignature({ rawBody: body, signatureHeader: sig, secret: SECRET }), true);
});

test("verifyWebhookSignature: length-mismatch returns false without throwing", () => {
  assert.equal(
    verifyWebhookSignature({ rawBody: "{}", signatureHeader: "abcd", secret: SECRET }),
    false,
  );
});

// --- extractItems / normalizeItem ---------------------------------------

const sampleInbound = {
  message: {
    id: "wamid.123",
    timestamp: "1730092800",
    type: "text",
    from: "16315551181",
    text: { body: "Hello" },
    kapso: { direction: "inbound", origin: "cloud_api", content: "Hello" },
  },
  conversation: {
    id: "conv_1",
    kapso: { contact_name: "John Doe" },
  },
  phone_number_id: "123456789012345",
};

test("extractItems: single root-level payload", () => {
  assert.equal(extractItems(sampleInbound).length, 1);
});

test("extractItems: batched data[] payload", () => {
  assert.equal(extractItems({ type: "x", batch: true, data: [sampleInbound, sampleInbound] }).length, 2);
});

test("extractItems: rejects non-object", () => {
  assert.throws(() => extractItems(null));
  assert.throws(() => extractItems([1, 2]));
});

test("extractItems: rejects missing shape", () => {
  assert.throws(() => extractItems({ foo: "bar" }));
});

test("normalizeItem: basic text message", () => {
  const n = normalizeItem(sampleInbound, "default");
  assert.ok(n);
  assert.equal(n!.messageId, "wamid.123");
  assert.equal(n!.from, "+16315551181");
  assert.equal(n!.text, "Hello");
  assert.equal(n!.fromName, "John Doe");
  assert.equal(n!.type, "text");
});

test("normalizeItem: drops outbound echoes", () => {
  const n = normalizeItem({
    message: { ...sampleInbound.message, kapso: { direction: "outbound" } },
  }, "default");
  assert.equal(n, null);
});

test("normalizeItem: drops business_app-origin", () => {
  const n = normalizeItem({
    message: { ...sampleInbound.message, kapso: { direction: "inbound", origin: "business_app" } },
  }, "default");
  assert.equal(n, null);
});

test("normalizeItem: audio with transcript falls back to transcript text", () => {
  const n = normalizeItem({
    message: {
      id: "wamid.2", timestamp: "1730093100", type: "audio", from: "16315551181",
      kapso: {
        direction: "inbound", origin: "cloud_api", has_media: true,
        media_url: "https://api.kapso.ai/media/x",
        media_data: { content_type: "audio/ogg" },
        transcript: { text: "Hello, I need help" },
      },
    },
  }, "default");
  assert.ok(n);
  assert.equal(n!.text, "Hello, I need help");
  assert.equal(n!.type, "audio");
  assert.equal(n!.mediaUrl, "https://api.kapso.ai/media/x");
  assert.equal(n!.mediaMimeType, "audio/ogg");
});

test("normalizeItem: image falls back to kapso.content if no text.body", () => {
  const n = normalizeItem({
    message: {
      id: "wamid.3", timestamp: "1730093200", type: "image", from: "16315551181",
      image: { caption: "Photo" },
      kapso: {
        direction: "inbound", origin: "cloud_api",
        content: "Photo description", media_url: "https://api.kapso.ai/media/y",
      },
    },
  }, "default");
  assert.ok(n);
  assert.equal(n!.text, "Photo description");
  assert.equal(n!.type, "image");
});

test("normalizeItem: missing required fields returns null", () => {
  assert.equal(normalizeItem({ message: { id: "x" } }, "default"), null);
  assert.equal(normalizeItem({}, "default"), null);
  assert.equal(normalizeItem({ message: { id: "x", from: "16315551181" } }, "default"), null);
});

test("normalizeItem: reads reply context.id", () => {
  const n = normalizeItem({
    message: {
      ...sampleInbound.message,
      context: { id: "wamid.original" },
    },
    conversation: sampleInbound.conversation,
  }, "default");
  assert.equal(n!.replyToMessageId, "wamid.original");
});

test("normalizeItem: contact_name from conversation.kapso (not top-level)", () => {
  // Regression: Limbo adapter read the wrong path.
  const n = normalizeItem({
    message: sampleInbound.message,
    conversation: {
      contact_name: "WRONG",           // should NOT win
      kapso: { contact_name: "RIGHT" },
    },
  }, "default");
  assert.equal(n!.fromName, "RIGHT");
});

// --- parseKapsoWebhook end-to-end --------------------------------------

test("parseKapsoWebhook: happy path returns messages", () => {
  const body = JSON.stringify(sampleInbound);
  const sig = signBody(body);
  const cache = new IdempotencyCache();
  const res = parseKapsoWebhook({
    rawBody: body,
    headers: {
      "x-webhook-signature": sig,
      "x-idempotency-key": "req-1",
      "x-webhook-event": "whatsapp.message.received",
    },
    secret: SECRET,
    idempotency: cache,
    accountId: "default",
  });
  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 1);
});

test("parseKapsoWebhook: rejects bad signature with reason bad_signature", () => {
  const body = JSON.stringify(sampleInbound);
  const res = parseKapsoWebhook({
    rawBody: body,
    headers: { "x-webhook-signature": "0".repeat(64) },
    secret: SECRET,
    idempotency: new IdempotencyCache(),
    accountId: "default",
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_signature");
});

test("parseKapsoWebhook: missing signature -> missing_signature reason", () => {
  const res = parseKapsoWebhook({
    rawBody: "{}",
    headers: {},
    secret: SECRET,
    idempotency: new IdempotencyCache(),
    accountId: "default",
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_signature");
});

test("parseKapsoWebhook: duplicate idempotency key returns ok with reason=duplicate, no messages", () => {
  const body = JSON.stringify(sampleInbound);
  const sig = signBody(body);
  const cache = new IdempotencyCache();
  cache.seen("req-dup");
  const res = parseKapsoWebhook({
    rawBody: body,
    headers: { "x-webhook-signature": sig, "x-idempotency-key": "req-dup" },
    secret: SECRET,
    idempotency: cache,
    accountId: "default",
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, "duplicate");
  assert.equal(res.messages.length, 0);
});

test("parseKapsoWebhook: malformed JSON -> bad_payload", () => {
  const body = "not json";
  const sig = signBody(body);
  const res = parseKapsoWebhook({
    rawBody: body,
    headers: { "x-webhook-signature": sig },
    secret: SECRET,
    idempotency: new IdempotencyCache(),
    accountId: "default",
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_payload");
});

test("parseKapsoWebhook: signature is verified against raw body bytes (not re-serialized)", () => {
  // The body has specific whitespace — the signature must be computed over
  // those exact bytes, not over a re-stringified parse.
  const body = '{"message":{"id":"wamid.1","timestamp":"1730092800","type":"text","from":"16315551181","text":{"body":"Hi"},"kapso":{"direction":"inbound","origin":"cloud_api"}}}';
  const sig = signBody(body);
  const res = parseKapsoWebhook({
    rawBody: Buffer.from(body, "utf8"),
    headers: { "x-webhook-signature": sig },
    secret: SECRET,
    idempotency: new IdempotencyCache(),
    accountId: "default",
  });
  assert.equal(res.ok, true);
  assert.equal(res.messages.length, 1);
});
