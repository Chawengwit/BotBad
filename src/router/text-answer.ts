import { AppError, isAppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  actionRejected,
  askAgain,
  askLocation,
  askNewBillCommand,
  askOtherItem,
  askPromptPay,
  errorMessage,
} from "@/line/messages";
import {
  expirePendingAction,
  findAwaitingPendingAction,
  type PendingActionRow,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import { findLastPromptPayOf } from "@/repositories/bill.repository";
import { findLatestPromptPay } from "@/repositories/game.repository";
import { parseAmount, parseItemLine } from "@/services/bill.service";
import { resolveOrCreateGuests } from "@/services/people.service";
import { findUserById } from "@/repositories/user.repository";
import { courtNameSchema, locationUrlSchema, promptPaySchema } from "@/services/game.service";
import { doAddBillItems } from "./bill-actions";
import { isSmallTalk, isStopWord } from "./listening";
import { advanceBillWizard, advanceCreateWizard, advanceEditWizard } from "./wizard";

/** แปลงชื่อบิลกับรายการที่พิมพ์มาอิสระให้เป็นบิล ทำด้วย Gemini จึงต้องให้คนเรียกส่งมาให้ */
export type BillInterpreter = (pending: PendingActionRow, text: string) => Promise<LineMessage[]>;

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
    return advanceEditWizard(pending, "court_name", parsed.data);
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
    return advanceEditWizard(pending, "location_url", url);
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
    return advanceEditWizard(pending, "promptpay", parsed.data);
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
  // ค่าน้ำพิมพ์ชื่อคนต่อท้ายได้เหมือนรายการอื่น ๆ เช่น "60 เชวง แบงค์"
  if (awaiting === "bill_water") {
    return addItemWithPayers(pending, `ค่าน้ำ ${text.trim()}`, () => [
      askAgain('💧 พิมพ์จำนวนเงิน และใส่ชื่อคนต่อท้ายได้ถ้าเก็บบางคน เช่น "60 เชวง แบงค์"'),
    ]);
  }

  const amount = parseAmount(text);
  if (amount === null) {
    return [askAgain("💵 พิมพ์เป็นตัวเลขจำนวนเงินนะ เช่น 600 (ไม่เกิน 100,000 บาท)")];
  }

  return advanceBillWizard(pending, { [BILL_AMOUNT_FIELDS[awaiting] ?? ""]: amount });
}

function applyBillOtherItem(pending: PendingActionRow, text: string): Promise<LineMessage[]> {
  return addItemWithPayers(pending, text, () => [
    askAgain('➕ พิมพ์ชื่อรายการกับจำนวนเงินในบรรทัดเดียว ใส่ชื่อคนต่อท้ายได้ถ้าเก็บบางคน'),
    askOtherItem(),
  ]);
}

/**
 * เพิ่มรายการเข้าบิล พร้อมรายชื่อคนร่วมจ่ายถ้าระบุมา (PRP guests-split-bills-and-digest §5.3)
 * ชื่อที่ยังไม่รู้จักถือว่าเป็นแขก สร้างให้เลย เพราะคนพิมพ์กำลังบอกว่าใครกินใครใช้
 */
async function addItemWithPayers(
  pending: PendingActionRow,
  text: string,
  onInvalid: () => LineMessage[],
): Promise<LineMessage[]> {
  const parsed = parseItemLine(text);
  if (!parsed) return onInvalid();

  const items = [...((pending.payload.other_items as unknown[]) ?? [])];
  const patch: PendingPayload = {
    other_items: [
      ...items,
      { label: parsed.label, amount: parsed.amount },
    ] as PendingPayload["other_items"],
  };

  if (parsed.payerNames.length > 0) {
    const actor = await findUserById(pending.requested_by);
    const people = await resolveOrCreateGuests(
      pending.line_group_id,
      parsed.payerNames,
      actor ?? { id: pending.requested_by, line_user_id: null, line_group_id: null, display_name: "" },
    );

    const payers = (pending.payload.item_payers ?? {}) as Record<string, string[]>;
    const names = (pending.payload.payer_names ?? {}) as Record<string, string>;

    patch.item_payers = {
      ...payers,
      [parsed.label]: people.map((person) => person.id),
    } as PendingPayload["item_payers"];
    patch.payer_names = {
      ...names,
      ...Object.fromEntries(people.map((person) => [person.id, person.display_name])),
    } as PendingPayload["payer_names"];
  }

  return advanceBillWizard(pending, patch);
}

