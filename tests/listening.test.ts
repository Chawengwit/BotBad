import { describe, expect, it } from "vitest";
import { isSmallTalk, isStopWord } from "@/router/listening";
import { buildSystemPrompt, IGNORE_SENTINEL, isIgnoreReply } from "@/llm/system-prompt";
import * as ruleCommands from "@/router/rule-commands";
import { parseCommand, RULE_COMMANDS } from "@/router/rule-commands";

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

/**
 * โหมดฟังปิดเมื่อ "ไม่ได้คุยกับบอท" เท่านั้น ไม่ใช่เมื่อ "งานสำเร็จ" (spec §6)
 * ของเดิมปิดทุกครั้งที่คำสั่งจบในตัว ซึ่งคือกรณีปกติที่สุด
 * ผู้ใช้เลยต้องเรียก "บอทจ๋า" ใหม่แทบทุกประโยค
 */
describe("คำสั่งทุกตัวต่ออายุโหมดฟัง", () => {
  it("ไม่มีคำสั่งไหนที่ถูกจัดว่า 'จบแล้วปิดโหมดฟัง' อีก", () => {
    // ถ้ามีใครเอา keepsConversationOpen กลับมา เทสนี้จะพัง
    expect(Object.keys(ruleCommands)).not.toContain("keepsConversationOpen");
  });

  it("ทุกคำสั่งยังแยกออกจากข้อความทั่วไปได้", () => {
    for (const command of RULE_COMMANDS) {
      expect(parseCommand(command)).toEqual({ command, args: "" });
    }
  });
});
