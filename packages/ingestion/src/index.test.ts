import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Important: mock dependencies BEFORE importing the module under test
vi.mock("./env", () => ({ requireEnv: vi.fn() }));
vi.mock("./api", () => ({
  fetchEventsPage: vi.fn(),
}));
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    connectDb: vi.fn(async () => ({}) as any),
    migrate: vi.fn(async () => {}),
    printCount: vi.fn(async () => {}),
    savePage: vi.fn(async () => 0),
    savePageAndCursorTx: vi.fn(async () => ({ inserted: 0 })),
    loadCursor: vi.fn(async () => undefined),
    saveCursor: vi.fn(async () => {}),
  };
});
vi.mock("./ingestion", () => ({ runIngestion: vi.fn() }));

import { main } from "./index";
import { requireEnv } from "./env";
import { fetchEventsPage } from "./api";
import { connectDb, migrate, loadCursor, saveCursor, savePage, printCount, savePageAndCursorTx } from "./db";
import { runIngestion } from "./ingestion";

describe("index.ts (wiring)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("wires env + db + deps into runIngestion", async () => {
    const fakeDb = { any: "db" } as any;

    (requireEnv as any).mockImplementation((name: string) => {
      if (name === "API_BASE_URL") return "http://example/api/v1";
      if (name === "TARGET_API_KEY") return "test-key";
      throw new Error(`unexpected env: ${name}`);
    });

    (connectDb as any).mockResolvedValue(fakeDb);
    (migrate as any).mockResolvedValue(undefined);
    (runIngestion as any).mockResolvedValue(undefined);

    await main();

    expect(requireEnv).toHaveBeenCalledWith("API_BASE_URL");
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(fakeDb);

    // Ensure runIngestion called with the exact functions (wiring correctness)
    expect(runIngestion).toHaveBeenCalledTimes(1);

    const [depsArg, optsArg] = (runIngestion as any).mock.calls[0];

    expect(depsArg).toMatchObject({
      savePage,
      loadCursor,
      saveCursor,
      savePageAndCursor: savePageAndCursorTx,
      printCount,
    });
    expect(typeof depsArg.retrievePage).toBe("function");

    expect(optsArg).toEqual({
      limit: 1000,
      db: fakeDb,
    });
  });

  it("wires retrievePage wrapper with baseUrl + apiKey", async () => {
    const fakeDb = {} as any;

    (requireEnv as any).mockImplementation((name: string) => {
      if (name === "API_BASE_URL") return "http://x/api/v1";
      if (name === "TARGET_API_KEY") return "test-key";
      throw new Error(`unexpected env: ${name}`);
    });

    (connectDb as any).mockResolvedValue(fakeDb);
    (migrate as any).mockResolvedValue(undefined);
    (runIngestion as any).mockResolvedValue(undefined);
    (fetchEventsPage as any).mockResolvedValue({
      data: [],
      hasMore: false,
    });

    await main();

    const [depsArg] = (runIngestion as any).mock.calls[0];

    expect(typeof depsArg.retrievePage).toBe("function");

    await depsArg.retrievePage(5, "c1");

    expect(fetchEventsPage).toHaveBeenCalledWith(
      "http://x/api/v1",
      "test-key",
      5,
      "c1"
    );
  });

  it("fails fast when TARGET_API_KEY is missing", async () => {
    (requireEnv as any).mockImplementation((name: string) => {
      if (name === "API_BASE_URL") return "http://x/api/v1";
      if (name === "TARGET_API_KEY") throw new Error("TARGET_API_KEY is required");
      throw new Error(`unexpected env: ${name}`);
    });

    await expect(main()).rejects.toThrow("TARGET_API_KEY is required");

    expect(connectDb).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(runIngestion).not.toHaveBeenCalled();
  });

  it("propagates errors (doesn't swallow) if migrate fails", async () => {
    const fakeDb = {} as any;

    (requireEnv as any).mockReturnValue("http://example/api/v1");
    (connectDb as any).mockResolvedValue(fakeDb);
    (migrate as any).mockRejectedValue(new Error("migrate failed"));

    await expect(main()).rejects.toThrow("migrate failed");
    expect(runIngestion).not.toHaveBeenCalled();
  });
});
