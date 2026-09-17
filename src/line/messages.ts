import type { ErrorCode } from "@/errors/app-errors";
import type {
  ButtonsMessage,
  FlexComponent,
  FlexMessage,
  LineMessage,
  MessageAction,
  TextMessage,
} from "@/lib/line";
import {
  amountRow,
  bubble,
  COLOR,
  flexMessage,
  footerButtons,
  header,
  hbox,
  infoRow,
  note,
  separator,
  title,
  vbox,
} from "./flex";
import { addDays, formatDuration, formatThaiDate, formatTimeRange, todayInBangkok } from "@/lib/time";
import type { PendingActionType } from "@/repositories/pending-action.repository";
import { WAKE_WORD } from "@/router/wake-word";
import { MAX_PLAYERS, MIN_PLAYERS, type GameDraft } from "@/services/game.service";
import { summarize, toBaht } from "@/services/bill.service";
import type { BillItemRow, BillRow, BillShareRow } from "@/repositories/types";
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

/** เวลาตั้งต้นเวลาไม่รู้ว่ากลุ่มนี้ชอบตีกี่โมง */
export const DEFAULT_START_TIME = "19:00";

/**
 * ถามวันและเวลาในคำถามเดียว (spec §9.1)
 * แยกเป็นสองขั้นตอนไม่ได้ช่วยอะไร เพราะคนนึกออกพร้อมกันอยู่แล้วว่าจะตีเมื่อไหร่
 *
 * ปุ่มลัดใช้เวลาของรอบที่แล้วเป็นตัวตั้ง เพราะก๊วนส่วนใหญ่ตีเวลาเดิมทุกสัปดาห์
 * ค่าในปุ่มคำนวณตั้งแต่ตอนสร้างปุ่ม ป้ายบอกอะไรก็ได้อย่างนั้นจริง ๆ
 */
