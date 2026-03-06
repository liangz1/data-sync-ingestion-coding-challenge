import { requireEnv } from "./env";

type EventsResponse = {
  data: Array<{
    id: string;
    ts: string;
    type: string;
  }>;
  hasMore: boolean;
  nextCursor?: string;
};

function buildEventsUrl(baseUrl: string, limit: number, cursor?: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

function pickHeader(headers: Headers, ...names: string[]): string | null {
  for (const name of names) {
    const v = headers.get(name);
    if (v) return v;
  }
  return null;
}

async function fetchPage(
  baseUrl: string,
  apiKey: string,
  limit: number,
  cursor?: string
): Promise<Response> {
  const url = buildEventsUrl(baseUrl, limit, cursor);
  return fetch(url, {
    headers: {
      "X-API-Key": apiKey,
    },
  });
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");
  const apiKey = requireEnv("TARGET_API_KEY");

  console.log("[probe] starting API probe...");
  console.log(`[probe] baseUrl=${baseUrl}`);

  const candidateLimits = [1000, 2000, 5000, 10000];
  let recommendedLimit: number | undefined;

  console.log("[probe] checking auth + first page...");

  const firstRes = await fetchPage(baseUrl, apiKey, candidateLimits[0]);
  console.log(`[probe] first request status=${firstRes.status}`);

  if (!firstRes.ok) {
    const body = await firstRes.text().catch(() => "");
    throw new Error(
      `[probe] first request failed: status=${firstRes.status} body=${body}`
    );
  }

  const firstJson = (await firstRes.json()) as EventsResponse;

  const remaining = pickHeader(
    firstRes.headers,
    "x-ratelimit-remaining",
    "ratelimit-remaining"
  );
  const reset = pickHeader(
    firstRes.headers,
    "x-ratelimit-reset",
    "ratelimit-reset"
  );
  const retryAfter = pickHeader(firstRes.headers, "retry-after");
  const contentType = pickHeader(firstRes.headers, "content-type");
  const link = pickHeader(firstRes.headers, "link");

  console.log(
    `[probe] first page: pageSize=${firstJson.data.length} hasMore=${firstJson.hasMore} nextCursor=${firstJson.nextCursor ?? "null"}`
  );

  console.log("[probe] response headers:");
  console.log(`  content-type=${contentType ?? "n/a"}`);
  console.log(`  ratelimit-remaining=${remaining ?? "n/a"}`);
  console.log(`  ratelimit-reset=${reset ?? "n/a"}`);
  console.log(`  retry-after=${retryAfter ?? "n/a"}`);
  console.log(`  link=${link ?? "n/a"}`);

  console.log("[probe] testing candidate limits...");

  for (const limit of candidateLimits) {
    const startedAt = Date.now();
    const res = await fetchPage(baseUrl, apiKey, limit);
    const elapsedMs = Date.now() - startedAt;

    const status = res.status;
    let pageSizeText = "n/a";
    let bodySnippet = "";

    if (res.ok) {
      const json = (await res.json()) as EventsResponse;
      pageSizeText = String(json.data.length);
      recommendedLimit = limit;
    } else {
      const body = await res.text().catch(() => "");
      bodySnippet = body.slice(0, 200);
    }

    console.log(
      `[probe] limit=${limit} status=${status} elapsedMs=${elapsedMs} pageSize=${pageSizeText}` +
        (bodySnippet ? ` body=${JSON.stringify(bodySnippet)}` : "")
    );
  }

  console.log(
    `[probe] recommendedLimit=${recommendedLimit ?? "none"}`
  );

  if (!recommendedLimit) {
    console.log(
      "[probe] no candidate limit succeeded; use the documented/default limit and inspect the API manually"
    );
  }

  console.log("[probe] done");
}

main().catch((err) => {
  console.error("[probe] fatal error:", err);
  process.exit(1);
});
