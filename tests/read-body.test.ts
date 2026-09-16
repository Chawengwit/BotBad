import { describe, expect, it } from "vitest";
import { readBodyWithLimit } from "@/lib/read-body";

const makeRequest = (body: BodyInit, headers: HeadersInit = {}) =>
  new Request("http://localhost/api/line/webhook", { method: "POST", body, headers });

describe("readBodyWithLimit", () => {
  it("reads a normal body", async () => {
    const body = JSON.stringify({ events: [] });
    const raw = await readBodyWithLimit(makeRequest(body));
    expect(raw?.toString("utf8")).toBe(body);
  });

  it("keeps Thai text byte-for-byte", async () => {
    const body = JSON.stringify({ text: "บอทจ๋า เปิดตี" });
    const raw = await readBodyWithLimit(makeRequest(body));
    expect(raw?.equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  it("returns null when content-length exceeds the limit", async () => {
    const request = makeRequest("small", { "content-length": "999999999" });
    expect(await readBodyWithLimit(request, 1000)).toBeNull();
  });

  it("returns null when the streamed body exceeds the limit, even without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(200));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/line/webhook", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required by undici for a stream body but missing from the DOM types
      duplex: "half",
    });

    expect(await readBodyWithLimit(request, 1000)).toBeNull();
  });

  it("accepts a body exactly at the limit", async () => {
    const body = "x".repeat(1000);
    const raw = await readBodyWithLimit(makeRequest(body), 1000);
    expect(raw?.byteLength).toBe(1000);
  });
});
