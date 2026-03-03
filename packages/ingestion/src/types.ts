import type { Client } from "pg";

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
  retrievePage: (baseUrl: string, limit: number, cursor?: string) => Promise<EventsResponse>;
  savePage: (db: Client, page: EventsResponse) => Promise<void>;
  loadCursor: (db: Client) => Promise<string | undefined>;
  saveCursor: (db: Client, cursor: string) => Promise<void>;
  printCount: (db: Client) => Promise<void>;
};

export type RunIngestionOptions = {
  baseUrl: string;
  limit: number;
  db: Client;
  // Safety guard: prevents infinite loops if the real API behaves unexpectedly
  maxPages?: number;
};
