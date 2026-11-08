/**
 * The core's share of the startup wiring (junto/ipc.ts). With the core in its
 * own process, main has no core services, so what needs them runs here: the
 * seed canvas, the mail and sink change publishes, usage and the kernel
 * snapshot, the connection-change notices, the wire traffic, the checkout
 * watch and the onboarding nudge's interject. Each publish rides the core
 * push, which main relays.
 *
 * It is one Layer the core's runtime builds after its services (entry.ts):
 * every subscription it makes is released when the Layer's scope closes, so a
 * core that stops, or a test's, leaves nothing listening.
 */
import { Effect, Layer, type Scope } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { KernelService } from "../kernel/service";
import { ModelService } from "../model/service";
import { UsageService } from "../usage/usage-service";
import { WorkRepository } from "../work/repository";
import { CorePushes, type CorePushesShape } from "../push";
import { WIRE_TRAFFIC } from "../../contract/core/channels";
import { wireTrafficPreview, type WireTrafficEvent } from "@shared/wire-traffic";
import type { Canvas } from "@shared/model";
import type { UsageState } from "@shared/usage";
import { USAGE_ENABLED } from "@shared/features";
import { coreRunner } from "../core-runner";
import { MachineCoreMail } from "../core-runtime";
import { ModelActorRefs } from "../model/actor-refs";
import { SettingsService } from "../settings/service";
import { closingFence } from "../term/closing-fence";
import { injectionSupervisor } from "../term/injection-supervisor";
import { makeOnboardNudgeInterject } from "../term/onboard-nudge-interject";
import { wireFactorySupervisor } from "../term/factory-delivery-composition";
import { termPlane } from "../term/plane";
import { terminalObserverPlane } from "../term/observer";
import { makeCheckoutWatchComposition } from "../work/checkout-watch-composition";
import type { CheckoutWatchSupervisor } from "../work/checkout-watch-live";
import { CrewRepository } from "../work/crew-repository";
import { canvasReceiptBasis } from "../work/delivery-receipts";
import { onCanvasChangeForEdgeMap } from "../work/edge-map-notify";
import { messageDelivery } from "../work/message-delivery";
import { TaskRepository } from "../work/task-repository";
import { ClipboardHost } from "../../contract/host/clipboard";
import { harnessRecordFor } from "@shared/harness-records";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { ClipboardUnreadable, clipboardSafeAssert } from "../term/drive/clipboard-guard";

/** A subscription held until the scope closes: `subscribe` returns what stops it, when it returns anything. */
const listening = (subscribe: () => unknown): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(subscribe),
    (stop) =>
      Effect.sync(() => {
        if (typeof stop === "function") stop();
      }),
  ).pipe(Effect.asVoid);

/**
 * The usage snapshot reaches the window only where the build turns usage on
 * (baseline junto/ipc.ts:896); the first fetch at the end of this op is gated
 * the same way. Exported for the flag's test.
 */
export const subscribeUsageWhenEnabled = (
  usage: { readonly subscribe: (listener: (state: UsageState) => void) => unknown },
  pushes: CorePushesShape,
  enabled: boolean = USAGE_ENABLED,
): unknown => (enabled ? usage.subscribe((state) => Effect.runSync(pushes.publish(IPC_CHANNELS.usageChanged, state))) : undefined);

export const CoreStartup = Layer.effectDiscard(
  Effect.gen(function* () {
    const model = yield* ModelService;
    const clipboardHost = yield* ClipboardHost;
    const pushes = yield* CorePushes;
    yield* model.ensureSeed.pipe(Effect.catch(() => Effect.void));
    const mail = yield* WorkRepository;
    yield* listening(() =>
      mail.subscribeChanges((canvasName, nodeId, kind) => {
        Effect.runSync(pushes.publish(kind === "mail" ? IPC_CHANNELS.workMailChanged : IPC_CHANNELS.workSinkChanged, { canvasName, nodeId }));
      }),
    );
    const usage = yield* UsageService;
    yield* listening(() => subscribeUsageWhenEnabled(usage, pushes));
    const kernel = yield* KernelService;
    yield* listening(() => kernel.subscribe((snapshot) => Effect.runSync(pushes.publish(IPC_CHANNELS.kernelChanged, snapshot))));

    // Keep the last model topology for compact connection-change notices.
    const noticeCanvases = new Map<string, Canvas>();
    for (const name of yield* model.listCanvases()) noticeCanvases.set(name, yield* model.canvas(name));
    yield* listening(() =>
      model.subscribeChanges((event, next) => {
        const previous = noticeCanvases.get(event.canvas);
        noticeCanvases.set(event.canvas, next);
        void coreRunner.runPromise(onCanvasChangeForEdgeMap(event.canvas, { previous, next }));
      }),
    );
    yield* listening(() =>
      model.subscribeCanvasesChanges((event, current) => {
        if (event._tag === "Removed") noticeCanvases.delete(event.canvas);
        else if (current) noticeCanvases.set(event.canvas, current);
      }),
    );

    yield* listening(() => injectionSupervisor.subscribeOnboarding((event) => Effect.runSync(pushes.publish(IPC_CHANNELS.seatOnboardingChanged, event))));

    // A continuation line held by the seat's input box is said on the seat, and every message typed into a seat pulses its wire.
    yield* listening(() =>
      injectionSupervisor.subscribeContinuationHeld((bindingId, hold, line) => {
        const live = termPlane.host.get(bindingId);
        if (!live?.canvasName || !live.nodeId) return;
        Effect.runSync(pushes.publish(WIRE_TRAFFIC, {
          canvasName: live.canvasName,
          toNodeId: live.nodeId,
          kind: "notice",
          messageId: `continuation:${bindingId}:${live.epoch}`,
          preview: wireTrafficPreview(line),
          at: Date.now(),
          held: hold,
        } satisfies WireTrafficEvent));
      }),
    );
    yield* listening(() => messageDelivery.subscribeDelivered((event) => Effect.runSync(pushes.publish(WIRE_TRAFFIC, event))));

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
          clipboardHost.ClipboardSafeForGrok().pipe(
            Effect.mapError((cause) => new ClipboardUnreadable({ message: cause.message })),
          ),
        run: (effect) => coreRunner.runPromise(effect),
      }),
    );
    yield* listening(() =>
      coreMail.seats.onSuspend(() => {
        suspended = true;
        checkoutWatch?.stop();
      }),
    );

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
      // A harness can keep the continuation line and refuse the submit while
      // it is still starting (pi 1.5.0). The bare Enter is the drive's own
      // recovery submit, which never pastes text.
      submit: (bindingId) => managedDrive.submitRecoveryCr(bindingId),
      composerVerdict: (bindingId) => seatStateRuntime.composerVerdict(bindingId),
      subscribeSnapshots: (listener) => terminalObserverPlane.subscribeGlobal(listener),
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
    yield* listening(() => settings.subscribe(() => syncCheckoutWatch()));
    // The watch stops with the scope, as every listener above does.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        checkoutWatch?.stop();
      }),
    );

    // First usage fetch is fire-and-forget off the boot critical path.
    if (USAGE_ENABLED) usage.start();
  }),
);
