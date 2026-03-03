import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requireEnv,
  buildEventsUrl,
  retrievePage,
  savePage,
  runIngestion,
  type EventsResponse,
  type IngestionDeps,
} from "./index";

type AnyResponse = any;

describe("index.ts", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    // @ts-ignore
    delete globalThis.fetch;
  });

  it("requireEnv throws a clear error when missing", () => {
    delete process.env.MISSING_ENV;
    expect(() => requireEnv("MISSING_ENV")).toThrowError("MISSING_ENV is required");
  });

  it("buildEventsUrl strips trailing slashes and sets params correctly", () => {
    const url = buildEventsUrl("http://mock-api:8787/api/v1////", 1000, "abc");
    expect(url).toBe("http://mock-api:8787/api/v1/events?limit=1000&cursor=abc");
  });

  it("retrievePage throws on non-2xx and includes status/body", async () => {
    // @ts-ignore
    globalThis.fetch = vi.fn(async () => {
      const res: AnyResponse = {
        ok: false,
        status: 429,
        text: async () => "rate limited",
      };
      return res;
    });

    await expect(retrievePage("http://mock-api:8787/api/v1", 10)).rejects.toThrow(
      "API error: 429 rate limited"
    );
  });

  it("retrievePage returns parsed JSON on success", async () => {
    const payload = {
      data: [{ id: "1", ts: "2026-01-01T00:00:00Z", type: "x" }],
      hasMore: false,
      nextCursor: "1",
    };

    // @ts-ignore
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(url).toContain("/events?limit=5");
      const res: AnyResponse = {
        ok: true,
        status: 200,
        json: async () => payload,
      };
      return res;
    });

    const page = await retrievePage("http://mock-api:8787/api/v1", 5);
    expect(page.hasMore).toBe(false);
    expect(page.data[0].id).toBe("1");
  });

  it("savePage does nothing for empty page.data", async () => {
    const fakeClient = {
      query: vi.fn(async () => ({ rows: [] })),
    } as any;

    await savePage(fakeClient, { data: [], hasMore: false });

    expect(fakeClient.query).not.toHaveBeenCalled();
  });

  it("savePage builds correct parameterized INSERT and values", async () => {
    const fakeClient = {
      query: vi.fn(async () => ({ rows: [] })),
    } as any;

    const page = {
      data: [
        { id: "1", ts: "2026-01-01T00:00:00Z", type: "a" },
        { id: "2", ts: "2026-01-01T00:00:01Z", type: "b" },
      ],
      hasMore: true,
      nextCursor: "2",
    };

    await savePage(fakeClient, page);

    expect(fakeClient.query).toHaveBeenCalledTimes(1);
    const [sql, values] = fakeClient.query.mock.calls[0];

    // 2 rows * 4 cols => 8 params
    expect(sql).toContain("INSERT INTO ingested_events (id, ts, type, raw)");
    expect(sql).toContain("VALUES ($1, $2, $3, $4),($5, $6, $7, $8)");
    expect(values).toHaveLength(8);

    // values order: id, ts, type, raw(event object)
    expect(values[0]).toBe("1");
    expect(values[1]).toBe("2026-01-01T00:00:00Z");
    expect(values[2]).toBe("a");
    expect(values[3]).toEqual(page.data[0]);
  });

  describe("runIngestion (fully mocked deps, no DB, no network)", () => {
    function makeDeps(overrides?: Partial<IngestionDeps>): IngestionDeps {
      return {
        retrievePage: vi.fn(),
        savePage: vi.fn(async () => {}),
        loadCursor: vi.fn(async () => undefined),
        saveCursor: vi.fn(async () => {}),
        printCount: vi.fn(async () => {}),
        ...overrides,
      };
    }

    it("happy path: advances cursor, saves pages, stops when hasMore=false", async () => {
      const db = {} as any;

      const pages: EventsResponse[] = [
        {
          data: [{ id: "1", ts: "t1", type: "x" }],
          hasMore: true,
          nextCursor: "c1",
        },
        {
          data: [{ id: "2", ts: "t2", type: "y" }],
          hasMore: false,
          nextCursor: "c2", // even if present, hasMore=false should end
        },
      ];

      const deps = makeDeps({
        loadCursor: vi.fn(async () => undefined),
        retrievePage: vi.fn()
          .mockResolvedValueOnce(pages[0])
          .mockResolvedValueOnce(pages[1]),
      });

      await runIngestion(deps, { baseUrl: "http://x", limit: 1000, db });

      expect(deps.retrievePage).toHaveBeenCalledTimes(2);
      expect(deps.retrievePage).toHaveBeenNthCalledWith(1, "http://x", 1000, undefined);
      expect(deps.retrievePage).toHaveBeenNthCalledWith(2, "http://x", 1000, "c1");

      expect(deps.savePage).toHaveBeenCalledTimes(2);
      expect(deps.saveCursor).toHaveBeenCalledTimes(1);
      expect(deps.saveCursor).toHaveBeenNthCalledWith(1, db, "c1");

      expect(deps.printCount).toHaveBeenCalledTimes(1);
    });

    it("BUG prevention: throws when hasMore=true but nextCursor is missing (fail-fast)", async () => {
      const db = {} as any;

      const deps = makeDeps({
        retrievePage: vi.fn(async () => ({
          data: [{ id: "1", ts: "t", type: "x" }],
          hasMore: true,
          // nextCursor missing on purpose
        })),
      });

      await expect(
        runIngestion(deps, { baseUrl: "http://x", limit: 1000, db, maxPages: 10 })
      ).rejects.toThrow(/nextCursor is missing/i);

      // Should fail on first page; no second fetch
      expect(deps.retrievePage).toHaveBeenCalledTimes(1);
    });

    it("maxPages guard: throws if pages exceed maxPages (infinite loop safety net)", async () => {
      const db = {} as any;

      const deps = makeDeps({
        retrievePage: vi.fn(async () => ({
          data: [{ id: "1", ts: "t", type: "x" }],
          hasMore: true,
          nextCursor: "same", // still advances cursor but API could still loop forever in weird ways
        })),
      });

      await expect(
        runIngestion(deps, { baseUrl: "http://x", limit: 1000, db, maxPages: 3 })
      ).rejects.toThrow(/exceeded maxPages=3/i);

      expect(deps.retrievePage).toHaveBeenCalledTimes(3); // 4th page triggers guard
    });
  });
});
