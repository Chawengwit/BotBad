import { getLineEnv } from "@/lib/env";
import { replyMessages } from "@/lib/line";
import { verifyLineSignature } from "@/lib/line-signature";
import { handleEvent } from "@/line/handle-event";
import { lineWebhookBodySchema } from "@/line/webhook-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const env = getLineEnv();
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = lineWebhookBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const reply = (replyToken: string, messages: Parameters<typeof replyMessages>[1]) =>
    replyMessages(replyToken, messages, env.LINE_CHANNEL_ACCESS_TOKEN);

  // signature ถูกต้องแล้ว ต้องตอบ 200 เสมอ error ภายในให้ log ไว้
  // (LINE Verify ส่ง events: [] มา จึงผ่านตรงนี้และได้ 200)
  const results = await Promise.allSettled(parsed.data.events.map((event) => handleEvent(event, reply)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[webhook] event handling failed:", result.reason);
    }
  }

  return Response.json({ ok: true });
}
