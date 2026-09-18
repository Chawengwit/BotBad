import type {
  FlexBox,
  FlexBubble,
  FlexComponent,
  FlexIcon,
  FlexMessage,
  FlexSeparator,
  FlexText,
  MessageAction,
} from "@/lib/line";

/**
 * ตัวช่วยประกอบ Flex Message (spec §23, §25)
 *
 * ไฟล์นี้รู้แค่เรื่องหน้าตา ไม่รู้จักรอบตีหรือบิล ส่วนที่ว่าการ์ดใบไหนมีอะไรบ้างอยู่ที่ messages.ts
 * แยกไว้เพราะ JSON ของ Flex ยาวจนกลบเนื้อหาของข้อความถ้าเขียนปนกัน
 */

/**
 * สีทั้งหมดที่การ์ดใช้ เลือกให้อ่านออกบนพื้นขาวของ bubble
 * LINE ไม่เปลี่ยนพื้นหลัง bubble ตามธีมของเครื่อง จึงกำหนดสีตรง ๆ ได้
 */
export const COLOR = {
  ink: "#1F2937",
  muted: "#6B7280",
  accent: "#16A34A",
  warn: "#DC2626",
  line: "#E5E7EB",
  soft: "#F3F4F6",
  onAccent: "#FFFFFF",
} as const;

/**
 * ไอคอน Font Awesome Free (solid) ที่การ์ดใช้ ชื่อตรงกับไฟล์ต้นฉบับของ Font Awesome
 * Flex โหลดฟอนต์เองไม่ได้ ไอคอนจึงเป็นไฟล์ PNG ใน public/icons/<สี>/<ชื่อ>.png หนึ่งไฟล์ต่อหนึ่งสี
 * เพิ่มชื่อที่นี่แล้วต้องสร้างไฟล์ให้ครบทุกสีด้วย ไม่งั้นไอคอนจะหายไปเฉย ๆ บนการ์ด
 */
