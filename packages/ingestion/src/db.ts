import { Client } from "pg";
import { requireEnv } from "./env";
import type { EventsResponse } from "./types";

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
