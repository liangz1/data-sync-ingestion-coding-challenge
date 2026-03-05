import { requireEnv } from "./env";
import { retrievePage } from "./api";
import { connectDb, migrate, loadCursor, saveCursor, savePage, savePageAndCursorTx, printCount } from "./db";
import { runIngestion } from "./ingestion";

export async function main(): Promise<void> {
  const baseUrl = requireEnv("API_BASE_URL");

  const db = await connectDb();
  await migrate(db);

  await runIngestion(
    { retrievePage, savePage, loadCursor, saveCursor, savePageAndCursor: savePageAndCursorTx, printCount },
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
