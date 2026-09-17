import { AppError, isAppError, type ErrorCode } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { endTime, formatThaiDate } from "@/lib/time";
import {
  billCard,
  confirmBill,
  confirmCancelGame,
  confirmCloseGame,
  confirmCreateGame,
  confirmEditGame,
  joinedForNotice,
  joinedNotice,
  leftForNotice,
  leftNotice,
  NAG_AFTER_CHANGES,
  nagFlipFlop,
  paymentRecorded,
  paymentUndone,
  playerList,
} from "@/line/messages";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import { createPendingAction, updatePendingPayload } from "@/repositories/pending-action.repository";
import { findPlayerStatus } from "@/repositories/player.repository";
import type { LineUserRow } from "@/repositories/types";
import {
  editPatchSchema,
  startCancelGame,
  startCloseGame,
  validatePatch,
} from "@/services/game-admin.service";
import { defaultMaxPlayers, gameDraftSchema, missingDraftFields } from "@/services/game.service";
import {
  billDraftSchema,
  buildBillItems,
  getBill,
  markPayment,
  startCreateBill,
  summarize,
  toBaht,
  totalOf,
  unpaidSharesForGame,
} from "@/services/bill.service";
import { advanceBillWizard } from "@/router/wizard";
import { joinGame, joinPeople, leaveGame, leavePeople, listPlayers } from "@/services/player.service";
import { resolveOrCreateGuests, resolvePeople } from "@/services/people.service";
import { upsertGuest } from "@/repositories/user.repository";
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
  user: LineUserRow;
};

function ok(data: unknown, messages: LineMessage[] = []): ToolOutcome {
  return { result: { ok: true, data }, messages };
}

function fail(error: ToolErrorCode, extra: Record<string, unknown> = {}): ToolOutcome {
  return { result: { ok: false, error, ...extra }, messages: [] };
}

async function describeOpenGame(lineGroupId: string, user: LineUserRow) {
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

/**
 * ลงชื่อแทนคนอื่นผ่าน LLM (PRP guests-split-bills-and-digest §9)
 * ชื่อที่ไม่รู้จักถือว่าเป็นแขกใหม่ เหมือนทางคำสั่งพิมพ์ทุกประการ
 */
async function runJoinFor(
  lineGroupId: string,
  user: LineUserRow,
  names: string[],
): Promise<[unknown, LineMessage[]]> {
  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });

  const guests = await Promise.all(unknown.map((guest) => upsertGuest(lineGroupId, guest)));
  const result = await joinPeople(lineGroupId, [...people, ...guests], user.id);

  return [
    {
      joined: result.people.map((person) => person.display_name),
      new_guests: guests.map((guest) => guest.display_name),
      current_players: result.joinedCount,
      max_players: result.game.max_players,
    },
    [joinedForNotice(user.display_name, result, guests.map((guest) => guest.display_name))],
  ];
}

