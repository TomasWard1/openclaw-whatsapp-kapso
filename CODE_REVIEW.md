# Code Review — openclaw-whatsapp-kapso

Date: 2026-04-23
Reviewer: Senior code reviewer (automated audit)
Commit reviewed: working tree at `/tmp/openclaw-whatsapp-kapso-build/openclaw-whatsapp-kapso`

## Summary

The plugin is well-structured, TDD-first, and delivers on the headline goal: a native, in-process OpenClaw channel plugin that wraps Kapso's WhatsApp API so cron/announce/approval flows can reach users over WhatsApp. All 65 unit tests pass, packaging ships the right 15 files, secrets hygiene is clean (only placeholder values like `kp_live_xyz` / `this-is-thirty-two-chars-fine!!!` in tests & README), CI/CodeQL/Dependabot/publish OIDC workflows are present and syntactically valid, and the README clearly differentiates from `Enriquefft/openclaw-kapso-whatsapp`. **There is one critical correctness bug** (media URLs are passed through lazily despite Kapso's 4–5 minute URL expiry — this will break media handling end-to-end for any consumer who doesn't eagerly download) and a few major gaps (branch protection exists but is effectively a no-op with 0 required approvers and admin bypass; outbound retries ignore `Retry-After`; no tests for network-layer errors). With the media issue fixed or explicitly documented as a consumer responsibility, this is release-ready for a 0.x / CalVer preview.

---

## Critical findings (block release — security / correctness)

### C1. Media URLs are passed through lazily — will 404 for all downstream consumers

**Where:** `src/inbound.ts:176-180`, `src/types.ts:41`, README line 47 ("Audio transcript support").

The inbound normalizer pulls `message.kapso.media_url` out of the payload and hands it back to the host as `NormalizedInboundMessage.mediaUrl`. Per `/tmp/kapso-api-research.md:451-452` and 476, Kapso media URLs are signed and **expire in ~4–5 minutes**. A host that receives the normalized message and enqueues it (to a job queue, a persistent conversation buffer, a cron-triggered workflow, anything async) will attempt to fetch the URL later and get a 401/403.

There is no mitigation in this plugin: no eager download, no re-fetch helper, no "download now" hook, no warning in the type-doc that the URL is time-bounded.

Two acceptable fixes:

1. (Preferred) Add an optional eager-fetch step in `parseKapsoWebhook` that downloads bytes to a caller-supplied blob sink and replaces `mediaUrl` with a stable URL (or a `mediaBytes` buffer / `mediaBlobId` handle).
2. (Minimum) Document the expiry loudly in `types.ts` on the `mediaUrl` field and expose a `refetchMediaUrl(mediaId, phoneNumberId)` helper that hits `GET /meta/whatsapp/v24.0/{media_id}?phone_number_id={pnid}` (kapso research §5) so consumers have a migration path.

Currently neither path exists, which means every media message is a silent time-bomb.

---

## Major findings (should fix before 1.0)

### M1. Branch protection is present but effectively disabled

**Where:** GitHub `main` and `staging` protection responses.

Running `gh api /repos/TomasWard1/openclaw-whatsapp-kapso/branches/main/protection` returns a protection object, but:

- `required_approving_review_count: 0` — any direct push by a collaborator satisfies "required review".
- `enforce_admins: false` — repo admins bypass protection entirely.
- `required_status_checks.contexts: []` and `checks: []` — CI is not required to pass before merge.
- `required_signatures.enabled: false`.

Net effect: protection is cosmetic. For a public plugin where the ask is "branch protection actually on", this is misleading. Recommend: enable `enforce_admins`, require at least `required_status_checks.contexts: ["test (20)", "test (22)"]`, and (if solo-maintained) leave `required_approving_review_count: 0` but require status checks to pass.

### M2. Outbound retries ignore `Retry-After` header on 429

**Where:** `src/send.ts:68-103`.

The retry loop uses pure exponential backoff (`500ms * 2^attempt`) and never reads the `Retry-After` response header. Meta/Kapso's 429 responses can carry `Retry-After` (seconds or HTTP date). Ignoring it means we can retry before the cooldown and immediately get another 429, burning the retry budget. Under sustained rate-limit pressure we'd hit the "exhausted retries" path and throw instead of waiting the upstream-requested window.

