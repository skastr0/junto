import { Effect } from "effect";
import type { ActorRef } from "@shared/work-protocol";
import type { CrewRepository, AttemptKey } from "./crew-repository";
import type { MessageDeliveryAttemptStore } from "./message-delivery";

/** Promise boundary over the app's existing repository and compiled seat identity. */
export const makeMailAttemptStore = (deps: {
  readonly repository: CrewRepository;
  readonly resolveSeat: (canvas: string, nodeId: string) => Promise<ActorRef>;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly now?: () => string;
}): MessageDeliveryAttemptStore => {
  const now = deps.now ?? (() => new Date().toISOString());
  const keyFor = async (input: {
    canvas: string; nodeId: string; messageId: string; generation: string;
  }): Promise<AttemptKey> => {
    const seat = await deps.resolveSeat(input.canvas, input.nodeId);
    if (seat.canvasName !== input.canvas || seat.nodeId !== input.nodeId) {
      throw new Error("Mail recipient does not match the compiled seat");
    }
    return {
      sink: { canvasName: input.canvas, nodeId: input.nodeId },
      messageId: input.messageId,
      recipientSeatId: seat.seatId,
      recipientGeneration: input.generation,
    };
  };
  return {
    enqueueAttempt: async (input) => {
      const key = await keyFor(input);
      return (await deps.run(deps.repository.enqueueAttempt({
        ...key, policy: input.policy, at: input.at ?? now(),
      }))).attempt;
    },
    enqueueBatch: async (input) => {
      const seat = await deps.resolveSeat(input.canvas, input.nodeId);
      if (seat.canvasName !== input.canvas || seat.nodeId !== input.nodeId) {
        throw new Error("Mail recipient does not match the compiled seat");
      }
      const at = input.at ?? now();
      return deps.run(deps.repository.enqueueBatch({
        members: input.members.map((member) => ({
          sink: { canvasName: input.canvas, nodeId: input.nodeId },
          recipientSeatId: seat.seatId,
          recipientGeneration: member.generation,
          messageId: member.messageId,
          policy: member.policy,
          batchId: input.batchId,
          at,
        })),
      }));
    },
    markAttempted: async (input) => {
      const key = await keyFor(input);
      return deps.run(Effect.gen(function* () {
        yield* deps.repository.markAttempted({ ...key, at: input.at ?? now() });
        const row = yield* deps.repository.attempt(key);
        if (row === undefined) return yield* Effect.fail(new Error("Mail intent has no durable attempt"));
        return row;
      }));
    },
    recordAttempt: async (input) => {
      const key = await keyFor(input);
      const outcome = "notifiedAt" in input.set
        ? { kind: "notified" as const, at: input.set.notifiedAt }
        : "unresolvedAt" in input.set
          ? { kind: "unresolved" as const, at: input.set.unresolvedAt }
          : { kind: "refused" as const, at: input.set.refusedAt, reason: input.set.refusedReason };
      return deps.run(deps.repository.recordAttempt({ ...key, outcome, write: input.write }));
    },
    attempt: async (input) => deps.run(deps.repository.attempt(await keyFor(input))),
    hasNotifiedAcrossGenerations: async (input) => {
      const seat = await deps.resolveSeat(input.canvas, input.nodeId);
      if (seat.canvasName !== input.canvas || seat.nodeId !== input.nodeId) {
        throw new Error("Mail recipient does not match the compiled seat");
      }
      return deps.run(deps.repository.hasNotifiedAcrossGenerations(
        { canvasName: input.canvas, nodeId: input.nodeId }, input.messageId, seat.seatId,
      ));
    },
    reconcileUnresolvedAttempts: (at) => deps.run(deps.repository.reconcileUnresolvedAttempts(at)),
    grantHeldAttempt: async (input) => {
      const key = await keyFor(input);
      return deps.run(deps.repository.grantHeldAttempt({
        ...key, at: input.at ?? now(),
      }));
    },
    listHeldAttempts: async (canvas) => deps.run(deps.repository.listHeldAttempts(canvas)),
    grantNoticeFallback: async (input) => {
      const seat = await deps.resolveSeat(input.canvas, input.nodeId);
      if (seat.canvasName !== input.canvas || seat.nodeId !== input.nodeId) {
        throw new Error("Mail recipient does not match the compiled seat");
      }
      return deps.run(deps.repository.grantNoticeFallback({
        sink: { canvasName: input.canvas, nodeId: input.nodeId },
        messageId: input.messageId,
        recipientSeatId: seat.seatId,
        reason: input.reason,
        at: input.at ?? now(),
      }));
    },
    hasNoticeFallback: async (input) => {
      const seat = await deps.resolveSeat(input.canvas, input.nodeId);
      if (seat.canvasName !== input.canvas || seat.nodeId !== input.nodeId) {
        throw new Error("Mail recipient does not match the compiled seat");
      }
      return deps.run(deps.repository.hasNoticeFallback(
        { canvasName: input.canvas, nodeId: input.nodeId }, input.messageId, seat.seatId,
      ));
    },
  };
};
