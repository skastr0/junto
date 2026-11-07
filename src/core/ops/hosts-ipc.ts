/**
 * The one machine command the window sends (hosts/ipc.ts) and its doctor
 * report (src/app/ipc-handlers.ts). The command answers in the owner envelope, and its
 * progress is published, so the window that asked hears it and no other. The
 * hosts read and write operations this file used to carry had no window
 * caller; the machine list comes from the owner command client instead.
 */
import { Effect, Option } from "effect";
import { OPERATOR_PROTOCOL_VERSION, type OperatorResponseEnvelope } from "@shared/operator-control";
import type { StationInfo, DoctorReport } from "@shared/contracts";
import { buildDoctorReport } from "../doctor";
import { MachineOwnerControl } from "../hosts/machine-owner";
import { dispatchMachineIpcCommand } from "../hosts/machine-ipc-command";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../../contract/core/channels";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

declare module "../ops" {
  interface CoreOps {
    "ipc.hosts.command": CoreOp<
      { readonly input: unknown; readonly requestId: string },
      OperatorResponseEnvelope
    >;
    "ipc.doctor.report": CoreOp<{ readonly station: StationInfo }, DoctorReport>;
  }
}

coreOps({
  // An operator command with its progress: the asking window is named, so the
  // push lands in that window alone.
  "ipc.hosts.command": ({ input, requestId }) =>
    Effect.gen(function* () {
      const actions = yield* Effect.serviceOption(MachineOwnerControl);
      if (Option.isNone(actions)) {
        return {
          protocol: OPERATOR_PROTOCOL_VERSION,
          ok: false,
          error: { type: "runtime_down", message: "Machine control is not ready", details: { retryable: false } },
        } satisfies OperatorResponseEnvelope;
      }
      return yield* dispatchMachineIpcCommand(actions.value, input, (progress) =>
        publish(MACHINE_PROGRESS, { requestId, progress } satisfies MachineProgressPushed),
      );
    }),
  // The window's doctor: every service's own answer, as one document, with
  // this installation's station facts as main knows them.
  "ipc.doctor.report": ({ station }) => buildDoctorReport(station),
});
