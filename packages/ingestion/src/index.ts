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

type RetrieveParams = {
  baseUrl: string; // e.g. http://mock-api:8787/api/v1
  limit: number;
  cursor?: string;
  apiKey?: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function buildEventsUrl(baseUrl: string, limit: number, cursor?: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

async function retrievePage(params: RetrieveParams): Promise<Response> {
  const url = buildEventsUrl(params.baseUrl, params.limit, params.cursor);

  const headers: Record<string, string> = {};
  if (params.apiKey) headers["X-API-Key"] = params.apiKey;

  console.log(`[ingestion] GET ${url}`);
  return fetch(url, { headers });
}

async function handleError(res: Response): Promise<void> {
  // 统一打印一些你后面会用到的 header（真实 API 会更有用）
  console.log(`[ingestion] status=${res.status}`);

  if (res.ok) return;

  const body = await res.text().catch(() => "");
  throw new Error(`Request failed: ${res.status} ${res.statusText}\n${body}`);
}

function validatePayload(json: unknown): EventsResponse {
  // Step 1 先轻量校验：确保有 data 数组、hasMore boolean
  if (typeof json !== "object" || json === null) throw new Error("Invalid JSON: not an object");

  const anyJson = json as any;
  if (!Array.isArray(anyJson.data)) throw new Error("Invalid JSON: data is not an array");
  if (typeof anyJson.hasMore !== "boolean") throw new Error("Invalid JSON: hasMore is not boolean");

  return anyJson as EventsResponse;
}

function savePage(page: EventsResponse): void {
  // Step 1 暂时不写 DB：只打印（你下一步会把这里换成 insert/batch insert）
  console.log(`[ingestion] received ${page.data.length} events`);
  console.log(`[ingestion] hasMore=${page.hasMore}, nextCursor=${page.nextCursor ?? "null"}`);
  if (page.data.length > 0) console.log("[ingestion] sample event:", page.data[0]);
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");
  const apiKey = process.env.TARGET_API_KEY; // mock 可不填

  const res = await retrievePage({ baseUrl, limit: 5, apiKey });
  await handleError(res);

  const json = await res.json();
  const page = validatePayload(json);

  savePage(page);

  console.log("[ingestion] step 1 complete");
}

main().catch((err) => {
  console.error("[ingestion] fatal error:", err);
  process.exit(1);
});

// 开发阶段：保持容器不退出
setInterval(() => {
  console.log("[ingestion] alive...");
}, 30000);
