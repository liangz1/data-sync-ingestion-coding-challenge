import type { IngestionDeps, RunIngestionOptions } from "./types";

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
      throw new Error(
        `[ingestion] exceeded maxPages=${maxPages}; aborting to avoid infinite loop`
      );
    }

    const page = await deps.retrievePage(baseUrl, limit, cursor);

    await deps.savePage(db, page);

    if (page.hasMore) {
      if (!page.nextCursor) {
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
