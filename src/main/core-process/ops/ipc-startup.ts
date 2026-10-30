/**
 * The core's share of the startup wiring (junto/ipc.ts). With the core in its
 * own process, main has no core services, so what needs them runs here, once,
 * from entry.ts after startCore: the seed canvas, the mail and sink change
 * publishes, usage and the kernel snapshot. Each publish rides the core push,
 * which main relays.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { KernelService } from "../../junto/kernel/service";
import { ModelService } from "../../junto/model/service";
import { UsageService } from "../../junto/usage/usage-service";
import { WorkRepository } from "../../junto/work/repository";
import { publish } from "../push";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.startup.core": CoreOp<Record<string, never>, void>;
  }
}

coreOps({
  "ipc.startup.core": () =>
    Effect.gen(function* () {
      const model = yield* ModelService;
      yield* model.ensureSeed.pipe(Effect.catch(() => Effect.void));
      const mail = yield* WorkRepository;
      mail.subscribeChanges((canvasName, nodeId, kind) => {
        if (kind === "mail") publish(IPC_CHANNELS.workMailChanged, { canvasName, nodeId });
        else publish(IPC_CHANNELS.workSinkChanged, { canvasName, nodeId });
      });
      const usage = yield* UsageService;
      usage.subscribe((state) => publish(IPC_CHANNELS.usageChanged, state));
      const kernel = yield* KernelService;
      kernel.subscribe((snapshot) => publish(IPC_CHANNELS.kernelChanged, snapshot));
    }),
});
