import type { EventsResponse } from "./types";

/**
 * Sleep helper (non-blocking).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse Retry-After header.
 * Supports:
 *   - seconds (e.g. "5")
 *   - HTTP date (RFC 7231)
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

/**
 * Parse X-RateLimit-Reset (epoch seconds or ms).
 */
function parseRateLimitResetMs(headers: Headers): number | undefined {
  const value = headers.get("x-ratelimit-reset");
  if (!value) return undefined;

  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;

  // If looks like seconds, convert
  const ms = n < 1e12 ? n * 1000 : n;
  return Math.max(0, ms - Date.now());
}

/**
 * Build events URL.
 */
export function buildEventsUrl(
  baseUrl: string,
  limit: number,
  cursor?: string
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

/**
 * Fetch with rate-limit awareness.
 */
async function fetchWithRetry(
  url: string,
  apiKey?: string,
  maxRetries: number = 8
): Promise<Response> {
  let attempt = 0;

  while (true) {
    attempt += 1;

    const headers: Record<string, string> = {};
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(url, { headers });

    if (res.ok) {
      return res;
    }

    const retryable = res.status === 429 || res.status === 503;

    if (!retryable || attempt > maxRetries) {
      const body = await res.text().catch(() => "");
      throw new Error(`API error: ${res.status} ${body}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers);
    const resetMs = parseRateLimitResetMs(res.headers);

    const baseBackoff = Math.min(
      30_000,
      250 * Math.pow(2, attempt - 1)
    );

    const jitter = Math.floor(Math.random() * 250);

    const waitMs = Math.max(
      retryAfterMs ?? 0,
      resetMs ?? 0,
      baseBackoff + jitter
    );

    console.warn(
      `[ingestion] rate limited (status=${res.status}) attempt=${attempt}/${maxRetries} waitMs=${waitMs}`
    );

    await sleep(waitMs);
  }
}

/**
 * Retrieve a page of events.
 */
export async function retrievePage(
  baseUrl: string,
  limit: number,
  cursor?: string
): Promise<EventsResponse> {
  const url = buildEventsUrl(baseUrl, limit, cursor);

  console.log(`[ingestion] GET ${url}`);

  const apiKey = process.env.TARGET_API_KEY;

  const res = await fetchWithRetry(url, apiKey);

  const remaining =
    res.headers.get("x-ratelimit-remaining") ??
    res.headers.get("ratelimit-remaining");

  if (remaining) {
    console.log(`[ingestion] ratelimit-remaining=${remaining}`);
  }

  const json = await res.json();
  return json as EventsResponse;
}
