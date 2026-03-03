import { describe, it, expect, vi } from "vitest";
import { savePage } from "./db";

describe("db", () => {
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

    expect(sql).toContain("INSERT INTO ingested_events (id, ts, type, raw)");
    expect(sql).toContain("VALUES ($1, $2, $3, $4),($5, $6, $7, $8)");
    expect(values).toHaveLength(8);

    expect(values[0]).toBe("1");
    expect(values[1]).toBe("2026-01-01T00:00:00Z");
    expect(values[2]).toBe("a");
    expect(values[3]).toEqual(page.data[0]);
  });
});
