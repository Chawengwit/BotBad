import { z } from "zod";

// replyToken จริงยาวไม่ถึง 100 ตัวอักษร ที่ใส่ max ไว้เพื่อไม่ให้ค่าแปลก ๆ
// ถูกส่งต่อไปเป็น request ก้อนใหญ่หา LINE
const MAX_REPLY_TOKEN_LENGTH = 200;

/**
 * source รับแบบหลวม ๆ ตั้งใจให้ type ที่ LINE เพิ่มมาใหม่ (เช่น square) ผ่าน validation ได้
 * แล้วไปตัดสินใจที่ handle-event ว่าจะตอบอะไร ตาม spec §22 ข้อ 4
 */
const sourceSchema = z.looseObject({
  type: z.string(),
  userId: z.string().optional(),
  groupId: z.string().optional(),
  roomId: z.string().optional(),
});

export const lineEventSchema = z.looseObject({
  type: z.string(),
  replyToken: z.string().max(MAX_REPLY_TOKEN_LENGTH).optional(),
  source: sourceSchema.optional(),
  message: z
    .looseObject({
      type: z.string(),
      text: z.string().optional(),
      // ข้อความแบบแชร์ตำแหน่งจาก LINE
      title: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
  postback: z
    .looseObject({
      // data ที่บอทสร้างเองสั้นมาก ค่าที่ยาวผิดปกติไม่ต้องรับไว้
      data: z.string().max(1000),
      // datetimepicker ส่งค่าที่ผู้ใช้เลือกมาตรงนี้
      params: z
        .looseObject({
          date: z.string().max(20).optional(),
          time: z.string().max(20).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * ตัว body บังคับรูปแบบตามที่ LINE ส่งจริง ถ้าผิดไปจากนี้ต้องรู้ตัว ไม่ใช่เงียบ
 * ส่วน events เก็บเป็น unknown[] แล้วค่อย validate ทีละ event
 * เพื่อไม่ให้ event ชนิดใหม่ทำให้ทั้ง batch ตกไป
 */
export const lineWebhookBodySchema = z.object({
  destination: z.string(),
  events: z.array(z.unknown()),
});

export type LineEvent = z.infer<typeof lineEventSchema>;
