import { test } from "node:test";
import assert from "node:assert/strict";
import { kapsoPlugin, webhookPathForAccount } from "../src/channel.ts";

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

test("config.listAccountIds extracts the channel section from a full openclaw config", () => {
  // OpenClaw hands the plugin the FULL openclaw.json, not the channel slice.
  // The plugin must look up its own section under `channels.<id>`.
  const fullCfg = {
    gateway: { mode: "local" },
    agents: { defaults: {} },
    channels: {
      "whatsapp-kapso": {
        apiKey: "k",
        phoneNumberId: "123",
        webhookSecret: SECRET,
      },
    },
  };
  assert.deepEqual(kapsoPlugin.config.listAccountIds(fullCfg), ["default"]);
});

test("config.resolveAccount extracts the channel section from a full openclaw config", () => {
  const fullCfg = {
    channels: {
      "whatsapp-kapso": {
        apiKey: "k",
        phoneNumberId: "123",
        webhookSecret: SECRET,
      },
    },
  };
  const acct = kapsoPlugin.config.resolveAccount({ cfg: fullCfg });
  assert.ok(acct);
  assert.equal(acct!.accountId, "default");
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

test("gateway.startAccount returns a pending task that resolves on abort", async () => {
  const acct = kapsoPlugin.config.resolveAccount({
    cfg: { apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET },
  })!;
  const controller = new AbortController();
  const task = kapsoPlugin.gateway.startAccount({
    account: acct,
    abortSignal: controller.signal,
  });
  assert.ok(task instanceof Promise);
  // Race against a 200ms timeout — task must NOT resolve before abort.
  let resolvedEarly = false;
  await Promise.race([
    task.then(() => { resolvedEarly = true; }),
    new Promise((r) => setTimeout(r, 200)),
  ]);
  assert.equal(resolvedEarly, false, "task should stay pending until abort");
  controller.abort();
  await task;
});

test("webhookPathForAccount builds the per-account path", () => {
  assert.equal(webhookPathForAccount("default"), "/webhooks/whatsapp-kapso/default");
});

test("webhookPathForAccount sanitizes unsafe characters", () => {
  assert.equal(
    webhookPathForAccount("MyAcct/../hack?x=1"),
    "/webhooks/whatsapp-kapso/myacct____hack_x_1",
  );
});
