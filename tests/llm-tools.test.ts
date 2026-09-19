import { describe, expect, it } from "vitest";
import { MAX_REPLY_MESSAGES } from "@/lib/line";
import { buildSystemPrompt } from "@/llm/system-prompt";
import { isToolName, toolDeclarations, toolSchemas } from "@/llm/tools";
import type { GameRow } from "@/repositories/types";

const game: GameRow = {
  id: "1",
  line_group_id: "C1",
  created_by: "7",
  play_date: "2026-09-17",
  start_time: "19:00",
  duration_minutes: 120,
  court_count: 2,
  max_players: 16,
  status: "open",
  court_name: "ABC Badminton",
  location_url: null,
  promptpay: null,
  edit_count: 0,
};

// 2026-09-16 17:30 เวลาไทย
const now = new Date("2026-09-16T10:30:00Z");

describe("tool declarations", () => {
  it("ชื่อ tool ที่ประกาศกับ schema ตรงกันทุกตัว", () => {
    const declared = toolDeclarations.map((tool) => tool.name ?? "").sort();
    expect(declared).toEqual(Object.keys(toolSchemas).sort());
  });

  it("ทุก tool มีคำอธิบาย", () => {
    for (const tool of toolDeclarations) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  it("ไม่มี tool ไหนรับ user หรือ group จาก LLM", () => {
    const parameterNames = toolDeclarations.flatMap((tool) =>
      Object.keys((tool.parameters?.properties ?? {}) as Record<string, unknown>),
    );

    expect(parameterNames).not.toContain("user_id");
    expect(parameterNames).not.toContain("group_id");
    expect(parameterNames).not.toContain("line_user_id");
  });

  it("รู้จักเฉพาะ tool ที่ประกาศไว้", () => {
    expect(isToolName("join_game")).toBe(true);
    expect(isToolName("drop_table")).toBe(false);
  });
});

describe("tool argument schemas", () => {
  it("tool ที่ไม่มีพารามิเตอร์ ห้ามรับอะไรเพิ่ม", () => {
    expect(toolSchemas.join_game.safeParse({}).success).toBe(true);
    expect(toolSchemas.join_game.safeParse({ user_id: "U1" }).success).toBe(false);
    expect(toolSchemas.get_open_games.safeParse({ round_date: "2026-09-19" }).success).toBe(false);
  });

  /** รอบที่หมายถึงระบุด้วยวันและเวลา (PRP multi-open-rounds §6) */
  it.each([
    "join_game",
    "leave_game",
    "list_players",
    "propose_edit_game",
    "propose_cancel_game",
    "propose_close_game",
    "start_bill",
    "propose_create_bill",
  ] as const)("%s รับวันและเวลาของรอบ ผิดรูปแบบปฏิเสธ", (name) => {
    expect(toolSchemas[name].safeParse({ round_date: "2026-09-19", round_time: "18:00" }).success).toBe(true);
    expect(toolSchemas[name].safeParse({ round_date: "เสาร์" }).success).toBe(false);
    expect(toolSchemas[name].safeParse({ round_time: "6 โมง" }).success).toBe(false);
  });

  it("รับค่าที่ถูกต้องของการเปิดรอบ", () => {
    const parsed = toolSchemas.propose_create_game.safeParse({
      court_count: 2,
      max_players: 16,
      play_date: "2026-09-17",
      start_time: "19:00",
      duration_minutes: 120,
      court_name: "ABC Badminton",
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["คอร์ทเกินช่วง", { court_count: 9 }],
    ["จำนวนคนน้อยเกินไป", { max_players: 1 }],
    ["จำนวนคนมากเกินไป", { max_players: 999 }],
    ["วันที่ผิดรูปแบบ", { play_date: "17/09/2026" }],
    ["เวลาผิดรูปแบบ", { start_time: "7pm" }],
    ["ชั่วโมงไม่เต็ม", { duration_minutes: 45 }],
    ["ลิงก์ไม่ใช่ URL", { location_url: "ไปตามทางเลย" }],
    ["ฟิลด์แปลกปลอม", { created_by: "U1" }],
  ])("ปฏิเสธ %s", (_label, args) => {
    expect(toolSchemas.propose_create_game.safeParse(args).success).toBe(false);
  });

  it.each([
    ["ไม่ระบุว่าเรื่องไหน", {}],
    ["บิลใหม่พร้อมชื่อ", { kind: "new", title: "ร้านโชคดี" }],
    ["คิดค่ารอบ", { kind: "game" }],
    ["แก้บิลเดิม", { kind: "edit" }],
  ])("start_bill รับ %s", (_label, args) => {
    expect(toolSchemas.start_bill.safeParse(args).success).toBe(true);
  });

  it.each([
    ["kind ที่ไม่รู้จัก", { kind: "delete" }],
    ["ชื่อบิลว่าง", { kind: "new", title: " " }],
    ["ฟิลด์แปลกปลอม", { bill_id: "7" }],
  ])("start_bill ปฏิเสธ %s", (_label, args) => {
    expect(toolSchemas.start_bill.safeParse(args).success).toBe(false);
  });

  it("บอกเลขพร้อมเพย์มากับบิลได้ เก็บเป็นตัวเลขล้วน", () => {
    const parsed = toolSchemas.propose_create_bill.safeParse({
      title: "ร้านโชคดี",
      other_items: [{ label: "ค่าข้าว", amount: 1500 }],
      promptpay: "081-234-5678",
    });

    expect(parsed.success && parsed.data.promptpay).toBe("0812345678");
    expect(toolSchemas.propose_create_bill.safeParse({ promptpay: "12345" }).success).toBe(false);
  });
});

describe("reply limit", () => {
  it("LINE รับได้ 5 ข้อความต่อครั้ง ตัวเลขนี้ต้องไม่เปลี่ยนโดยไม่ตั้งใจ", () => {
    expect(MAX_REPLY_MESSAGES).toBe(5);
  });
});

describe("system prompt", () => {
  it("ใส่วันเวลาไทยและชื่อคนที่คุยด้วย", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGames: [], now });

    expect(prompt).toContain("2026-09-16");
    expect(prompt).toContain("17:30");
    expect(prompt).toContain("เชวง");
    expect(prompt).toContain("ไม่มีรอบที่เปิดอยู่");
  });

  it("สรุปรอบที่เปิดอยู่ พร้อมบอกว่าเป็นคนเปิดรอบหรือเปล่า", () => {
    const prompt = buildSystemPrompt({
      displayName: "เชวง",
      openGames: [{ game, joinedCount: 5, isCreator: true, hasJoined: false }],
      now,
    });

    expect(prompt).toContain("ABC Badminton");
    expect(prompt).toContain("5/16 คน");
    expect(prompt).toContain("เป็นคนเปิดรอบนี้");
    expect(prompt).toContain("ยังไม่ได้ลงชื่อ");
  });

  /** LLM ต้องเห็นทุกรอบพร้อมวันที่แบบ YYYY-MM-DD ถึงจะส่ง round_date ได้ตรงรอบ (PRP multi-open-rounds §6) */
  it("เปิดหลายรอบ บอกทุกรอบพร้อมวันที่ และบอกกติกาเลือกรอบ", () => {
    const saturday = { ...game, id: "2", play_date: "2026-09-19", court_name: "คอร์ทสามย่าน" };
    const prompt = buildSystemPrompt({
      displayName: "เชวง",
      openGames: [
        { game, joinedCount: 5, isCreator: true, hasJoined: false },
        { game: saturday, joinedCount: 2, isCreator: false, hasJoined: true },
      ],
      now,
    });

    expect(prompt).toContain("(2026-09-17)");
    expect(prompt).toContain("(2026-09-19)");
    expect(prompt).toContain("คอร์ทสามย่าน");
    expect(prompt).toContain("ไม่เกิน 3 รอบ");
    expect(prompt).not.toContain("ครั้งละ 1 รอบ");
    expect(prompt).toContain("round_date");
  });

  it("ไม่มี placeholder ค้างและมีกฎความปลอดภัยครบ", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGames: [], now });

    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("R14");
    expect(prompt).toContain("R16");
  });

  /**
   * "คิดเงิน" ที่ไม่บอกว่าเรื่องไหน ต้องให้ผู้ใช้เลือก ไม่เดาว่าเป็นค่ารอบ
   * และห้ามถามรายการเป็นข้อความเฉย ๆ เพราะคำตอบถัดไปจะหลุดไปเป็นคำสั่งดูบิล
   */
  it("มีกฎให้เรียก start_bill เมื่อยังไม่รู้รายการ", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGames: [], now });

    expect(prompt).toContain("R23");
    expect(prompt).toContain("start_bill");
    expect(prompt).not.toContain("งานที่กำลังทำ: สร้างบิลใหม่");
  });

  /**
   * ไม่ระบุชื่อบิล ระบบเลือกใบที่เกี่ยวข้องให้เอง (PRP guests-split-bills-and-digest §5.2)
   * ถ้า LLM ถามชื่อบิลเองก่อน จะถามถึงใบที่คนนั้นจ่ายไปแล้วเหมือนเดิม
   */
  it("ไม่ระบุชื่อบิล ให้เรียก tool เลย ไม่ถามชื่อบิลเองก่อน", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGames: [], now });

    expect(prompt).not.toContain("ต้องระบุชื่อบิลทุกครั้ง");
    expect(prompt).toContain("ห้ามถามชื่อบิลเองก่อน");
  });

  it("ตอบต่อจากปุ่มสร้างบิลใหม่ บอก LLM ว่าข้อความนี้คือบิล พร้อมชื่อที่ตั้งไว้", () => {
    const named = buildSystemPrompt({ displayName: "เชวง", openGames: [], now, newBill: { title: "ร้านโชคดี" } });
    expect(named).toContain("งานที่กำลังทำ: สร้างบิลใหม่");
    expect(named).toContain('title "ร้านโชคดี"');

    const unnamed = buildSystemPrompt({ displayName: "เชวง", openGames: [], now, newBill: { title: "" } });
    expect(unnamed).toContain("ยังไม่ได้ตั้งชื่อบิลให้ถามชื่อก่อน");
  });
});
