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
import { billDraftSchema, ITEM_LABEL_MAX_LENGTH, MAX_OTHER_ITEMS } from "@/services/bill.service";
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

/**
 * รอบที่หมายถึง กลุ่มเปิดได้หลายรอบพร้อมกัน (PRP multi-open-rounds §6)
 * ไม่ใช้ชื่อ play_date / start_time เพราะ propose_edit_game ใช้ชื่อนั้นเป็นค่าใหม่ของรอบอยู่แล้ว
 */
const roundFields = {
  round_date: {
    type: Type.STRING,
    description:
      'วันของรอบที่หมายถึง รูปแบบ YYYY-MM-DD ใส่เฉพาะเมื่อผู้ใช้พูดถึงวันของรอบ เช่น "รอบวันเสาร์" ' +
      "ไม่ได้พูดถึงไม่ต้องส่ง ระบบเลือกรอบหรือถามผู้ใช้เอง",
  },
  round_time: {
    type: Type.STRING,
    description: "เวลาเริ่มของรอบที่หมายถึง รูปแบบ HH:mm ใส่เฉพาะเมื่อผู้ใช้พูดถึงเวลาของรอบ ใช้แยกสองรอบที่อยู่วันเดียวกัน",
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

const billPayersField = {
  payers: {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        label: {
          type: Type.STRING,
          description: 'ชื่อรายการที่เก็บบางคน ต้องตรงกับชื่อรายการที่ส่งมา เช่น "ค่าน้ำ" หรือ "ค่าคอร์ท"',
        },
        names: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "ชื่อคนที่ร่วมจ่ายรายการนี้ ตามที่ผู้ใช้พิมพ์มาเป๊ะ ๆ",
        },
      },
    },
    description:
      "ระบุเฉพาะรายการที่เก็บบางคน รายการที่ไม่อยู่ในนี้จะเก็บทุกคนในบิล " +
      'เช่น "ค่าน้ำหารเฉพาะเชวงกับแบงค์" ส่ง [{ label: "ค่าน้ำ", names: ["เชวง", "แบงค์"] }]',
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
    name: "get_open_games",
    description:
      "ดูทุกรอบตีที่เปิดอยู่ของกลุ่มนี้ ได้วัน เวลา คอร์ท จำนวนคนที่ลงชื่อ และผู้สร้างของแต่ละรอบ " +
      "ใช้เมื่อผู้ใช้ถามว่ามีรอบไหม เต็มหรือยัง กี่โมง ตีที่ไหน",
  },
  {
    name: "list_players",
    description:
      "ดูรายชื่อผู้เล่นที่ลงชื่อ เรียงตามลำดับที่ลงชื่อ ไม่ระบุรอบได้รายชื่อทุกรอบที่เปิดอยู่",
    parameters: { type: Type.OBJECT, properties: roundFields },
  },
  {
    name: "join_game",
    description:
      "ลงชื่อเข้ารอบที่เปิดอยู่ ไม่ส่ง names มาคือลงชื่อ 'ผู้ใช้ที่พิมพ์ข้อความนี้' " +
      "ถ้าผู้ใช้เอ่ยชื่อคนอื่นหรือบอกว่าพาเพื่อนมา ให้ส่งชื่อเหล่านั้นใน names",
    parameters: { type: Type.OBJECT, properties: { ...peopleFields, ...roundFields } },
  },
  {
    name: "leave_game",
    description:
      "ถอนชื่อออกจากรอบที่เปิดอยู่ ไม่ส่ง names มาคือถอน 'ผู้ใช้ที่พิมพ์ข้อความนี้' " +
      "ถ้าผู้ใช้บอกให้ถอนคนอื่น ให้ส่งชื่อใน names ระบบจะเช็กรายชื่อและสิทธิ์เอง ถอนคนอื่นต้องกดยืนยันก่อน",
    parameters: { type: Type.OBJECT, properties: { ...peopleFields, ...roundFields } },
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
      "เสนอแก้ไขรอบที่เปิดอยู่ ยังไม่แก้จริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ส่งเฉพาะค่าที่ต้องการเปลี่ยน ใช้ได้เฉพาะคนที่เปิดรอบ " +
      "play_date / start_time คือค่าใหม่ ส่วนรอบที่จะแก้ระบุด้วย round_date / round_time",
    parameters: { type: Type.OBJECT, properties: { ...gameFields, ...roundFields } },
  },
  {
    name: "get_bill",
    parameters: { type: Type.OBJECT, properties: billTitleField },
    description:
      "ดูบิลค่าใช้จ่ายของกลุ่มนี้ ได้รายการค่าใช้จ่าย ยอดต่อคน และใครจ่ายแล้วหรือยังไม่จ่าย ใช้เมื่อผู้ใช้ถามว่าคนละเท่าไหร่ ใครยังไม่จ่าย หรือขอดูบิล",
  },
  {
    name: "start_bill",
    description:
      "เริ่มคิดเงินเมื่อผู้ใช้ยังไม่ได้บอกรายการกับจำนวนเงิน ระบบจะส่งการ์ดหรือคำถามไปให้ผู้ใช้ตอบเอง " +
      "ไม่ส่ง kind = ขึ้นการ์ดให้เลือกว่าจะคิดค่ารอบ สร้างบิลใหม่ หรือแก้บิลเดิม ใช้เมื่อไม่ชัดว่าเงินเรื่องไหน เช่น \"คิดเงินหน่อย\" " +
      "kind = new เมื่อบอกชัดว่าจะสร้างบิลใหม่หรือบิลเรื่องที่ไม่ใช่ค่ารอบ เช่น \"สร้างบิลใหม่\" \"คิดค่าข้าวหน่อย\" " +
      "kind = game เมื่อบอกชัดว่าจะคิดค่ารอบตีที่เปิดอยู่ ใช้ได้เฉพาะคนที่เปิดรอบ " +
      "kind = edit เมื่อจะแก้บิลที่ส่งไปแล้ว เพิ่มหรือลบรายการ ใช้ได้เฉพาะคนสร้างบิล",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: {
          type: Type.STRING,
          description: 'ใส่ได้ "game", "new" หรือ "edit" เท่านั้น ไม่แน่ใจว่าเรื่องไหนไม่ต้องส่ง',
        },
        title: {
          type: Type.STRING,
          description: "ชื่อบิลใหม่ ใส่เฉพาะ kind = new และผู้ใช้ตั้งชื่อมาเอง",
        },
        ...roundFields,
      },
    },
  },
  {
    name: "propose_create_bill",
    description:
      "เสนอคิดเงินเมื่อรู้รายการกับจำนวนเงินแล้ว ยังไม่ส่งบิลจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน " +
      "ไม่ส่ง title = คิดเงินค่ารอบตีที่เปิดอยู่ ใช้ได้เฉพาะคนที่เปิดรอบ " +
      "ส่ง title = บิลลอย ๆ ที่ไม่ผูกกับรอบ ใครในกลุ่มก็สร้างได้ " +
      "บิลลอย ๆ ที่ไม่ได้บอกเลขพร้อมเพย์ ระบบจะถามเลขก่อนขึ้นการ์ดยืนยัน",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ...billFields,
        ...billTitleOnCreate,
        ...billPayersField,
        promptpay: {
          type: Type.STRING,
          description: "เลขพร้อมเพย์ที่ให้โอน ใส่เฉพาะเมื่อผู้ใช้บอกเลขมาในข้อความ",
        },
        ...roundFields,
      },
    },
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
    parameters: { type: Type.OBJECT, properties: roundFields },
  },
  {
    name: "propose_close_game",
    description:
      "เสนอปิดรอบที่เล่นจบแล้ว ยังไม่ปิดจริงจนกว่าผู้ใช้จะกดปุ่มยืนยัน ใช้ได้เฉพาะคนที่เปิดรอบ " +
      "รอบที่เลยวันเล่นแล้วระบบปิดให้เองทุกเช้า",
    parameters: { type: Type.OBJECT, properties: roundFields },
  },
];

