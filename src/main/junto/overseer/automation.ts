// Automation writes on the overseer plane (plan 07, cli L4). Only the operator
// and overseers write automations, as with the canvas: `automation.create`,
// `automation.edit`, `automation.enable`, `automation.disable`,
// `automation.archive` and `automation.run` are overseer operations, written
// on the overseer's own canvas as that seat. The automation domain checks the
// overseer toggle again when it rules, and keeps the targets in its reach.

import { Effect } from "effect";
import { isAutomationWriteOp } from "@shared/automation-control";
import { asNodeId } from "@shared/model";
import type { OverseerCaller, OverseerRequest } from "@shared/overseer-control";
import type { WorkErrorBody } from "@shared/work-control";
import type { ActorRef } from "@shared/work-protocol";
import { handleAutomationWrite, liveAutomationPorts, type AutomationPorts } from "../work/automation-control";
import { modelCanvas, type OverseerStores } from "./portfolio";

export const executeOverseerAutomation = (
  caller: OverseerCaller,
  request: OverseerRequest,
  actor: ActorRef,
  ports: AutomationPorts = liveAutomationPorts,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const operation = request.operation;
    if (!isAutomationWriteOp(operation)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "ProtocolError",
        message: `the automation handler does not answer ${operation}`,
      });
    }
    const canvas = yield* modelCanvas(caller.canvasName);
    return yield* handleAutomationWrite(operation, request.args, {
      canvas,
      canvasName: caller.canvasName,
      actor: { kind: "seat", seatId: actor.seatId, nodeId: asNodeId(caller.nodeId) },
    }, ports);
  });
