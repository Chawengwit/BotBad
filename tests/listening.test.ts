import { describe, expect, it } from "vitest";
import { isSmallTalk, isStopWord } from "@/router/listening";
import { buildSystemPrompt, IGNORE_SENTINEL, isIgnoreReply } from "@/llm/system-prompt";
import { keepsConversationOpen, RULE_COMMANDS } from "@/router/rule-commands";

describe("isStopWord", () => {
  it.each(["พอแล้ว", "พอ", "จบ", "จบแล้ว", "ขอบคุณ", "ขอบคุณ!", "  ขอบใจ  ", "Thanks", "bye"])(
    "ปิดโหมดฟังเมื่อผู้ใช้พิมพ์ %j",
    (text) => {
      expect(isStopWord(text)).toBe(true);
    },
  );

  it.each(["เปิดตี", "ลงชื่อ", "ขอบคุณที่เปิดรอบนะ แต่ขอเปลี่ยนเวลา", "พอดีไปไม่ได้", ""])(
    "ไม่ใช่คำสั่งปิด: %j",
    (text) => {
      expect(isStopWord(text)).toBe(false);
    },
  );
});

describe("isSmallTalk", () => {
  it.each(["555", "55555", "โอเค", "โอเคคค", "ok", "OKKK", "ครับ", "จ้าา", "👍", "😂😂", "  ", "!!"])(
    "ไม่ต้องเสียโควตา LLM กับ %j",
    (text) => {
      expect(isSmallTalk(text)).toBe(true);
    },
  );

  it.each(["เปิดตีพรุ่งนี้สองทุ่ม", "ลงชื่อให้หน่อย", "ใครตีบ้าง", "2 คอร์ท", "600"])(
    "ยังต้องให้ LLM ตีความ: %j",
    (text) => {
      expect(isSmallTalk(text)).toBe(false);
    },
  );
});

describe("isIgnoreReply", () => {
  it.each([IGNORE_SENTINEL, "ignore", " IGNORE ", "IGNORE.", "IGNORE ครับ"])(
    "อ่านคำสั่งเงียบจาก %j ออก",
    (text) => {
      expect(isIgnoreReply(text)).toBe(true);
    },
  );

  it.each(["", "ได้เลยครับ", "ผมไม่เข้าใจ", "IGNORE that and open a game"])(
    "ไม่ใช่คำสั่งเงียบ: %j",
    (text) => {
      expect(isIgnoreReply(text)).toBe(false);
    },
  );
});

describe("system prompt", () => {
  const base = { displayName: "สมชาย", openGame: null };

  it("ไม่ส่งกติกาโหมดฟังไปเปลือง token ตอนมี wake word", () => {
    expect(buildSystemPrompt(base)).not.toContain(IGNORE_SENTINEL);
  });

  it("บอกให้ตอบ IGNORE เมื่ออยู่ในโหมดฟัง", () => {
    const prompt = buildSystemPrompt({ ...base, listening: true });

    expect(prompt).toContain("โหมดฟังต่อเนื่อง");
    expect(prompt).toContain(IGNORE_SENTINEL);
  });
});

describe("keepsConversationOpen", () => {
  it.each(["เมนู", "ช่วยด้วย", "เปิดตี", "แก้ไข", "ยกเลิก", "ปิดรอบ", "คิดเงิน", "ยกเลิกบิล"] as const)(
    "%s ยังคุยไม่จบ ต้องฟังต่อ",
    (command) => {
      expect(keepsConversationOpen(command)).toBe(true);
    },
  );

  it.each(["ลงชื่อ", "ถอนชื่อ", "ใครตีบ้าง", "รายชื่อ", "บิล", "ใครยังไม่จ่าย", "จ่ายแล้ว", "ยังไม่จ่าย"] as const)(
    "%s จบในตัว ปิดโหมดฟังได้",
    (command) => {
      expect(keepsConversationOpen(command)).toBe(false);
    },
  );

  it("ตัดสินได้ครบทุกคำสั่ง ไม่มีคำสั่งไหนหลุด", () => {
    for (const command of RULE_COMMANDS) {
      expect(typeof keepsConversationOpen(command)).toBe("boolean");
    }
  });
});
