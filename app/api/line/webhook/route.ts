import { getLineAccessToken, getLineChannelSecret } from "@/lib/env";
import { replyMessages } from "@/lib/line";
import { verifyLineSignature } from "@/lib/line-signature";
import { formatErrorForLog } from "@/lib/log";
import { readBodyWithLimit } from "@/lib/read-body";
import { handleEvent, type ReplyFn } from "@/line/handle-event";
import { lineEventSchema, lineWebhookBodySchema } from "@/line/webhook-schema";

const OK_RESPONSE = { ok: true } as const;

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
    console.error("[webhook] unexpected body shape:", parsed.error.issues.length, "issue(s)");
    return [];
  }

  return parsed.data.events;
}

export async function POST(request: Request): Promise<Response> {
  // เช็ก header ก่อนอ่าน body จะได้ไม่เสียแรงอ่านข้อมูลของ request ที่ไม่มีทางผ่าน
  const signature = request.headers.get("x-line-signature");
  if (!signature) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const rawBody = await readBodyWithLimit(request);
  if (!rawBody) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  if (!verifyLineSignature(rawBody, signature, getLineChannelSecret())) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  // ผ่าน signature แล้ว ตั้งแต่จุดนี้ต้องตอบ 200 เสมอ (spec §22 ข้อ 8)
  // error ภายในให้ log ไว้ ไม่ให้ LINE ส่งซ้ำ
  // (LINE Verify ส่ง events: [] มา จึงผ่านตรงนี้และได้ 200)
  let accessToken: string;
  try {
    accessToken = getLineAccessToken();
  } catch (error) {
    console.error("[webhook] cannot reply:", formatErrorForLog(error));
    return Response.json(OK_RESPONSE);
  }

  const reply: ReplyFn = (replyToken, messages) => replyMessages(replyToken, messages, accessToken);

  const tasks = parseEvents(rawBody).map(async (rawEvent) => {
    const parsed = lineEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      console.error("[webhook] skipped unsupported event:", parsed.error.issues.length, "issue(s)");
      return;
    }
    await handleEvent(parsed.data, reply);
  });

  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === "rejected") {
      console.error(
        "[webhook] event handling failed:",
        formatErrorForLog(result.reason, [accessToken]),
      );
    }
  }

  return Response.json(OK_RESPONSE);
}
