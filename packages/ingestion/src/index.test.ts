import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Important: mock dependencies BEFORE importing the module under test
vi.mock("./env", () => ({ requireEnv: vi.fn() }));
vi.mock("./api", () => ({ retrievePage: vi.fn() }));
vi.mock("./db", () => ({
  connectDb: vi.fn(),
  migrate: vi.fn(),
  loadCursor: vi.fn(),
  saveCursor: vi.fn(),
  savePage: vi.fn(),
  printCount: vi.fn(),
}));
vi.mock("./ingestion", () => ({ runIngestion: vi.fn() }));

import { main } from "./index";
import { requireEnv } from "./env";
import { retrievePage } from "./api";
import { connectDb, migrate, loadCursor, saveCursor, savePage, printCount } from "./db";
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

    expect(depsArg).toEqual({
      retrievePage,
      savePage,
      loadCursor,
      saveCursor,
      printCount,
    });

    expect(optsArg).toEqual({
      baseUrl: "http://example/api/v1",
      limit: 1000,
      db: fakeDb,
    });
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
