import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  confirmCancelGame,
  confirmCloseGame,
  confirmEditGame,
  confirmLeavePlayers,
  editMenu,
  joinedForNotice,
  joinedNotice,
  leftForNotice,
  leftNotice,
  NAG_AFTER_CHANGES,
  nagFlipFlop,
  playerList,
  roundLabel,
  whichRound,
} from "@/line/messages";
import { createPendingAction, type PendingPayload } from "@/repositories/pending-action.repository";
import { upsertGuest } from "@/repositories/user.repository";
import type { GameRow, LineUserRow } from "@/repositories/types";
import { unpaidSharesForGame } from "@/services/bill.service";
import {
  proposeEditGame,
  startCancelGame,
  startCloseGame,
  startEditGame,
  type EditPatch,
} from "@/services/game-admin.service";
import { resolvePeople } from "@/services/people.service";
import { joinGame, joinPeople, leaveBlock, leaveGame, leavePeople, planLeave } from "@/services/player.service";
import {
  hasJoined,
  isFull,
  loadOpenRounds,
  matchRounds,
  pickRound,
  type Round,
  type RoundIntent,
  type RoundPick,
  type RoundSelector,
} from "@/services/round.service";

/**
 * งานที่เรียกได้ทั้งจากคำสั่งพิมพ์ ปุ่มบนการ์ด และ LLM
 * รวมไว้ที่เดียวเพื่อให้ทุกทางเข้าเลือกรอบและตอบเหมือนกันเสมอ
 *
 * กลุ่มเปิดได้หลายรอบ (PRP multi-open-rounds) ทุกงานจึงเริ่มจากเลือกรอบ
 * selector มาจาก LLM (วัน/เวลา) หรือจากปุ่มบนการ์ด "รอบไหน?" (id ของรอบ) ไม่ระบุคือให้ระบบเลือกเอง
 */

/** เปลี่ยนใจกลับไปกลับมาหลายรอบ บอทจะแซวต่อท้ายให้ */
function withNag(
  messages: LineMessage[],
  displayName: string,
  changeCount: number,
): LineMessage[] {
  if (changeCount < NAG_AFTER_CHANGES) return messages;
  return [...messages, nagFlipFlop(displayName, changeCount)];
}

/** กลุ่มเปิดอยู่หลายรอบ ผลลัพธ์ต้องบอกว่ารอบไหน ไม่งั้นทั้งกลุ่มไม่รู้ว่าลงหรือถอนรอบไหน (§4.4) */
function labelOf(game: GameRow, labeled: boolean): string | undefined {
  return labeled ? roundLabel(game) : undefined;
}

/**
 * หลายรอบเข้าเงื่อนไข ถามก่อนว่ารอบไหน (PRP multi-open-rounds §4.3)
 * จำคำสั่ง รายชื่อ และค่าที่เสนอไว้ใน pending กดแล้วจะทำคำสั่งเดิมซ้ำกับรอบที่เลือก เช็กทุกอย่างใหม่ตอนนั้น
 */
export async function askWhichRound(
  lineGroupId: string,
  user: LineUserRow,
  intent: RoundIntent,
  rounds: Round[],
  extra: { names?: string[]; patch?: PendingPayload } = {},
): Promise<LineMessage[]> {
  const pending = await createPendingAction({
    lineGroupId,
    requestedBy: user.id,
    actionType: "choose_game",
    payload: { intent, ...extra },
  });
  return [whichRound(pending.id, intent, rounds.map((round) => round.game), extra.names)];
}

/** ชื่อที่พิมพ์มาต้องชี้ได้คนเดียว ชื่อซ้ำกันต้องถามให้ชัดก่อน ไม่เดาเรื่อง "คน" */
async function resolveNames(lineGroupId: string, names: string[], user: LineUserRow) {
  const found = await resolvePeople(lineGroupId, names, user);
  if (found.ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: found.ambiguous });
  return found;
}

