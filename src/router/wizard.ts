import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  askCourtCount,
  askCourtName,
  askDate,
  askDuration,
  askLocation,
  askMaxPlayers,
  askTime,
  confirmCreateGame,
  confirmEditGame,
} from "@/line/messages";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import {
  updatePendingPayload,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import { editPatchSchema, validatePatch } from "@/services/game-admin.service";
import { gameDraftSchema, missingDraftFields, type DraftField } from "@/services/game.service";

/** คำถามของแต่ละช่อง ใช้ทั้งตอนเปิดรอบและตอนแก้ไข */
export function questionFor(
  field: DraftField | "location_url",
  pendingId: string,
  courtCount: number,
): LineMessage {
  switch (field) {
    case "court_count":
      return askCourtCount(pendingId);
    case "max_players":
      return askMaxPlayers(pendingId, courtCount);
    case "play_date":
      return askDate(pendingId);
    case "start_time":
      return askTime(pendingId);
    case "duration_minutes":
      return askDuration(pendingId);
    case "court_name":
      return askCourtName();
    case "location_url":
      return askLocation(pendingId);
  }
}

/**
 * เดินหน้า wizard เปิดรอบไปอีกขั้น
 * ช่องที่ต้องพิมพ์ตอบจะบันทึก awaiting ไว้ใน payload เพื่อให้รู้ว่าข้อความถัดไปคือคำตอบของอะไร
 */
export async function advanceCreateWizard(
  pendingId: string,
  payload: PendingPayload,
): Promise<LineMessage[]> {
  const courtCount = Number(payload.court_count ?? 1);
  const next = missingDraftFields(payload)[0];

  if (next) {
    const awaiting = next === "court_name" ? "court_name" : null;
    const saved = await updatePendingPayload(pendingId, { ...payload, awaiting });
    if (!saved) throw new AppError("PENDING_EXPIRED");
    return [questionFor(next, pendingId, courtCount)];
  }

  // ข้อมูลครบแล้ว ถามเรื่องแผนที่อีกหนึ่งครั้ง (ข้ามได้)
  if (payload.location_url === undefined && payload.location_asked !== true) {
    const saved = await updatePendingPayload(pendingId, {
      ...payload,
      awaiting: "location",
      location_asked: true,
    });
    if (!saved) throw new AppError("PENDING_EXPIRED");
    return [questionFor("location_url", pendingId, courtCount)];
  }

  const saved = await updatePendingPayload(pendingId, { ...payload, awaiting: null });
  if (!saved) throw new AppError("PENDING_EXPIRED");
  return [confirmCreateGame(pendingId, gameDraftSchema.parse(payload))];
}

/** แก้ไขทีละช่อง เลือกค่าเสร็จก็ไปการ์ดยืนยันเลย */
export async function advanceEditWizard(
  pendingId: string,
  lineGroupId: string,
  field: string,
  value: number | string,
): Promise<LineMessage[]> {
  const patch = editPatchSchema.parse({ [field]: value });

  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");

  // ตรวจตั้งแต่ตอนนี้ จะได้ไม่ให้กดยืนยันไปแล้วค่อยบอกว่าไม่ได้
  validatePatch(game, patch, await countJoinedPlayers(game.id));

  const saved = await updatePendingPayload(pendingId, { [field]: value, awaiting: null });
  if (!saved) throw new AppError("PENDING_EXPIRED");

  return [confirmEditGame(pendingId, game, patch)];
}
