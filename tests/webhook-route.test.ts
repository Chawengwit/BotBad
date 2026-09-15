import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/line/webhook/route";
import { MESSAGES } from "@/line/handle-event";

const SECRET = "test-channel-secret";
const TOKEN = "test-access-token";

function makeRequest(body: unknown, options: { signature?: string | null } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature =
    options.signature === undefined
      ? createHmac("sha256", SECRET).update(raw, "utf8").digest("base64")
      : options.signature;
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("x-line-signature", signature);
  return new Request("http://localhost/api/line/webhook", { method: "POST", headers, body: raw });
}

const textEvent = (text: string, source: object) => ({
  type: "message",
  replyToken: "reply-token-1",
  source,
  message: { type: "text", id: "1", text },
});

const group = { type: "group", groupId: "C123", userId: "U123" };

describe("POST /api/line/webhook", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_SECRET", SECRET);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN);
    fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 200 for LINE Verify (empty events)", async () => {
    const res = await POST(makeRequest({ destination: "U1", events: [] }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when signature is missing", async () => {
    const res = await POST(makeRequest({ destination: "U1", events: [] }, { signature: null }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is wrong", async () => {
    const res = await POST(makeRequest({ destination: "U1", events: [] }, { signature: "AAAA" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid json with a valid signature", async () => {
    const res = await POST(makeRequest("{not json"));
    expect(res.status).toBe(400);
  });

  it("ignores group text without wake word", async () => {
    const res = await POST(makeRequest({ destination: "U1", events: [textEvent("ใครตีบ้าง", group)] }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replies to group text with wake word", async () => {
    const res = await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", group)] }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.line.me/v2/bot/message/reply");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      replyToken: "reply-token-1",
      messages: [{ type: "text", text: MESSAGES.ready }],
    });
  });

  it("tells 1:1 chat users the bot is group-only", async () => {
    const res = await POST(
      makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า เปิดตี", { type: "user", userId: "U1" })] }),
    );
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages[0].text).toBe(MESSAGES.groupOnly);
  });

  it("ignores 1:1 chat text without wake word", async () => {
    await POST(makeRequest({ destination: "U1", events: [textEvent("hello", { type: "user", userId: "U1" })] }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("greets when joining a group", async () => {
    await POST(makeRequest({ destination: "U1", events: [{ type: "join", replyToken: "rt", source: group }] }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).messages[0].text).toBe(MESSAGES.joinGroup);
  });

  it("ignores unknown event types without failing", async () => {
    const res = await POST(
      makeRequest({ destination: "U1", events: [{ type: "unsend", source: group, unsend: { messageId: "1" } }] }),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when LINE reply API fails", async () => {
    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(makeRequest({ destination: "U1", events: [textEvent("บอทจ๋า", group)] }));
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalled();
  });
});
