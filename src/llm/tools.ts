import { Type, type FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import {
  courtNameSchema,
  locationUrlSchema,
  MAX_PLAYERS,
  MIN_PLAYERS,
  promptPaySchema,
} from "@/services/game.service";
import { DATE_PATTERN, TIME_PATTERN } from "@/lib/time";
import { billDraftSchema } from "@/services/bill.service";
import { MAX_NAMES_PER_COMMAND, MAX_NAME_LENGTH } from "@/services/people.service";

/**
 * Tool ที่ LLM เรียกได้ (LLM Design §6)
 * ไม่มีตัวไหนรับ user_id หรือ group_id เพราะ App ใส่จาก LINE event เอง
 */

const gameFields = {
  court_count: {
    type: Type.INTEGER,
    description: "จำนวนคอร์ท 1 ถึง 4",
  },
  max_players: {
    type: Type.INTEGER,
    description: `จำนวนคนสูงสุดที่รับ ${MIN_PLAYERS} ถึง ${MAX_PLAYERS} ถ้าผู้ใช้ไม่ได้บอก ให้ข้ามไป ระบบจะใช้ค่าปกติคือ คอร์ท x 8`,
  },
  play_date: {
    type: Type.STRING,
    description: "วันที่เล่น รูปแบบ YYYY-MM-DD ตามเวลาไทย",
  },
  start_time: {
    type: Type.STRING,
    description: "เวลาเริ่ม รูปแบบ HH:mm แบบ 24 ชั่วโมง เช่น 20:00",
  },
  duration_minutes: {
    type: Type.INTEGER,
    description: "ระยะเวลาเล่นเป็นนาที ต้องเป็นชั่วโมงเต็ม เช่น 60, 120, 180",
  },
  court_name: {
    type: Type.STRING,
    description: "ชื่อคอร์ทหรือสนามที่ไปเล่น เช่น ABC Badminton",
  },
  location_url: {
    type: Type.STRING,
    description: "ลิงก์แผนที่ของคอร์ท ใส่เฉพาะเมื่อผู้ใช้ให้ลิงก์มา",
  },
  promptpay: {
    type: Type.STRING,
    description:
      "เลขพร้อมเพย์ที่ให้โอนตอนคิดเงิน เป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก ใส่เฉพาะเมื่อผู้ใช้บอกเลขมา",
  },
};

const billTitleField = {
  bill_title: {
    type: Type.STRING,
    description:
      "ชื่อบิลที่หมายถึง ใส่เฉพาะเมื่อผู้ใช้เอ่ยชื่อบิลมาเอง กลุ่มมีบิลเปิดพร้อมกันได้หลายใบ",
  },
};

const peopleFields = {
  names: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description:
      "ชื่อคนที่ทำรายการให้ ตามที่ผู้ใช้พิมพ์มาเป๊ะ ๆ ห้ามเดาหรือแต่งชื่อเอง " +
      "ใส่เฉพาะชื่อที่ผู้ใช้เอ่ยถึงจริง ไม่ต้องใส่ชื่อผู้ใช้เองเว้นแต่เขาระบุมาด้วย",
  },
};

const billTitleOnCreate = {
  title: {
    type: Type.STRING,
    description:
      "ชื่อบิล ใส่เมื่อผู้ใช้อยากคิดเงินเรื่องที่ไม่ใช่ค่ารอบตี เช่น ค่ากินข้าวหลังตี " +
      "ไม่ใส่ = คิดเงินของรอบที่เปิดอยู่ และระบบตั้งชื่อให้เอง",
  },
};

