import { requireEnv } from "./env";
import type { EventsResponse } from "./types";
import type { PoolClient } from "pg";
import { Pool } from "pg";

type DbExecutor = {
  query: PoolClient["query"];
};

export async function connectDb(): Promise<Pool> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PGPOOLSIZE || 10),
  });

  return pool;
}

export async function migrate(DbExecutor: DbExecutor): Promise<void> {
  await DbExecutor.query(`
    CREATE TABLE IF NOT EXISTS ingested_events (
      id TEXT PRIMARY KEY,
      ts TIMESTAMPTZ,
      type TEXT,
      raw JSONB NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await DbExecutor.query(`
    CREATE TABLE IF NOT EXISTS ingestion_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("[ingestion] migration complete");
}

export async function loadCursor(DbExecutor: DbExecutor): Promise<string | undefined> {
  const r = await DbExecutor.query(
    `SELECT value FROM ingestion_state WHERE key = 'cursor';`
  );
  return r.rows[0]?.value;
}

export async function saveCursor(DbExecutor: DbExecutor, cursor: string): Promise<void> {
  await DbExecutor.query(
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
  DbExecutor: DbExecutor,
  page: EventsResponse
): Promise<number> {
  if (page.data.length === 0) return 0;

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

  const result = await DbExecutor.query(sql, values);
  const inserted = result.rowCount ?? 0;

  console.log(
    `[ingestion] attempted=${page.data.length}, inserted=${inserted}`
  );

  return inserted;
}

export async function savePageAndCursorTx(
  DbExecutor: DbExecutor,
  page: EventsResponse,
  nextCursor: string | undefined
): Promise<{ inserted: number }> {
  await DbExecutor.query("BEGIN");
  try {
    const inserted = await savePage(DbExecutor, page);

    if (nextCursor) {
      await DbExecutor.query(
        `
        INSERT INTO ingestion_state(key, value)
        VALUES ('cursor', $1)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = now();
        `,
        [nextCursor]
      );
    }

    await DbExecutor.query("COMMIT");
    return { inserted };
  } catch (e) {
    await DbExecutor.query("ROLLBACK");
    throw e;
  }
}

export async function printCount(DbExecutor: DbExecutor): Promise<void> {
  const r = await DbExecutor.query(
    `SELECT COUNT(*)::bigint AS c FROM ingested_events;`
  );
  console.log(`[ingestion] total rows=${r.rows[0].c}`);
}
