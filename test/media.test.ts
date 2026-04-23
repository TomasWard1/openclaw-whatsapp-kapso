import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchKapsoMedia, downloadMediaBytes } from "../src/media.js";
import type { KapsoAccountConfig } from "../src/types.js";

const account: KapsoAccountConfig = {
  apiKey: "kp_test_key",
  phoneNumberId: "597907523413541",
  webhookSecret: "x".repeat(32),
};

describe("fetchKapsoMedia", () => {
  it("hits the media endpoint with X-API-Key and phone_number_id", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          url: "https://lookaside.fbsbx.com/abcd",
          download_url: "https://kapso-media.example/xyz",
          mime_type: "audio/ogg",
          file_size: 4321,
        }),
        { status: 200 },
      );
    };

    const result = await fetchKapsoMedia({
      mediaId: "media_9876",
      account,
      fetch: fakeFetch,
    });

    assert.equal(
      capturedUrl,
      "https://api.kapso.ai/meta/whatsapp/v24.0/media_9876?phone_number_id=597907523413541",
    );
    assert.equal(capturedHeaders["X-API-Key"], "kp_test_key");
    assert.equal(result.url, "https://lookaside.fbsbx.com/abcd");
    assert.equal(result.downloadUrl, "https://kapso-media.example/xyz");
    assert.equal(result.mimeType, "audio/ogg");
    assert.equal(result.size, 4321);
  });

  it("throws a descriptive error on non-200", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await assert.rejects(
      () =>
        fetchKapsoMedia({
          mediaId: "media_404",
          account,
          fetch: fakeFetch,
        }),
      /kapso media.*404/i,
    );
  });
});

describe("downloadMediaBytes", () => {
  it("resolves a media_id to bytes via the two-step fetch", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.kapso.ai/meta/whatsapp/v24.0/media_777")) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/fresh",
            download_url: "https://kapso-media.example/fresh",
            mime_type: "image/jpeg",
            file_size: 200,
          }),
          { status: 200 },
        );
      }
      if (url === "https://kapso-media.example/fresh") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const result = await downloadMediaBytes({
      mediaId: "media_777",
      account,
      fetch: fakeFetch,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.bytes.length, 4);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  });

  it("prefers downloadUrl over url (Meta URL needs bearer auth)", async () => {
    let downloadedFrom: string | undefined;
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/meta/whatsapp/v24.0/")) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/needs-auth",
            download_url: "https://kapso-media.example/prefer-me",
            mime_type: "application/pdf",
            file_size: 50,
          }),
          { status: 200 },
        );
      }
      downloadedFrom = url;
      return new Response(new Uint8Array([0]), { status: 200 });
    };

    await downloadMediaBytes({
      mediaId: "media_pdf",
      account,
      fetch: fakeFetch,
    });

    assert.equal(downloadedFrom, "https://kapso-media.example/prefer-me");
  });
});
