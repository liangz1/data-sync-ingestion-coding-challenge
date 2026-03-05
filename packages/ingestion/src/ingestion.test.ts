import { describe, it, expect, vi } from "vitest";
import { runIngestion } from "./ingestion";
import type { EventsResponse, IngestionDeps } from "./types";

describe("ingestion", () => {
  function makeDeps(overrides?: Partial<IngestionDeps>): IngestionDeps {
    return {
      retrievePage: vi.fn(),
      savePage: vi.fn(async (_db, page) => page.data.length),
      loadCursor: vi.fn(async () => undefined),
      saveCursor: vi.fn(async () => {}),
      savePageAndCursor: vi.fn(async (_db, page, _nextCursor) => ({
        inserted: page.data.length,
      })),
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
        nextCursor: "c2", // should NOT be saved (by your updated logic)
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

    expect(deps.savePageAndCursor).toHaveBeenCalledTimes(1);
    expect(deps.savePage).toHaveBeenCalledTimes(1);
    expect(deps.savePageAndCursor).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.anything(), // page
      "c1"               // nextCursor
    );

    expect(deps.printCount).toHaveBeenCalledTimes(1);
  });

  it("throws when hasMore=true but nextCursor is missing (fail-fast)", async () => {
    const db = {} as any;

    const deps = makeDeps({
      retrievePage: vi.fn(async () => ({
        data: [{ id: "1", ts: "t", type: "x" }],
        hasMore: true,
        // nextCursor missing
      })),
    });

    await expect(
      runIngestion(deps, { baseUrl: "http://x", limit: 1000, db, maxPages: 10 })
    ).rejects.toThrow(/nextCursor is missing|Protocol violation/i);

    expect(deps.retrievePage).toHaveBeenCalledTimes(1);
  });

  it("maxPages guard: throws if pages exceed maxPages", async () => {
    const db = {} as any;

    const deps = makeDeps({
      retrievePage: vi.fn(async () => ({
        data: [{ id: "1", ts: "t", type: "x" }],
        hasMore: true,
        nextCursor: "same",
      })),
    });

    await expect(
      runIngestion(deps, { baseUrl: "http://x", limit: 1000, db, maxPages: 3 })
    ).rejects.toThrow(/exceeded maxPages=3/i);

    expect(deps.retrievePage).toHaveBeenCalledTimes(3);
  });

  function makePage(n: number, opts?: Partial<EventsResponse>): EventsResponse {
    return {
      data: Array.from({ length: n }, (_, i) => ({
        id: String(i + 1),
        ts: "2026-01-01T00:00:00Z",
        type: "x",
      })),
      hasMore: opts?.hasMore ?? false,
      nextCursor: opts?.nextCursor,
    };
  }

  it("metrics: accumulates attempted/inserted and logs periodic summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 10 pages to trigger one periodic metrics log (logEveryPages=10)
    const pages: EventsResponse[] = Array.from({ length: 10 }, (_, idx) =>
      makePage(3, {
        hasMore: idx < 9,
        nextCursor: idx < 9 ? String((idx + 1) * 3) : undefined,
      })
    );

    const deps = {
      retrievePage: vi.fn(async () => pages.shift()!),
      // simulate partial inserts (e.g., duplicates): inserted = 2 even though attempted = 3
      savePage: vi.fn(async (_db: any, page: EventsResponse) => {
        return page.data.length - 1;
      }),
      loadCursor: vi.fn(async () => undefined),
      saveCursor: vi.fn(async () => {}),
      savePageAndCursor: vi.fn(async (_db, page, _nextCursor) => ({
        inserted: page.data.length - 1,
      })),
      printCount: vi.fn(async () => {}),
    };

    const fakeDb: any = {};

    await runIngestion(deps as any, {
      baseUrl: "http://x/api/v1",
      limit: 1000,
      db: fakeDb,
      maxPages: 100,
    });

    // Verify we indeed processed 10 pages
    expect(deps.retrievePage).toHaveBeenCalledTimes(10);
    expect(deps.savePage).toHaveBeenCalledTimes(1);
    expect(deps.savePageAndCursor).toHaveBeenCalledTimes(9);

    // Find the metrics summary log line
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const summary = calls.find((s) => s.includes("[ingestion][metrics]"));
    expect(summary).toBeTruthy();

    // Attempted: 10 pages * 3 = 30
    expect(summary!).toContain("attempted=30");

    // Inserted: 10 pages * 2 = 20
    expect(summary!).toContain("inserted=20");

    // Should include fetchMs/dbMs and insertedPerSec fields (format stable enough)
    expect(summary!).toContain("fetchMs=");
    expect(summary!).toContain("dbMs=");
    expect(summary!).toContain("insertedPerSec=");

    // No warnings expected in this test
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("metrics: does not produce NaN when savePage returns a number", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const deps = {
      retrievePage: vi.fn(async () =>
        makePage(1, { hasMore: false })
      ),
      savePage: vi.fn(async () => 1),
      loadCursor: vi.fn(async () => undefined),
      saveCursor: vi.fn(async () => {}),
      printCount: vi.fn(async () => {}),
    };

    const fakeDb: any = {};

    await runIngestion(deps as any, {
      baseUrl: "http://x/api/v1",
      limit: 1000,
      db: fakeDb,
      maxPages: 10,
    });

    // Ensure no NaN appears in logs (best-effort sanity check)
    const calls = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(calls).not.toMatch(/NaN/);

    logSpy.mockRestore();
  });

  it("uses transactional write (page+cursor) when hasMore=true", async () => {
    const pages: EventsResponse[] = [
      { data: [{ id: "1", ts: "t", type: "x" }], hasMore: true, nextCursor: "1" },
      { data: [{ id: "2", ts: "t", type: "x" }], hasMore: false },
    ];

    const deps = {
      retrievePage: vi.fn(async () => pages.shift()!),
      savePage: vi.fn(async (_db, page) => page.data.length),
      saveCursor: vi.fn(async () => {}),
      savePageAndCursor: vi.fn(async (_db, page) => ({ inserted: page.data.length })),
      loadCursor: vi.fn(async () => undefined),
      printCount: vi.fn(async () => {}),
    };

    await runIngestion(deps as any, { baseUrl: "http://x", limit: 1000, db: {} as any, maxPages: 10 });

    expect(deps.savePageAndCursor).toHaveBeenCalledTimes(1);
    expect(deps.savePage).toHaveBeenCalledTimes(1); // only last page
  });
});
