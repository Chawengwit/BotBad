import type { ErrorCode } from "@/errors/app-errors";
import type { ButtonsMessage, LineMessage, MessageAction, TextMessage } from "@/lib/line";
import { formatDuration, formatThaiDate, formatTimeRange, todayInBangkok } from "@/lib/time";
import type { PendingActionType } from "@/repositories/pending-action.repository";
import { WAKE_WORD } from "@/router/wake-word";
import { MAX_PLAYERS, MIN_PLAYERS, type GameDraft } from "@/services/game.service";
import { summarize, toBaht } from "@/services/bill.service";
import type { BillItem, BillRow, BillShareRow } from "@/repositories/types";
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

/** เก็บเป็นตัวเลขล้วน แต่ตอนอ่านต้องเว้นวรรคให้เหมือนที่คนคุ้นเคย */
export function formatPromptPay(digits: string): string {
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 13) {
    return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
  }
  return digits;
}

export function askPromptPay(pendingId: string, lastUsed: string | null): TextMessage {
  return quickReplyText(
    "💸 เลขพร้อมเพย์สำหรับตอนคิดเงิน?\n\nพิมพ์เบอร์มือถือหรือเลขบัตรประชาชนของคนรับโอน ถ้ายังไม่ใส่ก็กดข้ามได้",
    [
      ...(lastUsed
        ? [
            {
              label: `ใช้ ${formatPromptPay(lastUsed)}`,
              data: wizardData(pendingId, "promptpay", "reuse"),
            },
          ]
        : []),
      { label: "ข้าม", data: wizardData(pendingId, "promptpay", "skip") },
    ],
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
    ...(draft.promptpay ? [`💸 พร้อมเพย์ ${formatPromptPay(draft.promptpay)}`] : []),
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
      { label: "💸 พร้อมเพย์", value: "promptpay" },
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
  if (patch.promptpay !== undefined) {
    const before = game.promptpay ? formatPromptPay(game.promptpay) : "(ยังไม่ระบุ)";
    lines.push(`💸 พร้อมเพย์ ${before} → ${formatPromptPay(patch.promptpay)}`);
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

/**
 * เตือนว่าใครยังไม่จ่าย แต่ไม่ขวางการปิดรอบ
 * ถ้าห้ามปิด คนที่ไม่จ่ายคนเดียวจะทำให้ทั้งกลุ่มเปิดรอบใหม่ไม่ได้ (PRP §5.7)
 */
function unpaidWarning(unpaid: BillShareRow[]): string[] {
  if (unpaid.length === 0) return [];

  const total = unpaid.reduce((sum, share) => sum + share.amount_satang, 0);
  return [
    "",
    `⚠️ ยังมีคนไม่จ่าย ${unpaid.length} คน`,
    `${unpaid.map((share) => share.display_name).join(", ")} — รวม ${formatBaht(total)}`,
    "",
    'ปิดรอบแล้วยังกด "จ่ายแล้ว" และถาม "ใครยังไม่จ่าย" ได้ตามปกติ',
  ];
}

export function confirmCloseGame(
  pendingId: string,
  game: GameRow,
  joinedCount: number,
  unpaid: BillShareRow[] = [],
): LineMessage {
  const body = ["🏁 ปิดรอบตีนี้?", gameSummary(game), `👥 ${joinedCount}/${game.max_players} คน`];
  const actions = confirmActions(pendingId, "✅ ปิดรอบ", "กลับ");

  // มีรายชื่อค้างจ่ายเมื่อไหร่ ข้อความจะยาวเกิน 160 ตัวอักษรของ buttons template ได้ง่าย
  if (unpaid.length === 0) return buttons("ปิดรอบตี?", body.join("\n"), actions);

  return quickReplyText(
    [...body, ...unpaidWarning(unpaid)].join("\n"),
    actions.map((action) => ({ label: action.label, data: "data" in action ? action.data : "" })),
  );
}

export function gameCancelled(): TextMessage {
  return text('🚫 ยกเลิกรอบตีเรียบร้อย\n\nเปิดรอบใหม่ได้ด้วย "บอทจ๋า เปิดตี"');
}

export function gameClosed(unpaid: BillShareRow[] = []): TextMessage {
  if (unpaid.length === 0) {
    return text('🏁 ปิดรอบเรียบร้อย ขอบคุณทุกคนที่มาตีนะ 🏸\n\nเปิดรอบใหม่ได้ด้วย "บอทจ๋า เปิดตี"');
  }

  const total = unpaid.reduce((sum, share) => sum + share.amount_satang, 0);
  return text(
    [
      "🏁 ปิดรอบเรียบร้อย ขอบคุณทุกคนที่มาตีนะ 🏸",
      "",
      `⭕ ยังค้างอยู่ ${unpaid.length} คน รวม ${formatBaht(total)}`,
      unpaid.map((share) => share.display_name).join(", "),
      "",
      'ตามเก็บต่อได้ด้วย "บอทจ๋า ใครยังไม่จ่าย"',
    ].join("\n"),
  );
}

export function actionRejected(actionType: PendingActionType): TextMessage {
  switch (actionType) {
    case "create_game":
      return text("ยกเลิกแล้ว ไม่ได้เปิดรอบตีนะ");
    case "edit_game":
      return text("ไม่ได้แก้อะไร รอบตียังเหมือนเดิม");
    case "create_bill":
      return text("ยกเลิกแล้ว ยังไม่ได้คิดเงินนะ");
    case "cancel_bill":
      return text("ไม่ได้ยกเลิกบิล บิลเดิมยังอยู่");
    default:
      return text("ไม่ได้ทำอะไรต่อ รอบตียังเปิดอยู่เหมือนเดิม");
  }
}

/** ตัวเลือกที่ขึ้นบ่อยในก๊วนไทย ที่เหลือพิมพ์เอาเอง */
export const COURT_FEE_CHOICES = [300, 400, 500] as const;
export const SHUTTLE_PRICE_CHOICES = [20, 25, 30] as const;
export const SHUTTLE_COUNT_CHOICES = [1, 2, 3, 4] as const;

/** เงินเก็บเป็นสตางค์ แต่คนอ่านเป็นบาททศนิยมสองตำแหน่งเสมอ */
export function formatBaht(satang: number): string {
  return toBaht(satang).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function askCourtFee(pendingId: string): TextMessage {
  return quickReplyText(
    "🏟️ ค่าคอร์ทเท่าไหร่?\n\nกดเลือกหรือพิมพ์จำนวนเงินมาได้เลย",
    [
      ...COURT_FEE_CHOICES.map((baht) => ({
        label: `${baht}`,
        data: wizardData(pendingId, "court_fee", String(baht)),
      })),
      { label: "ไม่มีค่าคอร์ท", data: wizardData(pendingId, "court_fee", "skip") },
    ],
  );
}

export function askShuttleCount(pendingId: string): TextMessage {
  return quickReplyText("🏸 ใช้ลูกแบดกี่ลูก?", [
    ...SHUTTLE_COUNT_CHOICES.map((count) => ({
      label: `${count} ลูก`,
      data: wizardData(pendingId, "shuttle_count", String(count)),
    })),
    { label: "ไม่มี", data: wizardData(pendingId, "shuttle_count", "0") },
  ]);
}

export function askShuttlePrice(pendingId: string, lastPriceSatang: number | null): TextMessage {
  const last = lastPriceSatang === null ? null : toBaht(lastPriceSatang);
  const choices = [...(last !== null ? [last] : []), ...SHUTTLE_PRICE_CHOICES.filter((baht) => baht !== last)];

  return quickReplyText(
    "🏸 ลูกละเท่าไหร่?\n\nกดเลือกหรือพิมพ์จำนวนเงินมาได้เลย",
    choices.map((baht, index) => ({
      label: index === 0 && last !== null ? `${baht} (ครั้งก่อน)` : `${baht}`,
      data: wizardData(pendingId, "shuttle_price", String(baht)),
    })),
  );
}

export function askExtraItem(pendingId: string): TextMessage {
  return quickReplyText("➕ มีค่าอื่นอีกไหม?", [
    { label: "💧 ค่าน้ำ", data: wizardData(pendingId, "extra", "water") },
    { label: "➕ อื่น ๆ", data: wizardData(pendingId, "extra", "other") },
    { label: "✅ ไม่มีแล้ว", data: wizardData(pendingId, "extra", "done") },
  ]);
}

export function askAmount(label: string): TextMessage {
  return text(`💵 ${label}เท่าไหร่?\n\nพิมพ์จำนวนเงินตอบได้เลย`);
}

export function askOtherItem(): TextMessage {
  return text('➕ พิมพ์ชื่อรายการกับจำนวนเงินมาในบรรทัดเดียว\n\nเช่น "ค่าเช่าไม้ 100"');
}

function itemIcon(label: string): string {
  if (label === "ค่าคอร์ท") return "🏟️";
  if (label === "ลูกแบด") return "🏸";
  if (label.includes("น้ำ")) return "💧";
  return "➕";
}

function itemLines(items: BillItem[]): string[] {
  return items.map((item) => {
    const detail =
      item.quantity > 1
        ? `${item.label} ${item.quantity} ลูก × ${formatBaht(item.unit_price_satang)}`
        : item.label;
    return `${itemIcon(item.label)} ${detail} — ${formatBaht(item.amount_satang)}`;
  });
}

function billLines(game: GameRow, items: BillItem[], totalSatang: number, headCount: number): string[] {
  return [
    `💰 คิดเงินรอบ ${formatThaiDate(game.play_date)}`,
    "",
    ...itemLines(items),
    "──────────",
    `รวม ${formatBaht(totalSatang)}`,
    `หาร ${headCount} คน → คนละ ${formatBaht(Math.floor(totalSatang / headCount))}`,
  ];
}

export function confirmBill(
  pendingId: string,
  game: GameRow,
  items: BillItem[],
  totalSatang: number,
  headCount: number,
): TextMessage {
  return quickReplyText(
    [...billLines(game, items, totalSatang, headCount), "", "ส่งบิลเข้ากลุ่มเลยไหม?"].join("\n"),
    confirmActions(pendingId, "✅ ส่งบิล").map((action) => ({
      label: action.label,
      data: "data" in action ? action.data : "",
    })),
  );
}

const BILL_ACTIONS = [
  { label: "💸 จ่ายแล้ว", data: "action=bill_paid" },
  { label: "👀 ใครยังไม่จ่าย", data: "action=bill_status" },
];

/**
 * การ์ดบิล ใช้ข้อความ + quick reply ไม่ใช่ buttons template
 * เพราะ buttons template จำกัดข้อความไว้ 160 ตัวอักษร ซึ่งบิลหลายรายการเกินได้ง่าย
 */
export function billCard(
  game: GameRow,
  bill: BillRow,
  shares: BillShareRow[],
  headline?: string,
): TextMessage {
  const { unpaid, settled } = summarize(shares);

  return quickReplyText(
    [
      ...(headline ? [headline, ""] : []),
      ...billLines(game, bill.items, bill.total_satang, shares.length),
      ...(game.promptpay ? ["", `💸 พร้อมเพย์ ${formatPromptPay(game.promptpay)}`] : []),
      "",
      settled ? "✅ จ่ายครบทุกคนแล้ว" : `⭕ ยังไม่จ่าย ${unpaid.length} คน`,
    ].join("\n"),
    BILL_ACTIONS,
  );
}

export function unpaidList(game: GameRow, bill: BillRow, shares: BillShareRow[]): TextMessage {
  const { paid, unpaid, unpaidTotalSatang, settled } = summarize(shares);
  const names = (list: BillShareRow[]) => list.map((share) => share.display_name).join(", ");

  return quickReplyText(
    [
      `💰 รอบ ${formatThaiDate(game.play_date)} — คนละ ${formatBaht(shares[0]?.amount_satang ?? 0)}`,
      "",
      ...(paid.length > 0 ? [`✅ จ่ายแล้ว (${paid.length})`, names(paid), ""] : []),
      ...(settled
        ? ["🎉 จ่ายครบทุกคนแล้ว"]
        : [
            `⭕ ยังไม่จ่าย (${unpaid.length})`,
            names(unpaid),
            "",
            `ยังไม่ได้รับ ${formatBaht(unpaidTotalSatang)}`,
            ...(game.promptpay ? [`💸 พร้อมเพย์ ${formatPromptPay(game.promptpay)}`] : []),
          ]),
    ].join("\n"),
    settled ? [] : BILL_ACTIONS.slice(0, 1),
  );
}

export function paymentRecorded(
  displayName: string,
  amountSatang: number,
  shares: BillShareRow[],
): TextMessage {
  const { unpaid, settled } = summarize(shares);

  return text(
    [
      `✅ บันทึกแล้ว ${displayName} จ่าย ${formatBaht(amountSatang)}`,
      settled ? "🎉 ครบทุกคนแล้ว" : `เหลืออีก ${unpaid.length} คน`,
    ].join("\n"),
  );
}

export function paymentUndone(displayName: string, shares: BillShareRow[]): TextMessage {
  const { unpaid } = summarize(shares);
  return text(`↩️ เอา ${displayName} กลับไปเป็นยังไม่จ่ายแล้ว\n\nค้างอยู่ ${unpaid.length} คน`);
}

export function confirmCancelBill(
  pendingId: string,
  game: GameRow,
  shares: BillShareRow[],
): TextMessage {
  const { paid } = summarize(shares);

  return quickReplyText(
    [
      `⚠️ ยกเลิกบิลของรอบ ${formatThaiDate(game.play_date)}?`,
      "",
      ...(paid.length > 0
        ? [`มีคนกดว่าจ่ายแล้ว ${paid.length} คน การยกเลิกจะลบบันทึกนั้นทิ้งด้วย`, ""]
        : []),
      "ยกเลิกแล้วคิดเงินใหม่ได้เลย",
    ].join("\n"),
    confirmActions(pendingId, "🗑️ ยกเลิกบิล").map((action) => ({
      label: action.label,
      data: "data" in action ? action.data : "",
    })),
  );
}

export function billCancelled(): TextMessage {
  return text('🗑️ ยกเลิกบิลแล้ว\n\nคิดใหม่ได้ด้วย "บอทจ๋า คิดเงิน"');
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
    case "NO_BILL":
      return text('❌ รอบนี้ยังไม่ได้คิดเงิน\n\nคนที่เปิดรอบพิมพ์ "บอทจ๋า คิดเงิน" ได้เลย');
    case "BILL_ALREADY_EXISTS":
      return text('⛔ รอบนี้คิดเงินไปแล้ว\n\nถ้าจะคิดใหม่ต้องพิมพ์ "บอทจ๋า ยกเลิกบิล" ก่อน');
    case "NOT_IN_BILL":
      return text("ℹ️ คุณไม่ได้อยู่ในบิลรอบนี้");
    case "NO_PLAYERS_TO_SPLIT":
      return text("❌ ยังไม่มีใครลงชื่อ เลยหารไม่ได้");
    case "AMOUNT_INVALID":
      return text("❌ จำนวนเงินต้องมากกว่า 0 และไม่เกิน 100,000 บาท");
    case "MISSING_FIELDS":
      return text("ℹ️ ข้อมูลยังไม่ครบ ลองเริ่มใหม่ด้วย “บอทจ๋า เปิดตี”");
    default:
      return text("😵 ระบบขัดข้อง ลองใหม่อีกครั้งนะ");
  }
}
