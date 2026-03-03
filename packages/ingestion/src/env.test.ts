import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireEnv } from "./env";

describe("env", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("requireEnv throws a clear error when missing", () => {
    delete process.env.MISSING_ENV;
    expect(() => requireEnv("MISSING_ENV")).toThrowError("MISSING_ENV is required");
  });
});
