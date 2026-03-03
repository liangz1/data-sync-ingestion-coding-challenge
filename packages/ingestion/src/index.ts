import { Client } from "pg";

export type DataSyncEvent = {
  id: string;
  ts: string;
  type: string;
};

export type EventsResponse = {
  data: DataSyncEvent[];
  hasMore: boolean;
  nextCursor?: string;
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function buildEventsUrl(baseUrl: string, limit: number, cursor?: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

export async function connectDb(): Promise<Client> {
  const client = new Client({
    connectionString: requireEnv("DATABASE_URL"),
  });
  await client.connect();
  return client;
}

export async function migrate(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ingested_events (
      id TEXT PRIMARY KEY,
      ts TIMESTAMPTZ,
      type TEXT,
      raw JSONB NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ingestion_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("[ingestion] migration complete");
}

export async function loadCursor(client: Client): Promise<string | undefined> {
  const r = await client.query(
    `SELECT value FROM ingestion_state WHERE key = 'cursor';`
  );
  return r.rows[0]?.value;
}

export async function saveCursor(client: Client, cursor: string): Promise<void> {
  await client.query(
    `
    INSERT INTO ingestion_state(key, value)
    VALUES ('cursor', $1)
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    `,
    [cursor]
  );
}

export async function retrievePage(
  baseUrl: string,
  limit: number,
  cursor?: string
): Promise<EventsResponse> {
  const url = buildEventsUrl(baseUrl, limit, cursor);

  console.log(`[ingestion] GET ${url}`);

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${body}`);
  }

  const json = await res.json();
  return json as EventsResponse;
}

export async function savePage(
  client: Client,
  page: EventsResponse
): Promise<void> {
  if (page.data.length === 0) return;

  const values: any[] = [];
  const rows: string[] = [];

  page.data.forEach((e, i) => {
    const base = i * 4;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(e.id, e.ts, e.type, e);
  });

  const sql = `
    INSERT INTO ingested_events (id, ts, type, raw)
    VALUES ${rows.join(",")}
    ON CONFLICT (id) DO NOTHING;
  `;

  const result = await client.query(sql, values);
  console.log(
    `[ingestion] attempted=${page.data.length}, inserted=${result.rowCount}`
  );
}

export async function printCount(client: Client): Promise<void> {
  const r = await client.query(
    `SELECT COUNT(*)::bigint AS c FROM ingested_events;`
  );
  console.log(`[ingestion] total rows=${r.rows[0].c}`);
}

/**
 * Dependency injection boundary for testability.
 * In tests, pass mocked deps; in prod, main() wires real deps.
 */
export type IngestionDeps = {
  retrievePage: (baseUrl: string, limit: number, cursor?: string) => Promise<EventsResponse>;
  savePage: (db: Client, page: EventsResponse) => Promise<void>;
  loadCursor: (db: Client) => Promise<string | undefined>;
  saveCursor: (db: Client, cursor: string) => Promise<void>;
  printCount: (db: Client) => Promise<void>;
};

export type RunIngestionOptions = {
  baseUrl: string;
  limit: number;
  db: Client;
  // Safety guard: prevents infinite loops if the real API behaves unexpectedly
  maxPages?: number;
};

/**
 * Core ingestion loop: deterministic, testable, no env access, no db connect, no migrate.
 */
export async function runIngestion(
  deps: IngestionDeps,
  opts: RunIngestionOptions
): Promise<void> {
  const { baseUrl, limit, db } = opts;
  const maxPages = opts.maxPages ?? Infinity;

  let cursor = await deps.loadCursor(db);
  console.log(`[ingestion] starting from cursor=${cursor ?? "BEGIN"}`);

  let pages = 0;

  while (true) {
    pages += 1;
    if (pages > maxPages) {
      throw new Error(`[ingestion] exceeded maxPages=${maxPages}; aborting to avoid infinite loop`);
    }

    const page = await deps.retrievePage(baseUrl, limit, cursor);

    await deps.savePage(db, page);

    if (page.hasMore) {
      if (!page.nextCursor) {
        // Fail-fast guard: prevents infinite loops if API says hasMore but doesn't return cursor
        throw new Error(
          `[ingestion] Protocol violation: hasMore=true but nextCursor is missing (cursor=${cursor ?? "BEGIN"}, pageSize=${page.data.length}).`
        );
      }
      await deps.saveCursor(db, page.nextCursor);
      cursor = page.nextCursor;
    } else {
      console.log("[ingestion] ingestion complete");
      break;
    }
  }

  await deps.printCount(db);
}

/**
 * Thin runtime entrypoint: wires real deps + env + migrations.
 */
export async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");

  const db = await connectDb();
  await migrate(db);

  await runIngestion(
    { retrievePage, savePage, loadCursor, saveCursor, printCount },
    { baseUrl, limit: 1000, db }
  );
}

// Only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("[ingestion] fatal error:", err);
    process.exit(1);
  });
}
