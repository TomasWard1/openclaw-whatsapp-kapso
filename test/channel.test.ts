import { test } from "node:test";
import assert from "node:assert/strict";
import { kapsoPlugin } from "../src/channel.ts";

const SECRET = "this-is-thirty-two-chars-fine!!!";

test("kapsoPlugin has correct id and meta", () => {
  assert.equal(kapsoPlugin.id, "whatsapp-kapso");
  assert.equal(kapsoPlugin.meta.id, "whatsapp-kapso");
  assert.equal(kapsoPlugin.capabilities.blockStreaming, true);
  assert.equal(kapsoPlugin.capabilities.media, true);
});

test("config.listAccountIds returns [] for garbage config", () => {
  assert.deepEqual(kapsoPlugin.config.listAccountIds({ foo: 1 }), []);
});

test("config.resolveAccount returns the default when config is valid", () => {
  const acct = kapsoPlugin.config.resolveAccount({
    cfg: { apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET },
  });
  assert.ok(acct);
  assert.equal(acct!.accountId, "default");
});

test("config.isConfigured is true only with all three fields", () => {
  const fullAcct = kapsoPlugin.config.resolveAccount({
    cfg: { apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET },
  });
  assert.equal(kapsoPlugin.config.isConfigured(fullAcct), true);
  assert.equal(kapsoPlugin.config.isConfigured(undefined), false);
});

test("gateway.startAccount returns a webhookHandler and done promise", async () => {
  const acct = kapsoPlugin.config.resolveAccount({
    cfg: { apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET },
  })!;
  const controller = new AbortController();
  const gw = await kapsoPlugin.gateway.startAccount({
    account: acct,
    abortSignal: controller.signal,
  });
  assert.equal(typeof gw.webhookHandler, "function");
  assert.ok(gw.done instanceof Promise);
  controller.abort();
  await gw.done;
});

test("webhookHandler returns 401 on missing signature", async () => {
  const acct = kapsoPlugin.config.resolveAccount({
    cfg: { apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET },
  })!;
  const gw = await kapsoPlugin.gateway.startAccount({ account: acct });
  const res = await gw.webhookHandler("{}", {});
  assert.equal(res.status, 401);
});