async function runLeaveFor(
  lineGroupId: string,
  user: LineUserRow,
  names: string[],
): Promise<[unknown, LineMessage[]]> {
  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });
  if (people.length === 0) throw new AppError("PERSON_NOT_FOUND", { names: unknown });

  const result = await leavePeople(lineGroupId, people, user.id);
  return [
    {
      left: result.people.map((person) => person.display_name),
      refused: result.skipped.map((entry) => entry.user.display_name),
      current_players: result.joinedCount,
      max_players: result.game.max_players,
    },
    [leftForNotice(user.display_name, result, unknown)],
  ];
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
        [playerList(game, players)],
      );
    }

    case "join_game": {
      const names = (args.names as string[] | undefined) ?? [];
      if (names.length > 0) {
        return ok(...(await runJoinFor(lineGroupId, user, names)));
      }

      const { game, joinedCount, changeCount } = await joinGame(lineGroupId, user.id);
      return ok({ current_players: joinedCount, max_players: game.max_players, changed_mind: changeCount }, [
        joinedNotice(user.display_name, joinedCount, game.max_players),
        ...(changeCount >= NAG_AFTER_CHANGES ? [nagFlipFlop(user.display_name, changeCount)] : []),
      ]);
    }

    case "leave_game": {
      const names = (args.names as string[] | undefined) ?? [];
      if (names.length > 0) {
        return ok(...(await runLeaveFor(lineGroupId, user, names)));
      }

      const { game, joinedCount, changeCount } = await leaveGame(lineGroupId, user.id);
      return ok({ current_players: joinedCount, max_players: game.max_players, changed_mind: changeCount }, [
        leftNotice(user.display_name, joinedCount, game.max_players),
        ...(changeCount >= NAG_AFTER_CHANGES ? [nagFlipFlop(user.display_name, changeCount)] : []),
      ]);
    }

    case "propose_create_game": {
      if (await findOpenGame(lineGroupId)) return fail("GAME_ALREADY_OPEN");

      // ไม่ได้บอกจำนวนคนมา ใช้ค่าปกติของจำนวนคอร์ทไปก่อน
      const draft = {
        ...args,
        ...(args.max_players === undefined && typeof args.court_count === "number"
          ? { max_players: defaultMaxPlayers(args.court_count) }
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
        payload: { ...parsed, venue_asked: true, location_asked: true, promptpay_asked: true },
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

    case "get_bill": {
      const { bill, items: billItems, shares } = await getBill(
        lineGroupId,
        (args.bill_title as string | undefined) ?? "",
      );
      const { paid, unpaid, unpaidTotalSatang, settled } = summarize(shares);

      return ok(
        {
          title: bill.title,
          items: billItems.map((item) => ({
            label: item.label,
            quantity: item.quantity,
            amount_baht: toBaht(item.amount_satang),
            payers: item.payers.map((payer) => payer.display_name),
          })),
          total_baht: toBaht(bill.total_satang),
          amounts: shares.map((share) => ({
            name: share.display_name,
            amount_baht: toBaht(share.amount_satang),
            paid: share.paid,
          })),
          paid: paid.map((share) => share.display_name),
          unpaid: unpaid.map((share) => share.display_name),
          unpaid_total_baht: toBaht(unpaidTotalSatang),
          settled,
          requester_paid: shares.find((share) => share.user_id === user.id)?.paid ?? null,
        },
        [billCard(bill, billItems, shares)],
      );
    }

    case "propose_create_bill": {
      const draft = billDraftSchema.parse(args);
      const title = (args.title as string | undefined)?.trim() ?? "";

      // ตรวจสิทธิ์และเงื่อนไขก่อน จะได้ไม่สร้างการ์ดยืนยันที่กดไปก็ไม่ผ่าน
      const { pending } = await startCreateBill(lineGroupId, user.id, title);

      const items = buildBillItems(draft);

      // รายการที่เก็บบางคน ต้องแปลชื่อเป็นคนก่อน ชื่อที่ยังไม่รู้จักถือว่าเป็นแขก
      // เพราะผู้ใช้กำลังบอกว่าใครกินใครใช้ ไม่ใช่เดาชื่อขึ้นมาเอง
      const chosen = (args.payers as { label: string; names: string[] }[] | undefined) ?? [];
      const itemPayers: Record<string, string[]> = {};
      const payerNames: Record<string, string> = {};

      for (const entry of chosen) {
        const people = await resolveOrCreateGuests(lineGroupId, entry.names, user);
        itemPayers[entry.label] = people.map((person) => person.id);
        for (const person of people) payerNames[person.id] = person.display_name;
      }

      // มาทาง LLM คือได้ข้อมูลครบในประโยคเดียว ช่องที่ไม่ได้บอกมาให้เป็น null
      // (= ไม่มีรายการนี้) ไม่ใช่ undefined ซึ่งจะทำให้ wizard ย้อนไปถามใหม่
      const preview = await advanceBillWizard(pending, {
        court_fee: draft.court_fee ?? null,
        shuttle_count: draft.shuttle_count ?? null,
        shuttle_price: draft.shuttle_price ?? null,
        ...(draft.other_items ? { other_items: draft.other_items } : {}),
        ...(chosen.length > 0 ? { item_payers: itemPayers, payer_names: payerNames } : {}),
        extras_done: true,
      });

      return ok({ status: "awaiting_confirmation", total_baht: toBaht(totalOf(items)) }, preview);
    }

    case "mark_my_payment": {
      const paid = Boolean(args.paid);
      const names = (args.names as string[] | undefined) ?? [];

      const people =
        names.length > 0
          ? (await resolvePeople(lineGroupId, names, user)).people
          : [user];
      if (people.length === 0) return fail("PERSON_NOT_FOUND", { names });

      const result = await markPayment(
        lineGroupId,
        user,
        people,
        paid,
        (args.bill_title as string | undefined) ?? "",
      );
      const { unpaid, settled } = summarize(result.shares);

      return ok(
        {
          paid,
          recorded: result.people.map((entry) => entry.user.display_name),
          refused: result.refused.map((entry) => entry.user.display_name),
          unpaid_count: unpaid.length,
          settled,
        },
        [
          paid
            ? paymentRecorded(user.display_name, result)
            : paymentUndone(user.display_name, result),
        ],
      );
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
