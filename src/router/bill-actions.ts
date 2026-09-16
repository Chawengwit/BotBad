import type { LineMessage } from "@/lib/line";
import {
  billCard,
  confirmCancelBill,
  paymentRecorded,
  paymentUndone,
  unpaidList,
} from "@/line/messages";
import type { UserRow } from "@/repositories/types";
import { getBill, markMyPayment, startCancelBill, startCreateBill } from "@/services/bill.service";
import { advanceBillWizard } from "./wizard";

/** งานที่ทำกับบิลของกลุ่ม ปุ่มบนการ์ดบิลไม่ต้องอ้าง id เหมือนปุ่มบนการ์ดรอบตี */

export async function doStartBill(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { pending } = await startCreateBill(lineGroupId, user.id);
  return advanceBillWizard(pending, {});
}

export async function doShowBill(lineGroupId: string): Promise<LineMessage[]> {
  const { game, bill, shares } = await getBill(lineGroupId);
  return [billCard(game, bill, shares)];
}

export async function doUnpaidList(lineGroupId: string): Promise<LineMessage[]> {
  const { game, bill, shares } = await getBill(lineGroupId);
  return [unpaidList(game, bill, shares)];
}

export async function doMarkPayment(
  lineGroupId: string,
  user: UserRow,
  paid: boolean,
): Promise<LineMessage[]> {
  const { shares, amountSatang } = await markMyPayment(lineGroupId, user.id, paid);

  return [
    paid
      ? paymentRecorded(user.display_name, amountSatang, shares)
      : paymentUndone(user.display_name, shares),
  ];
}

export async function doCancelBill(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { pending, view } = await startCancelBill(lineGroupId, user.id);
  return [confirmCancelBill(pending.id, view.game, view.shares)];
}
