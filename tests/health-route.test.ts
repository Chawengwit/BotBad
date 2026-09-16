import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/health/route";

const URL = "http://localhost/api/health";

describe("GET /api/health", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ตอบ 503 เมื่อต่อฐานข้อมูลไม่ได้ ไม่ throw ออกไป", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    const res = await GET(new Request(URL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ไม่บอกรายละเอียดฐานข้อมูลออกไปข้างนอก", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:hunter2@example.com:6543/postgres");

    const body = await (await GET(new Request(URL))).text();

    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("example.com");
  });

  describe("เมื่อตั้ง CRON_SECRET", () => {
    beforeEach(() => {
      vi.stubEnv("CRON_SECRET", "cron-secret-value");
      vi.stubEnv("DATABASE_URL", undefined);
    });

    it("ปฏิเสธคำขอที่ไม่มี Authorization", async () => {
      const res = await GET(new Request(URL));
      expect(res.status).toBe(401);
    });

    it("ปฏิเสธ Authorization ที่ผิด", async () => {
      const res = await GET(new Request(URL, { headers: { authorization: "Bearer wrong" } }));
      expect(res.status).toBe(401);
    });

    it("ผ่านเมื่อ Authorization ถูก (แล้วค่อยไปเช็กฐานข้อมูล)", async () => {
      const res = await GET(
        new Request(URL, { headers: { authorization: "Bearer cron-secret-value" } }),
      );
      expect(res.status).toBe(503);
    });
  });
});
