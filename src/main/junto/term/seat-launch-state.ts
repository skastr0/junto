/**
 * What an agent seat on this machine answers about its next start
 * (modelSeatLaunchState): whether it holds a session that locks its creation
 * settings, what its next start does, and whether its next turn, whoever
 * gives it, starts fresh. The card reads it here for this machine's seats,
 * and the seats link carries it to the machine that edits a seat's canvas
 * (seats-launch.ts).
 */
import { Effect } from "effect";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { NodeOf } from "@shared/model";
import { seatNextLaunch } from "@shared/seat-next-launch";
import { AppRuntime } from "../../runtime";
import { seatNextTurnOf } from "../seat-sessions/operator-offboard";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { shouldAvoidSharedHarnessResume } from "./managed-spawn-plan";
import type { SeatLaunchState } from "./seats-launch";
import { shouldResumeHarnessSession } from "./session-existence";

export const seatLaunchStateOf = async (canvas: string, node: NodeOf<"agent">): Promise<SeatLaunchState> => {
  const { session, history } = await AppRuntime.runPromise(Effect.flatMap(SeatSessionRepository,
    (sessions) => Effect.all({
      session: sessions.current(node.id, node.bindingId),
      history: sessions.list(node.id).pipe(Effect.orElseSucceed(() => [])),
    })));
  const lastEnded = history.find((row) => row.endedAt !== undefined)?.endReason;
  // The same proof a start asks for (managed-spawn-plan.ts): the harness's own
  // store holds the id, and this Junto is not an isolated home sharing the
  // harness's sessions, where every start is fresh.
  const cwd = node.launch?.cwd?.trim();
  const next = seatNextLaunch({
    harness: node.harness,
    ...(session ? { open: { harness: session.harness, sessionId: session.sessionId } } : {}),
    provisioned: isHarnessId(node.harness) && templateFor(node.harness).capabilityBadges.sessionId === "provision",
    provenOnDisk: session !== undefined && session.harness === node.harness && !shouldAvoidSharedHarnessResume() &&
      shouldResumeHarnessSession(true, { harness: node.harness, sessionId: session.sessionId, ...(cwd ? { cwd } : {}) }),
    ...(lastEnded ? { lastEnded } : {}),
  });
  const nextTurn = await seatNextTurnOf({ canvasName: canvas, seatId: node.id }, next);
  return { hasSession: session?.harness === node.harness, next, ...(nextTurn ? { nextTurn } : {}) };
};
