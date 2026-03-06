const express = require("express");

const app = express();
const port = process.env.PORT || 8787;

// ---------- Config ----------
const TOTAL_EVENTS = parsePositiveInt("MOCK_TOTAL_EVENTS", 3000);
const MAX_LIMIT = parsePositiveInt("MOCK_MAX_LIMIT", 1000);
const RESPONSE_DELAY_MS = Number(process.env.MOCK_RESPONSE_DELAY_MS || 0);

const REQUIRE_API_KEY = parseBool("MOCK_REQUIRE_API_KEY", true);
const EXPECTED_API_KEY = process.env.MOCK_API_KEY || "mock-key";

// Return 429 every N requests (0 = disabled)
const RATE_LIMIT_EVERY_N = parseNonNegativeInt("MOCK_RATE_LIMIT_EVERY_N", 0);
const RETRY_AFTER_SECONDS = parsePositiveInt("MOCK_RETRY_AFTER_SECONDS", 2);

// Static/demo rate-limit headers
const RATE_LIMIT_REMAINING = parsePositiveInt("MOCK_RATELIMIT_REMAINING", 99);

// Cursor lifecycle
const CURSOR_TTL_SECONDS = parseNonNegativeInt("MOCK_CURSOR_TTL_SECONDS", 0); // 0 = never expire

// Protocol error injection
// If cursor equals this value, return hasMore=true but omit nextCursor
const BREAK_PROTOCOL_AT_CURSOR = process.env.MOCK_BREAK_PROTOCOL_AT_CURSOR || "";

// ---------- State ----------
let requestCount = 0;
const cursorIssuedAtMs = new Map(); // cursor -> timestamp issued

// ---------- Helpers ----------
function parsePositiveInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parseNonNegativeInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

function parseBool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function makeEvent(id) {
  return {
    id: String(id),
    ts: new Date(1700000000000 + id * 1000).toISOString(),
    type: "mock",
  };
}

function parseCursor(cursor) {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return null;
  }
  return n;
}

function checkApiKey(req, res) {
  if (!REQUIRE_API_KEY) return true;

  const key = req.header("X-API-Key");
  if (!key) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Missing X-API-Key",
    });
    return false;
  }

  if (key !== EXPECTED_API_KEY) {
    res.status(403).json({
      error: "Forbidden",
      message: "Invalid API key",
    });
    return false;
  }

  return true;
}

function maybeRateLimit(req, res) {
  requestCount += 1;

  if (RATE_LIMIT_EVERY_N > 0 && requestCount % RATE_LIMIT_EVERY_N === 0) {
    const resetEpochSec = Math.floor(Date.now() / 1000) + RETRY_AFTER_SECONDS;

    res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(resetEpochSec));

    res.status(429).json({
      error: "RateLimitExceeded",
      message: `Mock rate limit triggered on request ${requestCount}`,
    });
    return true;
  }

  const resetEpochSec = Math.floor(Date.now() / 1000) + 60;
  res.setHeader("X-RateLimit-Remaining", String(RATE_LIMIT_REMAINING));
  res.setHeader("X-RateLimit-Reset", String(resetEpochSec));
  return false;
}

function maybeExpireCursor(cursor, res) {
  if (!cursor || CURSOR_TTL_SECONDS <= 0) return false;

  const issuedAt = cursorIssuedAtMs.get(cursor);
  if (!issuedAt) {
    res.status(410).json({
      error: "CursorExpired",
      message: `Cursor ${cursor} is unknown or expired`,
    });
    return true;
  }

  const ageMs = Date.now() - issuedAt;
  if (ageMs > CURSOR_TTL_SECONDS * 1000) {
    cursorIssuedAtMs.delete(cursor);
    res.status(410).json({
      error: "CursorExpired",
      message: `Cursor ${cursor} expired after ${CURSOR_TTL_SECONDS}s`,
    });
    return true;
  }

  return false;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    totalEvents: TOTAL_EVENTS,
    maxLimit: MAX_LIMIT,
    requireApiKey: REQUIRE_API_KEY,
    rateLimitEveryN: RATE_LIMIT_EVERY_N,
    cursorTtlSeconds: CURSOR_TTL_SECONDS,
  });
});

app.get("/api/v1/events", async (req, res) => {
  if (!checkApiKey(req, res)) return;
  if (maybeRateLimit(req, res)) return;

  const limitRaw = req.query.limit ? String(req.query.limit) : "100";
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    return res.status(400).json({
      error: "BadRequest",
      message: `Invalid limit: ${limitRaw}`,
    });
  }
  if (limit > MAX_LIMIT) {
    return res.status(400).json({
      error: "BadRequest",
      message: `limit must be <= ${MAX_LIMIT}`,
    });
  }

  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
  const start = parseCursor(cursor);
  if (start === null) {
    return res.status(400).json({
      error: "BadRequest",
      message: `Invalid cursor: ${cursor}`,
    });
  }

  if (maybeExpireCursor(cursor, res)) return;

  const from = start + 1;
  const to = Math.min(start + limit, TOTAL_EVENTS);

  const data = [];
  for (let id = from; id <= to; id += 1) {
    data.push(makeEvent(id));
  }

  const hasMore = to < TOTAL_EVENTS;
  const nextCursor = hasMore ? String(to) : undefined;

  // Save issued cursor timestamp so we can expire it later
  if (nextCursor) {
    cursorIssuedAtMs.set(nextCursor, Date.now());
  }

  // Optional protocol error injection
  if (BREAK_PROTOCOL_AT_CURSOR && cursor === BREAK_PROTOCOL_AT_CURSOR) {
    return res.json({
      data,
      hasMore: true,
      // nextCursor intentionally omitted
    });
  }

  if (RESPONSE_DELAY_MS > 0) {
    await new Promise((r) => setTimeout(r, RESPONSE_DELAY_MS));
  }

  return res.json({
    data,
    hasMore,
    nextCursor,
  });
});

app.listen(port, () => {
  console.log(`Mock API listening on port ${port}`);
  console.log(
    JSON.stringify(
      {
        totalEvents: TOTAL_EVENTS,
        maxLimit: MAX_LIMIT,
        requireApiKey: REQUIRE_API_KEY,
        expectedApiKey: EXPECTED_API_KEY,
        rateLimitEveryN: RATE_LIMIT_EVERY_N,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
        rateLimitRemaining: RATE_LIMIT_REMAINING,
        cursorTtlSeconds: CURSOR_TTL_SECONDS,
        breakProtocolAtCursor: BREAK_PROTOCOL_AT_CURSOR || null,
      },
      null,
      2
    )
  );
});
