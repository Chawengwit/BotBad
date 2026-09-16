import type { ErrorCode } from "@/errors/app-errors";
import type { ButtonsMessage, LineMessage, TextMessage } from "@/lib/line";
import { formatThaiDate, formatTimeRange, todayInBangkok } from "@/lib/time";
import type { GameDraft } from "@/services/game.service";
import type { GameRow } from "@/repositories/types";

export const WIZARD_TIME_CHOICES = ["18:00", "19:00", "20:00"] as const;
export const WIZARD_DURATION_CHOICES = [60, 120, 180] as const;

export function text(message: string): TextMessage {
  return { type: "text", text: message };
}

function wizardData(pendingId: string, step: string, value: string): string {
  return new URLSearchParams({ action: "wizard", pending_id: pendingId, step, value }).toString();
}

function buttons(altText: string, body: string, actions: ButtonsMessage["template"]["actions"]): ButtonsMessage {
  return { type: "template", altText, template: { type: "buttons", text: body, actions } };
}

export function askCourtCount(pendingId: string): ButtonsMessage {
  return buttons(
    "กี่คอร์ท?",
    "🏸 เปิดรอบตีแบด\n\nกี่คอร์ท?",
    [1, 2, 3, 4].map((count) => ({
      type: "postback" as const,
      label: `${count} คอร์ท`,
      displayText: `${count} คอร์ท`,
      data: wizardData(pendingId, "court", String(count)),
    })),
  );
}

export function askDate(pendingId: string, today: string = todayInBangkok()): ButtonsMessage {
  return buttons("วันไหน?", "📅 วันไหน?", [
    {
      type: "postback",
      label: "วันนี้",
      displayText: "วันนี้",
      data: wizardData(pendingId, "date", "today"),
    },
    {
      type: "postback",
      label: "พรุ่งนี้",
      displayText: "พรุ่งนี้",
      data: wizardData(pendingId, "date", "tomorrow"),
    },
    {
      type: "datetimepicker",
      label: "เลือกวัน",
      mode: "date",
      initial: today,
      min: today,
      data: new URLSearchParams({
        action: "wizard",
        pending_id: pendingId,
        step: "date",
        value: "picker",
      }).toString(),
    },
  ]);
}

export function askTime(pendingId: string): ButtonsMessage {
  return buttons("กี่โมง?", "⏰ กี่โมง?", [
    ...WIZARD_TIME_CHOICES.map((time) => ({
      type: "postback" as const,
      label: time,
      displayText: time,
      data: wizardData(pendingId, "time", time),
    })),
    {
      type: "datetimepicker",
      label: "กำหนดเวลาเอง",
      mode: "time",
      initial: "19:00",
      data: new URLSearchParams({
        action: "wizard",
        pending_id: pendingId,
        step: "time",
        value: "picker",
      }).toString(),
    },
  ]);
}

export function askDuration(pendingId: string): ButtonsMessage {
  return buttons(
    "เล่นกี่ชั่วโมง?",
    "⏱️ เล่นกี่ชั่วโมง?",
    WIZARD_DURATION_CHOICES.map((minutes) => ({
      type: "postback" as const,
      label: `${minutes / 60} ชั่วโมง`,
      displayText: `${minutes / 60} ชั่วโมง`,
      data: wizardData(pendingId, "duration", String(minutes)),
    })),
  );
}

export function confirmCreateGame(pendingId: string, draft: GameDraft): ButtonsMessage {
  const summary = [
    "🏸 เปิดตีแบด",
    `📅 ${formatThaiDate(draft.play_date)}`,
    `⏰ ${formatTimeRange(draft.start_time, draft.duration_minutes)}`,
    `🏟️ ${draft.court_count} คอร์ท · 👥 รับ ${draft.court_count * 8} คน`,
    "",
    "ยืนยันไหม?",
  ].join("\n");

  return buttons("ยืนยันเปิดรอบตี?", summary, [
    {
      type: "postback",
      label: "✅ เปิดตี",
      displayText: "✅ เปิดตี",
      data: new URLSearchParams({ action: "confirm", pending_id: pendingId }).toString(),
    },
    {
      type: "postback",
      label: "❌ ยกเลิก",
      displayText: "❌ ยกเลิก",
      data: new URLSearchParams({ action: "reject", pending_id: pendingId }).toString(),
    },
  ]);
}

export function gameCreated(game: GameRow): TextMessage {
  return text(
    [
      "🏸 BADMINTON",
      "",
      `📅 ${formatThaiDate(game.play_date)}`,
      `⏰ ${formatTimeRange(game.start_time, game.duration_minutes)}`,
      `🏟️ ${game.court_count} คอร์ท`,
      `👥 0/${game.max_players} คน`,
      "",
      "ยังไม่มีคนลงชื่อ",
    ].join("\n"),
  );
}

export function gameSummary(game: GameRow): string {
  return [
    `📅 ${formatThaiDate(game.play_date)}`,
    `⏰ ${formatTimeRange(game.start_time, game.duration_minutes)}`,
    `🏟️ ${game.court_count} คอร์ท`,
  ].join("\n");
}

/** ข้อความสำหรับแต่ละ error code ตาม spec §26 */
export function errorMessage(code: ErrorCode, details: Record<string, unknown> = {}): TextMessage {
  switch (code) {
    case "GAME_ALREADY_OPEN": {
      const game = details.game as GameRow | undefined;
      return text(
        [
          "⛔ กลุ่มนี้มีรอบที่เปิดอยู่แล้ว",
          ...(game ? ["", gameSummary(game)] : []),
          "",
          "ต้องปิดรอบหรือยกเลิกรอบเดิมก่อน",
        ].join("\n"),
      );
    }
    case "NO_OPEN_GAME":
      return text("❌ ตอนนี้ไม่มีรอบตีที่เปิดอยู่");
    case "DATE_IN_PAST":
      return text("❌ วันเวลานี้ผ่านไปแล้ว ลองเลือกใหม่นะ");
    case "PENDING_EXPIRED":
      return text("⛔ ปุ่มนี้หมดอายุหรือถูกใช้ไปแล้ว\n\nพิมพ์ “บอทจ๋า เปิดตี” เพื่อเริ่มใหม่");
    case "NOT_REQUESTER":
      return text("⛔ เฉพาะคนที่สั่งเท่านั้นที่กดปุ่มนี้ได้");
    case "NOT_GAME_CREATOR":
      return text("⛔ คุณไม่มีสิทธิ์แก้ไขรอบตีนี้");
    case "MISSING_FIELDS":
      return text("ℹ️ ข้อมูลยังไม่ครบ ลองเริ่มใหม่ด้วย “บอทจ๋า เปิดตี”");
    default:
      return text("😵 ระบบขัดข้อง ลองใหม่อีกครั้งนะ");
  }
}

export function wizardPrompt(
  pendingId: string,
  payload: Record<string, unknown>,
  missing: readonly string[],
): LineMessage {
  switch (missing[0]) {
    case "court_count":
      return askCourtCount(pendingId);
    case "play_date":
      return askDate(pendingId);
    case "start_time":
      return askTime(pendingId);
    case "duration_minutes":
      return askDuration(pendingId);
    default:
      return confirmCreateGame(pendingId, payload as unknown as GameDraft);
  }
}