Fix: after the `RETRY_STATUSES` check and before `await sleep(...)`, parse `res.headers.get("retry-after")` and prefer it (clamped to something sane like `min(header, 60_000)`) over the exponential.

### M3. No tests for network-layer errors in send.ts

**Where:** `test/send.test.ts`.

The suite covers happy path, 429 retry, 400 non-retry, 503 exhaustion, missing `messages[0].id`, and markRead — but not the `fetchImpl` throwing (`ECONNREFUSED`, abort, DNS). The code at `src/send.ts:81-86` has a `catch` branch that retries on thrown errors, but that branch is untested; regressions there wouldn't fail CI. Add:

- `test("retries on network error (fetch throws)")` — `fetchImpl` throws once, then succeeds.
- `test("exhausts retries on persistent network error")` — `fetchImpl` always throws.

Also `test/inbound.test.ts` has no test for a pre-signed-but-outside-v2-shape payload (e.g. a v1 `{event, data}` or Meta-kind `{object: "whatsapp_business_account", entry: [...]}`). The current code throws inside `extractItems` and produces `bad_payload` — a regression test pinning that behavior would guard against silent acceptance.

### M4. `configSchema` in `index.ts` and `openclaw.plugin.json` is a no-op empty object

**Where:** `index.ts:28`, `openclaw.plugin.json:4-8`.

Both files declare:
```js
configSchema: { type: "object", additionalProperties: false, properties: {} }
```

The real schema lives in `src/config-schema.ts` (Zod) and is wired via `kapsoPlugin.configSchema`. That's fine for the runtime, but a host that reads `openclaw.plugin.json` as metadata (for a plugin registry UI, e.g.) will display "no config required", which is wrong. Either:

- Serialize `KapsoConfigSchema` to JSON Schema and embed it in `openclaw.plugin.json`, or
- Remove the `configSchema` field entirely from the registration manifest so the host falls back to `kapsoPlugin.configSchema`.

### M5. `required_signatures.enabled: false` + `publish.yml` doesn't verify tag signature

**Where:** `.github/workflows/publish.yml`.

The workflow validates tag name == package.json version (`publish.yml:23-32`) but doesn't verify the tag is GPG-signed or that the pushing actor is authorized. Combined with M1 (admins bypass protection), a compromised maintainer token can push an arbitrary `v*` tag and trigger an npm publish with OIDC provenance — provenance only attests the build came from that repo, not that the tag was legitimate. For a 1.0, add `git verify-tag "$TAG_NAME"` and require signed tags.

---

## Minor findings (polish)

### m1. `api.ts` re-exports `listKapsoAccountIds` but not the types from `./src/types.js`

**Where:** `api.ts:28-35`.

`KapsoAccountConfig`, `ResolvedKapsoAccount`, `SendResult`, etc. are re-exported — good. But consumers writing middleware against the gateway shape (the object returned by `gateway.startAccount`) have no exported `GatewayResult` type. Not critical; a consumer can `ReturnType<typeof kapsoPlugin.gateway.startAccount>`. Would be nicer to expose it.

### m2. `src/runtime.ts` is a singleton with no tests in production paths

**Where:** `src/runtime.ts:17`, `test/runtime.test.ts` (exists, but the store isn't actually used by any production code path — `channel.ts` / `send.ts` / `inbound.ts` don't call `getKapsoRuntime()`).

Dead-ish code. Mirrored from `openclaw-vk` "just in case the host SDK needs it", per the comment at line 6. Either wire it into an actual code path (e.g. let `sendText` look up a shared logger via runtime) or delete it to reduce API surface.

### m3. Phone number normalization differs between inbound and outbound

**Where:** `src/inbound.ts:98-105` (`toE164` prefixes `+`) vs `src/send.ts:40-47` (`toKapsoPhoneNumber` strips `+`).

Both are correct for their context (host sees E.164 with `+`, Kapso API wants bare digits), but the two helpers are siblings with opposite semantics and no cross-reference comment. A host dev wiring this up will find this confusing. Consider a brief header comment in each file documenting the convention.

