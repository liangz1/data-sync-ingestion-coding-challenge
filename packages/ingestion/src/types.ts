import type { PoolClient } from "pg";

export type DbExecutor = {
  query: PoolClient["query"];
};

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

/**
 * Dependency injection boundary for testability.
 * In tests, pass mocked deps; in prod, main() wires real deps.
 */
export type IngestionDeps = {
  retrievePage: (limit: number, cursor?: string) => Promise<EventsResponse>;
  savePage: (db: DbExecutor, page: EventsResponse) => Promise<number>;
  loadCursor: (db: DbExecutor) => Promise<string | undefined>;
  // saveCursor is retained for backward compatibility but not used in the transactional path.
  saveCursor: (db: DbExecutor, cursor: string) => Promise<void>;
  // Transactional write: page + cursor in one atomic commit
  savePageAndCursor: (
    db: DbExecutor,
    page: EventsResponse,
    nextCursor: string
  ) => Promise<{ inserted: number }>;
  printCount: (db: DbExecutor) => Promise<void>;
};

export type RunIngestionOptions = {
  limit: number;
  db: DbExecutor;
  // Safety guard: prevents infinite loops if the real API behaves unexpectedly
  maxPages?: number;
};
