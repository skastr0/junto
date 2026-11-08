/**
 * The core's handlers of the hosts group (src/contract/core/hosts-ipc.ts):
 * the one machine command the window sends (src/app/hosts/ipc.ts) and its
 * doctor report (src/app/ipc-handlers.ts). The command answers in the owner
 * envelope, and its progress is published, so the window that asked hears it
 * and no other. The hosts read and write operations this file used to carry
 * had no window caller; the machine list comes from the owner command client
 * instead.
 */
import { Effect } from "effect";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../../contract/core/channels";
import { HostsRpcs } from "../../contract/core/hosts-ipc";
import { buildDoctorReport } from "../doctor";
import { MachineOwnerControl } from "../hosts/machine-owner";
import { dispatchMachineIpcCommand } from "../hosts/machine-ipc-command";
import { CorePushes } from "../push";

export const HostsHandlers = HostsRpcs.toLayer(
  Effect.gen(function* () {
    const actions = yield* MachineOwnerControl;
    const pushes = yield* CorePushes;
    return {
      // An operator command with its progress: the asking window is named, so
      // the push lands in that window alone.
      HostsCommand: ({ input, requestId }) =>
        dispatchMachineIpcCommand(actions, input, (progress) =>
          Effect.runSync(pushes.publish(MACHINE_PROGRESS, { requestId, progress } satisfies MachineProgressPushed)),
        ),
      // The window's doctor: every service's own answer, as one document, with
      // this installation's station facts as main knows them.
      HostsDoctorReport: ({ station }) => buildDoctorReport(station),
    };
  }),
);
