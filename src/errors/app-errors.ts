/**
 * error code ที่ใช้ร่วมกันทั้ง service, rule-based และ tool result (spec §26)
 * เก็บเป็น array ไม่ใช่ union ล้วน ๆ จะได้มีเทสวนเช็กได้ว่าทุก code มีข้อความของตัวเอง
 */
export const ERROR_CODES = [
  "NO_OPEN_GAME",
  "GAME_LIMIT_REACHED",
  "ALREADY_JOINED",
  "NOT_JOINED",
  "GAME_FULL",
  "NOT_GAME_CREATOR",
  "COURT_TOO_SMALL",
  "MAX_PLAYERS_TOO_SMALL",
  "DATE_IN_PAST",
  "NO_CHANGES",
  "MISSING_FIELDS",
  "PENDING_EXPIRED",
  "NOT_REQUESTER",
  "NOT_YOUR_GUEST",
  "PERSON_NOT_FOUND",
  "PERSON_AMBIGUOUS",
  "NO_BILL",
  "BILL_ALREADY_EXISTS",
  "BILL_AMBIGUOUS",
  "BILL_TITLE_TAKEN",
  "NOTHING_OWED",
  "NOTHING_PAID",
  "ALL_BILLS_SETTLED",
  "NOT_IN_BILL",
  "NO_PLAYERS_TO_SPLIT",
  "AMOUNT_INVALID",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
