import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/line/webhook/route";

const SECRET = "test-channel-secret";
const TOKEN = "test-access-token";

// ข้อความตาม spec §22 ข้อ 4 เขียนเป็น literal ไว้ที่นี่ ไม่อ้างค่าจากโค้ด
// จะได้จับได้ถ้ามีคนแก้ข้อความในโค้ดจนหลุดจาก spec
const GROUP_ONLY_TEXT = "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น";

const group = { type: "group", groupId: "C123", userId: "U123" };
const room = { type: "room", roomId: "R123", userId: "U123" };
const oneToOne = { type: "user", userId: "U123" };

const textEvent = (text: string, source: object, replyToken = "reply-token-1") => ({
  type: "message",
  replyToken,
  source,
  message: { type: "text", id: "1", text },
});

const sign = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("base64");

function makeRequest(body: unknown, options: { signature?: string | null; headers?: HeadersInit } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = options.signature === undefined ? sign(raw) : options.signature;
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (signature !== null) headers.set("x-line-signature", signature);
  return new Request("http://localhost/api/line/webhook", { method: "POST", headers, body: raw });
}

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

  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_SECRET", SECRET);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN);
    fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("signature", () => {
    it("returns 200 for LINE Verify (empty events)", async () => {
      const res = await POST(makeRequest({ destination: "U1", events: [] }));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never calls LINE when the signature header is missing", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }, { signature: null }),
      );
      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never calls LINE when the signature is wrong", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }, { signature: "AAAA" }),
      );
      expect(res.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
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

    it("rejects an oversized body before doing any work", async () => {
      const res = await POST(
        makeRequest({ destination: "U1", events: [] }, { headers: { "content-length": "999999999" } }),
      );
      expect(res.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("always answers 200 once the signature is valid", () => {
    it("logs and returns 200 for invalid json", async () => {
      const res = await POST(makeRequest("{not json"));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("logs and returns 200 for a body without events", async () => {
      const res = await POST(makeRequest({ destination: "U1", events: "nope" }));
      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("skips one unsupported event but still handles the others", async () => {
      const res = await POST(
        makeRequest({
          destination: "U1",
          events: [
            { type: "message", source: { type: "square", squareId: "S1" }, message: { type: "text", text: "บอทจ๋า" } },
            textEvent("บอทจ๋า", oneToOne, "reply-token-2"),
          ],
        }),
      );

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replyBody(fetchMock.mock.calls[0] as FetchCall).replyToken).toBe("reply-token-2");
    });

    it("returns 200 and does not call LINE when the access token is unusable", async () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "bad token with space");

      const res = await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("returns 200 when the LINE reply API fails", async () => {
      fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));

      const res = await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));
      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("redacts the access token from logs when fetch throws with it", async () => {
      fetchMock.mockRejectedValue(new TypeError(`Headers.append: "Bearer ${TOKEN}" is invalid.`));

      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", oneToOne)] }));

      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain(TOKEN);
      expect(logged).toContain("[redacted]");
    });
  });

  describe("who gets an answer", () => {
    it("ignores group text without the wake word", async () => {
      const res = await POST(makeRequest({ destination: "U1", events: [textEvent("ใครตีบ้าง", group)] }));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stays silent in a group until the router exists", async () => {
      // spec §18 Router ยังไม่ได้ทำ จึงยังไม่มีคำตอบสำหรับคำสั่งในกลุ่ม
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", group)] }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("tells 1:1 chat users the bot is group-only", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", oneToOne)] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replyBody(fetchMock.mock.calls[0] as FetchCall).messages).toEqual([
        { type: "text", text: GROUP_ONLY_TEXT },
      ]);
    });

    it("treats a multi-person room as not a group", async () => {
      await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", room)] }));
      expect(replyBody(fetchMock.mock.calls[0] as FetchCall).messages[0]?.text).toBe(GROUP_ONLY_TEXT);
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

    it("greets when joining a group", async () => {
      await POST(makeRequest({ destination: "U1", events: [{ type: "join", replyToken: "rt", source: group }] }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(replyBody(fetchMock.mock.calls[0] as FetchCall).messages[0]?.text).toContain("บอทจ๋า");
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
      const tokens = fetchMock.mock.calls.map((call) => replyBody(call as FetchCall).replyToken);
      expect(tokens).toEqual(["reply-token-a", "reply-token-b"]);
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