/** บิลลอย ๆ ใช้เลขของคนสร้างบิลเอง พิมพ์มาเองก็ได้ (PRP §5.2.1) */
async function applyBillPromptPay(pending: PendingActionRow, text: string): Promise<LineMessage[]> {
  const parsed = promptPaySchema.safeParse(text);
  if (!parsed.success) {
    return [
      askAgain("💸 เลขพร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก"),
      askPromptPay(pending.id, await findLastPromptPayOf(pending.requested_by)),
    ];
  }

  return advanceBillWizard(pending, { promptpay: parsed.data, promptpay_asked: true });
}

/**
 * ชื่อบิลกับรายการที่พิมพ์มาอิสระหลังกด "สร้างบิลใหม่" ส่งให้ Gemini แปลงเป็นบิล
 * บอกว่าไม่เอาแล้วก็เลิกรอ ส่วนคำรับคำสั้น ๆ ไม่ใช่รายการ ปล่อยผ่านโดยไม่เสียโควตา LLM
 */
async function answerNewBill(
  pending: PendingActionRow,
  text: string,
  interpret: BillInterpreter | undefined,
): Promise<LineMessage[] | null> {
  if (isStopWord(text)) {
    await expirePendingAction(pending.id, pending.line_group_id);
    return [actionRejected("create_bill")];
  }
  if (isSmallTalk(text)) return null;

  // ถอดคีย์ Gemini ออกระหว่างรอคำตอบ ตีความประโยคอิสระไม่ได้แล้ว ให้ไปทางคำสั่งแบบเดิม
  if (!interpret) {
    await expirePendingAction(pending.id, pending.line_group_id);
    return [askNewBillCommand()];
  }

  return interpret(pending, text);
}

/**
 * ขั้นที่ตอบแล้วทำไม่ได้ ต้องบอกเหตุผล ไม่ใช่เงียบแบบข้อความทั่วไปในกลุ่ม
 * คนพิมพ์กำลังตอบคำถามของบอทอยู่ ถ้าเงียบจะไม่รู้ว่าต้องทำอะไรต่อ เช่น ชื่อคนซ้ำกันหลายคน
 */
async function explainErrors(run: () => Promise<LineMessage[]>): Promise<LineMessage[]> {
  try {
    return await run();
  } catch (error) {
    if (isAppError(error)) return [errorMessage(error.code, error.details)];
    throw error;
  }
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
  /** ไม่มี = ตั้งค่า Gemini ไว้ไม่ครบ บิลที่พิมพ์มาอิสระตีความไม่ได้ */
  interpretBill?: BillInterpreter;
}): Promise<LineMessage[] | null> {
  const pending = await findAwaitingPendingAction(input.lineGroupId, input.lineUserId);
  if (!pending) return null;

  const awaiting = pending.payload.awaiting;

  if (awaiting === "bill_freeform") {
    if (input.text === undefined) return null;
    return answerNewBill(pending, input.text, input.interpretBill);
  }

  if (awaiting === "bill_promptpay") {
    const text = input.text;
    if (text === undefined) return null;
    return explainErrors(() => applyBillPromptPay(pending, text));
  }

  if (awaiting === "bill_edit_add") {
    const text = input.text;
    if (text === undefined) return null;

    // บอกว่าไม่แก้แล้ว เลิกทั้งการแก้บิลครั้งนี้ บิลเดิมไม่เปลี่ยน
    if (isStopWord(text)) {
      await expirePendingAction(pending.id, pending.line_group_id);
      return [actionRejected("edit_bill")];
    }
    return explainErrors(() => doAddBillItems(pending, text));
  }

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
