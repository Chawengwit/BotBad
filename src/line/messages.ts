import type { ErrorCode } from "@/errors/app-errors";
import type { ButtonsMessage, MessageAction, TextMessage } from "@/lib/line";
import { formatDuration, formatThaiDate, formatTimeRange, todayInBangkok } from "@/lib/time";
import type { PendingActionType } from "@/repositories/pending-action.repository";
import { WAKE_WORD } from "@/router/wake-word";
import { MAX_PLAYERS, MIN_PLAYERS, type GameDraft } from "@/services/game.service";
import type { EditPatch } from "@/services/game-admin.service";
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

function quickReplyText(body: string, items: { label: string; data: string }[]): TextMessage {
  return {
    type: "text",
    text: body,
    quickReply: {
      items: items.map((item) => ({
        type: "action",
        action: {
          type: "postback",
          label: item.label,
          displayText: item.label,
          data: item.data,
        },
      })),
    },
  };
}

/** ค่าปกติคือ คอร์ท x 8 แล้วให้เลือกบวกลบได้ทีละ 2 (spec §7) */
export function playerCountChoices(courtCount: number): number[] {
  const base = courtCount * 8;
  return [base - 4, base - 2, base, base + 2, base + 4].filter(
    (value) => value >= MIN_PLAYERS && value <= MAX_PLAYERS,
  );
}

export function askMaxPlayers(pendingId: string, courtCount: number): TextMessage {
  const base = courtCount * 8;

  return quickReplyText(
    `👥 รับกี่คน?\n\nค่าปกติของ ${courtCount} คอร์ทคือ ${base} คน`,
    playerCountChoices(courtCount).map((count) => ({
      label: count === base ? `${count} คน (ปกติ)` : `${count} คน`,
      data: wizardData(pendingId, "max", String(count)),
    })),
  );
}

export function askCourtName(): TextMessage {
  return text("🏟️ ไปตีที่คอร์ทไหน?\n\nพิมพ์ชื่อคอร์ทตอบได้เลย ไม่ต้องขึ้นต้นด้วย “บอทจ๋า”");
}

export function askLocation(pendingId: string): TextMessage {
  return quickReplyText(
    "📍 มีลิงก์แผนที่ไหม?\n\nวางลิงก์ Google Maps หรือกดแชร์ตำแหน่งมาก็ได้ ถ้าไม่มีก็กดข้ามได้เลย",
    [{ label: "ข้าม", data: wizardData(pendingId, "location", "skip") }],
  );
}

/** ใช้เมื่อ Gemini ล่ม โควตาหมด หรือยังไม่ได้ตั้งค่า (LLM Design §9) */
export function fallbackMenu(): TextMessage {
  return {
    type: "text",
    text: "🤔 ตอนนี้ผมยังไม่เข้าใจประโยคนี้\n\nลองเลือกคำสั่งด้านล่างได้เลย",
    quickReply: {
      items: ["เปิดตี", "ลงชื่อ", "ถอนชื่อ", "ใครตีบ้าง"].map((command) => ({
        type: "action" as const,
        action: {
          type: "message" as const,
          label: command,
          text: `${WAKE_WORD} ${command}`,
        },
      })),
    },
  };
}

export function askAgain(message: string): TextMessage {
  return text(message);
}

function confirmActions(
  pendingId: string,
  confirmLabel: string,
  rejectLabel = "❌ ยกเลิก",
): MessageAction[] {
  return [
    {
      type: "postback",
      label: confirmLabel,
      displayText: confirmLabel,
      data: new URLSearchParams({ action: "confirm", pending_id: pendingId }).toString(),
    },
    {
      type: "postback",
      label: rejectLabel,
      displayText: rejectLabel,
      data: new URLSearchParams({ action: "reject", pending_id: pendingId }).toString(),
    },
  ];
}

export function confirmCreateGame(pendingId: string, draft: GameDraft): ButtonsMessage {
  const summary = [
    `🏸 ${draft.court_name}`,
    `📅 ${formatThaiDate(draft.play_date)}`,
    `⏰ ${formatTimeRange(draft.start_time, draft.duration_minutes)}`,
    `🏟️ ${draft.court_count} คอร์ท · 👥 รับ ${draft.max_players} คน`,
    ...(draft.location_url ? ["📍 มีลิงก์แผนที่"] : []),
    "",
    "ยืนยันไหม?",
  ].join("\n");

  return buttons("ยืนยันเปิดรอบตี?", summary, confirmActions(pendingId, "✅ เปิดตี"));
}

