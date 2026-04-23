import { test } from "node:test";
import assert from "node:assert/strict";
import { KapsoAccountSchema, KapsoConfigSchema } from "../src/config-schema.ts";

test("account schema accepts a fully-formed account", () => {
  const res = KapsoAccountSchema.safeParse({
    apiKey: "kp_live_xxx",
    phoneNumberId: "647015955153740",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
  });
  assert.equal(res.success, true);
});

test("account schema rejects non-digit phoneNumberId", () => {
  const res = KapsoAccountSchema.safeParse({
    apiKey: "kp_live_xxx",
    phoneNumberId: "+15551234567",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
  });
  assert.equal(res.success, false);
});

test("account schema rejects short webhook secrets", () => {
  const res = KapsoAccountSchema.safeParse({
    apiKey: "kp_live_xxx",
    phoneNumberId: "647015955153740",
    webhookSecret: "short",
  });
  assert.equal(res.success, false);
});

test("account schema rejects unknown fields (strict)", () => {
  const res = KapsoAccountSchema.safeParse({
    apiKey: "kp_live_xxx",
    phoneNumberId: "647015955153740",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
    typoField: "oops",
  });
  assert.equal(res.success, false);
});

test("account schema rejects missing apiKey", () => {
  const res = KapsoAccountSchema.safeParse({
    phoneNumberId: "647015955153740",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
  });
  assert.equal(res.success, false);
});

test("config schema accepts minimal top-level-only", () => {
  const res = KapsoConfigSchema.safeParse({
    apiKey: "k",
    phoneNumberId: "123",
    webhookSecret: "this-is-thirty-two-chars-fine!!!",
  });
  assert.equal(res.success, true);
});

test("config schema accepts accounts sub-record", () => {
  const res = KapsoConfigSchema.safeParse({
    accounts: {
      prod: {
        apiKey: "a",
        phoneNumberId: "123",
        webhookSecret: "this-is-thirty-two-chars-fine!!!",
      },
    },
  });
  assert.equal(res.success, true);
});

test("config schema rejects invalid sub-account", () => {
  const res = KapsoConfigSchema.safeParse({
    accounts: {
      prod: { apiKey: "a", phoneNumberId: "not-digits", webhookSecret: "x" },
    },
  });
  assert.equal(res.success, false);
});
