import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  billCard,
  confirmCancelBill,
  paymentRecorded,
  paymentUndone,
  unpaidList,
} from "@/line/messages";
import { findActiveBillByTitle } from "@/repositories/bill.repository";
import type { LineUserRow } from "@/repositories/types";
import { getBill, markPayment, startCancelBill, startCreateBill } from "@/services/bill.service";
import { parseNames, resolvePeople } from "@/services/people.service";
import { advanceBillWizard } from "./wizard";

/** งานที่ทำกับบิลของกลุ่ม กลุ่มมีบิลเปิดพร้อมกันได้หลายใบ จึงระบุชื่อบิลต่อท้ายได้ */

export async function doStartBill(
  lineGroupId: string,
  user: LineUserRow,
  title = "",
): Promise<LineMessage[]> {
  const { pending } = await startCreateBill(lineGroupId, user.id, title);
  return advanceBillWizard(pending, {});
}

export async function doShowBill(lineGroupId: string, title = ""): Promise<LineMessage[]> {
  const { bill, items, shares } = await getBill(lineGroupId, title);
  return [billCard(bill, items, shares)];
}

export async function doUnpaidList(lineGroupId: string, title = ""): Promise<LineMessage[]> {
  const { bill, shares } = await getBill(lineGroupId, title);
  return [unpaidList(bill, shares)];
}

/**
 * บันทึกการจ่าย ของตัวเองหรือของคนอื่น (PRP guests-split-bills-and-digest §5.6)
 *
 * ส่วนเติมท้ายเป็นได้สองอย่าง: ชื่อบิล หรือรายชื่อคน
 * ลองเทียบกับชื่อบิลที่เปิดอยู่ก่อน ไม่ตรงถึงถือว่าเป็นชื่อคน
 * เทียบแบบตรงทั้งสตริงจึงไม่กำกวม เพราะชื่อบิลเป็นข้อความที่ผู้ใช้ตั้งเอง
 */
export async function doMarkPayment(
  lineGroupId: string,
  user: LineUserRow,
  paid: boolean,
  args = "",
): Promise<LineMessage[]> {
  const trimmed = args.trim();
  const asBill = trimmed ? await tryResolveTitle(lineGroupId, trimmed) : null;

  const names = asBill ? [] : parseNames(trimmed);
  const people =
    names.length > 0
      ? await resolvePeopleOrThrow(lineGroupId, names, user)
      : [user];

  const result = await markPayment(lineGroupId, user, people, paid, asBill ?? "");

  return [
    paid
      ? paymentRecorded(user.display_name, result)
      : paymentUndone(user.display_name, result),
  ];
}

async function tryResolveTitle(lineGroupId: string, title: string): Promise<string | null> {
  const bill = await findActiveBillByTitle(lineGroupId, title);
  return bill ? bill.title : null;
}

async function resolvePeopleOrThrow(
  lineGroupId: string,
  names: string[],
  user: LineUserRow,
) {
  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });
  if (people.length === 0) throw new AppError("PERSON_NOT_FOUND", { names: unknown });
  return people;
}

export async function doCancelBill(
  lineGroupId: string,
  user: LineUserRow,
  title = "",
): Promise<LineMessage[]> {
  const { pending, view } = await startCancelBill(lineGroupId, user.id, title);
  return [confirmCancelBill(pending.id, view.bill, view.shares)];
}
