# DataSync Ingestion Challenge

This repository implements a resilient ingestion pipeline for the DataSync Analytics API.

The goal is to ingest all historical events into PostgreSQL while handling rate limits, token expiration, malformed responses, and large historical backfills.

The solution runs entirely in Docker.

---

## How to run the solution

### Setup

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Edit `.env` and set your assigned `TARGET_API_KEY`.

### Run ingestion

```bash
sh run-ingestion.sh
```

To watch worker progress:

```bash
docker compose logs -f ingestion
```

To verify results in PostgreSQL:

```bash
docker exec -it assignment-postgres psql -U postgres ingestion
```

Useful checks:

```sql
SELECT COUNT(*) FROM ingested_events;
SELECT COUNT(*), COUNT(DISTINCT id) FROM ingested_events;
```

---

## Architecture overview

The final solution uses the feed API rather than the basic cursor API.

```text
DataSync API
    |
    v
stream-access + feed API
    |
    v
Time sharding
    |
    v
Parallel workers
    |
    v
PostgreSQL
```

Main components:

- **FeedClient**: obtains and refreshes feed access tokens, requests feed pages, and handles retries.
- **Time sharding**: splits the full historical range into smaller windows.
- **Parallel workers**: ingest multiple time shards concurrently.
- **PostgreSQL storage**: stores raw events with idempotent inserts.

Key design choices:

- use the higher-throughput feed endpoint
- shard by time range instead of relying on one global cursor
- use `INSERT ... ON CONFLICT DO NOTHING` for restart safety
- retry transient failures such as `429`, `502`, `503`, `504`, and malformed JSON responses

---

## API discoveries

During exploration, I found two relevant APIs.

### 1. Public cursor API

```text
GET /api/v1/events
```

Properties observed:

- cursor-based pagination
- stricter rate limits
- slower for large historical ingestion
- less suitable for parallelization

This path was workable, but too slow for a full backfill.

### 2. Feed API used by the dashboard

```text
POST /internal/dashboard/stream-access
GET  /api/v1/events/.../feed
```

Properties observed:

- supports `since` / `until` filtering
- supports pagination with `nextCursor`
- supports larger page sizes
- much better suited to time sharding and parallel ingestion

The dashboard endpoint returns a short-lived token, and the feed endpoint is then accessed with:

- `X-API-Key`
- `X-Stream-Token`

This feed API became the primary ingestion path.

---

## Ingestion strategy

The final pipeline ingests historical data using **time-based sharding**.

The discovered historical range was approximately:

- start: 2025-12-28
- end: 2026-01-27

That range is split into fixed windows, for example one shard per day.

Each worker:

1. claims a time shard
2. requests feed pages within that shard
3. writes events to PostgreSQL
4. moves to the next shard

This avoids relying on a single long-lived global cursor and makes the system much more resilient to cursor expiration.

---

## Fault tolerance

The pipeline retries several classes of transient failure:

- HTTP `429` rate limit responses
- HTTP `502`, `503`, `504`
- malformed / truncated JSON responses
- temporary token refresh failures

Feed tokens expire quickly, so token refresh is built into the client.

Database writes are idempotent:

```sql
INSERT ... ON CONFLICT DO NOTHING
```

This means restarts are safe even if some shards are re-scanned.

---

## Measured throughput

From the real ingestion logs:

- first recorded progress line: `[23:48:39] Events ingested: 20000`
- last recorded progress line: `[00:06:15] Events ingested: 2734174`

That means:

- elapsed time: **17 minutes 36 seconds** = **1056 seconds**
- ingested events in that interval: **2,714,174 - 20,000 = 2,694,174**
- average throughput over that interval: **about 2,551 events/sec**

Calculation:

```text
2,694,174 / 1,056 ≈ 2,551 events/sec
```

This was substantially faster than the earlier single-stream approach.

---

## What I would improve with more time

### 1. Persistent shard checkpointing

The current version is restart-safe, but not resume-efficient.

A stronger version would persist:

- shard status
- per-shard cursor
- retry metadata

That would allow incomplete shards to resume exactly where they stopped.

### 2. Handle truncated JSON responses from the feed API

During ingestion we occasionally observed responses where the HTTP body
contained incomplete JSON, resulting in errors such as:

```
SyntaxError: Unterminated string in JSON at position 422433
```

This appears to be caused by upstream gateway or server-side truncation of
large JSON responses.

Currently these failures terminate the worker and require a restart.

A more robust implementation would:

- Parse responses using `response.text()` followed by guarded `JSON.parse`
- Detect truncated or malformed JSON responses
- Treat them as retryable transient errors
- Retry the request with exponential backoff

This would further improve the resilience of the ingestion pipeline when
dealing with unstable upstream services.

### 3. Cleaner submission workflow

I would add a small export / submit script to:

- validate row counts
- export final event IDs
- submit results automatically

### 4. More complete tests for the feed path

The original tests focused on the cursor API path.

With more time I would add:

- feed token refresh tests
- sharding tests
- retry tests for malformed JSON and gateway failures

### 5. Adaptive rate limiting

The current retry and backoff logic is static.

I would improve it by:

- reading rate-limit headers when available
- dynamically reducing concurrency
- pacing workers globally instead of letting each worker back off independently

### 6. Better observability

I would add:

- structured metrics for throughput
- shard-level progress reporting
- retry counters by error type
- ETA estimation


---

## AI Tools used

ChatGPT Auto

---

## Summary

This solution evolved from a straightforward cursor-based ingester into a more scalable feed-based ingestion system.

Final characteristics:

- Docker-first execution
- feed API ingestion
- time sharding
- parallel workers
- retry handling for unstable APIs
- idempotent PostgreSQL writes
- restart-safe behavior

The resulting design is much better suited for large historical backfills than the original cursor-only approach.
