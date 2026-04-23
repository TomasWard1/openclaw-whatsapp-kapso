import { DEFAULT_KAPSO_BASE_URL, KAPSO_API_PATH } from "./config-schema.js";
import type { KapsoAccountConfig } from "./types.js";

export interface KapsoMediaMetadata {
  url: string;
  downloadUrl: string;
  mimeType?: string;
  size?: number;
}

export interface KapsoMediaBytes {
  bytes: Uint8Array;
  mimeType?: string;
  size: number;
}

export interface FetchKapsoMediaInput {
  mediaId: string;
  account: KapsoAccountConfig;
  fetch?: typeof fetch;
}

/**
 * Resolve a Kapso media_id to fresh URLs + metadata.
 *
 * Kapso media URLs (both the Meta CDN `url` and Kapso's `download_url`) expire
 * in 4-5 minutes. Consumers who want to process media asynchronously (queue
 * work, background job) should NOT hold on to the URL from the inbound webhook
 * — they should store the `mediaId` and call this helper when they actually
 * need the bytes.
 */
export async function fetchKapsoMedia(
  input: FetchKapsoMediaInput,
): Promise<KapsoMediaMetadata> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const base = (input.account.apiBaseUrl ?? DEFAULT_KAPSO_BASE_URL).replace(/\/+$/, "");
  const url =
    `${base}${KAPSO_API_PATH}/${encodeURIComponent(input.mediaId)}` +
    `?phone_number_id=${encodeURIComponent(input.account.phoneNumberId)}`;

  const res = await fetchImpl(url, {
    method: "GET",
    headers: { "X-API-Key": input.account.apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `kapso media: HTTP ${res.status} fetching metadata for ${input.mediaId} — ${text.slice(0, 300)}`,
    );
  }
  const parsed = (await res.json()) as Record<string, unknown>;
  const metaUrl = typeof parsed.url === "string" ? parsed.url : undefined;
  const downloadUrl =
    typeof parsed.download_url === "string" ? parsed.download_url : undefined;
  if (!metaUrl || !downloadUrl) {
    throw new Error(
      `kapso media: response missing url/download_url — ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  const mimeType = typeof parsed.mime_type === "string" ? parsed.mime_type : undefined;
  const size = typeof parsed.file_size === "number" ? parsed.file_size : undefined;
  return { url: metaUrl, downloadUrl, mimeType, size };
}

/**
 * Two-step download: resolve fresh URLs via {@link fetchKapsoMedia}, then
 * download the bytes from Kapso's download_url (which is preferred over
 * Meta's CDN url because the latter requires a WABA bearer token we don't
 * necessarily have).
 */
export async function downloadMediaBytes(
  input: FetchKapsoMediaInput,
): Promise<KapsoMediaBytes> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const meta = await fetchKapsoMedia(input);

  const res = await fetchImpl(meta.downloadUrl, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `kapso media: HTTP ${res.status} downloading ${input.mediaId} — ${text.slice(0, 300)}`,
    );
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const contentType = res.headers.get("content-type") ?? undefined;
  return {
    bytes,
    mimeType: meta.mimeType ?? contentType ?? undefined,
    size: bytes.length,
  };
}