export const ICON_NAMES = [
  "arrow-left",
  "bottle-water",
  "building",
  "calculator",
  "calendar-days",
  "check",
  "circle-check",
  "circle-exclamation",
  "clock",
  "coins",
  "comment-dots",
  "flag-checkered",
  "forward",
  "hourglass-half",
  "list",
  "location-dot",
  "money-bill-wave",
  "pen",
  "plus",
  "receipt",
  "rotate-left",
  "sun",
  "table-tennis-paddle-ball",
  "triangle-exclamation",
  "user-minus",
  "user-plus",
  "users",
  "xmark",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** สีที่มีไฟล์ไอคอนให้ใช้ ไอคอนเป็นรูป เปลี่ยนสีทีหลังไม่ได้ */
export const ICON_COLORS = {
  white: COLOR.onAccent,
  ink: COLOR.ink,
  accent: COLOR.accent,
  warn: COLOR.warn,
} as const;

export type IconColor = keyof typeof ICON_COLORS;

/** LINE โหลดรูปจาก URL สาธารณะผ่าน HTTPS เท่านั้น ไฟล์อยู่บนโดเมนเดียวกับ webhook */
const ICON_BASE_URL = "https://bot-bad.vercel.app/icons";

export function icon(name: IconName, color: IconColor = "accent", size = "sm"): FlexIcon {
  return { type: "icon", url: `${ICON_BASE_URL}/${color}/${name}.png`, size };
}

/** หัวการ์ดหรือหัวข้อ: ไอคอนกับข้อความหนึ่งบรรทัด */
export type Headline = { icon: IconName; text: string };

export function flexMessage(altText: string, contents: FlexBubble): FlexMessage {
  return { type: "flex", altText, contents };
}

export function vbox(contents: FlexComponent[], options: Partial<FlexBox> = {}): FlexBox {
  return { type: "box", layout: "vertical", contents, ...options };
}

export function hbox(contents: FlexComponent[], options: Partial<FlexBox> = {}): FlexBox {
  return { type: "box", layout: "horizontal", contents, ...options };
}

export function separator(margin = "md"): FlexSeparator {
  return { type: "separator", margin, color: COLOR.line };
}

/** ไอคอนนำหน้าข้อความ ใช้ baseline เพราะ Flex วาง icon ได้เฉพาะใน box แบบนี้ */
function iconLine(iconName: IconName, iconColor: IconColor, text: FlexText, options: Partial<FlexBox> = {}): FlexBox {
  return { type: "box", layout: "baseline", spacing: "md", contents: [icon(iconName, iconColor), text], ...options };
}

/** หัวการ์ด แถบสีพร้อมไอคอนและข้อความขาว */
export function header(headline: Headline, color: string = COLOR.accent): FlexBox {
  return vbox(
    [
      iconLine(headline.icon, "white", {
        type: "text",
        text: headline.text,
        color: COLOR.onAccent,
        weight: "bold",
        size: "md",
        wrap: true,
      }),
    ],
    { backgroundColor: color, paddingAll: "16px" },
  );
}

/** หัวข้อย่อยในตัวการ์ด ตัวหนาสีเดียวกับไอคอน */
export function heading(headline: Headline, color: "accent" | "warn" = "accent", size = "sm"): FlexBox {
  return iconLine(headline.icon, color, {
    type: "text",
    text: headline.text,
    size,
    weight: "bold",
    color: COLOR[color],
    wrap: true,
  });
}

/** ชื่อเรื่องตัวใหญ่ในตัวการ์ด เช่น ชื่อคอร์ท */
export function title(text: string): FlexText {
  return { type: "text", text, weight: "bold", size: "xl", color: COLOR.ink, wrap: true };
}

/** บรรทัดข้อมูล: ไอคอนแล้วตามด้วยข้อความ */
export function infoRow(iconName: IconName, value: string, action?: MessageAction): FlexBox {
  const text: FlexText = { type: "text", text: value, size: "sm", color: COLOR.ink, flex: 1, wrap: true };
  return iconLine(iconName, "accent", action ? { ...text, action, color: COLOR.accent } : text);
}

/**
 * บรรทัดจำนวนเงิน ชื่อรายการชิดซ้าย ตัวเลขชิดขวา จะได้ไล่สายตาลงมาเป็นคอลัมน์
 * ใส่ไอคอนได้ถ้าเป็นรายการในบิล
 */
export function amountRow(label: string, amount: string, bold = false, iconName?: IconName): FlexBox {
  const texts: FlexText[] = [
    {
      type: "text",
      text: label,
      size: "sm",
      color: bold ? COLOR.ink : COLOR.muted,
      weight: bold ? "bold" : "regular",
      flex: 4,
      wrap: true,
    },
    {
      type: "text",
      text: amount,
      size: "sm",
      color: COLOR.ink,
      weight: bold ? "bold" : "regular",
      align: "end",
      flex: 2,
    },
  ];

  return iconName
    ? { type: "box", layout: "baseline", spacing: "md", contents: [icon(iconName, "accent"), ...texts] }
    : hbox(texts);
}

export function note(text: string, color: string = COLOR.muted): FlexText {
  return { type: "text", text, size: "xs", color, wrap: true, margin: "md" };
}

export type Button = { label: string; action: MessageAction; icon?: IconName; primary?: boolean };

/**
 * ปุ่มที่มีไอคอน สร้างจาก box ที่ผูก action เพราะ component button ของ Flex ใส่ได้แค่ข้อความ
 * ปุ่มหลักพื้นเขียวตัวขาว ปุ่มอื่นพื้นเทาตัวเข้ม
 */
function buttonBox(button: Button): FlexBox {
  const color = button.primary ? COLOR.onAccent : COLOR.ink;

  return {
    type: "box",
    layout: "baseline",
    action: button.action,
    backgroundColor: button.primary ? COLOR.accent : COLOR.soft,
    cornerRadius: "md",
    paddingAll: "10px",
    spacing: "sm",
    justifyContent: "center",
    flex: 1,
    contents: [
      ...(button.icon ? [icon(button.icon, button.primary ? "white" : "ink")] : []),
      { type: "text", text: button.label, size: "sm", weight: "bold", color, flex: 0 },
    ],
  };
}

/** ปุ่มท้ายการ์ด เรียงแถวละสองปุ่ม จะได้ไม่ยาวเป็นหางเวลามีตัวเลือกเยอะ */
export function footerButtons(buttons: Button[]): FlexBox {
  const rows: FlexBox[] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(hbox(buttons.slice(index, index + 2).map(buttonBox), { spacing: "sm" }));
  }
  return vbox(rows, { spacing: "sm", paddingAll: "12px" });
}

/**
 * การ์ดคำถามหรือเมนู: หัวข้อ รายละเอียด แล้วปุ่มท้ายการ์ด
 * ใช้แทนข้อความธรรมดาเมื่อมีปุ่ม เพราะปุ่มท้ายการ์ดกดได้ทั้งบนมือถือและ LINE PC
 */
export function questionCard(question: Headline, details: FlexComponent[], buttons: Button[]): FlexMessage {
  return flexMessage(
    question.text,
    bubble({
      body: vbox([heading(question, "accent", "md"), ...details], { spacing: "md", paddingAll: "20px" }),
      footer: footerButtons(buttons),
    }),
  );
}

export function bubble(parts: {
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
}): FlexBubble {
  return { type: "bubble", ...parts };
}
