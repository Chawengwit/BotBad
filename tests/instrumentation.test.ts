import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../instrumentation";
import { SECRET, TOKEN } from "./helpers";

describe("register (startup env check)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports success when the env is complete", async () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", SECRET);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN);

    await expect(register()).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join(" ")).toContain("OK");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never rejects when the env is broken, it only logs", async () => {
    // ถ้า hook นี้ throw server จะตายทั้งตัว ซึ่งแย่กว่าการปล่อยให้ webhook ตอบ 503
    vi.stubEnv("LINE_CHANNEL_SECRET", undefined);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", undefined);

    await expect(register()).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("LINE_CHANNEL_SECRET");
    expect(logged).toContain("LINE_CHANNEL_ACCESS_TOKEN");
  });

  it("does not put env values into the log", async () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", "bad secret with spaces");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN);

    await register();

    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("bad secret with spaces");
  });
});
