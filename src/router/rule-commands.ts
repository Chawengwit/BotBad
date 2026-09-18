import type { LineMessage } from "@/lib/line";
import {
  askCourtCount,
  confirmCancelGame,
  confirmCloseGame,
  editMenu,
  helpMenu,
} from "@/line/messages";
import type { LineUserRow } from "@/repositories/types";
import { startCancelGame, startCloseGame, startEditGame } from "@/services/game-admin.service";
import { startCreateGame } from "@/services/game.service";
import { unpaidSharesForGame } from "@/services/bill.service";
import {
  doBillMenu,
  doCancelBill,
  doMarkPayment,
  doShowBill,
  doStartNewBill,
  doUnpaidList,
} from "./bill-actions";
import { doJoin, doJoinFor, doLeave, doLeaveFor, doList } from "./game-actions";
import { WAKE_WORD } from "./wake-word";

/** คำสั่งที่ทำงานได้แล้ว ส่วนที่เหลือรอขั้นตอนถัดไปของ spec §29 */
export const RULE_COMMANDS = [
  "เมนู",
  "ช่วยด้วย",
  "เปิดตี",
  "ลงชื่อ",
  "ถอนชื่อ",
  "ใครตีบ้าง",
  "รายชื่อ",
  "แก้ไข",
  "ยกเลิก",
  "ปิดรอบ",
  "คิดเงิน",
  "บิล",
  "ใครยังไม่จ่าย",
  "จ่ายแล้ว",
  "ยังไม่จ่าย",
  "ยกเลิกบิล",
] as const;

export type RuleCommand = (typeof RULE_COMMANDS)[number];

/**
 * คำสั่งที่รับรายชื่อหรือชื่อบิลต่อท้ายได้ (PRP guests-split-bills-and-digest §8.1)
 *
 * ของเดิมเทียบแบบตรงทั้งข้อความ (spec §18) ซึ่งใช้กับ "ลงชื่อ กิ้ฟ วิท" ไม่ได้
 * คำสั่งในรายการนี้จึงเทียบแบบ "ขึ้นต้นด้วย" แล้วเก็บที่เหลือเป็นส่วนเติม
 * ไม่มีส่วนเติม = พฤติกรรมเดิมทุกประการ
 */
const COMMANDS_WITH_ARGS: readonly RuleCommand[] = [
  "ลงชื่อ",
  "ถอนชื่อ",
  "จ่ายแล้ว",
  "ยังไม่จ่าย",
  "คิดเงิน",
  "บิล",
  "ใครยังไม่จ่าย",
  "ยกเลิกบิล",
];

/**
 * คำสั่งที่ส่วนเติมท้ายเป็นชื่อบิล ชื่อบิลอยู่บรรทัดเดียวเสมอ
 * พิมพ์มาหลายบรรทัดคือกำลังบอกรายการในบิล เช่น "บิล ร้านโชคดี" ตามด้วยค่าข้าวค่าน้ำ
 * ถ้าจับเป็นคำสั่ง "บิล" จะกลายเป็นขอดูบิลชื่อยาวทั้งก้อน แล้วตอบว่าหาบิลไม่เจอ
 */
const BILL_TITLE_COMMANDS: readonly RuleCommand[] = ["คิดเงิน", "บิล", "ใครยังไม่จ่าย", "ยกเลิกบิล"];

export type ParsedCommand = { command: RuleCommand; args: string };

/** เช็กก่อนแตะฐานข้อมูลหรือเรียก LINE API จะได้ไม่เปลืองกับข้อความที่ยังไม่รองรับ */
export function isRuleCommand(command: string): command is RuleCommand {
  return (RULE_COMMANDS as readonly string[]).includes(command);
}

/**
 * แยกข้อความหลัง wake word ออกเป็นคำสั่งกับส่วนเติมท้าย
 * คืน null เมื่อไม่ตรงคำสั่งไหนเลย ให้ผู้เรียกส่งต่อให้ LLM
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (isRuleCommand(trimmed)) return { command: trimmed, args: "" };

  for (const command of COMMANDS_WITH_ARGS) {
    if (!trimmed.startsWith(command)) continue;

    const args = trimmed.slice(command.length).trim();
    // ต้องมีตัวคั่นจริง ๆ ไม่ใช่คำอื่นที่บังเอิญขึ้นต้นเหมือนกัน
    if (args.length > 0 && trimmed[command.length] !== undefined && /^[\s,]/u.test(trimmed[command.length]!)) {
      if (BILL_TITLE_COMMANDS.includes(command) && trimmed.includes("\n")) return null;
      return { command, args };
    }
  }

  return null;
}

/** ตัด wake word ออกและเก็บเฉพาะคำสั่ง */
export function stripWakeWord(text: string): string {
  const index = text.indexOf(WAKE_WORD);
  return index < 0 ? text.trim() : text.slice(index + WAKE_WORD.length).trim();
}

export async function handleRuleCommand(input: {
  command: RuleCommand;
  /** ส่วนเติมท้ายคำสั่ง เช่นรายชื่อคน ว่างแปลว่าทำกับตัวเอง */
  args?: string;
  lineGroupId: string;
  user: LineUserRow;
}): Promise<LineMessage[]> {
  const args = input.args?.trim() ?? "";

  switch (input.command) {
    case "เมนู":
    case "ช่วยด้วย":
      return [helpMenu()];
    case "เปิดตี": {
      const pending = await startCreateGame(input.lineGroupId, input.user.id);
      return [askCourtCount(pending.id)];
    }
    case "ลงชื่อ":
      return args
        ? doJoinFor(input.lineGroupId, input.user, args)
        : doJoin(input.lineGroupId, input.user);
    case "ถอนชื่อ":
      return args
        ? doLeaveFor(input.lineGroupId, input.user, args)
        : doLeave(input.lineGroupId, input.user);
    case "ใครตีบ้าง":
    case "รายชื่อ":
      return doList(input.lineGroupId);
    case "แก้ไข": {
      const { pending } = await startEditGame(input.lineGroupId, input.user.id);
      return [editMenu(pending.id)];
    }
    case "ยกเลิก": {
      const { pending, game, joinedCount } = await startCancelGame(input.lineGroupId, input.user.id);
      return [confirmCancelGame(pending.id, game, joinedCount)];
    }
    case "ปิดรอบ": {
      const { pending, game, joinedCount } = await startCloseGame(input.lineGroupId, input.user.id);
      return [confirmCloseGame(pending.id, game, joinedCount, await unpaidSharesForGame(game.id))];
    }
    case "คิดเงิน":
      // ไม่บอกชื่อบิล = ยังไม่รู้ว่าเงินเรื่องไหน ถามก่อนแทนการเดาว่าเป็นค่ารอบ
      return args
        ? doStartNewBill(input.lineGroupId, input.user, args)
        : doBillMenu(input.lineGroupId, input.user);
    case "บิล":
      return doShowBill(input.lineGroupId, args);
    case "ใครยังไม่จ่าย":
      return doUnpaidList(input.lineGroupId, args);
    case "จ่ายแล้ว":
      return doMarkPayment(input.lineGroupId, input.user, true, args);
    case "ยังไม่จ่าย":
      return doMarkPayment(input.lineGroupId, input.user, false, args);
    case "ยกเลิกบิล":
      return doCancelBill(input.lineGroupId, input.user, args);
  }
}
