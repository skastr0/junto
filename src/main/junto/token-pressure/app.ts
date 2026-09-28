/**
 * The app side of token pressure: which seats to watch, read off the
 * canvases, and how the nudge reaches a seat. The nudge is ordinary prompt
 * mail on the one delivery path every message takes, signed by Junto, and it
 * never starts a seat that is down.
 */
import { Effect } from "effect";
import { ulid } from "ulid";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { mailExtensionMetadata } from "@shared/crew";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { PRODUCT_NAME } from "@shared/product-name";
import { makeUserMessage } from "@shared/task";
import { isSeatTokenPressure } from "@shared/token-pressure";
import { operatorActorRef } from "@shared/work-reference";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { mainAuthoringGate } from "../main-authoring-gate";
import { SettingsService } from "../settings/service";
import { WorkService } from "../work/service";
import { messageDelivery } from "../work/message-delivery";
import type { PressureSeat } from "./monitor";

/** Every local managed-agent seat on every canvas (Command Center only). */
export const listPressureSeats = (): Promise<ReadonlyArray<PressureSeat>> =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      if ((yield* settings.get).station.role !== "command-center") return [];
      const canvases = yield* CanvasesService;
      const seats: PressureSeat[] = [];
      for (const summary of yield* canvases.list) {
        const read = yield* Effect.result(canvases.read(summary.name, "tokenPressure.seats"));
        if (read._tag === "Failure") continue;
        for (const node of read.success.doc.nodes) {
          const surface = actorDeliverySurfaceOf(node);
          if (surface?._tag !== "managedAgent" || surface.hostId !== "local") continue;
          const terminal = node.ether?.terminal;
          const harness = surface.harness;
          const model = isHarnessId(harness)
            ? recoverDocumentLaunchChoices(harness, terminal?.launch).model
            : undefined;
          const override = terminal?.tokenPressure;
          seats.push({
            canvasName: summary.name,
            nodeId: node.id,
            bindingId: surface.bindingId,
            harness,
            sessionId: terminal?.sessionId?.trim() ?? "",
            ...(terminal?.launch?.cwd ? { cwd: terminal.launch.cwd } : {}),
            ...(model ? { launchModel: model } : {}),
            ...(terminal?.launch?.env ? { env: terminal.launch.env } : {}),
            ...(override !== undefined && isSeatTokenPressure(override) ? { override } : {}),
          });
        }
      }
      return seats;
    }),
  );

/**
 * Put the nudge in the seat's mailbox and type it in. The monitor only
 * calls this while the seat is idle between turns; `holdWake` keeps a seat
 * that stopped in the meantime from being started by it.
 */
export const sendPressureNudge = async (seat: PressureSeat, text: string): Promise<boolean> => {
  const sender = operatorActorRef(seat.canvasName);
  const messageId = ulid();
  messageDelivery.holdWake(messageId);
  const message = makeUserMessage({
    messageId,
    text,
    contextId: seat.canvasName,
    metadata: {
      factoryMail: true,
      tokenPressure: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: sender.seatId,
        senderNodeId: sender.nodeId,
        senderName: PRODUCT_NAME,
        senderGeneration: "operator",
        senderHarness: "unknown",
      }),
    },
  });
  const appended = await mainAuthoringGate
    .run("token-pressure.nudge", () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const canvases = yield* CanvasesService;
          const read = yield* Effect.result(canvases.read(seat.canvasName, "tokenPressure.seats"));
          if (read._tag === "Failure") return false;
          const node = read.success.doc.nodes.find((candidate) => candidate.id === seat.nodeId);
          const surface = node === undefined ? undefined : actorDeliverySurfaceOf(node);
          // The seat changed hands since the list was read: say nothing.
          if (surface === undefined || surface.bindingId !== seat.bindingId) return false;
          const work = yield* WorkService;
          const result = yield* work.workSystemMailboxNotify(seat.canvasName, seat.nodeId, message);
          return result.ok ? result.data.messageId : false;
        }),
      ),
    )
    .catch(() => false as const);
  if (appended === false) return false;
  // In the mailbox it is sent: a seat not ready this instant gets it the
  // moment it is, so a second nudge would only repeat it.
  void messageDelivery.deliver(seat.canvasName, seat.nodeId, appended).catch(() => undefined);
  return true;
};
