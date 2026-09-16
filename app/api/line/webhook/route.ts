import { getLineEnv, type LineEnv } from "@/lib/env";
import { replyMessages } from "@/lib/line";
import { verifyLineSignature } from "@/lib/line-signature";
import { formatErrorForLog } from "@/lib/log";
import { discardBody, MAX_WEBHOOK_BODY_BYTES, readBodyWithLimit } from "@/lib/read-body";
import { handleEvent, type EventContext } from "@/line/handle-event";
import { lineEventSchema, lineWebhookBodySchema } from "@/line/webhook-schema";

// ประกาศไว้ให้ชัด เพราะ route นี้ใช้ node:crypto และ Buffer จะรันบน edge ไม่ได้
export const runtime = "nodejs";

const OK_RESPONSE = { ok: true } as const;

// LINE ส่งมาทีละไม่กี่ event ตั้งเพดานต่ำไว้เพื่อไม่ให้ handler ใช้เวลานานจน LINE ถือว่า timeout
// แล้วส่งซ้ำมาด้วย replyToken ที่ใช้ไปแล้ว (แต่ละ event อาจรอ Gemini ได้ถึง 8 วินาที)
const MAX_EVENTS_PER_REQUEST = 10;
const MAX_CONCURRENT_REPLIES = 5;

function describeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join(", ");
}

function parseEvents(rawBody: Buffer): unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    console.error("[webhook] body is not valid json:", formatErrorForLog(error));
    return [];
  }

  const parsed = lineWebhookBodySchema.safeParse(json);
  if (!parsed.success) {
    console.error("[webhook] unexpected body shape:", describeIssues(parsed.error));
    return [];
  }

  return parsed.data.events;
}

async function handleOneEvent(rawEvent: unknown, context: EventContext): Promise<void> {
  const parsed = lineEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    console.error("[webhook] skipped unsupported event:", describeIssues(parsed.error));
    return;
  }
  await handleEvent(parsed.data, context);
}

async function handleEvents(
  events: unknown[],
  context: EventContext,
  secrets: readonly string[],
): Promise<void> {
  const accepted = events.slice(0, MAX_EVENTS_PER_REQUEST);
  if (events.length > accepted.length) {
    console.error(`[webhook] ignored ${events.length - accepted.length} event(s) over the limit`);
  }

  for (let start = 0; start < accepted.length; start += MAX_CONCURRENT_REPLIES) {
    const batch = accepted.slice(start, start + MAX_CONCURRENT_REPLIES);
    const results = await Promise.allSettled(batch.map((event) => handleOneEvent(event, context)));

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[webhook] event handling failed:", formatErrorForLog(result.reason, secrets));
      }
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  // เช็ก header ก่อนอ่าน body จะได้ไม่เสียแรงอ่านข้อมูลของ request ที่ไม่มีทางผ่าน
  const signature = request.headers.get("x-line-signature");
  if (!signature) {
    discardBody(request);
    console.warn("[webhook] rejected: missing x-line-signature");
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let env: LineEnv;
  try {
    env = getLineEnv();
  } catch (error) {
    // ตอบให้ดังพอที่ปุ่ม Verify ของ LINE จะไม่ผ่าน จะได้รู้ตั้งแต่ก่อนเปิดใช้งานจริง
    discardBody(request);
    console.error("[webhook] not configured:", formatErrorForLog(error));
    return Response.json({ error: "not configured" }, { status: 503 });
  }

  const read = await readBodyWithLimit(request, MAX_WEBHOOK_BODY_BYTES);
  if (read.status === "too-large") {
    console.warn("[webhook] rejected: body over", MAX_WEBHOOK_BODY_BYTES, "bytes");
    return Response.json({ error: "payload too large" }, { status: 413 });
  }
  if (read.status === "timeout") {
    console.warn("[webhook] rejected: timed out while reading the body");
    return Response.json({ error: "request timeout" }, { status: 408 });
  }
  if (read.status === "error") {
    console.warn("[webhook] could not read the body:", formatErrorForLog(read.error));
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  if (!verifyLineSignature(read.body, signature, env.LINE_CHANNEL_SECRET)) {
    console.warn("[webhook] rejected: signature mismatch (LINE_CHANNEL_SECRET ตรงกับ channel หรือเปล่า?)");
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  // ผ่าน signature แล้ว ตั้งแต่จุดนี้ต้องตอบ 200 เสมอ (spec §22 ข้อ 8)
  // error ภายในให้ log ไว้ ไม่ให้ LINE ส่งซ้ำ
  // (LINE Verify ส่ง events: [] มา จึงผ่านตรงนี้และได้ 200)
  const context: EventContext = {
    reply: (replyToken, messages) => replyMessages(replyToken, messages, env.LINE_CHANNEL_ACCESS_TOKEN),
    accessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
  };

  await handleEvents(parseEvents(read.body), context, [
    env.LINE_CHANNEL_ACCESS_TOKEN,
    env.LINE_CHANNEL_SECRET,
  ]);

  return Response.json(OK_RESPONSE);
}
