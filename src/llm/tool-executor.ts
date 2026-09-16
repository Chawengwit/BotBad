import { isAppError, type ErrorCode } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { endTime, formatThaiDate } from "@/lib/time";
import {
  confirmCancelGame,
  confirmCloseGame,
  confirmCreateGame,
  confirmEditGame,
  gameCard,
  playerList,
} from "@/line/messages";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import { createPendingAction } from "@/repositories/pending-action.repository";
import { findPlayerStatus } from "@/repositories/player.repository";
import type { UserRow } from "@/repositories/types";
import {
  editPatchSchema,
  startCancelGame,
  startCloseGame,
  validatePatch,
} from "@/services/game-admin.service";
import { gameDraftSchema, missingDraftFields } from "@/services/game.service";
import { unpaidSharesForGame } from "@/services/bill.service";
import { joinGame, leaveGame, listPlayers } from "@/services/player.service";
import { isToolName, toolSchemas, type ToolName } from "./tools";

export type ToolErrorCode = ErrorCode | "INVALID_ARGUMENT" | "INVALID_TOOL";

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ToolErrorCode; [key: string]: unknown };

export type ToolOutcome = {
  result: ToolResult;
  /** ปุ่มหรือการ์ดที่ App จะแนบท้ายข้อความของ LLM (LLM Design §8) */
  messages: LineMessage[];
};

export type ToolContext = {
  lineGroupId: string;
  user: UserRow;
};

function ok(data: unknown, messages: LineMessage[] = []): ToolOutcome {
  return { result: { ok: true, data }, messages };
}

function fail(error: ToolErrorCode, extra: Record<string, unknown> = {}): ToolOutcome {
  return { result: { ok: false, error, ...extra }, messages: [] };
}

async function describeOpenGame(lineGroupId: string, user: UserRow) {
  const game = await findOpenGame(lineGroupId);
  if (!game) return null;

  const joinedCount = await countJoinedPlayers(game.id);
  const status = await findPlayerStatus(game.id, user.id);

  return {
    game,
    joinedCount,
    summary: {
      play_date: game.play_date,
      weekday: formatThaiDate(game.play_date).split(" ")[0],
      start_time: game.start_time,
      end_time: endTime(game.start_time, game.duration_minutes),
      court_count: game.court_count,
      court_name: game.court_name,
      has_location: game.location_url !== null,
      current_players: joinedCount,
      max_players: game.max_players,
      is_full: joinedCount >= game.max_players,
      requester_is_creator: game.created_by === user.id,
      requester_joined: status === "joined",
    },
  };
}

async function runTool(name: ToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const { lineGroupId, user } = context;

  switch (name) {
    case "get_open_game": {
      const open = await describeOpenGame(lineGroupId, user);
      return open ? ok(open.summary) : fail("NO_OPEN_GAME");
    }

    case "list_players": {
      const { game, players } = await listPlayers(lineGroupId);
      return ok(
        {
          current_players: players.length,
          max_players: game.max_players,
          players: players.map((player) => player.display_name),
        },
        [playerList(game, players), gameCard(game, players.length, "ทำอะไรต่อดี?")],
      );
    }

    case "join_game": {
      const { game, joinedCount } = await joinGame(lineGroupId, user.id);
      return ok({ current_players: joinedCount, max_players: game.max_players }, [
        gameCard(game, joinedCount, `✅ ${user.display_name} ลงชื่อแล้ว`),
      ]);
    }

    case "leave_game": {
      const { game, joinedCount } = await leaveGame(lineGroupId, user.id);
      return ok({ current_players: joinedCount, max_players: game.max_players }, [
        gameCard(game, joinedCount, `👋 ${user.display_name} ถอนชื่อแล้ว`),
      ]);
    }

    case "propose_create_game": {
      if (await findOpenGame(lineGroupId)) return fail("GAME_ALREADY_OPEN");

      // ไม่ได้บอกจำนวนคนมา ใช้ค่าปกติของจำนวนคอร์ทไปก่อน
      const draft = {
        ...args,
        ...(args.max_players === undefined && typeof args.court_count === "number"
          ? { max_players: args.court_count * 8 }
          : {}),
      };

      const missing = missingDraftFields(draft);
      if (missing.length > 0) return fail("MISSING_FIELDS", { missing, received: args });

      const parsed = gameDraftSchema.parse(draft);
      const pending = await createPendingAction({
        lineGroupId,
        requestedBy: user.id,
        actionType: "create_game",
        // มาทาง LLM คือได้ข้อมูลครบมาในประโยคเดียว ไม่ต้องให้ wizard ย้อนไปถามช่องที่ข้ามได้อีก
        payload: { ...parsed, location_asked: true, promptpay_asked: true },
      });

      return ok({ status: "awaiting_confirmation" }, [confirmCreateGame(pending.id, parsed)]);
    }

    case "propose_edit_game": {
      const patch = editPatchSchema.parse(args);
      const game = await findOpenGame(lineGroupId);
      if (!game) return fail("NO_OPEN_GAME");
      if (game.created_by !== user.id) return fail("NOT_GAME_CREATOR");

      validatePatch(game, patch, await countJoinedPlayers(game.id));

      const pending = await createPendingAction({
        lineGroupId,
        requestedBy: user.id,
        actionType: "edit_game",
        gameId: game.id,
        payload: patch,
      });

      return ok({ status: "awaiting_confirmation" }, [confirmEditGame(pending.id, game, patch)]);
    }

    case "propose_cancel_game": {
      const { pending, game, joinedCount } = await startCancelGame(lineGroupId, user.id);
      return ok({ status: "awaiting_confirmation" }, [
        confirmCancelGame(pending.id, game, joinedCount),
      ]);
    }

    case "propose_close_game": {
      const { pending, game, joinedCount } = await startCloseGame(lineGroupId, user.id);
      return ok({ status: "awaiting_confirmation" }, [
        confirmCloseGame(pending.id, game, joinedCount, await unpaidSharesForGame(game.id)),
      ]);
    }
  }
}

/**
 * เรียก tool ตามที่ LLM ขอ
 * ทุก argument ต้องผ่าน zod และ error ทางธุรกิจถูกแปลงเป็นผลลัพธ์ ไม่ throw ออกไป (LLM Design §7)
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  if (!isToolName(name)) return fail("INVALID_TOOL");

  const parsed = toolSchemas[name].safeParse(args);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }

  try {
    return await runTool(name, parsed.data as Record<string, unknown>, context);
  } catch (error) {
    if (isAppError(error)) return fail(error.code, error.details);
    throw error;
  }
}
