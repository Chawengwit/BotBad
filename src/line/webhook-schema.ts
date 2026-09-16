import { z } from "zod";

const sourceSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("user"), userId: z.string() }),
  z.looseObject({ type: z.literal("group"), groupId: z.string(), userId: z.string().optional() }),
  z.looseObject({ type: z.literal("room"), roomId: z.string(), userId: z.string().optional() }),
]);

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

/**
 * รับ events เป็น unknown[] แล้วค่อย validate ทีละ event
 * เพื่อไม่ให้ event ชนิดใหม่ของ LINE ทำให้ทั้ง batch ถูกทิ้ง
 */
export const lineWebhookBodySchema = z.looseObject({
  events: z.array(z.unknown()).default([]),
});

export type LineEvent = z.infer<typeof lineEventSchema>;
