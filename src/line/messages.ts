import type { ErrorCode } from "@/errors/app-errors";
import type { FlexBox, FlexComponent, FlexMessage, LineMessage, TextMessage } from "@/lib/line";
import {
  amountRow,
  bubble,
  type Button,
  COLOR,
  flexMessage,
  footerButtons,
  header,
  heading,
  type Headline,
  icon,
  type IconName,
  infoRow,
  note,
  questionCard,
  separator,
  title,
  vbox,
} from "./flex";
import { addDays, formatDuration, formatThaiDate, formatTimeRange, todayInBangkok } from "@/lib/time";
import type { PendingActionType } from "@/repositories/pending-action.repository";
import { WAKE_WORD } from "@/router/wake-word";
import { MAX_PLAYERS, MIN_PLAYERS, type GameDraft } from "@/services/game.service";
import {
  summarize,
  toBaht,
  type BillEditPlan,
  type BillMenuOptions,
  type GameBillBlock,
} from "@/services/bill.service";
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

/** ปุ่มตัวเลือกของ wizard ตัวเลือกที่เป็นตัวเลขล้วนไม่ต้องมีไอคอน */
function choice(label: string, data: string, iconName?: IconName): Button {
  return { label, ...(iconName ? { icon: iconName } : {}), action: { type: "postback", label, data } };
}

/** ปุ่มเปิดปฏิทิน ค่าที่เลือกส่งกลับมาใน params ของ postback ไม่ได้อยู่ใน data */
function picker(
  label: string,
  iconName: IconName,
  data: string,
  options: { mode: "date" | "time" | "datetime"; initial: string; min?: string },
): Button {
  return { label, icon: iconName, action: { type: "datetimepicker", label, data, ...options } };
}

export function askCourtCount(pendingId: string): FlexMessage {
  return questionCard(
    { icon: "table-tennis-paddle-ball", text: "เปิดรอบตีแบด กี่คอร์ท?" },
    [],
    [1, 2, 3, 4].map((count) => choice(`${count} คอร์ท`, wizardData(pendingId, "court", String(count)))),
  );
}

export function askDate(pendingId: string, today: string = todayInBangkok()): FlexMessage {
  return questionCard({ icon: "calendar-days", text: "วันไหน?" }, [], [
    choice("วันนี้", wizardData(pendingId, "date", "today")),
    choice("พรุ่งนี้", wizardData(pendingId, "date", "tomorrow")),
    picker("เลือกวัน", "calendar-days", wizardData(pendingId, "date", "picker"), {
      mode: "date",
      initial: today,
      min: today,
    }),
  ]);
}

