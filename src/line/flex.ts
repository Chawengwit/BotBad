import type {
  FlexBox,
  FlexBubble,
  FlexComponent,
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
  onAccent: "#FFFFFF",
} as const;

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

/** หัวการ์ด แถบสีพร้อมข้อความขาว */
export function header(title: string, color: string = COLOR.accent): FlexBox {
  return vbox([{ type: "text", text: title, color: COLOR.onAccent, weight: "bold", size: "md", wrap: true }], {
    backgroundColor: color,
    paddingAll: "16px",
  });
}

/** ชื่อเรื่องตัวใหญ่ในตัวการ์ด เช่น ชื่อคอร์ท */
export function title(text: string): FlexText {
  return { type: "text", text, weight: "bold", size: "xl", color: COLOR.ink, wrap: true };
}

/** บรรทัดข้อมูล: ไอคอนคงที่กว้างเท่ากันทุกแถว แล้วค่อยเป็นข้อความ */
export function infoRow(icon: string, value: string, action?: MessageAction): FlexBox {
  const text: FlexText = { type: "text", text: value, size: "sm", color: COLOR.ink, flex: 5, wrap: true };

  return hbox([{ type: "text", text: icon, size: "sm", flex: 1 }, action ? { ...text, action, color: COLOR.accent } : text], {
    spacing: "sm",
  });
}

/** บรรทัดจำนวนเงิน ชื่อรายการชิดซ้าย ตัวเลขชิดขวา จะได้ไล่สายตาลงมาเป็นคอลัมน์ */
export function amountRow(label: string, amount: string, bold = false): FlexBox {
  return hbox([
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
  ]);
}

export function note(text: string, color: string = COLOR.muted): FlexText {
  return { type: "text", text, size: "xs", color, wrap: true, margin: "md" };
}

/** ปุ่มท้ายการ์ด ใช้เฉพาะการ์ดที่ขอให้กดยืนยัน (spec §23) */
export function footerButtons(actions: MessageAction[]): FlexBox {
  return vbox(
    actions.map((action, index) => ({
      type: "button" as const,
      action,
      style: index === 0 ? ("primary" as const) : ("secondary" as const),
      ...(index === 0 ? { color: COLOR.accent } : {}),
      height: "sm" as const,
    })),
    { spacing: "sm", paddingAll: "12px" },
  );
}

export function bubble(parts: {
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
}): FlexBubble {
  return { type: "bubble", ...parts };
}
