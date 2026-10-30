/**
 * The core's share of the startup wiring (junto/ipc.ts). With the core in its
 * own process, main has no core services, so what needs them runs here, once,
 * from entry.ts after startCore: the seed canvas, the mail and sink change
 * publishes, usage and the kernel snapshot, the connection-change notices, the
 * checkout watch and the onboarding nudge's interject. Each publish rides the core push, which main relays.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { KernelService } from "../../junto/kernel/service";
import { ModelService } from "../../junto/model/service";
import { UsageService } from "../../junto/usage/usage-service";
import { WorkRepository } from "../../junto/work/repository";
import { publish } from "../push";
import type { Canvas } from "@shared/model";
import { USAGE_ENABLED } from "@shared/features";
import { onboardNudgeRefusal } from "@shared/seat-onboarding-status";
import { redactProvidersForIpc, type Settings } from "@shared/settings";
import { coreRunner } from "../../core-runner";
import { MachineCoreMail } from "../../core-runtime";
import { ModelActorRefs } from "../../junto/model/actor-refs";
import { SettingsService } from "../../junto/settings/service";
import { closingFence } from "../../junto/term/closing-fence";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { makeOnboardNudgeInterject } from "../../junto/term/onboard-nudge-interject";
import { wireFactorySupervisor } from "../../junto/term/factory-delivery-composition";
import { termPlane } from "../../junto/term/plane";
import { terminalObserverPlane } from "../../junto/term/observer";
import { seatStateRuntime } from "../../junto/term/agent-state/runtime";
import { makeCheckoutWatchComposition } from "../../junto/work/checkout-watch-composition";
import type { CheckoutWatchSupervisor } from "../../junto/work/checkout-watch-live";
import { CrewRepository } from "../../junto/work/crew-repository";
import { canvasReceiptBasis } from "../../junto/work/delivery-receipts";
import { onCanvasChangeForEdgeMap } from "../../junto/work/edge-map-notify";
import { messageDelivery } from "../../junto/work/message-delivery";
import { TaskRepository } from "../../junto/work/task-repository";
import { bindSeatIpc, seatOnOfCore } from "./ipc-seats";
import { coreOps, type CoreOp } from "../ops";
import { host } from "../host-ops";
import { harnessRecordFor } from "@shared/harness-records";
import { seatStateRuntime } from "../../junto/term/agent-state/runtime";
import { ClipboardUnreadable, clipboardSafeAssert } from "../../junto/term/drive/clipboard-guard";

declare module "../ops" {
  interface CoreOps {
    "ipc.startup.core": CoreOp<Record<string, never>, void>;
    "ipc.settings.current": CoreOp<Record<string, never>, Settings>;
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

      // Keep the last model topology for compact connection-change notices.
      const noticeCanvases = new Map<string, Canvas>();
      for (const name of yield* model.listCanvases()) noticeCanvases.set(name, yield* model.canvas(name));
      model.subscribeChanges((event, next) => {
        const previous = noticeCanvases.get(event.canvas);
        noticeCanvases.set(event.canvas, next);
        void coreRunner.runPromise(onCanvasChangeForEdgeMap(event.canvas, { previous, next }));
      });
      model.subscribeCanvasesChanges((event, current) => {
        if (event._tag === "Removed") noticeCanvases.delete(event.canvas);
        else if (current) noticeCanvases.set(event.canvas, current);
      });

      injectionSupervisor.subscribeOnboarding((event) => publish(IPC_CHANNELS.seatOnboardingChanged, event));

      const coreMail = yield* MachineCoreMail;
      const settings = yield* SettingsService;
      let suspended = false;
      let checkoutWatch: CheckoutWatchSupervisor | undefined;
      const { drive: managedDrive, mailReadyNow, driveReady } = coreMail.seats;
      // A harness that refuses an image paste (Grok) is asked before the drive
      // types; the pasteboard's formats are Electron's, so main answers and an
      // answer it does not give is a no (drive/clipboard-guard.ts).
      coreMail.seats.setClipboardSafe(
        clipboardSafeAssert({
          guarded: (bindingId) =>
            harnessRecordFor(seatStateRuntime.machine.getSlot(bindingId)?.harness)?.pty.clipboardImageGuard === true,
          ask: () =>
            Effect.tryPromise({
              try: () => host.call("clipboard.safeForGrok", {}),
              catch: (cause) =>
                new ClipboardUnreadable({ message: cause instanceof Error ? cause.message : String(cause) }),
            }),
        }),
      );
      coreMail.seats.onSuspend(() => {
        suspended = true;
        checkoutWatch?.stop();
      });

      // The onboarding nudge is interjected: typed whatever the seat is
      // doing, mid-turn included, because a nudge that waits for a turn to
      // end can be hours late. A dialog waiting for an answer is never typed
      // into, and the drive holds back for a draft in the composer.
      const interjectOnboardNudge = makeOnboardNudgeInterject({
        suspended: () => suspended,
        sealed: (bindingId) => closingFence.sealed(bindingId),
        mailReady: mailReadyNow,
        writeMail: (bindingId, text) => managedDrive.writeMail(bindingId, text),
      });
      // The supervisor's own lines: the automatic onboarding nudge and the
      // `--continue` handoff. It runs here, in the core, so its writer is the
      // core's mail gate, its composer reading the seat state's, and its
      // snapshots the observer's. Main holds no copy of any of it.
      wireFactorySupervisor({
        supervisor: injectionSupervisor,
        interject: (bindingId, text) =>
          interjectOnboardNudge(bindingId, text).then((outcome) => outcome === "written"),
        write: (bindingId, text, options) =>
          managedDrive.writePrompt(bindingId, text, { ready: options?.ready ?? driveReady(bindingId), ...(options ?? {}) }),
        composerVerdict: (bindingId) => seatStateRuntime.composerVerdict(bindingId),
        subscribeSnapshots: (listener) => terminalObserverPlane.subscribeGlobal(listener),
      });
      // The operator's nudge asks this core's plane for the seat, its running state and the interject.
      bindSeatIpc({
        seatOn: (target) => seatOnOfCore(target),
        seatRunning: (bindingId) => termPlane.host.get(bindingId)?.status === "running",
        interjectNudge: async (bindingId, text) => {
          const outcome = await interjectOnboardNudge(bindingId, text);
          return outcome === "written" ? { ok: true as const } : { ok: false as const, message: onboardNudgeRefusal(outcome) };
        },
        noteNudged: (bindingId) => injectionSupervisor.noteNudgeDelivered(bindingId),
      });

      checkoutWatch = makeCheckoutWatchComposition({
        model,
        actorRefs: yield* ModelActorRefs,
        settings,
        host: termPlane.host,
        crew: yield* CrewRepository,
        workRepository: mail,
        tasks: yield* TaskRepository,
        messageDelivery,
        basisFor: canvasReceiptBasis,
        run: (effect) => coreRunner.runPromise(effect),
        write: (effect) => coreRunner.runPromise(effect),
        onError: (error) => console.error("[checkout-watch]", error),
      });
      const syncCheckoutWatch = (): void => {
        if (!suspended) checkoutWatch?.start();
        else checkoutWatch?.stop();
      };
      syncCheckoutWatch();
      settings.subscribe(() => syncCheckoutWatch());

      // First usage fetch is fire-and-forget off the boot critical path.
      if (USAGE_ENABLED) usage.start();
    }),
  // The settings as they stand, provider secrets masked, for main's own readers.
  "ipc.settings.current": () => Effect.flatMap(SettingsService, (settings) => Effect.map(settings.get, redactProvidersForIpc)),
});
