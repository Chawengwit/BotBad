import { AppError } from "@/errors/app-errors";
import { getSql, type Queryable } from "@/lib/db";
import { findPeopleByName, upsertGuest } from "@/repositories/user.repository";
import type { UserRow } from "@/repositories/types";

/**
 * แปลชื่อที่ผู้ใช้พิมพ์มาเป็นคนในระบบ (PRP guests-split-bills-and-digest §4.4)
 *
 * บอทดึงรายชื่อสมาชิกจาก LINE ไม่ได้ (ต้องเป็นบัญชี verified/premium)
 * จึงรู้จักเฉพาะแขกของกลุ่ม และสมาชิกที่เคยลงชื่อในรอบของกลุ่มนี้มาก่อน
 *
 * เทียบชื่อแบบตัดช่องว่างหัวท้ายและไม่สนตัวพิมพ์ ไม่ทำ fuzzy match
 * เพราะเดาผิดเรื่อง "คน" แย่กว่าถามซ้ำ
 */

export const MAX_NAME_LENGTH = 40;
/** กันคนพิมพ์รายชื่อยาวเป็นพรืดจนรอบเต็มในคำสั่งเดียว */
export const MAX_NAMES_PER_COMMAND = 10;

/**
 * แยกรายชื่อจากส่วนเติมท้ายคำสั่ง
 * รับได้ทั้งเว้นวรรคและคอมมา เช่น "กิ้ฟ วิท" หรือ "กิ้ฟ, วิท"
 */
export function parseNames(input: string): string[] {
  return input
    .split(/[,\s]+/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_NAME_LENGTH)
    .slice(0, MAX_NAMES_PER_COMMAND);
}

/** คำที่ผู้ใช้ใช้เรียกตัวเอง จะได้พิมพ์ "จ่ายแล้ว ฉัน กิ้ฟ" ได้ */
const SELF_WORDS = ["ฉัน", "ผม", "เรา", "ตัวเอง", "me"];

export function isSelfWord(name: string): boolean {
  return SELF_WORDS.includes(name.trim().toLowerCase());
}

export type ResolvedPerson =
  | { kind: "found"; user: UserRow }
  | { kind: "ambiguous"; name: string; candidates: UserRow[] }
  | { kind: "unknown"; name: string };

/** หาคนจากชื่อ ไม่สร้างแขกใหม่เอง คนเรียกเป็นคนตัดสินว่าจะสร้างไหม */
export async function resolvePerson(
  lineGroupId: string,
  name: string,
  sql: Queryable = getSql(),
): Promise<ResolvedPerson> {
  const trimmed = name.trim();
  const candidates = await findPeopleByName(lineGroupId, trimmed, sql);

  if (candidates.length === 1) return { kind: "found", user: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", name: trimmed, candidates };
  return { kind: "unknown", name: trimmed };
}

export type ResolveManyResult = {
  people: UserRow[];
  /** ชื่อที่ยังไม่รู้จัก ผู้เรียกต้องถามยืนยันก่อนสร้างเป็นแขก */
  unknown: string[];
  ambiguous: string[];
};

export async function resolvePeople(
  lineGroupId: string,
  names: string[],
  self: UserRow,
  sql: Queryable = getSql(),
): Promise<ResolveManyResult> {
  const result: ResolveManyResult = { people: [], unknown: [], ambiguous: [] };
  const seen = new Set<string>();

  for (const name of names) {
    if (isSelfWord(name)) {
      if (!seen.has(self.id)) {
        seen.add(self.id);
        result.people.push(self);
      }
      continue;
    }

    const resolved = await resolvePerson(lineGroupId, name, sql);
    if (resolved.kind === "ambiguous") {
      result.ambiguous.push(resolved.name);
    } else if (resolved.kind === "unknown") {
      result.unknown.push(resolved.name);
    } else if (!seen.has(resolved.user.id)) {
      seen.add(resolved.user.id);
      result.people.push(resolved.user);
    }
  }

  return result;
}

/**
 * แปลงชื่อเป็นคน โดยสร้างแขกใหม่ให้เลยถ้ายังไม่รู้จัก
 * ใช้หลังจากผู้ใช้ยืนยันแล้วเท่านั้น (เช่น กดปุ่มยืนยันเพิ่มแขก)
 */
export async function resolveOrCreateGuests(
  lineGroupId: string,
  names: string[],
  self: UserRow,
  sql: Queryable = getSql(),
): Promise<UserRow[]> {
  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, self, sql);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });

  const created = await Promise.all(unknown.map((name) => upsertGuest(lineGroupId, name, sql)));
  return [...people, ...created];
}