const GAME_ACTIONS: MessageAction[] = [
  { type: "postback", label: "🙋 ลงชื่อ", displayText: "ลงชื่อ", data: "action=join" },
  { type: "postback", label: "❌ ถอนชื่อ", displayText: "ถอนชื่อ", data: "action=leave" },
  { type: "postback", label: "👀 รายชื่อ", displayText: "ใครตีบ้าง", data: "action=list" },
];

/**
 * การ์ดรอบตีพร้อมปุ่ม
 * LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ ทุกครั้งที่มีความเคลื่อนไหวจึงส่งการ์ดใบใหม่
 */
export function gameCard(game: GameRow, joinedCount: number, headline?: string): ButtonsMessage {
  const body = [
    headline ?? `🏸 ${game.court_name ?? "BADMINTON"}`,
    `📅 ${formatThaiDate(game.play_date)}`,
    `⏰ ${formatTimeRange(game.start_time, game.duration_minutes)}`,
    `🏟️ ${game.court_count} คอร์ท · 👥 ${joinedCount}/${game.max_players} คน`,
  ].join("\n");

  return buttons("รอบตีแบด", body, GAME_ACTIONS);
}

export function playerList(game: GameRow, players: { display_name: string }[]): TextMessage {
  const names = players.map((player, index) => `${index + 1}. ${player.display_name}`);

  return text(
    [
      `🏸 ${game.court_name ?? "BADMINTON"}`,
      `📅 ${formatThaiDate(game.play_date)}`,
      `⏰ ${formatTimeRange(game.start_time, game.duration_minutes)}`,
      `🏟️ ${game.court_count} คอร์ท`,
      ...(game.location_url ? [`📍 ${game.location_url}`] : []),
      "",
      `👥 ${players.length}/${game.max_players} คน`,
      "",
      ...(names.length > 0 ? names : ["ยังไม่มีคนลงชื่อ"]),
    ].join("\n"),
  );
}

export function editMenu(pendingId: string): TextMessage {
  return quickReplyText(
    "✏️ ต้องการแก้ไขอะไร?",
    [
      { label: "🏟️ จำนวนคอร์ท", value: "court" },
      { label: "👥 จำนวนคน", value: "max" },
      { label: "📅 วันที่", value: "date" },
      { label: "⏰ เวลา", value: "time" },
      { label: "⏱️ ระยะเวลา", value: "duration" },
      { label: "🏸 ชื่อคอร์ท", value: "name" },
      { label: "📍 แผนที่", value: "location" },
    ].map((choice) => ({
      label: choice.label,
      data: wizardData(pendingId, "field", choice.value),
    })),
  );
}

function changeLines(game: GameRow, patch: EditPatch): string[] {
  const lines: string[] = [];

  if (patch.court_count !== undefined) {
    lines.push(`🏟️ ${game.court_count} → ${patch.court_count} คอร์ท`);
  }
  if (patch.max_players !== undefined) {
    lines.push(`👥 รับ ${game.max_players} → ${patch.max_players} คน`);
  }
  if (patch.court_name !== undefined) {
    lines.push(`🏸 ${game.court_name ?? "(ยังไม่ระบุ)"} → ${patch.court_name}`);
  }
  if (patch.location_url !== undefined) {
    lines.push("📍 อัปเดตลิงก์แผนที่");
  }
  if (patch.play_date !== undefined) {
    lines.push(`📅 ${formatThaiDate(game.play_date)} → ${formatThaiDate(patch.play_date)}`);
  }
  if (patch.start_time !== undefined) {
    lines.push(`⏰ ${game.start_time} → ${patch.start_time}`);
  }
  if (patch.duration_minutes !== undefined) {
    lines.push(
      `⏱️ ${formatDuration(game.duration_minutes)} → ${formatDuration(patch.duration_minutes)}`,
    );
  }

  return lines;
}

export function confirmEditGame(
  pendingId: string,
  game: GameRow,
  patch: EditPatch,
): ButtonsMessage {
  return buttons(
    "ยืนยันการแก้ไข?",
    ["✏️ ยืนยันการแก้ไข?", ...changeLines(game, patch)].join("\n"),
    confirmActions(pendingId, "✅ ยืนยัน"),
  );
}

