import type { IngestionDeps, RunIngestionOptions } from "./types";

/**
 * Metrics collector utils.
 */
type IngestionMetrics = {
  startedAtMs: number;
  pages: number;
  attempted: number;
  inserted: number;
  fetchMs: number;
  dbMs: number;
};

function nowMs(): number {
  return Date.now();
}

function fmtRate(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(1);
}

/**
 * Core ingestion loop: deterministic, testable, no env access, no db connect, no migrate.
 */
export async function runIngestion(
  deps: IngestionDeps,
  opts: RunIngestionOptions
): Promise<void> {
  const { limit, db } = opts;
  const maxPages = opts.maxPages ?? Infinity;

  let cursor = await deps.loadCursor(db);
  console.log(`[ingestion] starting from cursor=${cursor ?? "BEGIN"}`);

  const metrics: IngestionMetrics = {
    startedAtMs: nowMs(),
    pages: 0,
    attempted: 0,
    inserted: 0,
    fetchMs: 0,
    dbMs: 0,
  };

  const logEveryPages = 10;

  while (true) {
    metrics.pages += 1;
    if (metrics.pages > maxPages) {
        throw new Error(
        `[ingestion] exceeded maxPages=${maxPages}; aborting to avoid infinite loop`
        );
    }

    const fetchStart = nowMs();
    const page = await deps.retrievePage(limit, cursor);
    const fetchDur = nowMs() - fetchStart;
    metrics.fetchMs += fetchDur;

    metrics.attempted += page.data.length;

    const dbStart = nowMs();
    let insertedThisPage = 0;

    if (page.hasMore) {
      if (!page.nextCursor) {
        throw new Error(
          `[ingestion] Protocol violation: hasMore=true but nextCursor is missing (cursor=${
            cursor ?? "BEGIN"
          }, pageSize=${page.data.length}).`
        );
      }

      const r = await deps.savePageAndCursor(db, page, page.nextCursor);
      insertedThisPage = r.inserted;
      cursor = page.nextCursor;
    } else {
      // last page: no cursor update needed
      insertedThisPage = await deps.savePage(db, page);
    }

    const dbDur = nowMs() - dbStart;
    metrics.dbMs += dbDur;

    metrics.inserted += insertedThisPage;

    // Periodic summary
    if (metrics.pages % logEveryPages === 0) {
        const elapsedSec = (nowMs() - metrics.startedAtMs) / 1000;
        const rate = metrics.inserted / Math.max(1e-6, elapsedSec);

        console.log(
        `[ingestion][metrics] pages=${metrics.pages} attempted=${metrics.attempted} inserted=${metrics.inserted} ` +
            `fetchMs=${metrics.fetchMs} dbMs=${metrics.dbMs} ` +
            `insertedPerSec=${fmtRate(rate)}`
        );
    }

    if (!page.hasMore) {
      console.log("[ingestion] ingestion complete");
      break;
    }
  }

  await deps.printCount(db);
}
