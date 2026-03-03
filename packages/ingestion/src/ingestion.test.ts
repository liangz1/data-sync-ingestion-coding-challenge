import { describe, it, expect, vi } from "vitest";
import { runIngestion } from "./ingestion";
import type { EventsResponse, IngestionDeps } from "./types";

describe("ingestion", () => {
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

    expect(deps.savePage).toHaveBeenCalledTimes(2);

    // After your code change: saveCursor only on hasMore=true
    expect(deps.saveCursor).toHaveBeenCalledTimes(1);
    expect(deps.saveCursor).toHaveBeenCalledWith(db, "c1");

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
});
