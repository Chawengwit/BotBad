import { z } from "zod";

const sourceSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("user"), userId: z.string() }),
  z.looseObject({ type: z.literal("group"), groupId: z.string(), userId: z.string().optional() }),
  z.looseObject({ type: z.literal("room"), roomId: z.string(), userId: z.string().optional() }),
]);

// รับทุก event ไว้ก่อน แล้วค่อยเลือกประมวลผลเฉพาะที่ต้องการ
// เพื่อไม่ให้ event ชนิดใหม่ของ LINE ทำให้ทั้ง request ถูก reject
export const lineEventSchema = z.looseObject({
  type: z.string(),
  replyToken: z.string().optional(),
  source: sourceSchema.optional(),
  message: z
    .looseObject({
      type: z.string(),
      text: z.string().optional(),
    })
    .optional(),
});

export const lineWebhookBodySchema = z.object({
  destination: z.string(),
  events: z.array(lineEventSchema),
});

export type LineEvent = z.infer<typeof lineEventSchema>;
export type LineWebhookBody = z.infer<typeof lineWebhookBodySchema>;
