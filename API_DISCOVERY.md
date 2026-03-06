# API Discovery Notes

This document summarizes the API exploration performed during development of the ingestion pipeline.
The goal was to identify the most efficient and reliable way to retrieve the full dataset (~3M events).

---

# 1. Initial Public API: `/api/v1/events`

The assignment documentation references the public endpoint:

GET /api/v1/events

This endpoint supports cursor-based pagination:

GET /api/v1/events?limit=1000
GET /api/v1/events?limit=1000&cursor=...

Typical response shape:

{
  "data": [...],
  "hasMore": true,
  "nextCursor": "..."
}

## Observed behavior

Headers returned by the API:

X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset

Empirical probing showed:

- Maximum page size appears capped around 5000 events
- Rate limit roughly 10 requests per minute

## Throughput estimate

Total events ≈ 3,000,000  
Page size ≈ 5000  
Requests required ≈ 600  
Rate limit ≈ 10 req/min  
Total time ≈ ~60 minutes

This exceeds the assignment goal of completing ingestion within 30 minutes.

Therefore we investigated whether a more efficient ingestion path exists.

---

# 2. Discovery of Dashboard Feed API

Using the provided dashboard UI and browser developer tools, an additional API flow was observed.

## Step 1: obtain stream token

POST /internal/dashboard/stream-access

Required headers:

X-API-Key  
Cookie: dashboard_api_key=<api_key>

Response:

{
  "streamAccess": {
    "endpoint": "/api/v1/events/.../feed",
    "token": "...",
    "expiresIn": 300,
    "tokenHeader": "X-Stream-Token"
  }
}

This returns:

- a feed endpoint
- a short-lived stream token (5 minutes)

---

# 3. Feed Endpoint

GET /api/v1/events/<stream-id>/feed

Required headers:

X-API-Key  
X-Stream-Token

Query parameters:

since  
until  
limit  
cursor

Example request:

GET /feed?since=...&until=...&limit=5000

Example response:

{
  "data": [...],
  "pagination": {
    "limit": 5000,
    "hasMore": true,
    "nextCursor": "...",
    "cursorExpiresIn": 116
  },
  "meta": {
    "total": 3000000,
    "returned": 5000
  }
}

## Observed properties

- supports large page sizes (tested up to 5000 events/page)
- explicit pagination metadata
- cursor expiration is exposed
- dataset total size available
- supports time range filtering

---

# 4. Throughput Comparison

| API | Page Size | Rate Limit | Estimated Time |
|----|----|----|----|
| `/events` | ~5000 | ~10 req/min | ~60 minutes |
| `feed` | 5000 | no observed strict limit | < 5 minutes |

Feed ingestion estimate:

3,000,000 / 5000 ≈ 600 requests  
~300ms/request ≈ ~3 minutes total

---

# 5. Design Decision

The ingestion pipeline will support **two ingestion strategies**.

## Primary Strategy: Feed API

stream-access → feed pagination

Advantages:

- higher throughput
- larger page size
- explicit pagination metadata
- time window filtering
- predictable cursor expiration

## Fallback Strategy: Public `/events`

Used when:

- stream token cannot be obtained
- dashboard access is unavailable
- feed API behavior changes

The fallback ensures compatibility with the documented public API.

---

# 6. Implementation Plan

The ingestion worker will be extended with the following components.

## New module

src/stream.ts

Responsibilities:

- request stream token
- manage token refresh
- call feed endpoint
- handle cursor pagination

## Feed ingestion flow

1. obtain stream token
2. call feed endpoint
3. write events to database
4. advance cursor
5. repeat until hasMore=false

## Cursor persistence

Cursor state will continue to be stored in PostgreSQL to allow:

- crash recovery
- resumable ingestion

## Token lifecycle

Since stream tokens expire after 5 minutes:

- the worker will refresh tokens automatically
- token renewal occurs before expiration

---

# 7. Conclusion

The public `/events` endpoint is sufficient but too slow for full ingestion within the assignment time constraints.

The discovered **feed API provides a significantly more efficient ingestion path**, enabling completion within minutes while still maintaining cursor safety and resumability.

The final ingestion pipeline therefore supports:

- high-throughput ingestion via feed
- robust fallback via `/events`
