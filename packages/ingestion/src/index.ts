type DataSyncEvent = {
  id: string;
  ts: string;
  type: string;
};

type EventsResponse = {
  data: DataSyncEvent[];
  hasMore: boolean;
  nextCursor?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const baseUrl = requireEnv("API_BASE_URL").replace(/\/+$/, "");
  const apiKey = process.env.TARGET_API_KEY;

  const url = new URL(`${baseUrl}/events`);
  url.searchParams.set("limit", "5");

  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;

  console.log(`[ingestion] GET ${url.toString()}`);

  const res = await fetch(url, { headers });

  console.log(`[ingestion] status=${res.status}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const json = (await res.json()) as EventsResponse;

  console.log(`[ingestion] received ${json.data.length} events`);
  console.log(`[ingestion] hasMore=${json.hasMore}, nextCursor=${json.nextCursor}`);

  if (json.data.length > 0) {
    console.log("[ingestion] sample event:", json.data[0]);
  }

  console.log("[ingestion] step 1 complete");
}

main().catch((err) => {
  console.error("[ingestion] fatal error:", err);
  process.exit(1);
});

// 👇 防止容器退出（开发阶段用）
setInterval(() => {
  console.log("[ingestion] alive...");
}, 30000);
