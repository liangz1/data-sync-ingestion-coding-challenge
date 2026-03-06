# Data Sync Ingestion Service

A resilient, resumable event ingestion service that pulls paginated events from an external API and stores them in PostgreSQL.

The system is designed to run entirely in Docker and complete ingestion automatically without manual intervention.

---

# Architecture Overview

```
DataSync API
      │
      ▼
Ingestion Worker
      │
      ▼
PostgreSQL
```

The ingestion worker:

1. Fetches paginated events from the API
2. Writes events to PostgreSQL
3. Stores the latest cursor
4. Resumes automatically after restarts

---

# Requirements

The solution:

- Runs entirely in Docker
- Works using the command:

```
sh run-ingestion.sh
```

No manual steps are required once ingestion starts.

---

# Configuration

The ingestion worker uses environment variables.

Example `.env`:

```
TARGET_API_KEY=your_api_key_here
```

Required variables:

| Variable | Description |
|--------|-------------|
| API_BASE_URL | Base URL of the DataSync API |
| TARGET_API_KEY | API key used for authentication |
| DATABASE_URL | PostgreSQL connection string |

`.env` files are **not committed to git**.

`.env.example` is provided as a template.

---

# Running the System

Start the full system:

```
sh run-ingestion.sh
```

This launches:

- PostgreSQL
- Mock API
- Ingestion worker

The ingestion worker will:

1. Run database migrations
2. Load the saved cursor
3. Fetch event pages from the API
4. Store events in PostgreSQL
5. Continue until `hasMore=false`

---

# Mock API

A configurable mock API is provided for local testing.

Supported features:

| Feature | Description |
|------|-------------|
| Configurable event count | `MOCK_TOTAL_EVENTS` |
| Max page size | `MOCK_MAX_LIMIT` |
| API key validation | `MOCK_REQUIRE_API_KEY`, `MOCK_API_KEY` |
| Rate limiting simulation | `MOCK_RATE_LIMIT_EVERY_N` |
| Retry delay simulation | `MOCK_RETRY_AFTER_SECONDS` |
| Cursor expiration | `MOCK_CURSOR_TTL_SECONDS` |
| Protocol violation injection | `MOCK_BREAK_PROTOCOL_AT_CURSOR` |
| Response latency | `MOCK_RESPONSE_DELAY_MS` |

This allows testing failure scenarios without using a real API key.

---

# Ingestion Guarantees

## Idempotent Writes

Events are inserted using:

```
ON CONFLICT (id) DO NOTHING
```

Duplicate events are ignored safely.

---

## Transactional Page Commit

Each page is written in a single transaction:

```
BEGIN
INSERT events
UPDATE cursor
COMMIT
```

This ensures a cursor is never advanced without its data being committed.

---

## Rate Limit Handling

The ingestion client automatically handles rate limits.

When receiving `429`:

- respects `Retry-After`
- respects `X-RateLimit-Reset`
- retries automatically

Example log:

```
[ingestion] ratelimit-remaining=99
```

---

## Protocol Safety

The worker validates API pagination responses.

If the API returns:

```
hasMore=true but nextCursor missing
```

the worker fails fast to prevent infinite loops.

---

## Cursor Expiration

Sequential ingestion continuously refreshes cursors and normally avoids expiration.

Cursor expiration mainly affects restart scenarios.

If a stored cursor becomes invalid:

- ingestion fails fast
- restarting from the beginning is safe due to idempotent inserts

---

# Observability

The worker logs ingestion progress and metrics.

Example logs:

```
[ingestion] attempted=1000, inserted=1000
[ingestion] ratelimit-remaining=99
[ingestion] total rows=3000
```

Metrics include:

- pages processed
- attempted inserts
- successful inserts
- rate limit headers

---

# Testing

The system is tested with:

- Unit tests for ingestion logic
- Mocked database and API clients
- Integration tests using the mock API

Test scenarios include:

- normal ingestion
- rate limiting
- protocol violations
- oversized page requests
- cursor expiration

---

# Project Structure

```
packages/
  ingestion/
    src/
      api.ts
      db.ts
      ingestion.ts
      index.ts
      env.ts
mock-api/
docker-compose.yml
```

The codebase separates:

- API client
- database logic
- ingestion loop
- configuration

to keep components testable and maintainable.

---

# Summary

This ingestion system provides:

- resumable ingestion
- idempotent writes
- transactional page commits
- rate limit resilience
- configurable failure testing via mock API

The architecture is designed for reliability under real-world API behavior.