### m4. `KapsoConfigSchema` uses `.strict()` which forbids unknown keys at the config root

**Where:** `src/config-schema.ts:25-33`.

The strict-ness is good (typo detection) but will reject hosts that pass additional per-plugin metadata on the same config object — e.g. OpenClaw could add `channels.whatsapp-kapso.logLevel` later. Consider `.strip()` at the outer level while keeping `.strict()` on the per-account schema, or a small allow-list of ignored root keys.

### m5. `publish.yml` runs `npm test` but doesn't run `npm pack --dry-run` as a second gate

**Where:** `.github/workflows/publish.yml:34-36`.

CI runs pack-dry-run (`.github/workflows/ci.yml:26`); publish doesn't. If someone edits `files` in package.json in a commit that only lands on a tag, the publish path would miss it. Trivial to add — just an extra `- run: npm pack --dry-run` step before `npm publish`.

### m6. README lists "sticker" under Features but `SendMediaOptions.caption` sticker-path has no caption support anyway

**Where:** `README.md:42`, `src/send.ts:135-137`.

Stickers can't carry captions in Meta's Cloud API; `sendMedia` correctly drops the caption for stickers. Feature bullet is accurate but the asymmetry isn't documented. Fine for now.

### m7. `LICENSE` year is fine, but `README.md:155` hardcodes "2026" — double check for rollover

Low priority. Auto-templating or `Copyright (c) 2026-present` would be nicer.

---

## Commendations (what was done well)

- **Signature verification is textbook correct.** `src/inbound.ts:49-67` reads the raw body (not a re-serialization), uses `crypto.timingSafeEqual`, handles the `sha256=` prefix for Meta-kind webhooks, validates hex before buffer conversion, and returns `false` on any malformed input instead of throwing. Tests at `test/inbound.test.ts:45-83` cover tampered body, missing header, malformed header, sha256= prefix, and length mismatch. This is exactly what the criteria asked for.
- **IdempotencyCache is a real bounded LRU**, not an unbounded Set. `src/inbound.ts:9-39` implements recency refresh via delete-then-set (relying on V8's insertion-ordered Map), with tests at `test/inbound.test.ts:20-41` covering first-seen, eviction under capacity, and refresh-survives-eviction. Exactly the behavior the criteria demanded.
- **Both v2 envelopes are parsed.** `extractItems` at `src/inbound.ts:118-132` handles the single root `{ message, conversation, phone_number_id }` and the batched `{ type, batch: true, data: [...] }` shapes. Tests cover both at `test/inbound.test.ts:103-118`.
- **Send correctness.** `src/send.ts:66` uses the exact endpoint `POST {base}/meta/whatsapp/v24.0/{phone_number_id}/messages`, auth via `X-API-Key` (line 78), reply-to via `context.message_id` (lines 125-127), retries on 429/5xx with exponential backoff (lines 96-98), and correctly strips the `+` prefix for Meta's bare-digits convention (line 42).
- **TDD is real.** 65 tests, all passing, all exercising observable behavior rather than restating the implementation. The suites mirror `src/` one-to-one. Edge cases like "drops outbound echoes" (`test/inbound.test.ts:130`), "contact_name from conversation.kapso, not top-level" (line 196), and "signature is verified against raw body bytes not re-serialized" (line 285) show the author actually thought about adversarial inputs.
- **Packaging is tight.** `npm pack --dry-run` ships exactly the 15 files listed in `package.json:files` — no tests, no `.github/`, no `node_modules`, no CONTRIBUTING, no BLOCKERS. 14.4 kB packed / 43 kB unpacked.
- **Secrets hygiene is clean.** Every "kp_live_…" / "apiKey" / "webhookSecret" occurrence is a placeholder in tests, README, or setup prompts. No real credentials anywhere.
- **README differentiation from `Enriquefft/openclaw-kapso-whatsapp` is genuinely useful** (README:22-36), with a table that explains when each project is the right choice rather than dunking on the alternative. Screenshot TODOs are marked with `<!-- TODO: -->` as requested.
- **CI matrix covers Node 20 + 22**, and CodeQL, Dependabot, publish-with-OIDC-provenance are all in place.