export function askTime(pendingId: string): FlexMessage {
  return questionCard({ icon: "clock", text: "กี่โมง?" }, [], [
    ...WIZARD_TIME_CHOICES.map((time) => choice(time, wizardData(pendingId, "time", time))),
    picker("กำหนดเวลาเอง", "clock", wizardData(pendingId, "time", "picker"), {
      mode: "time",
      initial: "19:00",
    }),
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
): FlexMessage {
  const shortcut = (label: string, date: string) =>
    choice(`${label} ${usualTime}`, wizardData(pendingId, "when", `${date} ${usualTime}`));

  return questionCard({ icon: "calendar-days", text: "ตีเมื่อไหร่?" }, [], [
    shortcut("วันนี้", today),
    shortcut("พรุ่งนี้", addDays(today, 1)),
    picker("เลือกวันและเวลา", "calendar-days", wizardData(pendingId, "when", "picker"), {
      mode: "datetime",
      initial: `${today}T${usualTime}`,
      min: `${today}T00:00`,
    }),
  ]);
}

export function askDuration(pendingId: string): FlexMessage {
  return questionCard(
    { icon: "hourglass-half", text: "เล่นกี่ชั่วโมง?" },
    [],
    WIZARD_DURATION_CHOICES.map((minutes) =>
      choice(`${minutes / 60} ชั่วโมง`, wizardData(pendingId, "duration", String(minutes))),
    ),
  );
}

/** ค่าปกติคือ คอร์ท x 8 แล้วให้เลือกบวกลบได้ทีละ 2 (spec §7) */
export function playerCountChoices(courtCount: number): number[] {
  const base = courtCount * 8;
  return [base - 4, base - 2, base, base + 2, base + 4].filter(
    (value) => value >= MIN_PLAYERS && value <= MAX_PLAYERS,
  );
}

export function askMaxPlayers(pendingId: string, courtCount: number): FlexMessage {
  const base = courtCount * 8;

  return questionCard(
    { icon: "users", text: "รับกี่คน?" },
    [note(`ค่าปกติของ ${courtCount} คอร์ทคือ ${base} คน`)],
    playerCountChoices(courtCount).map((count) =>
      choice(count === base ? `${count} คน (ปกติ)` : `${count} คน`, wizardData(pendingId, "max", String(count))),
    ),
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
): FlexMessage {
  return questionCard(
    { icon: "building", text: "ที่เดิมไหม?" },
    [
      vbox(
        [
          { type: "text", text: courtName, size: "md", weight: "bold", color: COLOR.ink, wrap: true },
          ...(hasMap ? [infoRow("location-dot", "มีลิงก์แผนที่")] : []),
          ...(promptpay ? [infoRow("money-bill-wave", `พร้อมเพย์ ${formatPromptPay(promptpay)}`)] : []),
        ],
        { spacing: "sm" },
      ),
    ],
    [
      choice("ที่เดิม", wizardData(pendingId, "venue", "same"), "rotate-left"),
      choice("เปลี่ยนที่", wizardData(pendingId, "venue", "change"), "pen"),
    ],
  );
}

export function askLocation(pendingId: string): FlexMessage {
  return questionCard(
    { icon: "location-dot", text: "มีลิงก์แผนที่ไหม?" },
    [note("วางลิงก์ Google Maps หรือกดแชร์ตำแหน่งมาก็ได้ ถ้าไม่มีก็กดข้ามได้เลย")],
    [choice("ข้าม", wizardData(pendingId, "location", "skip"), "forward")],
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

export function askPromptPay(pendingId: string, lastUsed: string | null): FlexMessage {
  return questionCard(
    { icon: "money-bill-wave", text: "เลขพร้อมเพย์สำหรับตอนคิดเงิน?" },
    [note("พิมพ์เบอร์มือถือหรือเลขบัตรประชาชนของคนรับโอน ถ้ายังไม่ใส่ก็กดข้ามได้")],
    [
      ...(lastUsed
        ? [choice(`ใช้ ${formatPromptPay(lastUsed)}`, wizardData(pendingId, "promptpay", "reuse"), "rotate-left")]
        : []),
      choice("ข้าม", wizardData(pendingId, "promptpay", "skip"), "forward"),
    ],
  );
}

const COMMAND_ICONS = {
  เปิดตี: "plus",
  ลงชื่อ: "user-plus",
  ถอนชื่อ: "user-minus",
  ใครตีบ้าง: "list",
  คิดเงิน: "calculator",
} as const satisfies Record<string, IconName>;

/** ปุ่มลัดส่งเป็นข้อความที่มี wake word ครบ จะได้เข้าทางเดิมทุกครั้ง */
function commandButtons(commands: (keyof typeof COMMAND_ICONS)[]): Button[] {
  return commands.map((command) => ({
    label: command,
    icon: COMMAND_ICONS[command],
    action: { type: "message", label: command, text: `${WAKE_WORD} ${command}` },
  }));
}

/** ใช้เมื่อ Gemini ล่ม โควตาหมด หรือยังไม่ได้ตั้งค่า (LLM Design §9) */
export function fallbackMenu(): FlexMessage {
  return questionCard(
    { icon: "comment-dots", text: "ผมยังไม่เข้าใจประโยคนี้ครับพี่" },
    [note("ลองเลือกจากด้านล่างได้เลย")],
    commandButtons(["เปิดตี", "ลงชื่อ", "ถอนชื่อ", "ใครตีบ้าง"]),
  );
}

/**
 * ตอบตอนมีคนเรียกชื่อบอทเฉย ๆ ยังไม่ได้สั่งอะไร
 * หลังจากนี้บอทเปิดโหมดฟัง สั่งต่อได้เลยโดยไม่ต้องเรียกชื่ออีก (spec §6)
 */
export function greeting(): FlexMessage {
  return questionCard(
    { icon: "table-tennis-paddle-ball", text: "ว่าไงครับพี่" },
    [],
    commandButtons(["เปิดตี", "ลงชื่อ", "ใครตีบ้าง", "คิดเงิน"]),
  );
}

function helpSection(name: string, lines: string[]): FlexComponent {
  return vbox(
    [
      { type: "text", text: name, size: "sm", weight: "bold", color: COLOR.ink },
      ...lines.map((line) => ({ type: "text" as const, text: `• ${line}`, size: "sm", color: COLOR.ink, wrap: true })),
    ],
    { spacing: "xs" },
  );
}

/**
 * เมนูช่วยเหลือ — เป็นหนึ่งในกรณีที่แนบปุ่มได้ เพราะบอทรอคำสั่งอยู่ (spec §23)
 * สำคัญขึ้นมากตั้งแต่เลิกแนบปุ่มท้ายผลลัพธ์ เพราะนี่คือทางเดียวที่คนใหม่ในกลุ่มจะรู้ว่าสั่งอะไรได้
 */
export function helpMenu(): FlexMessage {
  return questionCard(
    { icon: "table-tennis-paddle-ball", text: "บอทจ๋าช่วยอะไรได้บ้าง" },
    [
      helpSection("รอบตี", [
        "เปิดตี — เปิดรอบใหม่",
        "ลงชื่อ / ถอนชื่อ",
        "ใครตีบ้าง — ดูรายชื่อ",
        "แก้ไข / ยกเลิก / ปิดรอบ (เฉพาะคนเปิดรอบ)",
      ]),
      helpSection("ค่าใช้จ่าย", [
        "คิดเงิน — หารค่าคอร์ทและลูกแบด (เฉพาะคนเปิดรอบ)",
        "บิล / ใครยังไม่จ่าย",
        "จ่ายแล้ว / ยังไม่จ่าย",
      ]),
      note(`พิมพ์ "${WAKE_WORD}" นำหน้า หรือเรียก "${WAKE_WORD}" เฉย ๆ ครั้งเดียวแล้วสั่งต่อได้เลย`),
    ],
    commandButtons(["เปิดตี", "ลงชื่อ", "ใครตีบ้าง", "คิดเงิน"]),
  );
}

/** ผู้ใช้บอกเองว่าจบแล้ว ปิดโหมดฟังทันทีไม่ต้องรอหมดเวลา */
export function goodbye(): TextMessage {
  return text("ได้เลยครับพี่ 👋 เรียก \"บอทจ๋า\" ได้ใหม่ทุกเมื่อ");
}

export function askAgain(message: string): TextMessage {
  return text(message);
}

function confirmActions(pendingId: string, confirmLabel: string, rejectLabel = "ยกเลิก"): Button[] {
  return [
    {
      label: confirmLabel,
      icon: "check",
      primary: true,
      action: {
        type: "postback",
        label: confirmLabel,
        data: new URLSearchParams({ action: "confirm", pending_id: pendingId }).toString(),
      },
    },
    {
      label: rejectLabel,
      icon: rejectLabel === "กลับ" ? "arrow-left" : "xmark",
      action: {
        type: "postback",
        label: rejectLabel,
        data: new URLSearchParams({ action: "reject", pending_id: pendingId }).toString(),
      },
    },
  ];
}

export function confirmCreateGame(pendingId: string, draft: GameDraft): FlexMessage {
  return flexMessage(
    "ยืนยันเปิดรอบตี?",
    bubble({
      header: header({ icon: "table-tennis-paddle-ball", text: "ยืนยันเปิดรอบตี?" }),
      body: vbox(
        [
          title(draft.court_name),
          vbox(
            [
              infoRow("calendar-days", formatThaiDate(draft.play_date)),
              infoRow("clock", formatTimeRange(draft.start_time, draft.duration_minutes)),
              infoRow("table-tennis-paddle-ball", `${draft.court_count} คอร์ท`),
              infoRow("users", `รับ ${draft.max_players} คน`),
              ...(draft.location_url ? [infoRow("location-dot", "มีลิงก์แผนที่")] : []),
              ...(draft.promptpay
                ? [infoRow("money-bill-wave", `พร้อมเพย์ ${formatPromptPay(draft.promptpay)}`)]
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
    infoRow("calendar-days", formatThaiDate(game.play_date)),
    infoRow("clock", formatTimeRange(game.start_time, game.duration_minutes)),
    infoRow("table-tennis-paddle-ball", `${game.court_count} คอร์ท`),
    infoRow("users", playerLine),
    // ใน Flex ข้อความไม่กลายเป็นลิงก์ให้เอง ต้องผูก action เข้ากับบรรทัดนั้นเอง
    ...(game.location_url
      ? [infoRow("location-dot", "เปิดแผนที่", { type: "uri" as const, label: "แผนที่", uri: game.location_url })]
      : []),
  ];
}

/**
 * การ์ดรอบตี — Flex ไม่มีปุ่ม (spec §23)
 * LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ ทุกครั้งที่มีความเคลื่อนไหวจึงส่งการ์ดใบใหม่
 */
export function gameCard(game: GameRow, joinedCount: number, headline?: Headline): FlexMessage {
  const courtName = game.court_name ?? "BADMINTON";

  return flexMessage(
    `${headline?.text ?? courtName} ${formatThaiDate(game.play_date)}`,
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

export function editMenu(pendingId: string): FlexMessage {
  const fields: [string, string, IconName][] = [
    ["จำนวนคอร์ท", "court", "table-tennis-paddle-ball"],
    ["จำนวนคน", "max", "users"],
    ["วันที่", "date", "calendar-days"],
    ["เวลา", "time", "clock"],
    ["ระยะเวลา", "duration", "hourglass-half"],
    ["ชื่อคอร์ท", "name", "building"],
    ["แผนที่", "location", "location-dot"],
    ["พร้อมเพย์", "promptpay", "money-bill-wave"],
  ];

  return questionCard(
    { icon: "pen", text: "ต้องการแก้ไขอะไร?" },
    [],
    fields.map(([label, value, iconName]) => choice(label, wizardData(pendingId, "field", value), iconName)),
  );
}

function changeLines(game: GameRow, patch: EditPatch): Headline[] {
  const lines: Headline[] = [];
  const add = (iconName: IconName, text: string) => lines.push({ icon: iconName, text });

  if (patch.court_count !== undefined) {
    add("table-tennis-paddle-ball", `${game.court_count} → ${patch.court_count} คอร์ท`);
  }
  if (patch.max_players !== undefined) {
    add("users", `รับ ${game.max_players} → ${patch.max_players} คน`);
  }
  if (patch.court_name !== undefined) {
    add("building", `${game.court_name ?? "(ยังไม่ระบุ)"} → ${patch.court_name}`);
  }
  if (patch.location_url !== undefined) {
    add("location-dot", "อัปเดตลิงก์แผนที่");
  }
  if (patch.promptpay !== undefined) {
    const before = game.promptpay ? formatPromptPay(game.promptpay) : "(ยังไม่ระบุ)";
    add("money-bill-wave", `พร้อมเพย์ ${before} → ${formatPromptPay(patch.promptpay)}`);
  }
  if (patch.play_date !== undefined) {
    add("calendar-days", `${formatThaiDate(game.play_date)} → ${formatThaiDate(patch.play_date)}`);
  }
  if (patch.start_time !== undefined) {
    add("clock", `${game.start_time} → ${patch.start_time}`);
  }
  if (patch.duration_minutes !== undefined) {
    add("hourglass-half", `${formatDuration(game.duration_minutes)} → ${formatDuration(patch.duration_minutes)}`);
  }

  return lines;
}

export function confirmEditGame(pendingId: string, game: GameRow, patch: EditPatch): FlexMessage {
  return flexMessage(
    "ยืนยันการแก้ไข?",
    bubble({
      header: header({ icon: "pen", text: "ยืนยันการแก้ไข?" }),
      body: vbox(
        [
          vbox(
            changeLines(game, patch).map((line) => infoRow(line.icon, line.text)),
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
      header: header({ icon: "triangle-exclamation", text: "ยกเลิกรอบตีนี้?" }, COLOR.warn),
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
        heading(
          { icon: "triangle-exclamation", text: `ยังมีคนไม่จ่าย ${unpaid.length} คน — รวม ${formatBaht(total)}` },
          "warn",
        ),
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
      header: header({ icon: "flag-checkered", text: "ปิดรอบตีนี้?" }),
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
    case "edit_bill":
      return text("ได้ครับพี่ บิลยังเหมือนเดิม");
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

export function askCourtFee(pendingId: string): FlexMessage {
  return questionCard(
    { icon: "building", text: "ค่าคอร์ทเท่าไหร่?" },
    [note("กดเลือกหรือพิมพ์จำนวนเงินมาได้เลย")],
    [
      ...COURT_FEE_CHOICES.map((baht) => choice(`${baht}`, wizardData(pendingId, "court_fee", String(baht)))),
      choice("ไม่มีค่าคอร์ท", wizardData(pendingId, "court_fee", "skip"), "forward"),
    ],
  );
}

export function askShuttleCount(pendingId: string): FlexMessage {
  return questionCard({ icon: "table-tennis-paddle-ball", text: "ใช้ลูกแบดกี่ลูก?" }, [], [
    ...SHUTTLE_COUNT_CHOICES.map((count) => choice(`${count} ลูก`, wizardData(pendingId, "shuttle_count", String(count)))),
    choice("ไม่มี", wizardData(pendingId, "shuttle_count", "0"), "forward"),
  ]);
}

export function askShuttlePrice(pendingId: string, lastPriceSatang: number | null): FlexMessage {
  const last = lastPriceSatang === null ? null : toBaht(lastPriceSatang);
  const choices = [...(last !== null ? [last] : []), ...SHUTTLE_PRICE_CHOICES.filter((baht) => baht !== last)];

  return questionCard(
    { icon: "table-tennis-paddle-ball", text: "ลูกละเท่าไหร่?" },
    [note("กดเลือกหรือพิมพ์จำนวนเงินมาได้เลย")],
    choices.map((baht, index) =>
      choice(
        index === 0 && last !== null ? `${baht} (ครั้งก่อน)` : `${baht}`,
        wizardData(pendingId, "shuttle_price", String(baht)),
      ),
    ),
  );
}

export function askExtraItem(pendingId: string): FlexMessage {
  return questionCard({ icon: "plus", text: "มีค่าอื่นอีกไหม?" }, [], [
    choice("ค่าน้ำ", wizardData(pendingId, "extra", "water"), "bottle-water"),
    choice("อื่น ๆ", wizardData(pendingId, "extra", "other"), "plus"),
    choice("ไม่มีแล้ว", wizardData(pendingId, "extra", "done"), "check"),
  ]);
}

export function askAmount(label: string): TextMessage {
  return text(`💵 ${label}เท่าไหร่?\n\nพิมพ์จำนวนเงินตอบได้เลย`);
}

export function askOtherItem(): TextMessage {
  return text('➕ พิมพ์ชื่อรายการกับจำนวนเงินมาในบรรทัดเดียว\n\nเช่น "ค่าเช่าไม้ 100"');
}

function itemIcon(label: string): IconName {
  if (label === "ค่าคอร์ท") return "building";
  if (label === "ลูกแบด") return "table-tennis-paddle-ball";
  if (label.includes("น้ำ")) return "bottle-water";
  return "plus";
}

function itemLabel(item: { label: string; quantity: number; unit_price_satang: number }): string {
  return item.quantity > 1
    ? `${item.label} ${item.quantity} ลูก × ${formatBaht(item.unit_price_satang)}`
    : item.label;
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
            amountRow(itemLabel(item), formatBaht(item.amount_satang), false, itemIcon(item.label)),
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
        heading({ icon: "circle-exclamation", text: "ยังไม่จ่าย" }, "warn"),
        ...shareRows(unpaid),
        ...(paid.length > 0 ? [heading({ icon: "circle-check", text: `จ่ายแล้ว ${paid.length} คน` }, "accent", "xs")] : []),
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
  promptpay: string | null = null,
): FlexMessage {
  return flexMessage(
    "ส่งบิลเข้ากลุ่มเลยไหม?",
    bubble({
      header: header({ icon: "receipt", text: "ตรวจบิลก่อนส่ง" }),
      body: vbox(
        [
          ...billBody(title, items, totalSatang, shares),
          separator("lg"),
          vbox(shareRows(shares), { spacing: "sm", margin: "lg" }),
          // เลขโอนต้องให้เห็นก่อนส่ง พิมพ์ผิดหลักเดียวเงินก็ไปผิดคน
          ...(promptpay
            ? [
                separator("lg"),
                vbox([infoRow("money-bill-wave", `พร้อมเพย์ ${formatPromptPay(promptpay)}`)], { margin: "lg" }),
              ]
            : []),
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
  headline?: Headline,
): FlexMessage {
  const { unpaidTotalSatang, settled } = summarize(shares);

  return flexMessage(
    headline?.text ?? `บิล ${bill.title}`,
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
                ? [infoRow("money-bill-wave", `โอนให้ ${creatorName(shares, bill)} · ${formatPromptPay(bill.promptpay)}`)]
                : []),
              // ใช้รูปเหรียญ ไม่ใช่ไอคอนเตือน เพราะไอคอนเตือนเป็นหัวรายชื่อคนค้างไปแล้วข้างบน
              infoRow(
                settled ? "circle-check" : "coins",
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
function payerGroup(group: Headline, tone: "accent" | "warn", names: string[]): FlexComponent[] {
  if (names.length === 0) return [];

  return [
    vbox(
      [
        heading({ icon: group.icon, text: `${group.text} (${names.length})` }, tone),
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
          ...payerGroup({ icon: "circle-check", text: "จ่ายแล้ว" }, "accent", names(paid)),
          ...(settled
            ? [heading({ icon: "circle-check", text: "จ่ายครบทุกคนแล้ว" })]
            : [
                ...payerGroup({ icon: "circle-exclamation", text: "ยังไม่จ่าย" }, "warn", names(unpaid)),
                separator("lg"),
                vbox(
                  [
                    amountRow("ยังไม่ได้รับ", formatBaht(unpaidTotalSatang), true),
                    ...(bill.promptpay
                      ? [infoRow("money-bill-wave", `พร้อมเพย์ ${formatPromptPay(bill.promptpay)}`)]
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
      header: header({ icon: "triangle-exclamation", text: "ยกเลิกบิลนี้?" }, COLOR.warn),
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

/** LINE ปฏิเสธป้ายปุ่มที่ยาวเกิน 40 ตัวอักษร ส่วนชื่อบิลกับชื่อรายการตั้งเองได้ยาวกว่านั้น */
const MAX_ACTION_LABEL = 40;

function fitLabel(label: string): string {
  return label.length <= MAX_ACTION_LABEL ? label : `${label.slice(0, MAX_ACTION_LABEL - 1)}…`;
}

/** เหตุผลที่คิดค่ารอบไม่ได้ ทั้งที่มีรอบเปิดอยู่ */
export function gameBillBlockedNote(game: GameRow, reason: GameBillBlock): string {
  const date = formatThaiDate(game.play_date);
  return reason === "not_creator"
    ? `คิดค่ารอบ ${date} ได้เฉพาะคนที่เปิดรอบ`
    : `รอบ ${date} ยังไม่มีใครลงชื่อ เลยยังคิดค่ารอบไม่ได้`;
}

/**
 * "คิดเงิน" เฉย ๆ ถามก่อนว่าเงินเรื่องไหน (spec §23 กรณีกำลังถาม)
 * ปุ่มที่ใช้ไม่ได้ไม่ขึ้น แต่บอกเหตุผลไว้ใต้คำถาม คนกดจะได้ไม่งงว่าปุ่มคิดค่ารอบหายไปไหน
 * วันที่ของรอบอยู่ในตัวการ์ด ไม่ใส่ในป้ายปุ่ม เพราะปุ่มครึ่งแถวใส่ได้แค่ราวสิบกว่าตัวอักษร
 */
export function billMenu(pendingId: string, options: BillMenuOptions): FlexMessage {
  const { game, gameBlocked, editableBills } = options;

  const details: FlexComponent[] = game
    ? [
        infoRow(
          "table-tennis-paddle-ball",
          `รอบ ${formatThaiDate(game.play_date)}${game.court_name ? ` · ${game.court_name}` : ""}`,
        ),
      ]
    : gameBlocked
      ? [note(gameBillBlockedNote(gameBlocked.game, gameBlocked.reason))]
      : [];

  return questionCard({ icon: "calculator", text: "คิดเงินอะไรดี?" }, details, [
    ...(game ? [choice("คิดค่ารอบ", wizardData(pendingId, "bill_kind", "game"), "table-tennis-paddle-ball")] : []),
    choice("สร้างบิลใหม่", wizardData(pendingId, "bill_kind", "new"), "plus"),
    ...(editableBills.length > 0 ? [choice("แก้บิลเดิม", wizardData(pendingId, "bill_kind", "edit"), "pen")] : []),
  ]);
}

/**
 * ขอชื่อบิลกับรายการ พิมพ์มาอิสระได้เลย บอทให้ Gemini แปลงเป็นบิล
 * เป็นข้อความธรรมดาเพราะไม่มีปุ่มให้กด (spec §23)
 */
export function askNewBillDetails(title = "", reason = ""): TextMessage {
  return text(
    [
      ...(reason ? [`ℹ️ ${reason}`, ""] : []),
      title
        ? `🧾 พิมพ์รายการของบิล "${title}" มาได้เลย บรรทัดละรายการ`
        : "🧾 พิมพ์ชื่อบิลกับรายการมาได้เลย บรรทัดละรายการ",
      "",
      "เช่น",
      ...(title ? [] : ["บิล ร้านข้าวต้ม"]),
      "ค่าข้าว 900 เชวง แบงค์ กิ้ฟ",
      "ค่าน้ำ 60 เชวง แบงค์",
      "",
      "ไม่ใส่ชื่อ = เก็บทุกคนในบิล",
    ].join("\n"),
  );
}

/** ไม่มี Gemini ให้ตีความประโยคอิสระ ต้องตั้งชื่อบิลมากับคำสั่งแล้วตอบทีละขั้นแบบเดิม */
export function askNewBillCommand(reason = ""): TextMessage {
  return text(
    [
      ...(reason ? [`ℹ️ ${reason}`, ""] : []),
      `🧾 พิมพ์ "${WAKE_WORD} คิดเงิน <ชื่อบิล>" เพื่อสร้างบิลใหม่`,
      `เช่น "${WAKE_WORD} คิดเงิน ค่ากินข้าว"`,
    ].join("\n"),
  );
}

/** บิลที่ให้เลือกแก้ได้ต่อครั้ง กลุ่มจริงมีบิลค้างพร้อมกันไม่กี่ใบ */
const MAX_BILL_CHOICES = 6;

/** แก้ได้หลายใบ ถามก่อนว่าใบไหน ป้ายเป็นชื่อบิลซึ่งยาวได้ จึงเรียงแถวละปุ่ม */
export function askWhichBillToEdit(pendingId: string, bills: BillRow[]): FlexMessage {
  return questionCard(
    { icon: "pen", text: "แก้บิลไหน?" },
    [],
    bills
      .slice(0, MAX_BILL_CHOICES)
      .map((bill) => choice(fitLabel(bill.title), wizardData(pendingId, "edit_bill", bill.id), "receipt")),
    1,
  );
}

/** รายการที่กำลังจะลบ ขีดฆ่าไว้ให้เห็นว่าอะไรหายไปก่อนกดยืนยัน */
function removedItemRow(item: BillItemRow): FlexBox {
  const struck = { size: "sm", color: COLOR.muted, decoration: "line-through" } as const;

  return {
    type: "box",
    layout: "baseline",
    spacing: "md",
    contents: [
      icon("xmark", "warn"),
      { type: "text", text: itemLabel(item), flex: 4, wrap: true, ...struck },
      { type: "text", text: formatBaht(item.amount_satang), align: "end", flex: 2, ...struck },
    ],
  };
}

/**
 * การ์ดแก้บิล: หน้าตาบิลหลังแก้ ให้ตรวจก่อนกดยืนยัน
 * รายการใหม่มีป้าย "(ใหม่)" รายการที่จะลบขีดฆ่าไว้ และเตือนว่าใครจะกลับเป็นยังไม่จ่าย
 * ยังไม่ได้แก้อะไรก็ยังไม่มีปุ่มยืนยัน มีแค่ปุ่มเพิ่ม/ลบรายการ
 */
export function editBillCard(
  pendingId: string,
  bill: BillRow,
  plan: BillEditPlan,
  names: Map<string, string>,
  canAddMore = true,
): FlexMessage {
  const nameOf = (userId: string) => names.get(userId) ?? "แขก";
  const listOf = (shares: BillShareRow[]) => shares.map((share) => share.display_name).join(", ");

  const itemRows = plan.items.map((item) =>
    vbox(
      [
        amountRow(
          item.added ? `${item.label} (ใหม่)` : itemLabel({ ...item, unit_price_satang: item.unitPriceSatang }),
          formatBaht(item.amountSatang),
          false,
          item.added ? "plus" : itemIcon(item.label),
        ),
        note(payerLabel(item.payers.map((payer) => ({ display_name: nameOf(payer.userId) })), plan.shares.length)),
      ],
      { spacing: "none" },
    ),
  );

  const warnings = [
    ...(plan.resetPaid.length > 0
      ? [note(`${listOf(plan.resetPaid)} บอกว่าจ่ายแล้ว แต่ยอดเปลี่ยน จะกลับเป็นยังไม่จ่าย`, COLOR.warn)]
      : []),
    ...(plan.droppedPaid.length > 0
      ? [note(`${listOf(plan.droppedPaid)} จ่ายแล้วแต่ไม่อยู่ในบิลแล้ว บันทึกการจ่ายจะหายไปด้วย`, COLOR.warn)]
      : []),
  ];

  const [confirmButton, rejectButton] = confirmActions(pendingId, "ยืนยันแก้บิล");
  const editButtons: Button[] = [
    ...(canAddMore ? [choice("เพิ่มรายการ", wizardData(pendingId, "edit", "add"), "plus")] : []),
    // ห้ามลบจนไม่เหลือรายการ บิลที่ไม่มีรายการไม่ใช่บิล ต้องยกเลิกบิลแทน
    ...(plan.items.length > 1 ? [choice("ลบรายการ", wizardData(pendingId, "edit", "remove"), "list")] : []),
  ];

  return flexMessage(
    `แก้บิล ${bill.title}`,
    bubble({
      header: header({ icon: "pen", text: "แก้บิล" }),
      body: vbox(
        [
          title(bill.title),
          vbox([...itemRows, ...plan.removed.map(removedItemRow)], { spacing: "md", margin: "lg" }),
          separator("lg"),
          vbox(
            [
              amountRow("รวม", formatBaht(plan.totalSatang), true),
              ...(plan.totalSatang !== bill.total_satang ? [note(`เดิม ${formatBaht(bill.total_satang)}`)] : []),
            ],
            { margin: "lg" },
          ),
          separator("lg"),
          vbox(
            plan.shares.map((share) => amountRow(nameOf(share.userId), formatBaht(share.amountSatang))),
            { spacing: "sm", margin: "lg" },
          ),
          ...warnings,
        ],
        { paddingAll: "20px" },
      ),
      footer: footerButtons(
        plan.changed && confirmButton && rejectButton
          ? [confirmButton, rejectButton, ...editButtons]
          : [...editButtons, ...(rejectButton ? [rejectButton] : [])],
      ),
    }),
  );
}

/** เลือกรายการที่จะลบ ป้ายมีทั้งชื่อรายการและยอด จึงเรียงแถวละปุ่ม */
export function askWhichItemToRemove(pendingId: string, plan: BillEditPlan): FlexMessage {
  return questionCard(
    { icon: "list", text: "ลบรายการไหน?" },
    [],
    [
      ...plan.items.map((item) =>
        choice(
          fitLabel(`${item.label} ${formatBaht(item.amountSatang)}`),
          wizardData(pendingId, "edit_remove", item.ref),
          "xmark",
        ),
      ),
      choice("กลับ", wizardData(pendingId, "edit", "back"), "arrow-left"),
    ],
    1,
  );
}

/** ขอรายการที่จะเพิ่มเข้าบิล รูปแบบเดียวกับตอนสร้างบิล */
export function askEditItems(): TextMessage {
  return text(
    [
      "➕ พิมพ์รายการที่จะเพิ่มได้เลย บรรทัดละรายการ",
      "",
      "เช่น",
      "ค่าน้ำแข็ง 40",
      "ค่าขนม 120 เชวง แบงค์",
      "",
      "ไม่ใส่ชื่อ = เก็บทุกคนในบิล",
    ].join("\n"),
  );
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
          heading(
            { icon: "table-tennis-paddle-ball", text: lines.gameIsOverdue ? "รอบที่ยังไม่ได้ปิด" : "มีนัด" },
            lines.gameIsOverdue ? "warn" : "accent",
          ),
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
          heading({ icon: "coins", text: "บิลค้างจ่าย" }, "warn"),
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
      header: header({ icon: "sun", text: "สรุปประจำสัปดาห์" }),
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
