import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { insertGame } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import { claimDigest, collectDigestData } from "@/repositories/digest.repository";
import { buildDigest } from "@/services/digest.service";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { messageText } from "../helpers";

const GROUP_ID = "C-test-digest";
const TODAY = "2026-09-18";

/**
 * สรุปประจำสัปดาห์อ่านจากฐานข้อมูลจริง (PRP guests-split-bills-and-digest §6)
 * ส่วนที่ unit test มองไม่เห็นคือ query — โดยเฉพาะบิลลอย ๆ ที่ไม่มี game_id
 */
describe.skipIf(!canRunDbTests())("สรุปประจำสัปดาห์ (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM group_digests WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM bills WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
  }

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  // Supabase free tier มีเพดาน connection และ pool ที่ไม่ได้ปิดจะค้างไว้จนจบ process
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(cleanup);
  afterEach(cleanup);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name: string): Promise<string> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return (await upsertUser(lineUserId, name, sql)).id;
  }

  async function openGame(createdBy: string, playDate = "2030-01-15"): Promise<string> {
    const game = await insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate,
        startTime: "19:00",
        durationMinutes: 120,
        courtCount: 2,
        maxPlayers: 16,
        courtName: "ABC Badminton",
        locationUrl: null,
        promptpay: null,
      },
      sql,
    );
    return game.id;
  }

  /** บิลที่ยังไม่มีใครจ่าย gameId = null คือบิลลอย ๆ */
  async function unpaidBill(
    createdBy: string,
    title: string,
    gameId: string | null,
    amountSatang: number,
  ): Promise<void> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO bills (line_group_id, game_id, created_by, title, items, total_satang)
      VALUES (${GROUP_ID}, ${gameId}, ${createdBy}, ${title}, ${sql.json([])}, ${amountSatang})
      RETURNING id
    `;
    await sql`
      INSERT INTO bill_shares (bill_id, user_id, amount_satang)
      VALUES (${rows[0]!.id}, ${createdBy}, ${amountSatang})
    `;
  }

  async function digestFor(): Promise<string | null> {
    const groups = (await collectDigestData(sql)).filter(
      (group) => group.lineGroupId === GROUP_ID,
    );
    const messages = groups[0] ? buildDigest(groups[0], TODAY) : null;
    return messages ? messageText(messages[0]!) : null;
  }

  it("กลุ่มที่ไม่มีรอบและไม่มีบิลค้าง ไม่โผล่ในสรุปเลย", async () => {
    await newUser("เชวง");
    expect(await digestFor()).toBeNull();
  });

  it("บอกรอบที่เปิดอยู่พร้อมจำนวนคนที่ลงแล้ว", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner);
    await joinGame(GROUP_ID, owner, sql);

    const body = await digestFor();
    expect(body).toContain("มีนัด");
    expect(body).toContain("ABC Badminton");
    expect(body).toContain("1/16 คน");
  });

  it("รอบที่วันเล่นผ่านไปแล้วแต่ยังไม่ปิด เตือนให้ปิดรอบ", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner, "2020-01-01");

    expect(await digestFor()).toContain("ยังไม่ได้ปิด");
  });

  /** บั๊กที่เคยมีจริง: นับบิลด้วยการ join ผ่าน games บิลลอย ๆ จึงหายไปทั้งใบ */
  it("นับบิลลอย ๆ ที่ไม่มี game_id ด้วย", async () => {
    const owner = await newUser("เชวง");
    await unpaidBill(owner, "ค่ากินข้าว", null, 30000);

    const body = await digestFor();
    expect(body).toContain("บิลค้างจ่าย");
    expect(body).toContain("1 ใบ");
    expect(body).toContain("300.00");
  });

  it("บิลของรอบกับบิลลอย ๆ นับรวมกัน", async () => {
    const owner = await newUser("เชวง");
    const gameId = await openGame(owner);

    await unpaidBill(owner, "รอบ พุธ", gameId, 20000);
    await unpaidBill(owner, "ค่ากินข้าว", null, 30000);

    const body = await digestFor();
    expect(body).toContain("2 ใบ");
    expect(body).toContain("500.00");
  });

  it("บิลที่จ่ายครบแล้วไม่นับว่าค้าง", async () => {
    const owner = await newUser("เชวง");
    await unpaidBill(owner, "ค่ากินข้าว", null, 30000);
    await sql`UPDATE bill_shares SET paid = true`;

    expect(await digestFor()).toBeNull();
  });

  it("บิลที่ถูกยกเลิกไม่นับว่าค้าง", async () => {
    const owner = await newUser("เชวง");
    await unpaidBill(owner, "ค่ากินข้าว", null, 30000);
    await sql`UPDATE bills SET status = 'cancelled' WHERE line_group_id = ${GROUP_ID}`;

    expect(await digestFor()).toBeNull();
  });

  it("ห้ามมีชื่อคนค้างจ่ายหลุดออกมา", async () => {
    const owner = await newUser("เชวงคนจ่ายช้า");
    await unpaidBill(owner, "ค่ากินข้าว", null, 30000);

    const body = await digestFor();
    expect(body).not.toContain("เชวงคนจ่ายช้า");
    expect(body).toContain("ใครยังไม่จ่าย");
  });

  it("จองสิทธิ์ส่งได้ครั้งเดียวต่อวัน", async () => {
    expect(await claimDigest(GROUP_ID, TODAY, sql)).toBe(true);
    expect(await claimDigest(GROUP_ID, TODAY, sql)).toBe(false);

    // วันถัดไปจองได้ใหม่
    expect(await claimDigest(GROUP_ID, "2026-09-25", sql)).toBe(true);
  });
});