/** ลงชื่อตัวเอง: รอบที่ยังไม่ได้ลงและยังไม่เต็ม */
export async function doJoin(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
): Promise<LineMessage[]> {
  const rounds = await loadOpenRounds(lineGroupId);
  const pick = pickRound(rounds, (round) => !hasJoined(round, user.id) && !isFull(round), selector);

  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "join", pick.rounds);
  if (pick.kind === "none") {
    const joinedAll = pick.rounds.every((round) => hasJoined(round, user.id));
    throw new AppError(joinedAll ? "ALREADY_JOINED" : "GAME_FULL", { all_rounds: true });
  }

  const { game, joinedCount, changeCount } = await joinGame(lineGroupId, pick.round.game.id, user.id);
  return withNag(
    [joinedNotice(user.display_name, joinedCount, game.max_players, labelOf(game, pick.labeled))],
    user.display_name,
    changeCount,
  );
}

/** ถอนชื่อตัวเอง: รอบที่ลงไว้ */
export async function doLeave(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
): Promise<LineMessage[]> {
  const rounds = await loadOpenRounds(lineGroupId);
  const pick = pickRound(rounds, (round) => hasJoined(round, user.id), selector);

  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "leave", pick.rounds);
  if (pick.kind === "none") throw new AppError("NOT_JOINED", { all_rounds: true });

  const { game, joinedCount, changeCount } = await leaveGame(lineGroupId, pick.round.game.id, user.id);
  return withNag(
    [leftNotice(user.display_name, joinedCount, game.max_players, labelOf(game, pick.labeled))],
    user.display_name,
    changeCount,
  );
}

/**
 * ลงชื่อให้คนอื่น รวมถึงแขกที่ไม่ได้อยู่ในกลุ่ม (PRP guests-split-bills-and-digest §4)
 * ชื่อที่ไม่รู้จักถือว่าเป็นแขกใหม่ที่คนสั่งพามาเอง จึงสร้างให้เลยโดยไม่ต้องถามซ้ำ
 * แต่ต้องประกาศในข้อความว่าเพิ่งเพิ่มใครเข้ามาใหม่ (§4.7)
 *
 * ทุกชื่อลงรอบเดียวกัน เลือกจากรอบที่ยังไม่เต็มและยังมีคนในรายชื่อที่ยังไม่ได้ลง
 */
export async function doJoinFor(
  lineGroupId: string,
  user: LineUserRow,
  names: string[],
  selector: RoundSelector = {},
): Promise<LineMessage[]> {
  if (names.length === 0) return doJoin(lineGroupId, user, selector);

  const { people, unknown } = await resolveNames(lineGroupId, names, user);
  const someoneNew = (round: Round) =>
    unknown.length > 0 || people.some((person) => !hasJoined(round, person.id));

  const rounds = await loadOpenRounds(lineGroupId);
  const pick = pickRound(rounds, (round) => !isFull(round) && someoneNew(round), selector);

  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "join_for", pick.rounds, { names });
  if (pick.kind === "none") {
    const joinedAll = pick.rounds.every((round) => !someoneNew(round));
    throw joinedAll
      ? new AppError("ALREADY_JOINED", { all_rounds: true, names: people.map((person) => person.display_name) })
      : new AppError("GAME_FULL", { all_rounds: true });
  }

  const guests = await Promise.all(unknown.map((name) => upsertGuest(lineGroupId, name)));
  const result = await joinPeople(lineGroupId, pick.round.game.id, [...people, ...guests], user.id);

  return [
    joinedForNotice(
      user.display_name,
      result,
      guests.map((guest) => guest.display_name),
      labelOf(result.game, pick.labeled),
    ),
  ];
}

/**
 * ถอนชื่อให้คนอื่น ได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้ (PRP §4.3)
 * ชื่อที่ไม่รู้จักถอนไม่ได้ ต่างจากลงชื่อที่สร้างแขกใหม่ให้ บอกว่าไม่อยู่ในรายชื่อ
 * เช็กว่ามีรอบเปิดอยู่ก่อนเสมอ แม้ทุกชื่อจะไม่รู้จักก็ตาม
 *
 * confirmOthers: สั่งเป็นประโยคผ่าน LLM อาจเป็นมุก เช่น "ยังไม่ให้ louis ตีแบด 555"
 * ถอนคนอื่นต้องกดยืนยันก่อน ส่วนคำสั่งพิมพ์และการกดเลือกรอบบนการ์ดถือว่ายืนยันแล้ว (PRP multi-open-rounds §4.3)
 */
