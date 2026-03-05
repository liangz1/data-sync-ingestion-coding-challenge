# DataSync Ingestion Service

A production-ready data ingestion system that extracts events from the
DataSync Analytics API and stores them in PostgreSQL.

------------------------------------------------------------------------

## Architecture Overview

The system is structured into clear responsibility boundaries:

    src/
      env.ts         // Environment variable handling
      api.ts         // API client (HTTP layer)
      db.ts          // PostgreSQL access layer
      ingestion.ts   // Core ingestion loop (pure control flow)
      types.ts       // Shared type definitions
      index.ts       // Runtime wiring / entrypoint

### Design Principles

-   **Separation of concerns**
    -   Network, database, and control flow are isolated
-   **Testability**
    -   `runIngestion` is dependency-injected and fully unit-testable
-   **Idempotency**
    -   `ON CONFLICT DO NOTHING` prevents duplicate inserts
-   **Resumability**
    -   Cursor is persisted in `ingestion_state`
-   **Fail-fast safety**
    -   Guard against infinite loops
    -   Detect protocol violations (`hasMore=true` without `nextCursor`)
-   **Deterministic control flow**
    -   No hidden global state

------------------------------------------------------------------------

## How It Works

1.  Connect to PostgreSQL
2.  Run schema migration (idempotent)
3.  Load last stored cursor
4.  Repeatedly:
    -   Fetch a page of events
    -   Store events in bulk
    -   Persist cursor
5.  Stop when `hasMore=false`
6.  Print total row count

------------------------------------------------------------------------

## Running the Service

Start all services:

``` bash
docker compose up -d --build
```

Or use the provided script:

``` bash
sh run-ingestion.sh
```

The ingestion service will:

-   Connect to PostgreSQL
-   Ingest events
-   Resume automatically after crash
-   Exit when complete

------------------------------------------------------------------------

## Database Schema

### `ingested_events`

  Column        Type          Description
  ------------- ------------- ---------------------
  id            TEXT (PK)     Event ID
  ts            TIMESTAMPTZ   Event timestamp
  type          TEXT          Event type
  raw           JSONB         Full event payload
  ingested_at   TIMESTAMPTZ   Ingestion timestamp

### `ingestion_state`

  Column       Type          Description
  ------------ ------------- -------------
  key          TEXT (PK)     State key
  value        TEXT          State value
  updated_at   TIMESTAMPTZ   Last update

------------------------------------------------------------------------

## Testing Strategy

Unit tests are split by layer:

-   `env.test.ts`
-   `api.test.ts`
-   `db.test.ts`
-   `ingestion.test.ts`
-   `index.test.ts` (wiring)

The core ingestion loop is fully mocked and does not require a real
database or network.

Run tests:

``` bash
npm test
```

------------------------------------------------------------------------

## Safety Guards

The ingestion loop includes:

-   `maxPages` limit (infinite loop protection)
-   Protocol validation (`hasMore` must include `nextCursor`)
-   Idempotent inserts

------------------------------------------------------------------------

## Rate Limit Handling

The API enforces rate limits and may return `429 Too Many Requests` (or transient `503 Service Unavailable`). The ingestion client is rate-limit aware and applies a retry/backoff strategy:

- **Auth header:** requests include `X-API-Key` (from `TARGET_API_KEY`) for header-based authentication.
- **Retryable statuses:** `429` and `503` trigger retries; other non-2xx responses fail fast with an error that includes the HTTP status and response body.
- **Server-guided backoff:** if present, the client respects:
  - `Retry-After` (seconds or HTTP-date)
  - `X-RateLimit-Reset` (epoch seconds or milliseconds)
- **Exponential backoff + jitter:** when server guidance is missing, the client uses exponential backoff (capped) plus a small random jitter to avoid thundering herd.
- **Observability:** the client logs `ratelimit-remaining` (from `X-RateLimit-Remaining` / `RateLimit-Remaining`) when provided by the API to help diagnose throttling.
- **Safety cap:** retries are bounded by a maximum retry count to avoid infinite retry loops.

------------------------------------------------------------------------

## Next Steps (Planned Enhancements)

-   Throughput optimization (parallel page fetching)
-   Metrics and ingestion rate logging
-   Bulk insert optimizations (COPY)
-   Integration tests with real DB container

------------------------------------------------------------------------

## Tools Used

-   Node.js 20
-   TypeScript
-   PostgreSQL 16
-   Docker Compose
-   Vitest
