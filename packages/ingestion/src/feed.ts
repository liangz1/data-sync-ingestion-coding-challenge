import { requireEnv } from "./env";

export type FeedEvent = {
  id: string;
  sessionId?: string;
  userId?: string;
  type: string;
  name?: string;
  properties?: Record<string, unknown>;
  timestamp: number;
  session?: Record<string, unknown>;
};

export type FeedPageResponse = {
  data: FeedEvent[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    cursorExpiresIn: number | null;
  };
  meta: {
    total: number;
    returned: number;
    requestId: string;
  };
};

export type StreamAccessResponse = {
  streamAccess: {
    endpoint: string;
    token: string;
    expiresIn: number;
    tokenHeader: string;
  };
  meta: {
    generatedAt: string;
    note?: string;
  };
};

export type NormalizedEvent = {
  id: string;
  ts: string;
  type: string;
  raw: FeedEvent;
};

export type NormalizedPage = {
  data: NormalizedEvent[];
  hasMore: boolean;
  nextCursor?: string;
};

function getOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function buildFeedUrl(
  baseUrl: string,
  endpoint: string,
  sinceMs: number,
  untilMs: number,
  limit: number,
  cursor?: string
): string {
  const origin = new URL(baseUrl).origin;
  const base = endpoint.startsWith("/") ? origin : baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`);

  url.searchParams.set("since", String(sinceMs));
  url.searchParams.set("until", String(untilMs));
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  return url.toString();
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function getStreamAccess(
  baseUrl: string,
  apiKey: string
): Promise<StreamAccessResponse["streamAccess"]> {
  const origin = getOrigin(baseUrl);
  const url = `${origin}/internal/dashboard/stream-access`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      "Content-Type": "application/json",
      "Cookie": `dashboard_api_key=${apiKey}`,
      "Origin": origin,
      "Referer": `${origin}/`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "X-API-Key": apiKey,
    },
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(
      `[feed] stream-access failed: status=${res.status} body=${body}`
    );
  }

  const json = (await res.json()) as StreamAccessResponse;

  if (!json.streamAccess?.endpoint || !json.streamAccess?.token) {
    throw new Error("[feed] invalid stream-access response");
  }

  return json.streamAccess;
}

export async function fetchFeedPage(
  baseUrl: string,
  endpoint: string,
  apiKey: string,
  streamToken: string,
  sinceMs: number,
  untilMs: number,
  limit: number,
  cursor?: string
): Promise<FeedPageResponse> {
  const url = buildFeedUrl(baseUrl, endpoint, sinceMs, untilMs, limit, cursor);

  console.log(`[feed] GET ${url}`);

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-API-Key": apiKey,
      "X-Stream-Token": streamToken,
    },
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(
      `[feed] request failed: status=${res.status} body=${body}`
    );
  }

  const json = (await res.json()) as FeedPageResponse;

  if (!json.pagination || !Array.isArray(json.data)) {
    throw new Error("[feed] invalid feed response shape");
  }

  return json;
}

export function normalizeFeedPage(page: FeedPageResponse): NormalizedPage {
  return {
    data: page.data.map((e) => ({
      id: e.id,
      ts: new Date(e.timestamp).toISOString(),
      type: e.type,
      raw: e,
    })),
    hasMore: page.pagination.hasMore,
    nextCursor: page.pagination.nextCursor ?? undefined,
  };
}

export class FeedClient {
  private endpoint?: string;
  private token?: string;
  private tokenHeader?: string;
  private tokenExpiresAtMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async refreshToken(): Promise<void> {
    const stream = await getStreamAccess(this.baseUrl, this.apiKey);

    this.endpoint = stream.endpoint;
    this.token = stream.token;
    this.tokenHeader = stream.tokenHeader;

    // Refresh a little early to avoid edge-of-expiry failures.
    const safetyBufferMs = 10_000;
    this.tokenExpiresAtMs =
      Date.now() + Math.max(0, stream.expiresIn * 1000 - safetyBufferMs);

    console.log(
      `[feed] stream token acquired, expiresIn=${stream.expiresIn}s endpoint=${stream.endpoint}`
    );
  }

  async ensureToken(): Promise<void> {
    if (
      this.endpoint &&
      this.token &&
      this.tokenHeader &&
      Date.now() < this.tokenExpiresAtMs
    ) {
      return;
    }

    await this.refreshToken();
  }

  async fetchPage(
    limit: number,
    sinceMs: number,
    untilMs: number,
    cursor?: string
  ): Promise<FeedPageResponse> {
    await this.ensureToken();

    return fetchFeedPage(
      this.baseUrl,
      this.endpoint!,
      this.apiKey,
      this.token!,
      sinceMs,
      untilMs,
      limit,
      cursor
    );
  }

  async fetchNormalizedPage(
    limit: number,
    sinceMs: number,
    untilMs: number,
    cursor?: string
  ): Promise<NormalizedPage> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const rawPage = await this.fetchPage(limit, sinceMs, untilMs, cursor);
        return normalizeFeedPage(rawPage);
      } catch (err) {
        lastErr = err;

        const msg = err instanceof Error ? err.message : String(err);

        const isRateLimited = msg.includes("status=429");

        const isRetryableServerError =
          msg.includes("status=502") ||
          msg.includes("status=503") ||
          msg.includes("status=504");

        const isRetryableInvalidJson =
          msg.includes("[feed] invalid JSON response") ||
          msg.includes("Infinity");

        if (
          (!isRateLimited &&
            !isRetryableServerError &&
            !isRetryableInvalidJson) ||
          attempt === 5
        ) {
          throw err;
        }

        if (isRateLimited) {
          console.warn(
            `[feed] rate limited on attempt=${attempt}/5 since=${sinceMs} until=${untilMs}; backing off before retry`
          );

          const backoffMs = 10_000 * attempt; // 10s, 20s, 30s...
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        if (isRetryableInvalidJson) {
          console.warn(
            `[feed] invalid JSON on attempt=${attempt}/5 since=${sinceMs} until=${untilMs}; retrying after backoff`
          );

          const backoffMs = 5_000 * attempt;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        console.warn(
          `[feed] transient server error on attempt=${attempt}/5 since=${sinceMs} until=${untilMs}; refreshing token and retrying`
        );

        await this.refreshToken();

        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

export function loadFeedWindowFromEnv(): {
  sinceMs: number;
  untilMs: number;
} {
  const sinceRaw = requireEnv("FEED_SINCE_MS");
  const untilRaw = requireEnv("FEED_UNTIL_MS");

  const sinceMs = Number(sinceRaw);
  const untilMs = Number(untilRaw);

  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    throw new Error("FEED_SINCE_MS and FEED_UNTIL_MS must be valid numbers");
  }
  if (sinceMs >= untilMs) {
    throw new Error("FEED_SINCE_MS must be less than FEED_UNTIL_MS");
  }

  return { sinceMs, untilMs };
}