const billFields = {
  court_fee: {
    type: Type.NUMBER,
    description: "ค่าคอร์ททั้งหมดเป็นบาท ใส่เฉพาะเมื่อผู้ใช้บอกมา ถ้าไม่มีค่าคอร์ทให้ข้ามไป",
  },
  shuttle_count: {
    type: Type.INTEGER,
    description: "จำนวนลูกแบดที่ใช้ ถ้าไม่ได้ใช้ลูกให้ส่ง 0",
  },
  shuttle_price: {
    type: Type.NUMBER,
    description: "ราคาลูกแบดต่อลูกเป็นบาท ต้องใส่คู่กับ shuttle_count ที่มากกว่า 0",
  },
  other_items: {
    type: Type.ARRAY,
    description: "ค่าใช้จ่ายอื่น เช่น ค่าน้ำ ค่าเช่าไม้ ค่าที่จอดรถ",
    items: {
      type: Type.OBJECT,
      properties: {
        label: { type: Type.STRING, description: "ชื่อรายการ เช่น ค่าน้ำ" },
        amount: { type: Type.NUMBER, description: "จำนวนเงินของรายการนี้เป็นบาท" },
      },
      required: ["label", "amount"],
    },
  },
};

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "get_open_game",
    description:
      "ดูรอบตีที่เปิดอยู่ของกลุ่มนี้ ได้วัน เวลา คอร์ท จำนวนคนที่ลงชื่อ และผู้สร้าง ใช้เมื่อผู้ใช้ถามว่ามีรอบไหม เต็มหรือยัง กี่โมง ตีที่ไหน",
  },
  {
    name: "list_players",
    description: "ดูรายชื่อผู้เล่นที่ลงชื่อในรอบที่เปิดอยู่ เรียงตามลำดับที่ลงชื่อ",
  },
  {
    name: "join_game",
    description:
      "ลงชื่อเข้ารอบที่เปิดอยู่ ไม่ส่ง names มาคือลงชื่อ 'ผู้ใช้ที่พิมพ์ข้อความนี้' " +
      "ถ้าผู้ใช้เอ่ยชื่อคนอื่นหรือบอกว่าพาเพื่อนมา ให้ส่งชื่อเหล่านั้นใน names",
    parameters: { type: Type.OBJECT, properties: peopleFields },
  },
  {
    name: "leave_game",
    description:
      "ถอนชื่อออกจากรอบที่เปิดอยู่ ไม่ส่ง names มาคือถอน 'ผู้ใช้ที่พิมพ์ข้อความนี้' " +
      "ถ้าผู้ใช้บอกให้ถอนคนอื่น ให้ส่งชื่อใน names ระบบจะตรวจสิทธิ์เองว่าถอนได้ไหม",
    parameters: { type: Type.OBJECT, properties: peopleFields },
  },
  {
    name: "propose_create_game",
    description:
      "เสนอเปิดรอบตีใหม่ ยังไม่เปิดจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ส่งเฉพาะค่าที่ผู้ใช้บอกมาแล้ว ถ้ายังไม่ครบ tool จะคืนรายการที่ขาดมาให้ถามต่อ",
    parameters: { type: Type.OBJECT, properties: gameFields },
  },
  {
    name: "propose_edit_game",
    description:
      "เสนอแก้ไขรอบที่เปิดอยู่ ยังไม่แก้จริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ส่งเฉพาะค่าที่ต้องการเปลี่ยน ใช้ได้เฉพาะคนที่เปิดรอบ",
    parameters: { type: Type.OBJECT, properties: gameFields },
  },
  {
    name: "get_bill",
    parameters: { type: Type.OBJECT, properties: billTitleField },
    description:
      "ดูบิลค่าใช้จ่ายของกลุ่มนี้ ได้รายการค่าใช้จ่าย ยอดต่อคน และใครจ่ายแล้วหรือยังไม่จ่าย ใช้เมื่อผู้ใช้ถามว่าคนละเท่าไหร่ ใครยังไม่จ่าย หรือขอดูบิล",
  },
  {
    name: "propose_create_bill",
    description:
      "เสนอคิดเงิน หารเท่ากันทุกคนที่อยู่ในบิล ยังไม่ส่งบิลจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน " +
      "ไม่ส่ง title = คิดเงินค่ารอบตีที่เปิดอยู่ ใช้ได้เฉพาะคนที่เปิดรอบ " +
      "ส่ง title = บิลลอย ๆ ที่ไม่ผูกกับรอบ ใครในกลุ่มก็สร้างได้",
    parameters: { type: Type.OBJECT, properties: { ...billFields, ...billTitleOnCreate } },
  },
  {
    name: "mark_my_payment",
    description:
      "บันทึกว่าจ่ายเงินแล้วหรือยัง ไม่ส่ง names มาคือของ 'ผู้ใช้ที่พิมพ์ข้อความนี้' " +
      "ถ้าเขาบอกว่าจ่ายแทนใคร เช่นจ่ายให้แขกที่พามา ให้ส่งชื่อเหล่านั้นใน names " +
      "ระบบตรวจสิทธิ์เองว่ากดแทนได้ไหม",
    parameters: {
      type: Type.OBJECT,
      properties: {
        paid: {
          type: Type.BOOLEAN,
          description: "true = จ่ายแล้ว, false = กลับไปเป็นยังไม่จ่าย",
        },
        ...peopleFields,
        ...billTitleField,
      },
      required: ["paid"],
    },
  },
  {
    name: "propose_cancel_game",
    description:
      "เสนอยกเลิกรอบที่เปิดอยู่ (ไม่ได้เล่น) ยังไม่ยกเลิกจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ใช้ได้เฉพาะคนที่เปิดรอบ",
  },
  {
    name: "propose_close_game",
    description:
      "เสนอปิดรอบที่เล่นจบแล้ว เพื่อให้กลุ่มเปิดรอบใหม่ได้ ยังไม่ปิดจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ใช้ได้เฉพาะคนที่เปิดรอบ",
  },
];

const noArgs = z.object({}).strict();

const peopleArgs = z
  .object({ names: z.array(z.string().trim().min(1).max(MAX_NAME_LENGTH)).max(MAX_NAMES_PER_COMMAND) })
  .partial()
  .strict();

const gameArgs = z
  .object({
    court_count: z.number().int().min(1).max(4),
    max_players: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    play_date: z.string().regex(DATE_PATTERN),
    start_time: z.string().regex(TIME_PATTERN),
    duration_minutes: z.number().int().positive().multipleOf(60),
    court_name: courtNameSchema,
    location_url: locationUrlSchema,
    promptpay: promptPaySchema,
  })
  .partial()
  .strict();

/** ตรวจ arguments ที่ LLM ส่งมาทุกครั้ง (LLM Design §6) */
export const toolSchemas = {
  get_open_game: noArgs,
  list_players: noArgs,
  join_game: peopleArgs,
  leave_game: peopleArgs,
  propose_create_game: gameArgs,
  propose_edit_game: gameArgs,
  propose_cancel_game: noArgs,
  propose_close_game: noArgs,
  get_bill: z.object({ bill_title: z.string().trim().max(60) }).partial().strict(),
  propose_create_bill: billDraftSchema.extend({ title: z.string().trim().max(60) }).partial().strict(),
  mark_my_payment: z
    .object({
      paid: z.boolean(),
      names: z.array(z.string().trim().min(1).max(MAX_NAME_LENGTH)).max(MAX_NAMES_PER_COMMAND),
      bill_title: z.string().trim().max(60),
    })
    .partial({ names: true, bill_title: true })
    .strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;

export function isToolName(name: string): name is ToolName {
  return name in toolSchemas;
}
