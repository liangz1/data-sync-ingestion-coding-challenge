import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildEventsUrl, fetchEventsPage } from "./api";

type AnyResponse = any;

function makeHeaders(init: Record<string, string>) {
  return new Headers(init);
}

function makeRes(opts: {
  ok: boolean;
  status: number;
  headers?: Headers;
  json?: any;
  text?: string;
}) {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: opts.headers ?? new Headers(),
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as any;
}

describe("api", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    // @ts-ignore
    delete globalThis.fetch;
    vi.useRealTimers();
  });

  it("buildEventsUrl strips trailing slashes and sets params correctly", () => {
    const url = buildEventsUrl("http://mock-api:8787/api/v1////", 1000, "abc");
    expect(url).toBe("http://mock-api:8787/api/v1/events?limit=1000&cursor=abc");
  });

  it("fetchEventsPage sends X-API-Key header when TARGET_API_KEY is provided", async () => {
    // @ts-ignore
    globalThis.fetch = vi.fn(async (_url: string, init?: any) => {
      expect(init?.headers?.["X-API-Key"]).toBe("test-key");
      return makeRes({
        ok: true,
        status: 200,
        json: { data: [], hasMore: false },
      });
    });

    await fetchEventsPage("http://x/api/v1", "test-key", 5);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fetchEventsPage returns parsed JSON on success", async () => {
    const payload = {
      data: [{ id: "1", ts: "2026-01-01T00:00:00Z", type: "x" }],
      hasMore: false,
      nextCursor: "1",
    };

    // @ts-ignore
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(url).toContain("/events?limit=5");
      return makeRes({
        ok: true,
        status: 200,
        json: payload,
      });
    });

    const page = await fetchEventsPage("http://mock-api:8787/api/v1", "test-key", 5);
    expect(page.hasMore).toBe(false);
    expect(page.data[0].id).toBe("1");
  });

  it("fetchEventsPage throws on non-2xx and includes status/body", async () => {
    // Non-retryable error (e.g. 401) should fail fast and include body
    // @ts-ignore
    globalThis.fetch = vi.fn(async () => {
      return makeRes({
        ok: false,
        status: 401,
        text: "unauthorized",
      });
    });

    await expect(fetchEventsPage("http://mock-api:8787/api/v1", "test-key", 10)).rejects.toThrow(
      "API error: 401 unauthorized"
    );
  });

  it("retries on 429 and respects Retry-After (seconds)", async () => {
    vi.useFakeTimers();

    process.env.TARGET_API_KEY = "k";

    const payload = { data: [], hasMore: false };

    // @ts-ignore
    globalThis.fetch = vi
      .fn()
      // first call: 429 with Retry-After: 1
      .mockResolvedValueOnce(
        makeRes({
          ok: false,
          status: 429,
          headers: makeHeaders({ "retry-after": "1" }),
          text: "rate limited",
        })
      )
      // second call: success
      .mockResolvedValueOnce(
        makeRes({
          ok: true,
          status: 200,
          json: payload,
        })
      );

    const p = fetchEventsPage("http://x/api/v1", "test-key", 5);

    // Let the internal sleep() elapse
    await vi.runAllTimersAsync();
    const page = await p;

    expect(page).toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and respects X-RateLimit-Reset (epoch seconds)", async () => {
    vi.useFakeTimers();

    // Freeze time so we can reason about reset delta
    vi.spyOn(Date, "now").mockReturnValue(1_000); // ms

    process.env.TARGET_API_KEY = "k";

    const payload = { data: [], hasMore: false };

    // X-RateLimit-Reset = 3 (epoch seconds) => 3000ms
    // now=1000ms => should wait ~2000ms (or more, but not less)
    // @ts-ignore
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeRes({
          ok: false,
          status: 429,
          headers: makeHeaders({ "x-ratelimit-reset": "3" }),
          text: "rate limited",
        })
      )
      .mockResolvedValueOnce(
        makeRes({
          ok: true,
          status: 200,
          json: payload,
        })
      );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const p = fetchEventsPage("http://x/api/v1", "test-key", 5);

    // Execute timers (sleep)
    await vi.runAllTimersAsync();
    const page = await p;

    expect(page).toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // Assert we scheduled a timeout with at least the reset delta (~2000ms)
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]).filter((v) => typeof v === "number") as number[];
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(2000);
  });
});
