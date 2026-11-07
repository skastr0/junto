/**
 * What an agent seat on this machine answers about its next start
 * (modelSeatLaunchState): whether it picks up where it was, which fixes its
 * creation settings, whether its next turn, whoever gives it, starts fresh,
 * and how it stands against its cache window. The card reads it here for
 * this machine's seats, and the seats link carries it to the machine that
 * edits a seat's canvas (seats-launch.ts).
 *
 * An effect over the seat's sessions, run in the runtime its process owns:
 * the window's, or the windowless core's. It never imports a runtime, so the
 * core bundle never reaches Electron through it.
 */
import { Clock, Effect } from "effect";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { NodeOf } from "@shared/model";
import { seatCacheWindow, seatNextLaunch } from "@shared/seat-next-launch";
import { seatLaunchOf } from "../seat-sessions/operator-offboard";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { shouldAvoidSharedHarnessResume } from "./managed-spawn-plan";
import type { SeatLaunchState } from "./seats-launch";
import { shouldResumeHarnessSession } from "./session-existence";

export const seatLaunchState = (canvas: string, node: NodeOf<"agent">) => Effect.gen(function* () {
  const sessions = yield* SeatSessionRepository;
  // One statement for both rows a card reads: the open session and the
  // reason the last one ended. Never the seat's history.
  const { open: session, lastEnded } = yield* sessions.launch(node.id, node.bindingId);
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
  const seat = { canvasName: canvas, seatId: node.id };
  // Both answers from one read of the seat, not one read each.
  const { nextTurn, facts: offboard } = yield* Effect.promise(() => seatLaunchOf(seat, next));
  const now = yield* Clock.currentTimeMillis;
  const cacheWindow = offboard && seatCacheWindow(nextTurn, offboard, now);
  const state: SeatLaunchState = {
    // Its next start picks up where it was, on the settings it started with.
    settingsFixed: next === "resume",
    ...(nextTurn ? { nextTurn } : {}),
    ...(cacheWindow ? { cacheWindow } : {}),
  };
  return state;
});
