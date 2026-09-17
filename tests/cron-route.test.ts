import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn(async () => [{ ok: 1 }]);
const collectDigestData = vi.fn(async () => [] as unknown[]);
const claimDigest = vi.fn(async () => true);
const pushMessages = vi.fn(async (_to: string, _messages: unknown[], _token: string) => {});
const getMessageQuota = vi.fn(async () => ({ limit: 300, used: 0 }));

vi.mock("@/lib/db", () => ({ getSql: () => sqlMock }));
vi.mock("@/lib/env", () => ({ getLineAccessToken: () => "test-access-token" }));
vi.mock("@/lib/line", () => ({ pushMessages, getMessageQuota }));
vi.mock("@/repositories/digest.repository", () => ({ collectDigestData, claimDigest }));

const { GET } = await import("@/../app/api/cron/daily/route");

const FRIDAY = new Date("2026-09-18T03:30:00Z"); // 10:30 ไทย วันศุกร์
const THURSDAY = new Date("2026-09-17T03:30:00Z");

const groupWithGame = {
  lineGroupId: "C123",
  game: {
    id: "1",
    line_group_id: "C123",
    created_by: "1",
    play_date: "2026-09-22",
    start_time: "19:00",
    duration_minutes: 120,
    court_count: 2,
    max_players: 16,
    status: "open" as const,
    court_name: "ABC Badminton",
    location_url: null,
    promptpay: null,
    edit_count: 0,
  },
  joinedCount: 6,
  unpaidBillCount: 0,
  unpaidTotalSatang: 0,
};

const quietGroup = {
  lineGroupId: "C999",
  game: null,
  joinedCount: 0,
  unpaidBillCount: 0,
  unpaidTotalSatang: 0,
};

const call = (headers: HeadersInit = {}) =>
  GET(new Request("http://localhost/api/cron/daily", { headers }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FRIDAY);
  sqlMock.mockClear();
  collectDigestData.mockClear().mockResolvedValue([]);
  claimDigest.mockClear().mockResolvedValue(true);
  pushMessages.mockClear();
  getMessageQuota.mockClear().mockResolvedValue({ limit: 300, used: 0 });
  delete process.env.CRON_SECRET;
  delete process.env.PUSH_QUOTA_STOP_AT;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("งานที่ทำทุกวัน", () => {
  it("แตะฐานข้อมูลทุกวัน แม้วันที่ไม่ push (กัน Supabase หลับ)", async () => {
    vi.setSystemTime(THURSDAY);
    const response = await call();

    expect(response.status).toBe(200);
    expect(sqlMock).toHaveBeenCalled();
    expect(pushMessages).not.toHaveBeenCalled();
  });

  it("ต่อฐานข้อมูลไม่ได้ตอบ 503 และไม่ push", async () => {
    sqlMock.mockRejectedValueOnce(new Error("connection refused"));
    const response = await call();

    expect(response.status).toBe(503);
    expect(pushMessages).not.toHaveBeenCalled();
  });
});

describe("push เฉพาะวันศุกร์", () => {
  it.each([
    ["จันทร์", "2026-09-14T03:30:00Z"],
    ["พฤหัส", "2026-09-17T03:30:00Z"],
    ["เสาร์", "2026-09-19T03:30:00Z"],
  ])("วัน%s ไม่ push แม้มีเรื่องค้าง", async (_label, iso) => {
    vi.setSystemTime(new Date(iso));
    collectDigestData.mockResolvedValue([groupWithGame]);

    await call();
    expect(pushMessages).not.toHaveBeenCalled();
    // ไม่ใช่ศุกร์ก็ไม่ต้องเสียแรงอ่านข้อมูลด้วย
    expect(collectDigestData).not.toHaveBeenCalled();
  });

  it("วันศุกร์ push กลุ่มที่มีเรื่อง", async () => {
    collectDigestData.mockResolvedValue([groupWithGame]);

    const body = (await (await call()).json()) as { digest: { sent: number } };
    expect(pushMessages).toHaveBeenCalledTimes(1);
    expect(pushMessages.mock.calls[0]?.[0]).toBe("C123");
    expect(body.digest.sent).toBe(1);
  });

  it("กลุ่มที่ไม่มีเรื่องเลย ต้องเงียบ", async () => {
    collectDigestData.mockResolvedValue([quietGroup]);

    await call();
    expect(pushMessages).not.toHaveBeenCalled();
    expect(claimDigest).not.toHaveBeenCalled();
  });
});

describe("กันส่งซ้ำและกันโควตาบาน", () => {
  it("จองไม่ได้แปลว่าส่งไปแล้ววันนี้ ต้องไม่ส่งซ้ำ", async () => {
    collectDigestData.mockResolvedValue([groupWithGame]);
    claimDigest.mockResolvedValue(false);

    await call();
    expect(pushMessages).not.toHaveBeenCalled();
  });

  it("ใช้โควตาเกินเพดานแล้วหยุดทั้งชุด", async () => {
    collectDigestData.mockResolvedValue([groupWithGame]);
    getMessageQuota.mockResolvedValue({ limit: 300, used: 280 });

    await call();
    expect(pushMessages).not.toHaveBeenCalled();
  });

  it("อ่านโควตาไม่ได้ ยังส่งต่อ ไม่ใช่เงียบทั้งระบบ", async () => {
    collectDigestData.mockResolvedValue([groupWithGame]);
    getMessageQuota.mockRejectedValue(new Error("LINE down"));

    await call();
    expect(pushMessages).toHaveBeenCalledTimes(1);
  });

  it("กลุ่มหนึ่ง push พังต้องไม่ทำให้กลุ่มที่เหลือไม่ได้รับ", async () => {
    collectDigestData.mockResolvedValue([
      groupWithGame,
      { ...groupWithGame, lineGroupId: "C456" },
    ]);
    pushMessages.mockRejectedValueOnce(new Error("push failed"));

    const body = (await (await call()).json()) as { digest: { sent: number; failed: number } };
    expect(pushMessages).toHaveBeenCalledTimes(2);
    expect(body.digest).toMatchObject({ sent: 1, failed: 1 });
  });
});

describe("CRON_SECRET", () => {
  it("ตั้งไว้แล้วไม่ส่ง Authorization มา ต้องโดนปฏิเสธ", async () => {
    process.env.CRON_SECRET = "s3cret";
    const response = await call();

    expect(response.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("ส่ง Authorization ถูกต้องผ่านได้", async () => {
    process.env.CRON_SECRET = "s3cret";
    const response = await call({ authorization: "Bearer s3cret" });

    expect(response.status).toBe(200);
  });
});
