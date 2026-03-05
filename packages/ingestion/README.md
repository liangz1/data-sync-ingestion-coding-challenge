# Event Ingestion Service

A resilient ingestion service that fetches events from a paginated HTTP API and stores them in PostgreSQL.

The service supports:

- Cursor-based incremental ingestion
- Idempotent writes
- Automatic recovery after restart
- Rate limit handling
- Transactional page commits
- Basic ingestion metrics

---

# Architecture

The ingestion loop performs the following steps:

1. Load the last processed cursor from the database.
2. Fetch a page of events from the API.
3. Store the events in PostgreSQL.
4. Persist the next cursor.
5. Repeat until `hasMore=false`.

Each page is processed exactly once in normal operation, and ingestion can safely resume after interruption.

---

# Data Model

## ingested_events

Stores the raw events returned by the API.

Primary key ensures idempotency.

```
id TEXT PRIMARY KEY
ts TIMESTAMP
type TEXT
raw JSONB
```

Duplicates are ignored using:

```
ON CONFLICT (id) DO NOTHING
```

---

## ingestion_state

Stores the ingestion cursor.

```
key TEXT PRIMARY KEY
value TEXT
updated_at TIMESTAMP
```

Only one key is currently used:

```
cursor
```

---

# Transactional Ingestion

To ensure consistency during ingestion, each page commit is performed in a **single database transaction**.

Within one transaction:

1. Insert events
2. Update cursor
3. Commit

```
BEGIN

INSERT INTO ingested_events ...
ON CONFLICT DO NOTHING

UPSERT ingestion_state(cursor)

COMMIT
```

This guarantees:

- No cursor advancement without persisted data
- No partial page ingestion
- Safe restart after crashes

---

# Rate Limit Handling

The API may return HTTP **429 (Too Many Requests)**.

The ingestion client automatically retries requests when rate limits occur.

Supported headers:

### Retry-After

```
Retry-After: <seconds>
```

The client waits the specified number of seconds before retrying.

### X-RateLimit-Reset

```
X-RateLimit-Reset: <epoch_seconds>
```

The client waits until the reset timestamp.

### Logging

The client logs remaining quota if provided:

```
[ingestion] ratelimit-remaining=99
```

This helps operators monitor available request budget.

---

# Metrics

Periodic ingestion metrics are logged every N pages:

```
[ingestion][metrics]
pages=10
attempted=10000
inserted=9987
fetchMs=210
dbMs=180
insertedPerSec=4200
```

Metrics include:

| Metric | Meaning |
|------|------|
| pages | number of processed pages |
| attempted | events received from API |
| inserted | rows inserted into DB |
| fetchMs | total API request time |
| dbMs | total database write time |
| insertedPerSec | ingestion throughput |

---

# Idempotency

The system is designed for **at-least-once ingestion**.

Possible scenarios:

- restart during ingestion
- duplicate page fetch
- network retry

Duplicates are safely ignored by the database primary key constraint.

Example log:

```
attempted=1000 inserted=0
```

This indicates the page was already previously ingested.

---

# Resumability

On startup the service resumes from the last saved cursor:

```
[ingestion] starting from cursor=9000
```

If the service crashes mid-run, ingestion continues from that position on restart.

---

# Running the Service

```
docker compose up
```

Logs will show ingestion progress:

```
[ingestion] starting from cursor=BEGIN
[ingestion] GET /events?limit=1000
[ingestion] attempted=1000 inserted=1000
```

---

# Testing

Run unit tests:

```
npm test
```

Tests cover:

- API pagination
- rate limit retry logic
- database insertion
- cursor persistence
- ingestion loop behavior

---

# Failure Scenarios & Guarantees

The ingestion system is designed to remain correct under common failure scenarios.

## Crash During API Fetch

If the service crashes while fetching a page:

- No database writes have occurred
- Cursor remains unchanged

On restart the same page will be fetched again.

This is safe because ingestion is idempotent.

---

## Crash During Database Insert

If the service crashes during page insertion:

- The database transaction is rolled back
- No partial page writes are committed
- Cursor is not advanced

The same page will be retried on restart.

---

## Crash After Insert But Before Cursor Update

This situation is prevented by the transactional design.

Event insertion and cursor persistence occur in the same transaction:

```
BEGIN
INSERT events
UPSERT cursor
COMMIT
```

Therefore:

- Either both succeed
- Or both fail

The system never advances the cursor without storing the corresponding events.

---

## Duplicate Page Fetch

Network retries or restarts may cause the same page to be processed more than once.

Duplicates are handled safely via the primary key constraint:

```
ON CONFLICT (id) DO NOTHING
```

Example log:

```
attempted=1000 inserted=0
```

This indicates that all events already existed in the database.

---

## API Protocol Violations

If the API returns:

```
hasMore = true
but nextCursor is missing
```

The ingestion process fails fast with an explicit error.

This prevents silent data loss caused by malformed pagination responses.

---

## Guarantees

The system provides the following guarantees:

| Property | Guarantee |
|--------|--------|
| No data loss | Cursor never advances without persisted events |
| Idempotency | Duplicate events are ignored |
| Crash safety | Safe restart after failure |
| At-least-once ingestion | Pages may be retried but never skipped |

These properties ensure reliable ingestion even under network errors, rate limiting, or process crashes.

---

# Future Improvements

Possible optimizations:

- concurrent page prefetching
- batch COPY ingestion for higher throughput
- adaptive rate limit scheduling
- structured metrics export (Prometheus)