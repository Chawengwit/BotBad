/** วันเวลาทั้งหมดของระบบอิงเวลาไทย (spec §7) */
export const TIMEZONE = "Asia/Bangkok";

const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"] as const;
const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
] as const;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const bangkokParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function partsOf(now: Date): Record<string, string> {
  return Object.fromEntries(
    bangkokParts.formatToParts(now).map((part) => [part.type, part.value]),
  );
}

/** วันที่วันนี้ตามเวลาไทย รูปแบบ YYYY-MM-DD */
export function todayInBangkok(now: Date = new Date()): string {
  const parts = partsOf(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** เวลาตอนนี้ตามเวลาไทย รูปแบบ HH:mm */
export function timeNowInBangkok(now: Date = new Date()): string {
  const parts = partsOf(now);
  // Intl คืน "24" ตอนเที่ยงคืนในบาง runtime
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${hour}:${parts.minute}`;
}

/** บวกวันแบบไม่สนใจ timezone เพราะทำงานบนสตริงวันที่ล้วน */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** true ถ้าวันเวลานั้นผ่านไปแล้วเมื่อเทียบกับเวลาไทยตอนนี้ */
export function isInThePast(date: string, time: string, now: Date = new Date()): boolean {
  return `${date} ${time}` < `${todayInBangkok(now)} ${timeNowInBangkok(now)}`;
}

/** เวลาสิ้นสุดของรอบ ข้ามเที่ยงคืนได้ */
export function endTime(startTime: string, durationMinutes: number): string {
  const [hour, minute] = startTime.split(":").map(Number) as [number, number];
  const total = (hour * 60 + minute + durationMinutes) % (24 * 60);
  const endHour = String(Math.floor(total / 60)).padStart(2, "0");
  const endMinute = String(total % 60).padStart(2, "0");
  return `${endHour}:${endMinute}`;
}

/** เช่น 2026-09-16 → "พุธ 16 ก.ย." */
export function formatThaiDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${THAI_MONTHS[month - 1]}`;
}

/** เช่น 19:00 + 120 นาที → "19:00 - 21:00" */
export function formatTimeRange(startTime: string, durationMinutes: number): string {
  return `${startTime} - ${endTime(startTime, durationMinutes)}`;
}

/** 120 → "2 ชั่วโมง" */
export function formatDuration(durationMinutes: number): string {
  return `${durationMinutes / 60} ชั่วโมง`;
}
