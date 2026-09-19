import { AppError, isAppError, type ErrorCode } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { endTime, formatThaiDate } from "@/lib/time";
import {
  billCard,
  confirmCreateGame,
  errorMessage,
  isRoundQuestion,
  paymentRecorded,
  paymentUndone,
  playerList,
} from "@/line/messages";
import { createPendingAction, type PendingPayload } from "@/repositories/pending-action.repository";
import type { LineUserRow } from "@/repositories/types";
import { editPatchSchema } from "@/services/game-admin.service";
import {
  defaultMaxPlayers,
  gameDraftSchema,
  missingDraftFields,
  requireRoomForGame,
} from "@/services/game.service";
import {
  billDraftSchema,
  buildBillItems,
  continueNewBill,
  getBill,
  markPayment,
  startCreateBill,
  summarize,
  toBaht,
  totalOf,
} from "@/services/bill.service";
import { doBillMenu, doStartEditBill, doStartGameBill, doStartNewBill } from "@/router/bill-actions";
import {
  doCancel,
  doClose,
  doEdit,
  doJoinFor,
  doLeaveFor,
} from "@/router/game-actions";
import { advanceBillWizard, needsBillPromptPay } from "@/router/wizard";
import { resolveOrCreateGuests, resolvePeople } from "@/services/people.service";
import {
  hasJoined,
  loadOpenRounds,
  matchRounds,
  type Round,
  type RoundSelector,
} from "@/services/round.service";
import { isToolName, toolSchemas, type ToolName } from "./tools";

export type ToolErrorCode = ErrorCode | "INVALID_ARGUMENT" | "INVALID_TOOL";

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ToolErrorCode; [key: string]: unknown };

export type ToolOutcome = {
  result: ToolResult;
  /** ปุ่มหรือการ์ดที่ App จะแนบท้ายข้อความของ LLM (LLM Design §8) */
  messages: LineMessage[];
  /** true = messages คือคำตอบทั้งหมด ไม่ส่งข้อความที่ LLM แต่งเอง */
  systemReply?: boolean;
};

/**
 * ลงชื่อ ถอนชื่อ และบันทึกจ่ายเงิน ตอบด้วยข้อความของระบบอย่างเดียว ทั้งตอนสำเร็จและไม่สำเร็จ
 * เคยเกิดจริงในแชท 2026-09-18: tool ไม่สำเร็จ ไม่มีข้อความอะไรออกไป
 * แชทจึงเหลือแค่ข้อความที่ LLM แต่งว่า "ถอนชื่อ louis ออกจากรอบให้แล้วครับ 👍"
 */
const SYSTEM_REPLY_TOOLS: ReadonlySet<ToolName> = new Set(["join_game", "leave_game", "mark_my_payment"]);

export type ToolContext = {
  lineGroupId: string;
  user: LineUserRow;
  /** กำลังสร้างบิลใหม่ต่อจากปุ่ม "สร้างบิลใหม่" propose_create_bill ต้องใช้ pending ใบนี้ต่อ */
  billPendingId?: string;
};

function ok(data: unknown, messages: LineMessage[] = []): ToolOutcome {
  return { result: { ok: true, data }, messages };
}

function fail(error: ToolErrorCode, extra: Record<string, unknown> = {}): ToolOutcome {
  return { result: { ok: false, error, ...extra }, messages: [] };
}

/** ข้อมูลรอบสำหรับ LLM ทุกค่าอ่านจากฐานข้อมูล LLM ไม่ต้องเดาอะไรเอง */
function describeRound({ game, players }: Round, user: LineUserRow) {
  return {
    play_date: game.play_date,
    weekday: formatThaiDate(game.play_date).split(" ")[0],
    start_time: game.start_time,
    end_time: endTime(game.start_time, game.duration_minutes),
    court_count: game.court_count,
    court_name: game.court_name,
    has_location: game.location_url !== null,
    current_players: players.length,
    max_players: game.max_players,
    is_full: players.length >= game.max_players,
    requester_is_creator: game.created_by === user.id,
    requester_joined: hasJoined({ game, players }, user.id),
  };
}

