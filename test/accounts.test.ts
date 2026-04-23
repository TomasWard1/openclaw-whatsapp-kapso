import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listKapsoAccountIds,
  resolveDefaultKapsoAccountId,
  resolveKapsoAccount,
  DEFAULT_ACCOUNT_ID,
} from "../src/accounts.ts";

const SECRET = "this-is-thirty-two-chars-fine!!!";

test("listKapsoAccountIds includes default when fully configured", () => {
  const ids = listKapsoAccountIds({
    apiKey: "a", phoneNumberId: "123", webhookSecret: SECRET,
  });
  assert.deepEqual(ids, [DEFAULT_ACCOUNT_ID]);
});

test("listKapsoAccountIds empty when top-level is incomplete", () => {
  const ids = listKapsoAccountIds({ apiKey: "a" });
  assert.deepEqual(ids, []);
});

test("listKapsoAccountIds merges sub-accounts", () => {
  const ids = listKapsoAccountIds({
    accounts: {
      prod: { apiKey: "a", phoneNumberId: "1", webhookSecret: SECRET },
      dev: { apiKey: "b", phoneNumberId: "2", webhookSecret: SECRET },
    },
  });
  assert.deepEqual(ids.sort(), ["dev", "prod"]);
});

test("resolveKapsoAccount returns default account", () => {
  const acct = resolveKapsoAccount({
    apiKey: "a", phoneNumberId: "123", webhookSecret: SECRET,
  });
  assert.ok(acct);
  assert.equal(acct!.accountId, DEFAULT_ACCOUNT_ID);
  assert.equal(acct!.config.apiKey, "a");
});

test("resolveKapsoAccount returns undefined for unknown accountId", () => {
  const acct = resolveKapsoAccount({}, "nope");
  assert.equal(acct, undefined);
});

test("resolveKapsoAccount sub-accounts inherit top-level fields as fallback", () => {
  const acct = resolveKapsoAccount({
    apiKey: "top",
    accounts: { prod: { apiKey: "sub", phoneNumberId: "123", webhookSecret: SECRET } },
  } as unknown as Parameters<typeof resolveKapsoAccount>[0], "prod");
  assert.ok(acct);
  // Sub wins.
  assert.equal(acct!.config.apiKey, "sub");
});

test("resolveDefaultKapsoAccountId picks default when present", () => {
  const id = resolveDefaultKapsoAccountId({
    apiKey: "a", phoneNumberId: "1", webhookSecret: SECRET,
    accounts: { other: { apiKey: "b", phoneNumberId: "2", webhookSecret: SECRET } },
  });
  assert.equal(id, DEFAULT_ACCOUNT_ID);
});

test("resolveDefaultKapsoAccountId falls back to first sub-account", () => {
  const id = resolveDefaultKapsoAccountId({
    accounts: { only: { apiKey: "a", phoneNumberId: "1", webhookSecret: SECRET } },
  });
  assert.equal(id, "only");
});
