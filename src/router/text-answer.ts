import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { askAgain, askLocation, askOtherItem, askPromptPay } from "@/line/messages";
import {
  findAwaitingPendingAction,
  type PendingActionRow,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import { findLatestPromptPay } from "@/repositories/game.repository";
import { parseAmount, parseOtherItem } from "@/services/bill.service";
import { courtNameSchema, locationUrlSchema, promptPaySchema } from "@/services/game.service";
import { advanceBillWizard, advanceCreateWizard, advanceEditWizard } from "./wizard";

const URL_IN_TEXT = /https?:\/\/[^\s]+/;

export type SharedLocation = { latitude: number; longitude: number };

/** ลิงก์แผนที่จากพิกัดที่แชร์มาใน LINE */
export function mapsUrlFromCoordinates({ latitude, longitude }: SharedLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

/** ผู้ใช้มักพิมพ์ข้อความปนลิงก์มา เลยดึงเฉพาะ URL ตัวแรกออกมา */
export function extractUrl(text: string): string | null {
  const found = text.match(URL_IN_TEXT)?.[0];
  if (!found) return null;

  const parsed = locationUrlSchema.safeParse(found);
  return parsed.success ? parsed.data : null;
}

async function applyCourtName(
  pending: PendingActionRow,
  text: string,
): Promise<LineMessage[]> {
  const parsed = courtNameSchema.safeParse(text.replace(/\s+/g, " "));
  if (!parsed.success) {
    return [askAgain("🏟️ ชื่อคอร์ทต้องยาว 1-60 ตัวอักษร ลองพิมพ์ใหม่อีกทีนะ")];
  }

  if (pending.action_type === "edit_game") {
    return advanceEditWizard(pending.id, pending.line_group_id, "court_name", parsed.data);
  }

  return advanceCreateWizard(pending, { court_name: parsed.data });
}

async function applyLocation(
  pending: PendingActionRow,
  url: string | null,
): Promise<LineMessage[]> {
  if (!url) {
    return [
      askAgain("📍 ยังไม่เจอลิงก์แผนที่ ลองวางลิงก์ Google Maps หรือกดแชร์ตำแหน่งมาก็ได้"),
      askLocation(pending.id),
    ];
  }

  if (pending.action_type === "edit_game") {
    return advanceEditWizard(pending.id, pending.line_group_id, "location_url", url);
  }

  return advanceCreateWizard(pending, { location_url: url });
}

async function applyPromptPay(pending: PendingActionRow, text: string): Promise<LineMessage[]> {
  const parsed = promptPaySchema.safeParse(text);
  if (!parsed.success) {
    return [
      askAgain("💸 เลขพร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก"),
      askPromptPay(pending.id, await findLatestPromptPay(pending.line_group_id)),
    ];
  }

  if (pending.action_type === "edit_game") {
    return advanceEditWizard(pending.id, pending.line_group_id, "promptpay", parsed.data);
  }

  return advanceCreateWizard(pending, { promptpay: parsed.data });
}

const BILL_AMOUNT_FIELDS: Record<string, string> = {
  bill_court_fee: "court_fee",
  bill_shuttle_price: "shuttle_price",
};

async function applyBillAmount(
  pending: PendingActionRow,
  awaiting: string,
  text: string,
): Promise<LineMessage[]> {
  const amount = parseAmount(text);
  if (amount === null) {
    return [askAgain("💵 พิมพ์เป็นตัวเลขจำนวนเงินนะ เช่น 600 (ไม่เกิน 100,000 บาท)")];
  }

  if (awaiting === "bill_water") {
    const items = [...((pending.payload.other_items as unknown[]) ?? [])];
    return advanceBillWizard(pending, {
      other_items: [...items, { label: "ค่าน้ำ", amount }] as PendingPayload["other_items"],
    });
  }

  return advanceBillWizard(pending, { [BILL_AMOUNT_FIELDS[awaiting] ?? ""]: amount });
}

async function applyBillOtherItem(
  pending: PendingActionRow,
  text: string,
): Promise<LineMessage[]> {
  const parsed = parseOtherItem(text);
  if (!parsed) return [askAgain('➕ พิมพ์ชื่อกับจำนวนเงินในบรรทัดเดียวนะ เช่น "ค่าเช่าไม้ 100"'), askOtherItem()];

  const items = [...((pending.payload.other_items as unknown[]) ?? [])];
  return advanceBillWizard(pending, {
    other_items: [...items, parsed] as PendingPayload["other_items"],
  });
}

/**
 * ข้อความที่ไม่มี wake word จะถูกอ่านก็ต่อเมื่อบอทกำลังรอคำตอบจากคนคนนั้นอยู่จริง (spec §6)
 * คืน null แปลว่าไม่เกี่ยวกับบอท ให้เงียบไว้
 */
export async function handleTextAnswer(input: {
  lineGroupId: string;
  lineUserId: string;
  text?: string;
  location?: SharedLocation;
}): Promise<LineMessage[] | null> {
  const pending = await findAwaitingPendingAction(input.lineGroupId, input.lineUserId);
  if (!pending) return null;

  const awaiting = pending.payload.awaiting;

  if (awaiting === "court_name") {
    if (input.text === undefined) return null;
    return applyCourtName(pending, input.text);
  }

  if (awaiting === "promptpay") {
    if (input.text === undefined) return null;
    return applyPromptPay(pending, input.text);
  }

  if (awaiting === "bill_court_fee" || awaiting === "bill_shuttle_price" || awaiting === "bill_water") {
    if (input.text === undefined) return null;
    return applyBillAmount(pending, awaiting, input.text);
  }

  if (awaiting === "bill_other") {
    if (input.text === undefined) return null;
    return applyBillOtherItem(pending, input.text);
  }

  if (awaiting === "location") {
    const url = input.location
      ? mapsUrlFromCoordinates(input.location)
      : extractUrl(input.text ?? "");
    return applyLocation(pending, url);
  }

  // ไม่ควรเกิด แต่ถ้า payload เพี้ยนก็อย่าเงียบหาย
  throw new AppError("INTERNAL_ERROR");
}