const noArgs = z.object({}).strict();

const roundArgs = {
  round_date: z.string().regex(DATE_PATTERN),
  round_time: z.string().regex(TIME_PATTERN),
};

const roundOnlyArgs = z.object(roundArgs).partial().strict();

const peopleArgs = z
  .object({
    names: z.array(z.string().trim().min(1).max(MAX_NAME_LENGTH)).max(MAX_NAMES_PER_COMMAND),
    ...roundArgs,
  })
  .partial()
  .strict();

const gameShape = {
  court_count: z.number().int().min(1).max(4),
  max_players: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
  play_date: z.string().regex(DATE_PATTERN),
  start_time: z.string().regex(TIME_PATTERN),
  duration_minutes: z.number().int().positive().multipleOf(60),
  court_name: courtNameSchema,
  location_url: locationUrlSchema,
  promptpay: promptPaySchema,
};

/** ตรวจ arguments ที่ LLM ส่งมาทุกครั้ง (LLM Design §6) */
export const toolSchemas = {
  get_open_games: noArgs,
  list_players: roundOnlyArgs,
  join_game: peopleArgs,
  leave_game: peopleArgs,
  propose_create_game: z.object(gameShape).partial().strict(),
  propose_edit_game: z.object({ ...gameShape, ...roundArgs }).partial().strict(),
  propose_cancel_game: roundOnlyArgs,
  propose_close_game: roundOnlyArgs,
  get_bill: z.object({ bill_title: z.string().trim().max(60) }).partial().strict(),
  start_bill: z
    .object({
      kind: z.enum(["game", "new", "edit"]),
      title: z.string().trim().min(1).max(60),
      ...roundArgs,
    })
    .partial()
    .strict(),
  propose_create_bill: billDraftSchema
    .extend({
      title: z.string().trim().max(60),
      promptpay: promptPaySchema,
      payers: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(ITEM_LABEL_MAX_LENGTH),
            names: z
              .array(z.string().trim().min(1).max(MAX_NAME_LENGTH))
              .min(1)
              .max(MAX_NAMES_PER_COMMAND),
          }),
        )
        .max(MAX_OTHER_ITEMS + 2),
      ...roundArgs,
    })
    .partial()
    .strict(),
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
