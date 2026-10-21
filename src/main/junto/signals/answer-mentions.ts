import { Effect, Option } from "effect";
import { ulid } from "ulid";
import type { AgentSignal } from "@shared/agent-signals";
import { mailExtensionMetadata } from "@shared/crew";
import { mentionLinksOf, mentionedOnce, mentionsOf } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { ModelService } from "../model/service";
import { mentionableSeats } from "../work/operator-threads";
import { WorkService } from "../work/service";

/**
 * The needs-you reply's side effect hook (0.10 plan 03 section 2): a seat
 * the operator mentions in an answer is copied on it. Only seats wired to
 * the signalling seat by an edge may be (section 3, the same rule the
 * composer offers from); a mention of any other refuses the answer before
 * anything is written. Tasks, artifacts and pages mentioned stay references.
 * A quiet answer mails no one, so it copies no one: its mentions are words.
 */

export type AnswerCopies =
  | { readonly ok: true; readonly seats: ReadonlyArray<NodeId> }
  | { readonly ok: false; readonly outside: ReadonlyArray<NodeId> };

/** Which seats an answer's text copies, given the canvas's node kinds and the seats wired to the signalling seat. */
export const answerCopies = (
  text: string,
  signalSeat: NodeId,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
  connected: ReadonlySet<string>,
): AnswerCopies => {
  const seats = mentionedOnce(mentionsOf(text, nodeKindOf))
    .flatMap((ref) => (ref.kind === "seat" && ref.nodeId !== signalSeat ? [ref.nodeId] : []));
  const outside = seats.filter((seat) => !connected.has(seat));
  return outside.length > 0 ? { ok: false, outside } : { ok: true, seats };
};

/** The copy's words: whose signal, what it said, and the answer. */
export const composeAnswerCopy = (
  signal: Pick<AgentSignal, "signalId" | "text">,
  seatName: string,
  response: string,
): string =>
  [`The operator answered ${seatName}'s signal (${signal.signalId}): "${signal.text}", and copied you:`, "", response.trim()].join("\n");

/**
 * Plan an answer's copies against the live canvas: the seats to copy, or the
 * refusal naming the ones that are not wired to the signalling seat.
 */
export const planAnswerCopies = (signal: Pick<AgentSignal, "canvasName" | "nodeId">, text: string) =>
  Effect.gen(function* () {
    // Nothing linked, nothing to read: the common answer pays no lookup.
    if (mentionLinksOf(text).length === 0) return { ok: true as const, seats: [] as ReadonlyArray<NodeId>, seatName: undefined };
    const model = yield* Effect.serviceOption(ModelService);
    if (Option.isNone(model)) return { ok: false as const, message: "mentions cannot be read in this Junto runtime" };
    const canvas = yield* Effect.result(model.value.canvas(signal.canvasName));
    if (canvas._tag === "Failure") return { ok: false as const, message: "the canvas could not be read to copy mentioned seats" };
    const nodes = canvas.success.nodes;
    const kindOf = (nodeId: NodeId): NodeKind | undefined => nodes.get(nodeId)?.kind;
    const name = (nodeId: NodeId): string => {
      const node = nodes.get(nodeId);
      return node === undefined ? nodeId : titleOf(node);
    };
    const seat = signal.nodeId as NodeId;
    const seatName = name(seat);
    const wired = yield* Effect.result(
      mentionableSeats(signal.canvasName, signal.nodeId).pipe(Effect.provideService(ModelService, model.value)),
    );
    if (wired._tag === "Failure") return { ok: false as const, message: `the seats wired to ${seatName} could not be read to copy mentioned seats` };
    const connected = new Set(wired.success.map((entry) => entry.nodeId));
    const copies = answerCopies(text, seat, kindOf, connected);
    if (copies.ok) return { ok: true as const, seats: copies.seats, seatName };
    return {
      ok: false as const,
      message: `${copies.outside.map((id) => `@${name(id)}`).join(", ")} ${copies.outside.length === 1 ? "is" : "are"} not wired to ${seatName}: an answer copies only seats connected to it`,
    };
  });

/**
 * Mail each planned seat a copy of the answer, in the answer's thread. A
 * copy that cannot be written is logged and skipped: the answer itself stands.
 */
export const sendAnswerCopies = (
  signal: Pick<AgentSignal, "canvasName" | "nodeId" | "signalId" | "text">,
  seatName: string,
  response: string,
  answerMessageId: string,
  seats: ReadonlyArray<NodeId>,
) =>
  Effect.gen(function* () {
    if (seats.length === 0) return [] as ReadonlyArray<NodeId>;
    const work = yield* WorkService;
    const sender = operatorActorRef(signal.canvasName);
    const copied: NodeId[] = [];
    for (const seat of seats) {
      const appended = yield* work.workSystemMailboxNotify(
        signal.canvasName,
        seat,
        makeUserMessage({
          messageId: ulid(),
          text: composeAnswerCopy(signal, seatName, response),
          contextId: signal.canvasName,
          metadata: {
            factoryMail: true,
            agentSignalId: signal.signalId,
            threadId: answerMessageId,
            inReplyTo: answerMessageId,
            ...mailExtensionMetadata({
              mailKind: "prompt",
              fromSeat: sender.seatId,
              senderNodeId: sender.nodeId,
              senderName: "operator",
              senderGeneration: "operator",
              senderHarness: "unknown",
            }),
          },
        }),
      );
      if (appended.ok) copied.push(seat);
      else yield* Effect.logWarning(`signal answer copy to ${seat} not written: ${appended.message}`);
    }
    return copied as ReadonlyArray<NodeId>;
  });
