/** LINE webhook body จริงเล็กมาก 1 MB เหลือเฟือ และกันคนยิง body ใหญ่ใส่ endpoint ที่ยังไม่ผ่าน auth */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/** กัน client ที่ค่อย ๆ หยอด body ทีละไบต์เพื่อยึด connection ไว้ */
export const READ_BODY_TIMEOUT_MS = 10_000;

export type ReadBodyResult =
  | { status: "ok"; body: Buffer }
  | { status: "too-large" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // client ตัดสายไปแล้ว ไม่มีอะไรต้องทำต่อ
  }
}

/** ยกเลิก body ที่ยังไม่ได้อ่าน เพื่อไม่ให้ค้างรอข้อมูลที่ไม่มีวันใช้ */
export function discardBody(request: Request): void {
  void request.body?.cancel().catch(() => {});
}

/** อ่าน body แบบจำกัดขนาดและเวลา ไม่ throw ออกไปข้างนอก */
export async function readBodyWithLimit(
  request: Request,
  limit: number = MAX_WEBHOOK_BODY_BYTES,
  timeoutMs: number = READ_BODY_TIMEOUT_MS,
): Promise<ReadBodyResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    discardBody(request);
    return { status: "too-large" };
  }

  const body = request.body;
  if (!body) return { status: "ok", body: Buffer.alloc(0) };

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void cancelQuietly(reader);
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        await cancelQuietly(reader);
        return { status: "too-large" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // client ตัดสายกลางคัน หรือ stream พังระหว่างอ่าน
    return timedOut ? { status: "timeout" } : { status: "error", error };
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) return { status: "timeout" };
  return { status: "ok", body: Buffer.concat(chunks, total) };
}
