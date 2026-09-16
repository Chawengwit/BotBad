/** LINE webhook body จริงเล็กมาก 1 MB เหลือเฟือ และกันคนยิง body ใหญ่ใส่ endpoint ที่ยังไม่ผ่าน auth */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/** อ่าน body แบบจำกัดขนาด คืน null ถ้าใหญ่เกิน limit */
export async function readBodyWithLimit(
  request: Request,
  limit: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<Buffer | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) return null;

  const body = request.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}
