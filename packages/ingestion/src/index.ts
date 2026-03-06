import { requireEnv } from "./env";
import { fetchEventsPage } from "./api";
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

export async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");
  const apiKey = requireEnv("TARGET_API_KEY");

  const maxPagesEnv = process.env.INGEST_MAX_PAGES;
  const maxPages = maxPagesEnv ? Number(maxPagesEnv) : undefined;

  // Time window discovered from dashboard
  const sinceMs = 1735381993000; // 2025-12-28 10:33:13
  const untilMs = 1769512812000; // 2026-01-27 11:20:12

  const feedClient = new FeedClient(baseUrl, apiKey);

  const db = await connectDb();
  await migrate(db);

  await runIngestion(
    {
      retrievePage: (limit, cursor) =>
        feedClient.fetchNormalizedPage(limit, sinceMs, untilMs, cursor),

      savePage,
      loadCursor,
      saveCursor,
      savePageAndCursor: savePageAndCursorTx,
      printCount,
    },
    { limit: 5000, db, maxPages }
  );
}

// Only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("[ingestion] fatal error:", err);
    process.exit(1);
  });
}
