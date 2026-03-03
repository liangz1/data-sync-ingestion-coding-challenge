import { describe, it, expect, vi, afterEach } from "vitest";
import { buildEventsUrl, retrievePage } from "./api";

type AnyResponse = any;

describe("api", () => {
  afterEach(() => {
    // @ts-ignore
    delete globalThis.fetch;
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
});
