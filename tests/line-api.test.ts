import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGroupMemberDisplayName,
  MAX_REPLY_MESSAGES,
  replyMessages,
  type LineMessage,
} from "@/lib/line";

const TOKEN = "test-access-token";

describe("replyMessages", () => {
  const fetchMock = vi.fn();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const messagesOf = (count: number): LineMessage[] =>
    Array.from({ length: count }, (_, index) => ({ type: "text" as const, text: `ข้อความ ${index}` }));

  it("ส่งได้ตามปกติเมื่อไม่เกินขีดจำกัด", async () => {
    await replyMessages("rt", messagesOf(3), TOKEN);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toHaveLength(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ตัดให้เหลือ 5 แทนที่จะปล่อยให้ LINE ปฏิเสธทั้งชุด", async () => {
    await replyMessages("rt", messagesOf(8), TOKEN);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toHaveLength(MAX_REPLY_MESSAGES);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("getGroupMemberDisplayName", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("คืนชื่อที่ LINE ให้มา", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "เชวง" }), { status: 200 })),
    );

    expect(await getGroupMemberDisplayName("C1", "U1", TOKEN)).toBe("เชวง");
  });

  it("token ใช้ไม่ได้ ต้องคืน null และ log ไว้ ไม่ใช่เงียบหาย", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    expect(await getGroupMemberDisplayName("C1", "U1", TOKEN)).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ไม่เอา access token ไปไว้ใน log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`Bearer ${TOKEN} rejected`);
      }),
    );

    await getGroupMemberDisplayName("C1", "U1", TOKEN);

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("[redacted]");
  });
});
