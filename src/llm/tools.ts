import { Type, type FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import {
  courtNameSchema,
  locationUrlSchema,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from "@/services/game.service";
import { DATE_PATTERN, TIME_PATTERN } from "@/lib/time";

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
      "ลงชื่อ 'ผู้ใช้ที่พิมพ์ข้อความนี้' เข้ารอบที่เปิดอยู่ ใช้เมื่อผู้ใช้บอกว่าจะไปตี ไปด้วย หรือขอลงชื่อ ห้ามใช้ลงชื่อแทนคนอื่น",
  },
  {
    name: "leave_game",
    description:
      "ถอนชื่อ 'ผู้ใช้ที่พิมพ์ข้อความนี้' ออกจากรอบที่เปิดอยู่ ใช้เมื่อผู้ใช้บอกว่าไปไม่ได้หรือขอถอนชื่อ ห้ามใช้ถอนชื่อแทนคนอื่น",
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

const gameArgs = z
  .object({
    court_count: z.number().int().min(1).max(4),
    max_players: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    play_date: z.string().regex(DATE_PATTERN),
    start_time: z.string().regex(TIME_PATTERN),
    duration_minutes: z.number().int().positive().multipleOf(60),
    court_name: courtNameSchema,
    location_url: locationUrlSchema,
  })
  .partial()
  .strict();

/** ตรวจ arguments ที่ LLM ส่งมาทุกครั้ง (LLM Design §6) */
export const toolSchemas = {
  get_open_game: noArgs,
  list_players: noArgs,
  join_game: noArgs,
  leave_game: noArgs,
  propose_create_game: gameArgs,
  propose_edit_game: gameArgs,
  propose_cancel_game: noArgs,
  propose_close_game: noArgs,
} as const;

export type ToolName = keyof typeof toolSchemas;

export function isToolName(name: string): name is ToolName {
  return name in toolSchemas;
}