/** รอบที่ผู้ใช้พูดถึง (PRP multi-open-rounds §6) ไม่ได้พูดถึงระบบเลือกหรือถามเอง */
function selectorOf(args: Record<string, unknown>): RoundSelector {
  return {
    ...(typeof args.round_date === "string" ? { date: args.round_date } : {}),
    ...(typeof args.round_time === "string" ? { time: args.round_time } : {}),
  };
}

async function runTool(name: ToolName, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const { lineGroupId, user } = context;

  switch (name) {
    case "get_open_games": {
      const rounds = await loadOpenRounds(lineGroupId);
      if (rounds.length === 0) return fail("NO_OPEN_GAME");
      return ok({ rounds: rounds.map((round) => describeRound(round, user)) });
    }

    case "list_players": {
      const rounds = matchRounds(await loadOpenRounds(lineGroupId), selectorOf(args));
      return ok(
        {
          rounds: rounds.map(({ game, players }) => ({
            play_date: game.play_date,
            start_time: game.start_time,
            current_players: players.length,
            max_players: game.max_players,
            players: players.map((player) => player.display_name),
          })),
        },
        rounds.map((round) => playerList(round.game, round.players)),
      );
    }

    // ทางเดียวกับคำสั่งพิมพ์ทุกประการ ผลลัพธ์เป็นข้อความของระบบ (SYSTEM_REPLY_TOOLS)
    case "join_game": {
      const names = (args.names as string[] | undefined) ?? [];
      const messages = await doJoinFor(lineGroupId, user, names, selectorOf(args));
      return ok({ status: "replied" }, messages);
    }

    // ถอนคนอื่นผ่านประโยคต้องกดยืนยันก่อน เพราะประโยคในแชทอาจเป็นมุก
    case "leave_game": {
      const names = (args.names as string[] | undefined) ?? [];
      const messages = await doLeaveFor(lineGroupId, user, names, selectorOf(args), true);
      return ok({ status: "replied" }, messages);
    }

    case "propose_create_game": {
      await requireRoomForGame(lineGroupId);

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
      // editPatchSchema ตัด round_date / round_time ทิ้งเอง เหลือเฉพาะค่าที่จะแก้
      const patch = editPatchSchema.parse(args);
      // ไม่มีอะไรจะแก้ บอกเลย ไม่ต้องถามรอบก่อนแล้วค่อยบอก
      if (Object.keys(patch).length === 0) return fail("NO_CHANGES");

      const messages = await doEdit(lineGroupId, user, selectorOf(args), patch);
      return ok({ status: "awaiting_confirmation" }, messages);
    }

    case "propose_cancel_game":
      return ok({ status: "awaiting_confirmation" }, await doCancel(lineGroupId, user, selectorOf(args)));

    case "propose_close_game":
      return ok({ status: "awaiting_confirmation" }, await doClose(lineGroupId, user, selectorOf(args)));

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

    case "start_bill": {
      // ทางเดียวกับการ์ด "คิดเงินอะไรดี?" ทุกประการ ทั้งตอนไม่ระบุและตอนระบุว่าเรื่องไหน
      const kind = args.kind as "game" | "new" | "edit" | undefined;
      const messages =
        kind === "game"
          ? await doStartGameBill(lineGroupId, user, selectorOf(args))
          : kind === "new"
            ? await doStartNewBill(lineGroupId, user, (args.title as string | undefined) ?? "")
            : kind === "edit"
              ? await doStartEditBill(lineGroupId, user)
              : await doBillMenu(lineGroupId, user);

      return ok({ status: "waiting_for_user" }, messages);
    }

    case "propose_create_bill": {
      const draft = billDraftSchema.parse(args);
      const title = (args.title as string | undefined)?.trim() ?? "";
      const promptpay = args.promptpay as string | undefined;

      // มาจากปุ่ม "สร้างบิลใหม่" ใช้ pending ใบนั้นต่อ ตั้งชื่อมาคือบิลลอย ๆ ตรวจชื่อก่อน
      // จะได้ไม่สร้างการ์ดยืนยันที่กดไปก็ไม่ผ่าน ไม่มีทั้งสองอย่างคือบิลค่ารอบ ต้องเลือกเกมก่อน
      const pending = context.billPendingId
        ? await continueNewBill(context.billPendingId, lineGroupId, user.id, title)
        : title
          ? (await startCreateBill(lineGroupId, user.id, title)).pending
          : null;

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
      const patch: PendingPayload = {
        court_fee: draft.court_fee ?? null,
        shuttle_count: draft.shuttle_count ?? null,
        shuttle_price: draft.shuttle_price ?? null,
        ...(draft.other_items ? { other_items: draft.other_items } : {}),
        ...(chosen.length > 0 ? { item_payers: itemPayers, payer_names: payerNames } : {}),
        ...(promptpay ? { promptpay, promptpay_asked: true } : {}),
        extras_done: true,
      };

      // บิลค่ารอบ: เกมเดียวไปการ์ดยืนยันเลย หลายเกมถามว่ารอบไหน รายการที่บอกมาจำไว้ในการ์ดนั้น
      if (!pending) {
        const messages = await doStartGameBill(lineGroupId, user, selectorOf(args), patch);
        return ok({ status: "awaiting_confirmation", total_baht: toBaht(totalOf(items)) }, messages);
      }

      // บิลลอย ๆ ที่ยังไม่รู้เลขพร้อมเพย์ จะได้คำถามเลขก่อน ไม่ใช่การ์ดยืนยัน
      const asksPromptPay = needsBillPromptPay(pending, { ...pending.payload, ...patch });
      const preview = await advanceBillWizard(pending, patch);

      return ok(
        {
          status: asksPromptPay ? "awaiting_promptpay" : "awaiting_confirmation",
          total_baht: toBaht(totalOf(items)),
        },
        preview,
      );
    }

    case "mark_my_payment": {
      const paid = Boolean(args.paid);
      const names = (args.names as string[] | undefined) ?? [];

      const people =
        names.length > 0
          ? (await resolvePeople(lineGroupId, names, user)).people
          : [user];
      if (people.length === 0) throw new AppError("PERSON_NOT_FOUND", { names });

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
          unchanged: result.unchanged.map((person) => person.display_name),
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

  const valid = parsed.data as Record<string, unknown>;
  try {
    const outcome = await runTool(name, valid, context);

    // ถามว่ารอบไหนเป็นข้อความของระบบเสมอ LLM ไม่ต้องถามหรือพูดทับเอง (PRP multi-open-rounds §6)
    if (outcome.messages.some(isRoundQuestion)) {
      return { result: { ok: true, data: { status: "choose_round" } }, messages: outcome.messages, systemReply: true };
    }
    return SYSTEM_REPLY_TOOLS.has(name) ? { ...outcome, systemReply: true } : outcome;
  } catch (error) {
    if (!isAppError(error)) throw error;
    if (!SYSTEM_REPLY_TOOLS.has(name)) return fail(error.code, error.details);

    // ไม่สำเร็จก็ตอบด้วยข้อความเดียวกับคำสั่งพิมพ์
    // ต้องถามว่าบิลไหน ตัวอย่างเป็นคำสั่งพิมพ์ที่ได้ผลเดียวกัน จะได้พิมพ์ตามได้แม้ Gemini ใช้ไม่ได้
    const names = (valid.names as string[] | undefined) ?? [];
    const command = name === "mark_my_payment" ? [valid.paid ? "จ่ายแล้ว" : "ยังไม่จ่าย", ...names].join(" ") : "";
    return {
      ...fail(error.code, error.details),
      messages: [errorMessage(error.code, { command, ...error.details })],
      systemReply: true,
    };
  }
}
