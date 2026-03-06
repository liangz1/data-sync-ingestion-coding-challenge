import type { PoolClient } from "pg";
import { FeedClient, type NormalizedPage } from "./feed";
import type { TimeShard } from "./shards";
import { printCount } from "./db";

type ParallelFeedIngestionOptions = {
  db: PoolClient;
  baseUrl: string;
  apiKey: string;
  shards: TimeShard[];
  concurrency: number;
  limit: number;
  savePage: (db: PoolClient, page: NormalizedPage) => Promise<number>;
};

type AggregateMetrics = {
  startedAtMs: number;
  pages: number;
  attempted: number;
  inserted: number;
  fetchMs: number;
  dbMs: number;
};

function fmtRate(n: number): string {
  return n.toFixed(1);
}

export async function runParallelFeedIngestion(
  opts: ParallelFeedIngestionOptions
): Promise<void> {
  const {
    db,
    baseUrl,
    apiKey,
    shards,
    concurrency,
    limit,
    savePage,
  } = opts;

  if (concurrency <= 0) {
    throw new Error("concurrency must be > 0");
  }

  let nextShardIndex = 0;

  const metrics: AggregateMetrics = {
    startedAtMs: Date.now(),
    pages: 0,
    attempted: 0,
    inserted: 0,
    fetchMs: 0,
    dbMs: 0,
  };

  async function runOneShard(workerId: number, shard: TimeShard): Promise<void> {
    const feedClient = new FeedClient(baseUrl, apiKey);

    console.log(
      `[parallel] worker=${workerId} starting ${shard.shardId} since=${shard.sinceMs} until=${shard.untilMs}`
    );

    let cursor: string | undefined = undefined;

    while (true) {
      const fetchStartedAt = Date.now();
      const page = await feedClient.fetchNormalizedPage(
        limit,
        shard.sinceMs,
        shard.untilMs,
        cursor
      );
      metrics.fetchMs += Date.now() - fetchStartedAt;

      const dbStartedAt = Date.now();
      const inserted = await savePage(db, page);
      metrics.dbMs += Date.now() - dbStartedAt;

      metrics.pages += 1;
      metrics.attempted += page.data.length;
      metrics.inserted += inserted;

      console.log(
        `[parallel] worker=${workerId} shard=${shard.shardId} attempted=${page.data.length} inserted=${inserted}`
      );

      if (!page.hasMore) {
        console.log(`[parallel] worker=${workerId} completed ${shard.shardId}`);
        break;
      }

      if (!page.nextCursor) {
        throw new Error(
          `[parallel] Protocol violation in ${shard.shardId}: hasMore=true but nextCursor is missing`
        );
      }

      cursor = page.nextCursor;
    }
  }

  async function workerLoop(workerId: number): Promise<void> {
    while (true) {
      const shardIndex = nextShardIndex;
      nextShardIndex += 1;

      if (shardIndex >= shards.length) {
        return;
      }

      const shard = shards[shardIndex];
      await runOneShard(workerId, shard);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(workerLoop(i + 1));
  }

  await Promise.all(workers);

  const elapsedSec = (Date.now() - metrics.startedAtMs) / 1000;
  const rate = metrics.inserted / Math.max(1e-6, elapsedSec);

  console.log(
    `[parallel][metrics] pages=${metrics.pages} attempted=${metrics.attempted} inserted=${metrics.inserted} ` +
      `fetchMs=${metrics.fetchMs} dbMs=${metrics.dbMs} insertedPerSec=${fmtRate(rate)}`
  );

  await printCount(db);
}
