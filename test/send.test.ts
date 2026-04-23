import { test } from "node:test";
import assert from "node:assert/strict";
import { createKapsoClient, toKapsoPhoneNumber } from "../src/send.ts";
import type { KapsoAccountConfig } from "../src/types.ts";

const account: KapsoAccountConfig = {
  apiKey: "kp_live_xyz",
  phoneNumberId: "647015955153740",
  webhookSecret: "this-is-thirty-two-chars-fine!!!",
};

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls: () => calls };
}

test("toKapsoPhoneNumber strips leading + and validates digits", () => {
  assert.equal(toKapsoPhoneNumber("+15551234567"), "15551234567");
  assert.equal(toKapsoPhoneNumber("15551234567"), "15551234567");
  assert.throws(() => toKapsoPhoneNumber("not-a-number"));
});

test("sendText POSTs the correct body and returns messageId", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 200, body: { messages: [{ id: "wamid.abc" }] } },
  ]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  const res = await client.sendText({ to: "+15551234567", text: "hello" });
  assert.equal(res.messageId, "wamid.abc");
  assert.equal(res.chatId, "15551234567");

  const c = calls()[0];
  assert.match(c.url, /meta\/whatsapp\/v24\.0\/647015955153740\/messages$/);
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "kp_live_xyz");
  const body = JSON.parse(String(c.init.body));
  assert.equal(body.messaging_product, "whatsapp");
  assert.equal(body.to, "15551234567");
  assert.equal(body.text.body, "hello");
});

test("sendText attaches context.message_id for replies", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 200, body: { messages: [{ id: "wamid.xyz" }] } },
  ]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  await client.sendText({
    to: "+15551234567",
    text: "re: hi",
    replyToMessageId: "wamid.original",
  });
  const body = JSON.parse(String(calls()[0].init.body));
  assert.deepEqual(body.context, { message_id: "wamid.original" });
});

test("sendMedia image with caption", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 200, body: { messages: [{ id: "wamid.m1" }] } },
  ]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  await client.sendMedia({
    to: "+15551234567",
    kind: "image",
    link: "https://example.com/p.jpg",
    caption: "hi",
  });
  const body = JSON.parse(String(calls()[0].init.body));
  assert.equal(body.type, "image");
  assert.deepEqual(body.image, { link: "https://example.com/p.jpg", caption: "hi" });
});

test("sendMedia audio omits caption", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 200, body: { messages: [{ id: "wamid.a1" }] } },
  ]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  await client.sendMedia({
    to: "+15551234567",
    kind: "audio",
    link: "https://example.com/v.ogg",
    caption: "ignored-for-audio",
  });
  const body = JSON.parse(String(calls()[0].init.body));
  assert.equal(body.type, "audio");
  assert.deepEqual(body.audio, { link: "https://example.com/v.ogg" });
});

test("retries on 429 then succeeds", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 429, body: "rate limited" },
    { status: 200, body: { messages: [{ id: "wamid.ok" }] } },
  ]);
  let sleeps = 0;
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async () => { sleeps++; },
  });
  const res = await client.sendText({ to: "+15551234567", text: "hi" });
  assert.equal(res.messageId, "wamid.ok");
  assert.equal(calls().length, 2);
  assert.equal(sleeps, 1);
});

test("throws on non-retryable 400", async () => {
  const { fetchImpl } = mockFetch([
    { status: 400, body: { error: { message: "bad number" } } },
  ]);
  const client = createKapsoClient(account, { fetch: fetchImpl, sleep: async () => {} });
  await assert.rejects(
    client.sendText({ to: "+15551234567", text: "hi" }),
    /HTTP 400/,
  );
});

test("exhausts retries then throws", async () => {
  const { fetchImpl, calls } = mockFetch([
    { status: 503, body: "down" },
    { status: 503, body: "down" },
    { status: 503, body: "down" },
    { status: 503, body: "down" },
  ]);
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async () => {},
    maxRetries: 2,
  });
  await assert.rejects(client.sendText({ to: "+15551234567", text: "hi" }), /HTTP 503/);
  assert.equal(calls().length, 3); // initial + 2 retries
});

test("throws when response omits messages[0].id", async () => {
  const { fetchImpl } = mockFetch([{ status: 200, body: { foo: "bar" } }]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  await assert.rejects(
    client.sendText({ to: "+15551234567", text: "hi" }),
    /messages\[0\]\.id/,
  );
});

test("markRead posts read + typing_indicator", async () => {
  const { fetchImpl, calls } = mockFetch([{ status: 200, body: {} }]);
  const client = createKapsoClient(account, { fetch: fetchImpl });
  await client.markRead({ messageId: "wamid.zzz", typing: true });
  const body = JSON.parse(String(calls()[0].init.body));
  assert.equal(body.status, "read");
  assert.equal(body.message_id, "wamid.zzz");
  assert.deepEqual(body.typing_indicator, { type: "text" });
});
