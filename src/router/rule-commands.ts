import type { LineMessage } from "@/lib/line";
import { askCourtCount, confirmCancelGame, confirmCloseGame, editMenu } from "@/line/messages";
import type { UserRow } from "@/repositories/types";
import { startCancelGame, startCloseGame, startEditGame } from "@/services/game-admin.service";
import { startCreateGame } from "@/services/game.service";
import { doJoin, doLeave, doList } from "./game-actions";
import { WAKE_WORD } from "./wake-word";

/** คำสั่งที่ทำงานได้แล้ว ส่วนที่เหลือรอขั้นตอนถัดไปของ spec §29 */
export const RULE_COMMANDS = [
  "เปิดตี",
  "ลงชื่อ",
  "ถอนชื่อ",
  "ใครตีบ้าง",
  "รายชื่อ",
  "แก้ไข",
  "ยกเลิก",
  "ปิดรอบ",
] as const;

export type RuleCommand = (typeof RULE_COMMANDS)[number];

/** เช็กก่อนแตะฐานข้อมูลหรือเรียก LINE API จะได้ไม่เปลืองกับข้อความที่ยังไม่รองรับ */
export function isRuleCommand(command: string): command is RuleCommand {
  return (RULE_COMMANDS as readonly string[]).includes(command);
}

/** ตัด wake word ออกและเก็บเฉพาะคำสั่ง */
export function stripWakeWord(text: string): string {
  const index = text.indexOf(WAKE_WORD);
  return index < 0 ? text.trim() : text.slice(index + WAKE_WORD.length).trim();
}

export async function handleRuleCommand(input: {
  command: RuleCommand;
  lineGroupId: string;
  user: UserRow;
}): Promise<LineMessage[]> {
  switch (input.command) {
    case "เปิดตี": {
      const pending = await startCreateGame(input.lineGroupId, input.user.id);
      return [askCourtCount(pending.id)];
    }
    case "ลงชื่อ":
      return doJoin(input.lineGroupId, input.user);
    case "ถอนชื่อ":
      return doLeave(input.lineGroupId, input.user);
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
      return [confirmCloseGame(pending.id, game, joinedCount)];
    }
  }
}
