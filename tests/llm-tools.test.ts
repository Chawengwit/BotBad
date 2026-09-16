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
});

describe("reply limit", () => {
  it("LINE รับได้ 5 ข้อความต่อครั้ง ตัวเลขนี้ต้องไม่เปลี่ยนโดยไม่ตั้งใจ", () => {
    expect(MAX_REPLY_MESSAGES).toBe(5);
  });
});

describe("system prompt", () => {
  it("ใส่วันเวลาไทยและชื่อคนที่คุยด้วย", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGame: null, now });

    expect(prompt).toContain("2026-09-16");
    expect(prompt).toContain("17:30");
    expect(prompt).toContain("เชวง");
    expect(prompt).toContain("ไม่มีรอบที่เปิดอยู่");
  });

  it("สรุปรอบที่เปิดอยู่ พร้อมบอกว่าเป็นคนเปิดรอบหรือเปล่า", () => {
    const prompt = buildSystemPrompt({
      displayName: "เชวง",
      openGame: { game, joinedCount: 5, isCreator: true, hasJoined: false },
      now,
    });

    expect(prompt).toContain("ABC Badminton");
    expect(prompt).toContain("5/16 คน");
    expect(prompt).toContain("เป็นคนเปิดรอบนี้");
    expect(prompt).toContain("ยังไม่ได้ลงชื่อ");
  });

  it("ไม่มี placeholder ค้างและมีกฎความปลอดภัยครบ", () => {
    const prompt = buildSystemPrompt({ displayName: "เชวง", openGame: null, now });

    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("R14");
    expect(prompt).toContain("R16");
  });
});
