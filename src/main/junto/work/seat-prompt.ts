/**
 * Prompt mail to a seat: text from the operator, or from Junto itself (the
 * offboard ask), written to the seat's mailbox and delivered like any other
 * mail, at once when the seat is live, else when it comes up.
 *
 * The window and the windowless core send it the same way; each passes the
 * runtime it owns.
 */
import { Effect } from "effect";
import { ulid } from "ulid";
import { asNodeId } from "@shared/model";
import { mailExtensionMetadata } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { MainAuthoringRefused, mainAuthoringGate } from "../main-authoring-gate";
import { ModelService } from "../model/service";
import { messageDelivery } from "./message-delivery";
import { WorkService, type WorkOpResult } from "./service";

export type SeatPromptRun = <A, E>(effect: Effect.Effect<A, E, ModelService | WorkService>) => Promise<A>;

export type SeatPromptInput = {
  readonly bindingId?: string;
  readonly text?: string;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly wake?: boolean;
};

export type SeatPromptResult =
  | { readonly ok: true; readonly disposition: "submitted" | "queued"; readonly messageId: string }
  | { readonly ok: false; readonly disposition: "failed"; readonly messageId?: string; readonly error: string };

const failed = (error: string): SeatPromptResult => ({ ok: false, disposition: "failed", error });

/** A refused write is an answer, not a throw. */
const authoring = <A>(operation: () => Promise<WorkOpResult<A>>): Promise<WorkOpResult<A>> =>
  mainAuthoringGate.run("ipc.work.message-append", operation).catch((error: unknown) => {
    if (error instanceof MainAuthoringRefused) {
      return { ok: false as const, code: "invalid" as const, message: error.message };
    }
    return Promise.reject(error);
  });

export const appendSeatPrompt = async (
  run: SeatPromptRun,
  input: SeatPromptInput,
  // Main's own prompts (offboard) sign as Junto; the renderer's are
  // always the operator's.
  senderName: string = "operator",
): Promise<SeatPromptResult> => {
  const bindingId = typeof input?.bindingId === "string" ? input.bindingId.trim() : "";
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!bindingId) return failed("binding required");
  if (!text) return failed("empty prompt");
  const canvasName = typeof input?.canvasName === "string" ? input.canvasName.trim() : "";
  const nodeId = typeof input?.nodeId === "string" ? input.nodeId.trim() : "";
  if (!canvasName || !nodeId) return failed("canvas and node required");
  const sender = operatorActorRef(canvasName);
  const messageId = ulid();
  // A caller that only addresses live seats keeps a down seat down.
  if (input?.wake === false) messageDelivery.holdWake(messageId);
  const message = makeUserMessage({
    messageId,
    text,
    contextId: canvasName,
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: sender.seatId,
        senderNodeId: sender.nodeId,
        senderName,
        senderGeneration: "operator",
        senderHarness: "unknown",
      }),
    },
  });
  try {
    const appended = await authoring(() =>
      run(
        Effect.gen(function* () {
          const model = yield* ModelService;
          const canvas = yield* model.canvas(canvasName);
          const node = canvas.nodes.get(asNodeId(nodeId));
          if (node?.kind !== "agent") {
            return { ok: false as const, code: "invalid" as const, message: "Choose an agent seat for this message" };
          }
          if (node.bindingId !== bindingId) {
            return { ok: false as const, code: "invalid" as const, message: "binding does not match the managed seat" };
          }
          const work = yield* WorkService;
          return yield* work.workSystemMailboxNotify(canvasName, nodeId, message);
        }),
      ),
    );
    if (!appended.ok) return failed(appended.message);
    const liveId = appended.data.messageId;
    const state = await messageDelivery.deliver(canvasName, nodeId, liveId);
    return { ok: true, disposition: state === "delivered" ? "submitted" : "queued", messageId: liveId };
  } catch (error) {
    return {
      ok: false,
      disposition: "failed",
      messageId,
      error: error instanceof Error ? error.message : "prompt write failed",
    };
  }
};
