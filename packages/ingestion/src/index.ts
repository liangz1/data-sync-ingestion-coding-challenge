import { requireEnv } from "./env";
import { fetchEventsPage } from "./api";
import { connectDb, migrate, loadCursor, saveCursor, savePage, savePageAndCursorTx, printCount } from "./db";
import { runIngestion } from "./ingestion";

export async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");
  const apiKey = requireEnv("TARGET_API_KEY");
  const maxPagesEnv = process.env.INGEST_MAX_PAGES;
  const maxPages = maxPagesEnv ? Number(maxPagesEnv) : undefined;

  const db = await connectDb();
  await migrate(db);

  await runIngestion(
    {
      retrievePage: (limit, cursor) => fetchEventsPage(baseUrl, apiKey, limit, cursor),
      savePage,
      loadCursor,
      saveCursor,
      savePageAndCursor: savePageAndCursorTx,
      printCount
    },
    { limit: 1000, db, maxPages }
  );
}

// Only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("[ingestion] fatal error:", err);
    process.exit(1);
  });
}