export async function doLeaveFor(
  lineGroupId: string,
  user: LineUserRow,
  names: string[],
  selector: RoundSelector = {},
  confirmOthers = false,
): Promise<LineMessage[]> {
  if (names.length === 0) return doLeave(lineGroupId, user, selector);

  const { people, unknown } = await resolveNames(lineGroupId, names, user);
  const rounds = await loadOpenRounds(lineGroupId);
  const pick = pickRound(
    rounds,
    (round) => people.some((person) => leaveBlock(round, person, user.id) === null),
    selector,
  );

  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "leave_for", pick.rounds, { names });
  if (pick.kind === "none") {
    // ไม่มีรอบไหนถอนใครได้เลย บอกเหตุผลของแต่ละคนโดยดูรวมทุกรอบ
    const skipped = people.map((person) => ({
      user: person,
      reason: pick.rounds.some((round) => hasJoined(round, person.id)) ? "not_yours" : "not_joined",
    }));
    return [leftForNotice(user.display_name, { joinedCount: 0, people: [], skipped }, unknown, { allRounds: true })];
  }

  const { round, labeled } = pick;
  const plan = planLeave(round, people, user.id);

  if (confirmOthers && plan.removable.some((person) => person.id !== user.id)) {
    const pending = await createPendingAction({
      lineGroupId,
      requestedBy: user.id,
      actionType: "leave_players",
      gameId: round.game.id,
      payload: { user_ids: plan.removable.map((person) => person.id), labeled },
    });
    return [
      confirmLeavePlayers(pending.id, plan.removable, plan.skipped, unknown, labelOf(round.game, labeled)),
    ];
  }

  const result = await leavePeople(lineGroupId, round.game.id, people, user.id);
  return [leftForNotice(user.display_name, result, unknown, { round: labelOf(result.game, labeled) })];
}

/** ขอรายชื่อก็ได้รายชื่อ ทุกรอบที่เปิดอยู่ในคำตอบเดียว ไม่ต้องถาม (PRP multi-open-rounds §4.2) */
export async function doList(lineGroupId: string, selector: RoundSelector = {}): Promise<LineMessage[]> {
  const rounds = matchRounds(await loadOpenRounds(lineGroupId), selector);
  return rounds.map((round) => playerList(round.game, round.players));
}

/** แก้ ยกเลิก ปิด ดูเฉพาะรอบที่คนสั่งเป็นคนเปิด */
async function pickOwnedRound(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector,
): Promise<Exclude<RoundPick, { kind: "none" }>> {
  const pick = pickRound(
    await loadOpenRounds(lineGroupId),
    (round) => round.game.created_by === user.id,
    selector,
  );
  if (pick.kind === "none") throw new AppError("NOT_GAME_CREATOR");
  return pick;
}

/**
 * แก้ไขรอบ ไม่มี patch = ขึ้นเมนูให้เลือกว่าจะแก้อะไร
 * มี patch = ค่าที่ LLM เสนอมาทั้งชุด ขึ้นการ์ดยืนยันเลย ถ้าต้องถามรอบก่อนก็จำ patch ไว้ในการ์ด
 */
export async function doEdit(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
  patch?: EditPatch,
): Promise<LineMessage[]> {
  const pick = await pickOwnedRound(lineGroupId, user, selector);
  if (pick.kind === "choose") {
    return askWhichRound(lineGroupId, user, "edit", pick.rounds, patch ? { patch: patch as PendingPayload } : {});
  }

  if (patch) {
    const { pending, game } = await proposeEditGame(lineGroupId, pick.round.game.id, user.id, patch);
    return [confirmEditGame(pending.id, game, patch)];
  }

  const { pending } = await startEditGame(lineGroupId, pick.round.game.id, user.id);
  return [editMenu(pending.id)];
}

export async function doCancel(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
): Promise<LineMessage[]> {
  const pick = await pickOwnedRound(lineGroupId, user, selector);
  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "cancel", pick.rounds);

  const { pending, game, joinedCount } = await startCancelGame(lineGroupId, pick.round.game.id, user.id);
  return [confirmCancelGame(pending.id, game, joinedCount)];
}

export async function doClose(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
): Promise<LineMessage[]> {
  const pick = await pickOwnedRound(lineGroupId, user, selector);
  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "close", pick.rounds);

  const { pending, game, joinedCount } = await startCloseGame(lineGroupId, pick.round.game.id, user.id);
  return [confirmCloseGame(pending.id, game, joinedCount, await unpaidSharesForGame(game.id))];
}
