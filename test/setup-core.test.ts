import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswers, kapsoWebhookUrl, kapsoSetupPlugin } from "../src/setup-core.ts";

const SECRET = "this-is-thirty-two-chars-fine!!!";

test("validateAnswers passes on valid input", () => {
  const r = validateAnswers({
    apiKey: "k", phoneNumberId: "123", webhookSecret: SECRET,
  });
  assert.equal(r.ok, true);
});

test("validateAnswers returns issues on invalid input", () => {
  const r = validateAnswers({ apiKey: "", phoneNumberId: "abc", webhookSecret: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.length >= 1);
});

test("kapsoWebhookUrl strips trailing slashes and URL-encodes accountId", () => {
  assert.equal(
    kapsoWebhookUrl("https://bot.example.com/", "prod"),
    "https://bot.example.com/webhooks/whatsapp-kapso/prod",
  );
  assert.equal(
    kapsoWebhookUrl("https://bot.example.com", "a b"),
    "https://bot.example.com/webhooks/whatsapp-kapso/a%20b",
  );
});

test("kapsoSetupPlugin exposes the expected wizard shape", () => {
  assert.equal(kapsoSetupPlugin.id, "whatsapp-kapso");
  assert.ok(Array.isArray(kapsoSetupPlugin.setupWizard.questions));
  const keys = kapsoSetupPlugin.setupWizard.questions.map((q) => q.key);
  assert.deepEqual(keys, ["apiKey", "phoneNumberId", "webhookSecret", "apiBaseUrl"]);
});
