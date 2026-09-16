/** error code ที่ใช้ร่วมกันทั้ง service, rule-based และ tool result ในอนาคต (spec §26) */
export type ErrorCode =
  | "NO_OPEN_GAME"
  | "GAME_ALREADY_OPEN"
  | "ALREADY_JOINED"
  | "NOT_JOINED"
  | "GAME_FULL"
  | "NOT_GAME_CREATOR"
  | "COURT_TOO_SMALL"
  | "MAX_PLAYERS_TOO_SMALL"
  | "DATE_IN_PAST"
  | "NO_CHANGES"
  | "MISSING_FIELDS"
  | "PENDING_EXPIRED"
  | "NOT_REQUESTER"
  | "INTERNAL_ERROR";

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
