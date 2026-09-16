import { describe, expect, it } from "vitest";
import { readBodyWithLimit } from "@/lib/read-body";
import { makeBrokenBodyRequest, WEBHOOK_URL } from "./helpers";

const makeRequest = (body: BodyInit, headers: HeadersInit = {}) =>
  new Request(WEBHOOK_URL, { method: "POST", body, headers });

function streamRequest(stream: ReadableStream<Uint8Array>): Request {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    body: stream,
    // @ts-expect-error duplex is required by undici for a stream body but missing from the DOM types
    duplex: "half",
  });
}

describe("readBodyWithLimit", () => {
  it("reads a normal body", async () => {
    const body = JSON.stringify({ events: [] });
    const result = await readBodyWithLimit(makeRequest(body));
    expect(result).toEqual({ status: "ok", body: Buffer.from(body, "utf8") });
  });

  it("keeps Thai text byte-for-byte", async () => {
    const body = JSON.stringify({ text: "บอทจ๋า เปิดตี" });
    const result = await readBodyWithLimit(makeRequest(body));
    expect(result.status === "ok" && result.body.equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  it("reports too-large when content-length exceeds the limit", async () => {
    const request = makeRequest("small", { "content-length": "999999999" });
    expect(await readBodyWithLimit(request, 1000)).toEqual({ status: "too-large" });
  });

  it("reports too-large when the streamed body exceeds the limit, even without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(200));
        controller.close();
      },
    });

    expect(await readBodyWithLimit(streamRequest(stream), 1000)).toEqual({ status: "too-large" });
  });

  it("accepts a body exactly at the limit", async () => {
    const result = await readBodyWithLimit(makeRequest("x".repeat(1000)), 1000);
    expect(result.status === "ok" && result.body.byteLength).toBe(1000);
  });

  it("reports an error instead of throwing when the client disconnects", async () => {
    const result = await readBodyWithLimit(makeBrokenBodyRequest());
    expect(result.status).toBe("error");
    expect(result).toHaveProperty("error");
  });

  it("reports a timeout instead of hanging on a slow body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        // ไม่ปิด stream เลย เหมือน client ที่หยอดข้อมูลทีละนิดเพื่อยึด connection
      },
    });

    const result = await readBodyWithLimit(streamRequest(stream), 1_000_000, 20);
    expect(result).toEqual({ status: "timeout" });
  });
});