export function askWhen(
  pendingId: string,
  usualTime: string = DEFAULT_START_TIME,
  today: string = todayInBangkok(),
): ButtonsMessage {
  const shortcut = (label: string, date: string) => ({
    type: "postback" as const,
    label: `${label} ${usualTime}`,
    displayText: `${label} ${usualTime}`,
    data: wizardData(pendingId, "when", `${date} ${usualTime}`),
  });

  return buttons("เมื่อไหร่?", "📅 ตีเมื่อไหร่?", [
    shortcut("วันนี้", today),
    shortcut("พรุ่งนี้", addDays(today, 1)),
    {
      type: "datetimepicker",
      label: "เลือกวันและเวลา",
      mode: "datetime",
      initial: `${today}T${usualTime}`,
      min: `${today}T00:00`,
      data: new URLSearchParams({
        action: "wizard",
        pending_id: pendingId,
        step: "when",
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
  return text("🏟️ ไปตีที่คอร์ทไหนครับพี่?\n\nพิมพ์ชื่อคอร์ทตอบได้เลย");
}

/**
 * ก๊วนประจำตีที่เดิมทุกสัปดาห์ ถามทีเดียวแทนที่จะไล่ถามชื่อคอร์ท แผนที่ และพร้อมเพย์ทีละข้อ
 * กด "ที่เดิม" = ยกทั้งสามค่าจากรอบก่อนมาเลย กด "เปลี่ยน" = ถามทีละข้อแบบเดิม
 */
export function askSameVenue(
  pendingId: string,
  courtName: string,
  hasMap: boolean,
  promptpay: string | null,
): ButtonsMessage {
  const body = [
    "🏟️ ที่เดิมไหม?",
    "",
    courtName,
    ...(hasMap ? ["📍 มีลิงก์แผนที่"] : []),
    ...(promptpay ? [`💸 พร้อมเพย์ ${formatPromptPay(promptpay)}`] : []),
  ].join("\n");

  return buttons("ที่เดิมไหม?", body, [
    {
      type: "postback",
      label: "ที่เดิม",
      displayText: "ที่เดิม",
      data: wizardData(pendingId, "venue", "same"),
    },
    {
      type: "postback",
      label: "เปลี่ยนที่",
      displayText: "เปลี่ยนที่",
      data: wizardData(pendingId, "venue", "change"),
    },
  ]);
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
/** ปุ่มลัดใต้ข้อความ ส่งเป็นข้อความที่มี wake word ครบ จะได้เข้าทางเดิมทุกครั้ง */
function commandShortcuts(commands: string[]): TextMessage["quickReply"] {
  return {
    items: commands.map((command) => ({
      type: "action" as const,
      action: {
        type: "message" as const,
        label: command,
        text: `${WAKE_WORD} ${command}`,
      },
    })),
  };
}

export function fallbackMenu(): TextMessage {
  return {
    type: "text",
    text: "🤔 ผมยังไม่เข้าใจประโยคนี้ครับพี่\n\nลองเลือกจากด้านล่างได้เลย",
    quickReply: commandShortcuts(["เปิดตี", "ลงชื่อ", "ถอนชื่อ", "ใครตีบ้าง"]),
  };
}

/**
 * ตอบตอนมีคนเรียกชื่อบอทเฉย ๆ ยังไม่ได้สั่งอะไร
 * หลังจากนี้บอทเปิดโหมดฟัง สั่งต่อได้เลยโดยไม่ต้องเรียกชื่ออีก (spec §6)
 */
export function greeting(): TextMessage {
  return {
    type: "text",
    text: "ว่าไงครับพี่ 🏸",
    quickReply: commandShortcuts(["เปิดตี", "ลงชื่อ", "ใครตีบ้าง", "คิดเงิน"]),
  };
}

/**
 * เมนูช่วยเหลือ — เป็นหนึ่งในกรณีที่แนบปุ่มได้ เพราะบอทรอคำสั่งอยู่ (spec §23)
 * สำคัญขึ้นมากตั้งแต่เลิกแนบปุ่มท้ายผลลัพธ์ เพราะนี่คือทางเดียวที่คนใหม่ในกลุ่มจะรู้ว่าสั่งอะไรได้
 */
export function helpMenu(): TextMessage {
  return {
    type: "text",
    text: [
      "🏸 บอทจ๋าช่วยอะไรได้บ้าง",
      "",
      "รอบตี",
      "• เปิดตี — เปิดรอบใหม่",
      "• ลงชื่อ / ถอนชื่อ",
      "• ใครตีบ้าง — ดูรายชื่อ",
      "• แก้ไข / ยกเลิก / ปิดรอบ (เฉพาะคนเปิดรอบ)",
      "",
      "ค่าใช้จ่าย",
      "• คิดเงิน — หารค่าคอร์ทและลูกแบด (เฉพาะคนเปิดรอบ)",
      "• บิล / ใครยังไม่จ่าย",
      "• จ่ายแล้ว / ยังไม่จ่าย",
      "",
      `พิมพ์ "${WAKE_WORD}" นำหน้า หรือเรียก "${WAKE_WORD}" เฉย ๆ ครั้งเดียวแล้วสั่งต่อได้เลย`,
    ].join("\n"),
    quickReply: commandShortcuts(["เปิดตี", "ลงชื่อ", "ใครตีบ้าง", "คิดเงิน"]),
  };
}

/** ผู้ใช้บอกเองว่าจบแล้ว ปิดโหมดฟังทันทีไม่ต้องรอหมดเวลา */
export function goodbye(): TextMessage {
  return text("ได้เลยครับพี่ 👋 เรียก \"บอทจ๋า\" ได้ใหม่ทุกเมื่อ");
}

export function askAgain(message: string): TextMessage {
  return text(message);
}

function confirmActions(
  pendingId: string,
  confirmLabel: string,
  rejectLabel = "ยกเลิก",
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

export function confirmCreateGame(pendingId: string, draft: GameDraft): FlexMessage {
  return flexMessage(
    "ยืนยันเปิดรอบตี?",
    bubble({
      header: header("🏸 ยืนยันเปิดรอบตี?"),
      body: vbox(
        [
          title(draft.court_name),
          vbox(
            [
              infoRow("📅", formatThaiDate(draft.play_date)),
              infoRow("⏰", formatTimeRange(draft.start_time, draft.duration_minutes)),
              infoRow("🏸", `${draft.court_count} คอร์ท`),
              infoRow("👥", `รับ ${draft.max_players} คน`),
              ...(draft.location_url ? [infoRow("📍", "มีลิงก์แผนที่")] : []),
              ...(draft.promptpay
                ? [infoRow("💸", `พร้อมเพย์ ${formatPromptPay(draft.promptpay)}`)]
                : []),
            ],
            { spacing: "sm", margin: "lg" },
          ),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "เปิดตี")),
    }),
  );
}

/** บรรทัดข้อมูลรอบตีที่ใช้ทั้งการ์ดรอบและการ์ดรายชื่อ */
function gameRows(game: GameRow, playerLine: string): FlexComponent[] {
  return [
    infoRow("📅", formatThaiDate(game.play_date)),
    infoRow("⏰", formatTimeRange(game.start_time, game.duration_minutes)),
    infoRow("🏸", `${game.court_count} คอร์ท`),
    infoRow("👥", playerLine),
    // ใน Flex ข้อความไม่กลายเป็นลิงก์ให้เอง ต้องผูก action เข้ากับบรรทัดนั้นเอง
    ...(game.location_url
      ? [infoRow("📍", "เปิดแผนที่", { type: "uri" as const, label: "แผนที่", uri: game.location_url })]
      : []),
  ];
}

/**
 * การ์ดรอบตี — Flex ไม่มีปุ่ม (spec §23)
 * LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ ทุกครั้งที่มีความเคลื่อนไหวจึงส่งการ์ดใบใหม่
 */
export function gameCard(game: GameRow, joinedCount: number, headline?: string): FlexMessage {
  const courtName = game.court_name ?? "BADMINTON";

  return flexMessage(
    `${headline ?? courtName} ${formatThaiDate(game.play_date)}`,
    bubble({
      ...(headline ? { header: header(headline) } : {}),
      body: vbox(
        [title(courtName), vbox(gameRows(game, `${joinedCount}/${game.max_players} คน`), { spacing: "sm", margin: "lg" })],
        { paddingAll: "20px" },
      ),
    }),
  );
}

/**
 * ลงชื่อ / ถอนชื่อเป็นงานที่จบในตัว ตอบสั้น ๆ พอ ไม่ต้องมีปุ่มให้กดต่อ (spec §23)
 * ใครจะลงเพิ่มหรือถอนก็พิมพ์สั่งเองได้ ไม่ต้องให้บอทยัดปุ่มใส่กลุ่มทุกครั้งที่มีคนขยับ
 */
export function joinedNotice(
  displayName: string,
  joinedCount: number,
  maxPlayers: number,
): TextMessage {
  return text(`✅ ${displayName} ลงชื่อแล้ว\n👥 ${joinedCount}/${maxPlayers} คน`);
}

/**
 * ลงชื่อแทนกัน ต้องบอกให้ทั้งกลุ่มเห็นว่าใครทำให้ใคร (PRP guests-split-bills-and-digest §4.7)
 * ไม่ใช่ขึ้นแค่ชื่อคนถูกลง ไม่งั้นคนอ่านไม่รู้ว่าใครเป็นคนพามา
 */
export function joinedForNotice(
  actorName: string,
  result: {
    joinedCount: number;
    people: { display_name: string }[];
    skipped: { user: { display_name: string }; reason: string }[];
  },
  newGuests: string[] = [],
): TextMessage {
  const names = result.people.map((person) => person.display_name);
  const already = result.skipped
    .filter((entry) => entry.reason === "already_joined")
    .map((entry) => entry.user.display_name);

  return text(
    [
      names.length > 0
        ? `✅ ${actorName} ลงชื่อให้ ${names.join(", ")}`
        : `ℹ️ ไม่มีใครถูกลงชื่อเพิ่ม`,
      ...(newGuests.length > 0 ? [`🆕 เพิ่มแขกใหม่: ${newGuests.join(", ")}`] : []),
      ...(already.length > 0 ? [`ℹ️ ${already.join(", ")} ลงชื่อไว้อยู่แล้ว`] : []),
      `👥 ${result.joinedCount} คน`,
    ].join("\n"),
  );
}

export function leftForNotice(
  actorName: string,
  result: {
    joinedCount: number;
    people: { display_name: string }[];
    skipped: { user: { display_name: string }; reason: string }[];
  },
  unknownNames: string[] = [],
): TextMessage {
  const names = result.people.map((person) => person.display_name);
  const notYours = result.skipped
    .filter((entry) => entry.reason === "not_yours")
    .map((entry) => entry.user.display_name);
  const notJoined = result.skipped
    .filter((entry) => entry.reason === "not_joined")
    .map((entry) => entry.user.display_name);

  return text(
    [
      names.length > 0
        ? `👋 ${actorName} ถอนชื่อให้ ${names.join(", ")}`
        : "ℹ️ ไม่มีใครถูกถอนชื่อ",
      ...(notYours.length > 0
        ? [`⛔ ${notYours.join(", ")} ถอนได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้`]
        : []),
      ...(notJoined.length > 0 ? [`ℹ️ ${notJoined.join(", ")} ไม่ได้ลงชื่อไว้`] : []),
      ...(unknownNames.length > 0 ? [`❓ ไม่รู้จัก ${unknownNames.join(", ")}`] : []),
      `👥 ${result.joinedCount} คน`,
    ].join("\n"),
  );
}

export function leftNotice(
  displayName: string,
  joinedCount: number,
  maxPlayers: number,
): TextMessage {
  return text(`👋 ${displayName} ถอนชื่อแล้ว\n👥 ${joinedCount}/${maxPlayers} คน`);
}

export function playerList(game: GameRow, players: { display_name: string }[]): FlexMessage {
  const courtName = game.court_name ?? "BADMINTON";

  return flexMessage(
    `รายชื่อ ${players.length}/${game.max_players} คน`,
    bubble({
      body: vbox(
        [
          title(courtName),
          vbox(gameRows(game, `${players.length}/${game.max_players} คน`), { spacing: "sm", margin: "lg" }),
          separator("lg"),
          vbox(
            players.length > 0
              ? players.map((player, index) => ({
                  type: "text" as const,
                  text: `${index + 1}. ${player.display_name}`,
                  size: "sm",
                  color: COLOR.ink,
                  wrap: true,
                }))
              : [note("ยังไม่มีคนลงชื่อ")],
            { spacing: "sm", margin: "lg" },
          ),
        ],
        { paddingAll: "20px" },
      ),
    }),
  );
}

export function editMenu(pendingId: string): TextMessage {
  return quickReplyText(
    "✏️ ต้องการแก้ไขอะไร?",
    [
      { label: "จำนวนคอร์ท", value: "court" },
      { label: "จำนวนคน", value: "max" },
      { label: "วันที่", value: "date" },
      { label: "เวลา", value: "time" },
      { label: "ระยะเวลา", value: "duration" },
      { label: "ชื่อคอร์ท", value: "name" },
      { label: "แผนที่", value: "location" },
      { label: "พร้อมเพย์", value: "promptpay" },
    ].map((choice) => ({
      label: choice.label,
      data: wizardData(pendingId, "field", choice.value),
    })),
  );
}

function changeLines(game: GameRow, patch: EditPatch): string[] {
  const lines: string[] = [];

  if (patch.court_count !== undefined) {
    lines.push(`🏸 ${game.court_count} → ${patch.court_count} คอร์ท`);
  }
  if (patch.max_players !== undefined) {
    lines.push(`👥 รับ ${game.max_players} → ${patch.max_players} คน`);
  }
  if (patch.court_name !== undefined) {
    lines.push(`🏟️ ${game.court_name ?? "(ยังไม่ระบุ)"} → ${patch.court_name}`);
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

export function confirmEditGame(pendingId: string, game: GameRow, patch: EditPatch): FlexMessage {
  return flexMessage(
    "ยืนยันการแก้ไข?",
    bubble({
      header: header("✏️ ยืนยันการแก้ไข?"),
      body: vbox(
        [
          vbox(
            changeLines(game, patch).map((line) => ({
              type: "text" as const,
              text: line,
              size: "sm",
              color: COLOR.ink,
              wrap: true,
            })),
            { spacing: "sm" },
          ),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "ยืนยัน")),
    }),
  );
}

export function confirmCancelGame(
  pendingId: string,
  game: GameRow,
  joinedCount: number,
): FlexMessage {
  return flexMessage(
    "ยืนยันยกเลิกรอบตี?",
    bubble({
      header: header("⚠️ ยกเลิกรอบตีนี้?", COLOR.warn),
      body: vbox(
        [
          title(game.court_name ?? "BADMINTON"),
          vbox(gameRows(game, `${joinedCount}/${game.max_players} คน`), { spacing: "sm", margin: "lg" }),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "ยืนยันยกเลิก", "กลับ")),
    }),
  );
}

/**
 * เตือนว่าใครยังไม่จ่าย แต่ไม่ขวางการปิดรอบ
 * ถ้าห้ามปิด คนที่ไม่จ่ายคนเดียวจะทำให้ทั้งกลุ่มเปิดรอบใหม่ไม่ได้ (PRP §5.7)
 */
function unpaidWarning(unpaid: BillShareRow[]): FlexComponent[] {
  if (unpaid.length === 0) return [];

  const total = unpaid.reduce((sum, share) => sum + share.amount_satang, 0);
  return [
    separator("lg"),
    vbox(
      [
        {
          type: "text",
          text: `⚠️ ยังมีคนไม่จ่าย ${unpaid.length} คน — รวม ${formatBaht(total)}`,
          size: "sm",
          color: COLOR.warn,
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: unpaid.map((share) => share.display_name).join(", "),
          size: "sm",
          color: COLOR.ink,
          wrap: true,
        },
        note('ปิดรอบแล้วยังบอกว่า "จ่ายแล้ว" และถาม "ใครยังไม่จ่าย" ได้ตามปกติ'),
      ],
      { spacing: "sm", margin: "lg" },
    ),
  ];
}

export function confirmCloseGame(
  pendingId: string,
  game: GameRow,
  joinedCount: number,
  unpaid: BillShareRow[] = [],
): FlexMessage {
  return flexMessage(
    "ปิดรอบตี?",
    bubble({
      header: header("🏁 ปิดรอบตีนี้?"),
      body: vbox(
        [
          title(game.court_name ?? "BADMINTON"),
          vbox(gameRows(game, `${joinedCount}/${game.max_players} คน`), { spacing: "sm", margin: "lg" }),
          ...unpaidWarning(unpaid),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "ปิดรอบ", "กลับ")),
    }),
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
      return text("ได้ครับพี่ ไม่ได้เปิดรอบตีนะ");
    case "edit_game":
      return text("ได้ครับพี่ รอบตียังเหมือนเดิม");
    case "create_bill":
      return text("ได้ครับพี่ ยังไม่ได้คิดเงินนะ");
    case "cancel_bill":
      return text("ได้ครับพี่ บิลเดิมยังอยู่");
    default:
      return text("ได้ครับพี่ รอบตียังเปิดอยู่เหมือนเดิม");
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
    { label: "ค่าน้ำ", data: wizardData(pendingId, "extra", "water") },
    { label: "อื่น ๆ", data: wizardData(pendingId, "extra", "other") },
    { label: "ไม่มีแล้ว", data: wizardData(pendingId, "extra", "done") },
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

function itemLabel(item: { label: string; quantity: number; unit_price_satang: number }): string {
  const detail =
    item.quantity > 1
      ? `${item.label} ${item.quantity} ลูก × ${formatBaht(item.unit_price_satang)}`
      : item.label;
  return `${itemIcon(item.label)} ${detail}`;
}

/** ชื่อคนร่วมจ่ายของรายการ ถ้าเก็บทุกคนในบิลก็ไม่ต้องไล่ชื่อให้รก */
function payerLabel(payers: { display_name: string }[], headCount: number): string {
  if (payers.length >= headCount) return "ทุกคน";
  return payers.map((payer) => payer.display_name).join(", ");
}

/**
 * ตัวบิล: รายการทีละบรรทัดพร้อมคนร่วมจ่าย แล้วปิดท้ายด้วยยอดรวมและยอดรายคน
 * ของเดิมขึ้น "คนละ X" ได้เพราะทุกคนเท่ากัน ตอนนี้แต่ละคนไม่เท่ากันแล้ว (PRP §5.7)
 */
function billBody(
  billTitle: string,
  items: BillItemRow[],
  totalSatang: number,
  shares: BillShareRow[],
): FlexComponent[] {
  const headCount = shares.length;

  return [
    title(billTitle),
    vbox(
      items.map((item) =>
        vbox(
          [
            amountRow(itemLabel(item), formatBaht(item.amount_satang)),
            note(payerLabel(item.payers, headCount)),
          ],
          { spacing: "none" },
        ),
      ),
      { spacing: "md", margin: "lg" },
    ),
    separator("lg"),
    vbox([amountRow("รวม", formatBaht(totalSatang), true)], { margin: "lg" }),
  ];
}

/** ยอดของแต่ละคน พร้อมสถานะจ่าย และคนที่จ่ายแทนถ้ามี */
function shareRows(shares: BillShareRow[]): FlexComponent[] {
  return shares.map((share) => amountRow(share.display_name, formatBaht(share.amount_satang)));
}

/**
 * ยอดของคนที่ยังไม่จ่าย พร้อมบรรทัดสรุปว่าจ่ายไปแล้วกี่คน
 *
 * การ์ดบิลขึ้นเฉพาะคนที่ยังค้าง เพราะก๊วนใหญ่ 20-30 คนแล้วไล่ทุกชื่อทุกครั้ง
 * การ์ดจะยาวจนคนเลิกอ่าน และคนที่จ่ายไปแล้วก็ไม่ได้ต้องทำอะไรต่อ
 * อยากเห็นรายชื่อคนจ่ายแล้วใช้ "บอทจ๋า ใครยังไม่จ่าย" ซึ่งแยกสองกลุ่มให้ครบ
 */
function outstandingRows(shares: BillShareRow[]): FlexComponent[] {
  const { paid, unpaid, settled } = summarize(shares);
  if (settled) return [];

  return [
    vbox(
      [
        { type: "text", text: "⭕ ยังไม่จ่าย", size: "sm", weight: "bold", color: COLOR.warn },
        ...shareRows(unpaid),
        ...(paid.length > 0 ? [note(`✅ จ่ายแล้ว ${paid.length} คน`, COLOR.accent)] : []),
      ],
      { spacing: "sm", margin: "lg" },
    ),
  ];
}

export function confirmBill(
  pendingId: string,
  title: string,
  items: BillItemRow[],
  totalSatang: number,
  shares: BillShareRow[],
): FlexMessage {
  return flexMessage(
    "ส่งบิลเข้ากลุ่มเลยไหม?",
    bubble({
      header: header("💰 ตรวจบิลก่อนส่ง"),
      body: vbox(
        [
          ...billBody(title, items, totalSatang, shares),
          separator("lg"),
          vbox(shareRows(shares), { spacing: "sm", margin: "lg" }),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "ส่งบิล")),
    }),
  );
}

/** การ์ดบิล — Flex ไม่มีปุ่ม ใครจ่ายแล้วพิมพ์ "บอทจ๋า จ่ายแล้ว" เอง (spec §23) */
export function billCard(
  bill: BillRow,
  items: BillItemRow[],
  shares: BillShareRow[],
  headline?: string,
): FlexMessage {
  const { unpaidTotalSatang, settled } = summarize(shares);

  return flexMessage(
    headline ?? `บิล ${bill.title}`,
    bubble({
      ...(headline ? { header: header(headline) } : {}),
      body: vbox(
        [
          ...billBody(bill.title, items, bill.total_satang, shares),
          // จ่ายครบแล้วไม่มีรายชื่อให้ขึ้น จะได้ไม่เหลือเส้นคั่นสองเส้นติดกัน
          ...(settled ? [] : [separator("lg"), ...outstandingRows(shares)]),
          separator("lg"),
          vbox(
            [
              ...(bill.promptpay
                ? [infoRow("💸", `โอนให้ ${creatorName(shares, bill)} · ${formatPromptPay(bill.promptpay)}`)]
                : []),
              // ใช้ 💰 ไม่ใช่ ⭕ เพราะ ⭕ ถูกใช้เป็นหัวรายชื่อคนค้างไปแล้วข้างบน
              infoRow(
                settled ? "✅" : "💰",
                settled ? "จ่ายครบทุกคนแล้ว" : `ยังไม่ได้รับ ${formatBaht(unpaidTotalSatang)}`,
              ),
            ],
            { spacing: "sm", margin: "lg" },
          ),
        ],
        { paddingAll: "20px" },
      ),
    }),
  );
}

/** ชื่อคนรับโอน ดึงจากยอดของคนสร้างบิล ไม่งั้นการ์ดจะมีแต่ตัวเลขไม่รู้ว่าโอนให้ใคร */
function creatorName(shares: BillShareRow[], bill: BillRow): string {
  return shares.find((share) => share.user_id === bill.created_by)?.display_name ?? "คนเปิดบิล";
}

/** รายชื่อว่าใครจ่ายแล้วใครยังค้าง แยกเป็นสองกลุ่มให้กวาดตาดูจบในทีเดียว */
function payerGroup(heading: string, color: string, names: string[]): FlexComponent[] {
  if (names.length === 0) return [];

  return [
    vbox(
      [
        { type: "text", text: `${heading} (${names.length})`, size: "sm", weight: "bold", color },
        { type: "text", text: names.join(", "), size: "sm", color: COLOR.ink, wrap: true },
      ],
      { spacing: "xs", margin: "lg" },
    ),
  ];
}

export function unpaidList(bill: BillRow, shares: BillShareRow[]): FlexMessage {
  const { paid, unpaid, unpaidTotalSatang, settled } = summarize(shares);
  const names = (list: BillShareRow[]) => list.map((share) => share.display_name);

  return flexMessage(
    settled ? "จ่ายครบทุกคนแล้ว" : `ยังไม่จ่าย ${unpaid.length} คน`,
    bubble({
      body: vbox(
        [
          title(bill.title),
          ...payerGroup("✅ จ่ายแล้ว", COLOR.accent, names(paid)),
          ...(settled
            ? [note("🎉 จ่ายครบทุกคนแล้ว", COLOR.accent)]
            : [
                ...payerGroup("⭕ ยังไม่จ่าย", COLOR.warn, names(unpaid)),
                separator("lg"),
                vbox(
                  [
                    amountRow("ยังไม่ได้รับ", formatBaht(unpaidTotalSatang), true),
                    ...(bill.promptpay
                      ? [infoRow("💸", `พร้อมเพย์ ${formatPromptPay(bill.promptpay)}`)]
                      : []),
                  ],
                  { spacing: "sm", margin: "lg" },
                ),
              ]),
        ],
        { paddingAll: "20px" },
      ),
    }),
  );
}

/** รายชื่อบิลที่เปิดอยู่ ใช้ตอนผู้ใช้ไม่ได้ระบุว่าหมายถึงใบไหน */
export function billChoices(titles: string[]): TextMessage {
  return text(
    [
      "❓ ตอนนี้มีบิลค้างอยู่หลายใบ",
      "",
      ...titles.map((title) => `• ${title}`),
      "",
      'ระบุชื่อบิลด้วย เช่น "บอทจ๋า บิล ' + (titles[0] ?? "ค่ากินข้าว") + '"',
    ].join("\n"),
  );
}

type PaymentOutcome = {
  shares: BillShareRow[];
  people: { user: { display_name: string }; amountSatang: number }[];
  refused: { user: { display_name: string }; reason: string }[];
};

function refusedLines(refused: PaymentOutcome["refused"]): string[] {
  const notInBill = refused
    .filter((entry) => entry.reason === "not_in_bill")
    .map((entry) => entry.user.display_name);
  const notAllowed = refused
    .filter((entry) => entry.reason === "not_allowed")
    .map((entry) => entry.user.display_name);

  return [
    ...(notInBill.length > 0 ? [`ℹ️ ${notInBill.join(", ")} ไม่ได้อยู่ในบิลนี้`] : []),
    ...(notAllowed.length > 0
      ? [`⛔ ${notAllowed.join(", ")} กดแทนได้เฉพาะเจ้าตัว คนที่พามา หรือคนเปิดบิล`]
      : []),
  ];
}

/**
 * ต้องขึ้นชื่อ "คนที่ถูกบันทึกว่าจ่าย" ไม่ใช่ชื่อคนสั่งเสมอไป
 * พิมพ์ "วิท จ่ายแล้ว" แล้วขึ้นว่าคนสั่งจ่าย คืออ่านแล้วเข้าใจผิดว่าเงินมาจากใคร
 */
export function paymentRecorded(actorName: string, result: PaymentOutcome): TextMessage {
  const { unpaid, settled } = summarize(result.shares);
  const total = result.people.reduce((sum, entry) => sum + entry.amountSatang, 0);
  const names = result.people.map((entry) => entry.user.display_name);
  const others = names.filter((name) => name !== actorName);
  const paidSelf = names.includes(actorName);

  const headline = paidSelf
    ? `✅ บันทึกแล้ว ${actorName} จ่าย ${formatBaht(total)}${
        others.length > 0 ? ` (รวม ${others.join(", ")})` : ""
      }`
    : `✅ บันทึกแล้ว ${others.join(", ")} จ่าย ${formatBaht(total)} (${actorName} บันทึกให้)`;

  return text(
    [
      names.length > 0 ? headline : "ℹ️ ยังไม่มีอะไรถูกบันทึกนะครับ",
      ...refusedLines(result.refused),
      settled ? "🎉 ครบทุกคนแล้ว" : `เหลืออีก ${unpaid.length} คน`,
    ].join("\n"),
  );
}

export function paymentUndone(actorName: string, result: PaymentOutcome): TextMessage {
  const { unpaid } = summarize(result.shares);
  const names = result.people.map((entry) => entry.user.display_name);

  return text(
    [
      names.length > 0
        ? `↩️ ${actorName} เอา ${names.join(", ")} กลับไปเป็นยังไม่จ่ายแล้ว`
        : "ℹ️ ไม่มีอะไรถูกเปลี่ยน",
      ...refusedLines(result.refused),
      `ค้างอยู่ ${unpaid.length} คน`,
    ].join("\n"),
  );
}

export function confirmCancelBill(
  pendingId: string,
  bill: BillRow,
  shares: BillShareRow[],
): FlexMessage {
  const { paid } = summarize(shares);

  return flexMessage(
    "ยกเลิกบิล?",
    bubble({
      header: header("⚠️ ยกเลิกบิลนี้?", COLOR.warn),
      body: vbox(
        [
          title(bill.title),
          ...(paid.length > 0
            ? [note(`มีคนบอกว่าจ่ายแล้ว ${paid.length} คน การยกเลิกจะลบบันทึกนั้นทิ้งด้วย`, COLOR.warn)]
            : []),
          note("ยกเลิกแล้วคิดเงินใหม่ได้เลย"),
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(confirmActions(pendingId, "ยกเลิกบิล")),
    }),
  );
}

export function billCancelled(): TextMessage {
  return text('🗑️ ยกเลิกบิลแล้ว\n\nคิดใหม่ได้ด้วย "บอทจ๋า คิดเงิน"');
}

/**
 * การ์ดสรุปประจำสัปดาห์ ส่งเข้ากลุ่มทุกวันศุกร์ 10 โมง (PRP guests-split-bills-and-digest §6.2)
 *
 * ห้ามมีชื่อคนค้างจ่ายเด็ดขาด บอกได้แค่จำนวนใบกับยอดรวม
 * ใครอยากรู้ว่าใครค้างให้พิมพ์ถามเอง ซึ่งเป็น reply และฟรี
 */
export function digestCard(lines: {
  game: {
    playDate: string;
    startTime: string;
    durationMinutes: number;
    courtName: string | null;
    joined: number;
    max: number;
  } | null;
  gameIsOverdue: boolean;
  unpaidBillCount: number;
  unpaidTotalSatang: number;
}): FlexMessage {
  const body: FlexComponent[] = [];

  if (lines.game) {
    const { playDate, startTime, durationMinutes, courtName, joined, max } = lines.game;
    body.push(
      vbox(
        [
          {
            type: "text",
            text: lines.gameIsOverdue ? "🏸 รอบที่ยังไม่ได้ปิด" : "🏸 มีนัด",
            size: "sm",
            weight: "bold",
            color: lines.gameIsOverdue ? COLOR.warn : COLOR.accent,
          },
          {
            type: "text",
            text: `${formatThaiDate(playDate)} ${formatTimeRange(startTime, durationMinutes)}${courtName ? ` · ${courtName}` : ""}`,
            size: "sm",
            color: COLOR.ink,
            wrap: true,
          },
          {
            type: "text",
            text: lines.gameIsOverdue
              ? 'เล่นจบแล้วพิมพ์ "บอทจ๋า ปิดรอบ" เพื่อเปิดรอบใหม่ได้'
              : `ลงชื่อแล้ว ${joined}/${max} คน`,
            size: "sm",
            color: COLOR.muted,
            wrap: true,
          },
        ],
        { spacing: "xs" },
      ),
    );
  }

  if (lines.unpaidBillCount > 0) {
    if (body.length > 0) body.push(separator("lg"));

    body.push(
      vbox(
        [
          { type: "text", text: "💰 บิลค้างจ่าย", size: "sm", weight: "bold", color: COLOR.warn },
          {
            type: "text",
            text: `${lines.unpaidBillCount} ใบ ยังไม่ได้รับ ${formatBaht(lines.unpaidTotalSatang)}`,
            size: "sm",
            color: COLOR.ink,
            wrap: true,
          },
          note('คนเปิดบิลพิมพ์ "บอทจ๋า ใครยังไม่จ่าย" เพื่อดูรายชื่อ'),
        ],
        { spacing: "xs", margin: "lg" },
      ),
    );
  }

  return flexMessage(
    "สรุปประจำสัปดาห์",
    bubble({
      header: header("☀️ สรุปประจำสัปดาห์"),
      body: vbox(body, { paddingAll: "20px" }),
    }),
  );
}

/**
 * แซวคนที่เปลี่ยนใจบ่อย เป็นมุขในก๊วน ไม่ได้บล็อกอะไรทั้งนั้น
 * เตือนตั้งแต่ครั้งที่ 3 เป็นต้นไป (เปลี่ยนใจได้ 2 ครั้งโดยบอทไม่ว่าอะไร)
 */
export const NAG_AFTER_CHANGES = 3;

export function nagFlipFlop(displayName: string, changeCount: number): TextMessage {
  return text(
    [
      `🙄 ${displayName} เปลี่ยนใจรอบที่ ${changeCount} แล้วนะ`,
      "",
      "ตกลงจะเล่นหรือไม่เล่น เอาให้ชัดทีนึงงง 😤",
    ].join("\n"),
  );
}

export function nagEdits(editCount: number): TextMessage {
  return text(
    [
      `😮‍💨 แก้รอบนี้ไปแล้ว ${editCount} ครั้งนะ`,
      "",
      "จะเปลี่ยนอีกไหม เปลือง token นะจ๊ะ 💸",
    ].join("\n"),
  );
}

export function gameSummary(game: GameRow): string {
  return [
    ...(game.court_name ? [`🏟️ ${game.court_name}`] : []),
    `📅 ${formatThaiDate(game.play_date)}`,
    `⏰ ${formatTimeRange(game.start_time, game.duration_minutes)}`,
    `🏸 ${game.court_count} คอร์ท`,
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
      return text("ℹ️ พี่ลงชื่อรอบนี้ไว้แล้วนะครับ");
    case "NOT_JOINED":
      return text("ℹ️ พี่ยังไม่ได้ลงชื่อรอบนี้นะครับ");
    case "GAME_FULL": {
      const current = details.current_players ?? "";
      const max = details.max_players ?? "";
      return text(`⛔ รอบนี้เต็มแล้ว\n\n🏸 ${current}/${max} คน\n\nไม่สามารถลงชื่อเพิ่มได้`);
    }
    case "DATE_IN_PAST":
      return text("❌ วันเวลานี้ผ่านไปแล้วครับพี่ ลองเลือกใหม่นะ");
    case "PENDING_EXPIRED":
      return text("⛔ ปุ่มนี้หมดอายุหรือถูกใช้ไปแล้ว\n\nพิมพ์ “บอทจ๋า เปิดตี” เพื่อเริ่มใหม่");
    case "NOT_REQUESTER":
      return text("⛔ ปุ่มนี้กดได้เฉพาะคนที่สั่งไว้นะครับ");
    case "NOT_GAME_CREATOR":
      return text("⛔ แก้ไข ยกเลิก หรือปิดรอบ ทำได้เฉพาะคนที่เปิดรอบนะครับพี่");
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
      return text("ℹ️ ไม่มีอะไรเปลี่ยนเลยครับพี่");
    case "NO_BILL":
      return text('❌ รอบนี้ยังไม่ได้คิดเงิน\n\nคนที่เปิดรอบพิมพ์ "บอทจ๋า คิดเงิน" ได้เลย');
    case "BILL_ALREADY_EXISTS":
      return text('⛔ รอบนี้คิดเงินไปแล้ว\n\nถ้าจะคิดใหม่ต้องพิมพ์ "บอทจ๋า ยกเลิกบิล" ก่อน');
    case "NOT_YOUR_GUEST":
      return text("⛔ ถอนได้เฉพาะตัวเองกับคนที่พี่ลงชื่อให้นะครับ");
    case "PERSON_NOT_FOUND": {
      const names = (details.names as string[] | undefined) ?? [];
      return text(
        [
          `❓ ไม่รู้จัก ${names.join(", ") || "ชื่อนี้"} ในกลุ่มนี้`,
          "",
          "ถ้าเป็นแขกที่พามาใหม่ พิมพ์ “บอทจ๋า ลงชื่อ <ชื่อ>” เพื่อเพิ่มได้เลย",
        ].join("\n"),
      );
    }
    case "PERSON_AMBIGUOUS": {
      const names = (details.names as string[] | undefined) ?? [];
      return text(`❓ มีหลายคนชื่อ ${names.join(", ")} ในกลุ่มนี้ ระบุให้ชัดกว่านี้หน่อย`);
    }
    case "NOT_IN_BILL":
      return text("ℹ️ พี่ไม่ได้อยู่ในบิลใบนี้นะครับ");
    case "NO_PLAYERS_TO_SPLIT":
      return text("❌ ยังไม่มีใครลงชื่อเลยครับพี่ เลยหารไม่ได้");
    case "AMOUNT_INVALID":
      return text("❌ จำนวนเงินต้องมากกว่า 0 และไม่เกิน 100,000 บาท");
    case "MISSING_FIELDS":
      return text("ℹ️ ข้อมูลยังไม่ครบ ลองเริ่มใหม่ด้วย “บอทจ๋า เปิดตี”");
    default:
      return text("😵 ระบบขัดข้องครับพี่ ลองใหม่อีกทีนะ");
  }
}
