import { test } from "node:test";
import assert from "node:assert/strict";
import { createKapsoClient } from "../src/send.ts";
import type { KapsoAccountConfig } from "../src/types.ts";

const account: KapsoAccountConfig = {
  apiKey: "kp_live_xyz",
  phoneNumberId: "647015955153740",
  webhookSecret: "this-is-thirty-two-chars-fine!!!",
};

test("respects Retry-After (seconds) on 429", async () => {
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async () => {
    i++;
    if (i === 1) {
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "7" },
      });
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await client.sendText({ to: "+15551234567", text: "hi" });
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 7000);
});

test("respects Retry-After HTTP-date on 503", async () => {
  const sleeps: number[] = [];
  const futureDate = new Date(Date.now() + 3500);
  let i = 0;
  const fetchImpl: typeof fetch = async () => {
    i++;
    if (i === 1) {
      return new Response("", {
        status: 503,
        headers: { "Retry-After": futureDate.toUTCString() },
      });
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
      status: 200,
    });
  };
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await client.sendText({ to: "+15551234567", text: "hi" });
  assert.equal(sleeps.length, 1);
  // Allow a small tolerance — parsed date vs Date.now() at call-time.
  assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 5000, `expected ~3500, got ${sleeps[0]}`);
});

test("falls back to exponential backoff when Retry-After is malformed", async () => {
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async () => {
    i++;
    if (i === 1) {
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "not-a-number" },
      });
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
      status: 200,
    });
  };
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await client.sendText({ to: "+15551234567", text: "hi" });
  assert.equal(sleeps[0], 500); // first backoff
});

test("throws underlying network error after exhausting retries (ECONNREFUSED)", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    const err = new Error("connect ECONNREFUSED 127.0.0.1:4000") as Error & {
      code?: string;
    };
    err.code = "ECONNREFUSED";
    throw err;
  };
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async () => {},
    maxRetries: 2,
  });
  await assert.rejects(
    client.sendText({ to: "+15551234567", text: "hi" }),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("throws AbortError when signal-like error propagates through retries", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    throw new DOMException("aborted", "AbortError");
  };
  const client = createKapsoClient(account, {
    fetch: fetchImpl,
    sleep: async () => {},
    maxRetries: 1,
  });
  await assert.rejects(
    client.sendText({ to: "+15551234567", text: "hi" }),
    /abort/i,
  );
  assert.equal(calls, 2);
});
