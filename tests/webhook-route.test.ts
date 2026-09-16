import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/line/webhook/route";
import {
  group,
  makeBrokenBodyRequest,
  makeRequest,
  oneToOne,
  room,
  SECRET,
  textEvent,
  TOKEN,
} from "./helpers";

// ข้อความตาม spec §22 ข้อ 4 เขียนเป็น literal ไว้ที่นี่ ไม่อ้างค่าจากโค้ด
// จะได้จับได้ถ้ามีคนแก้ข้อความในโค้ดจนหลุดจาก spec
const GROUP_ONLY_TEXT = "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น";

type FetchCall = [string, RequestInit];

function replyBody(call: FetchCall) {
  return JSON.parse(call[1].body as string) as {
    replyToken: string;
    messages: { type: string; text: string }[];
  };
}

describe("POST /api/line/webhook", () => {
  const fetchMock = vi.fn();
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const replies = () => fetchMock.mock.calls.map((call) => replyBody(call as FetchCall));
  const logged = () => [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ");

  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_SECRET", SECRET);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN);
    // สร้าง Response ใหม่ทุกครั้ง ถ้าใช้ตัวเดิมซ้ำ call ที่สองจะเจอ "Body is unusable"
    fetchMock.mockReset().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("signature", () => {
    it("returns 200 for LINE Verify (empty events), quietly", async () => {
      const res = await POST(makeRequest({ destination: "U1", events: [] }));

      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("never calls LINE when the signature header is missing", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }, { signature: null }),
      );

      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()).toContain("x-line-signature");
    });

    it("never calls LINE when the signature is wrong, and says so in the log", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }, { signature: "AAAA" }),
      );

      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()).toContain("LINE_CHANNEL_SECRET");
    });

    it("never calls LINE when the signature is made with another secret", async () => {
      const raw = JSON.stringify({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] });
      const forged = createHmac("sha256", "other-secret").update(raw, "utf8").digest("base64");

      const res = await POST(makeRequest(raw, { signature: forged }));

      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts a signed body that is not canonical JSON.stringify output", async () => {
      // LINE เซ็นจาก raw body ที่ส่งมา การ re-serialize ก่อนตรวจจะทำให้ request จริงถูกปฏิเสธ
      const raw = `{ "destination":"U1",\n  "events": [${JSON.stringify(textEvent("บอทจ๋า", oneToOne))}] }`;

      const res = await POST(makeRequest(raw));

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("broken requests", () => {
    it("rejects an oversized body before doing any work", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [] }, { headers: { "content-length": "999999999" } }),
      );

      expect(res.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("answers 400 instead of throwing when the client disconnects mid-body", async () => {
      const res = await POST(makeBrokenBodyRequest());

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()).toContain("body");
    });

    it("answers 503 when the LINE env is missing, so LINE Verify fails loudly", async () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", undefined);

      const res = await POST(makeRequest({ destination: "U1", events: [] }));

      expect(res.status).toBe(503);
      expect(logged()).toContain("LINE_CHANNEL_ACCESS_TOKEN");
    });

    it("answers 503 when an env value has a space in it", async () => {
      vi.stubEnv("LINE_CHANNEL_SECRET", "bad secret with spaces");

      const res = await POST(makeRequest({ destination: "U1", events: [] }));
      expect(res.status).toBe(503);
    });
  });

  describe("always answers 200 once the signature is valid", () => {
    it("logs and returns 200 for invalid json", async () => {
      const res = await POST(makeRequest("{not json"));

      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("logs and returns 200 when the body has no events key at all", async () => {
      const res = await POST(makeRequest({ destination: "U1" }));

      expect(res.status).toBe(200);
      expect(logged()).toContain("events");
    });

    it("logs and returns 200 when destination is missing", async () => {
      const res = await POST(makeRequest({ events: [] }));

      expect(res.status).toBe(200);
      expect(logged()).toContain("destination");
    });

    it("skips one unsupported event but still handles the others", async () => {
      const res = await POST(
        makeRequest({
          destination: "U1",
          events: [
            { type: "message", replyToken: 12345, source: group, message: { type: "text", text: "บอทจ๋า" } },
            textEvent("บอทจ๋า", oneToOne, "reply-token-2"),
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replies()[0]?.replyToken).toBe("reply-token-2");
    });

    it("skips an absurdly long reply token instead of sending it to LINE", async () => {
      await POST(
        makeRequest({
          destination: "U1",
          events: [textEvent("บอทจ๋า", oneToOne, "x".repeat(5000))],
        }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()).toContain("replyToken");
    });

    it("returns 200 when the LINE reply API fails", async () => {
      fetchMock.mockImplementation(async () => new Response("bad request", { status: 400 }));

      const res = await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("keeps both secrets out of the logs when fetch throws with them", async () => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError("fetch failed", {
          cause: new Error(`Bearer ${TOKEN} signed with ${SECRET}`),
        });
      });

      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));

      expect(logged()).not.toContain(TOKEN);
      expect(logged()).not.toContain(SECRET);
      expect(logged()).toContain("[redacted]");
    });
  });

  describe("who gets an answer", () => {
    it("ignores group text without the wake word, without logging", async () => {
      const res = await POST(makeRequest({ destination: "U1", events: [textEvent("ใครตีบ้าง", group)] }));

      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("stays silent in a group until the router exists", async () => {
      // spec §18 Router ยังไม่ได้ทำ จึงยังไม่มีคำตอบสำหรับคำสั่งในกลุ่ม
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", group)] }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("tells 1:1 chat users the bot is group-only", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", oneToOne)] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replies()[0]?.messages).toEqual([{ type: "text", text: GROUP_ONLY_TEXT }]);
    });

    it("treats a multi-person room as not a group", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", room)] }));

      expect(replies()[0]?.messages[0]?.text).toBe(GROUP_ONLY_TEXT);
    });

    it("answers source types LINE may add later, instead of dropping them", async () => {
      const square = { type: "square", squareId: "S1", squareChatId: "SC1", userId: "U1" };

      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", square)] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replies()[0]?.messages[0]?.text).toBe(GROUP_ONLY_TEXT);
    });

    it("still answers a group event that arrives without groupId", async () => {
      await POST(
        makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", { type: "group", userId: "U1" })] }),
      );

      // ยังถือว่าเป็นกลุ่ม จึงเงียบเหมือนกลุ่มปกติ ไม่ใช่ถูกทิ้งทั้ง event
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("ignores an event with no source at all", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", undefined)] }));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores 1:1 chat text without the wake word", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("hello", oneToOne)] }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores non-text messages", async () => {
      await POST(
        makeRequest({
          destination: "U1",
          events: [{ type: "message", replyToken: "rt", source: group, message: { type: "sticker", id: "1" } }],
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("greets when joining a group, without promising commands yet", async () => {
      await POST(makeRequest({ destination: "U1", events: [{ type: "join", replyToken: "rt", source: group }] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const text = replies()[0]?.messages[0]?.text ?? "";
      expect(text).toContain("บอทจ๋า");
      expect(text).toContain("ยังสั่งงานไม่ได้");
    });

    it("does not greet on join-like events from other sources", async () => {
      await POST(
        makeRequest({
          destination: "U1",
          events: [
            { type: "join", replyToken: "rt", source: room },
            { type: "memberJoined", replyToken: "rt2", source: group, joined: { members: [] } },
            { type: "follow", replyToken: "rt3", source: oneToOne },
          ],
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores unknown event types that carry a reply token", async () => {
      const res = await POST(
        makeRequest({
          destination: "U1",
          events: [{ type: "unsend", replyToken: "rt", source: group, unsend: { messageId: "1" } }],
        }),
      );

      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("batches", () => {
    it("answers every event with its own reply token", async () => {
      await POST(
        makeRequest({
          destination: "U1",
          events: [
            textEvent("บอทจ๋า เปิดตี", oneToOne, "reply-token-a"),
            { type: "join", replyToken: "reply-token-b", source: group },
            textEvent("ไม่มี wake word", oneToOne, "reply-token-c"),
          ],
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(replies().map((body) => body.replyToken)).toEqual(["reply-token-a", "reply-token-b"]);
    });

    it("caps how many events one request may fan out to", async () => {
      const events = Array.from({ length: 60 }, (_, index) =>
        textEvent("บอทจ๋า", oneToOne, `reply-token-${index}`),
      );

      const res = await POST(makeRequest({ destination: "U1", events }));

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(50);
      expect(logged()).toContain("over the limit");
    });

    it("does not fire every reply at once", async () => {
      let inFlight = 0;
      let peak = 0;
      fetchMock.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response("{}", { status: 200 });
      });

      const events = Array.from({ length: 20 }, (_, index) =>
        textEvent("บอทจ๋า", oneToOne, `reply-token-${index}`),
      );

      await POST(makeRequest({ destination: "U1", events }));

      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(peak).toBeLessThanOrEqual(5);
    });
  });

  describe("the outgoing LINE request", () => {
    it("posts to the Reply API with auth, json body and a timeout", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));

      const [url, init] = fetchMock.mock.calls[0] as FetchCall;
      expect(url).toBe("https://api.line.me/v2/bot/message/reply");
      expect(init.method).toBe("POST");

      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("content-type")).toBe("application/json");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(replyBody([url, init]).messages[0]?.type).toBe("text");
    });
  });
});
