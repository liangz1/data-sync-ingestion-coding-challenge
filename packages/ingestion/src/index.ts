import { requireEnv } from "./env";
import {
  connectDb,
  migrate,
  loadCursor,
  saveCursor,
  savePage,
  savePageAndCursorTx,
  printCount,
} from "./db";
import { runIngestion } from "./ingestion";
import { FeedClient } from "./feed";
import { buildTimeShards } from "./shards";
import { runParallelFeedIngestion } from "./parallel";

export async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");
  const apiKey = requireEnv("TARGET_API_KEY");

  const maxPagesEnv = process.env.INGEST_MAX_PAGES;
  const maxPages = maxPagesEnv ? Number(maxPagesEnv) : undefined;

  const feedConcurrencyEnv = process.env.FEED_CONCURRENCY;
  const feedConcurrency = feedConcurrencyEnv ? Number(feedConcurrencyEnv) : 1;

  const shardMsEnv = process.env.FEED_SHARD_MS;
  const shardSizeMs = shardMsEnv ? Number(shardMsEnv) : 24 * 60 * 60 * 1000; // 1 day

  // Time window discovered from dashboard
  const sinceMs = 1766917993000; // 2025-12-28 10:33:13
  const untilMs = 1769512812000; // 2026-01-27 11:20:12

  const pool = await connectDb();
  const db = await pool.connect();

  try {
    await migrate(db);

    if (feedConcurrency > 1) {
      const shards = buildTimeShards(sinceMs, untilMs, shardSizeMs);

      console.log(
        `[parallel] starting feed ingestion with shards=${shards.length} concurrency=${feedConcurrency} limit=5000`
      );

      await runParallelFeedIngestion({
        db,
        baseUrl,
        apiKey,
        shards,
        concurrency: feedConcurrency,
        limit: 5000,
        savePage,
      });

      return;
    }

    const feedClient = new FeedClient(baseUrl, apiKey);

    await runIngestion(
      {
        retrievePage: (limit, cursor) =>
          feedClient.fetchNormalizedPage(limit, sinceMs, untilMs, cursor),
        savePage,
        loadCursor: async () => undefined,
        saveCursor,
        savePageAndCursor: savePageAndCursorTx,
        printCount,
      },
      { limit: 5000, db, maxPages }
    );
  } finally {
    db.release();
    await pool.end();
  }
}

// Only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("[ingestion] fatal error:", err);
    process.exit(1);
  });
}