export function confirmCancelGame(
  pendingId: string,
  game: GameRow,
  joinedCount: number,
): ButtonsMessage {
  return buttons(
    "ยืนยันยกเลิกรอบตี?",
    [
      "⚠️ ยืนยันการยกเลิกรอบตี?",
      gameSummary(game),
      `👥 ${joinedCount}/${game.max_players} คน`,
    ].join("\n"),
    confirmActions(pendingId, "❌ ยืนยันยกเลิก", "กลับ"),
  );
}

export function confirmCloseGame(
  pendingId: string,
  game: GameRow,
  joinedCount: number,
): ButtonsMessage {
  return buttons(
    "ปิดรอบตี?",
    ["🏁 ปิดรอบตีนี้?", gameSummary(game), `👥 ${joinedCount}/${game.max_players} คน`].join("\n"),
    confirmActions(pendingId, "✅ ปิดรอบ", "กลับ"),
  );
}

export function gameCancelled(): TextMessage {
  return text('🚫 ยกเลิกรอบตีเรียบร้อย\n\nเปิดรอบใหม่ได้ด้วย "บอทจ๋า เปิดตี"');
}

export function gameClosed(): TextMessage {
  return text('🏁 ปิดรอบเรียบร้อย ขอบคุณทุกคนที่มาตีนะ 🏸\n\nเปิดรอบใหม่ได้ด้วย "บอทจ๋า เปิดตี"');
}

export function actionRejected(actionType: PendingActionType): TextMessage {
  switch (actionType) {
    case "create_game":
      return text("ยกเลิกแล้ว ไม่ได้เปิดรอบตีนะ");
    case "edit_game":
      return text("ไม่ได้แก้อะไร รอบตียังเหมือนเดิม");
    default:
      return text("ไม่ได้ทำอะไรต่อ รอบตียังเปิดอยู่เหมือนเดิม");
  }
}

export function gameSummary(game: GameRow): string {
  return [
    ...(game.court_name ? [`🏸 ${game.court_name}`] : []),
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
      return text('❌ ตอนนี้ไม่มีรอบตีที่เปิดอยู่\n\nพิมพ์ "บอทจ๋า เปิดตี" เพื่อเปิดรอบใหม่');
    case "ALREADY_JOINED":
      return text("ℹ️ คุณลงชื่อรอบนี้ไปแล้ว");
    case "NOT_JOINED":
      return text("ℹ️ คุณยังไม่ได้ลงชื่อรอบนี้");
    case "GAME_FULL": {
      const current = details.current_players ?? "";
      const max = details.max_players ?? "";
      return text(`⛔ รอบนี้เต็มแล้ว\n\n🏸 ${current}/${max} คน\n\nไม่สามารถลงชื่อเพิ่มได้`);
    }
    case "DATE_IN_PAST":
      return text("❌ วันเวลานี้ผ่านไปแล้ว ลองเลือกใหม่นะ");
    case "PENDING_EXPIRED":
      return text("⛔ ปุ่มนี้หมดอายุหรือถูกใช้ไปแล้ว\n\nพิมพ์ “บอทจ๋า เปิดตี” เพื่อเริ่มใหม่");
    case "NOT_REQUESTER":
      return text("⛔ เฉพาะคนที่สั่งเท่านั้นที่กดปุ่มนี้ได้");
    case "NOT_GAME_CREATOR":
      return text("⛔ เฉพาะคนที่เปิดรอบเท่านั้นที่แก้ไข ยกเลิก หรือปิดรอบได้");
    case "COURT_TOO_SMALL":
      return text(
        [
          `❌ ไม่สามารถลดเหลือ ${details.new_court_count} คอร์ทได้`,
          "",
          `ขณะนี้มีผู้เล่น ${details.current_players} คน`,
          `แต่ ${details.new_court_count} คอร์ทรองรับได้ ${details.new_max_players} คน`,
        ].join("\n"),
      );
    case "MAX_PLAYERS_TOO_SMALL":
      return text(
        [
          `❌ ลดเหลือ ${details.new_max_players} คนไม่ได้`,
          "",
          `ตอนนี้มีคนลงชื่อแล้ว ${details.current_players} คน`,
        ].join("\n"),
      );
    case "NO_CHANGES":
      return text("ℹ️ ไม่มีอะไรเปลี่ยนแปลง");
    case "MISSING_FIELDS":
      return text("ℹ️ ข้อมูลยังไม่ครบ ลองเริ่มใหม่ด้วย “บอทจ๋า เปิดตี”");
    default:
      return text("😵 ระบบขัดข้อง ลองใหม่อีกครั้งนะ");
  }
}
