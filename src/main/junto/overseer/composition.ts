
import { Effect, Result } from "effect";
import { OverseerLiveExecution, type OverseerLiveExecutionConstraint } from "./live/execution";
import type { Canvas } from "@shared/model";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { isHarnessId } from "@shared/managed-terminal-templates";
import type {
  OverseerArgsFor,
  OverseerCaller,
  OverseerRequest,
  OverseerResult,
} from "@shared/overseer-control";
import type { InstallationId } from "@shared/installation-id";
import type { WorkErrorBody } from "@shared/work-control";
import type { ModelActorRefs } from "../model/actor-refs";
import type { ModelService } from "../model/service";
import { ChatServiceContext } from "../chat/service";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import { termPlane } from "../term/plane";
import { MachineRepository } from "../machines/repository";
import type { BrowserSessionService } from "../browser/sessions";
import {
  mainAuthoringGate,
  mainAuthoringLabelForWorkOperation,
} from "../main-authoring-gate";
import { executeOverseer, type OverseerRuntime } from "./dispatch";
import { admitOverseer } from "./admission";
import {
  applySchedulerConfigure,
  commitAgentReseat,
  setOverseerNativeDeleteHooks,
} from "./canvas";
import {
  makeOverseerNativeLive,
  type AgentReseatCommitInput,
  type ApplicationCaptureResult,
  type OverseerNative,
  type SchedulerConfigureApplyInput,
} from "./native";
import { managedTerminalDriveForOverseer } from "../term/managed-drive-holder";
import type { ManagedTerminalDrive } from "../term/drive";
import type { ContentService } from "../content/service";
import { modelCanvases, type OverseerStores } from "./portfolio";
import type { WorkService } from "../work/service";

type OverseerServices =
  | OverseerStores
  | ChatServiceContext
  | ActorSeatOccupy
  | MachineRepository
  | ContentService
  | WorkService;

export type OverseerRunPromise = <A, E>(
  effect: Effect.Effect<A, E, OverseerServices>,
  options?: { readonly signal?: AbortSignal },
) => Promise<A>;

export type OverseerComposition = {
  readonly runtime: OverseerRuntime;
  readonly native: OverseerNative;
  readonly onOverseer: (
    request: OverseerRequest,
    caller: OverseerCaller,
    signal: AbortSignal,
    live?: OverseerLiveExecutionConstraint,
  ) => Promise<OverseerResult>;
  readonly bindPages: (pages: BrowserSessionService | undefined) => void;
  readonly dispose: () => void;
};

const unavailable = (message: string): WorkErrorBody => ({
  type: "RuntimeDown",
  message,
  details: { retryable: false },
});

const asWorkError = (error: unknown): WorkErrorBody => {
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    "message" in error &&
    typeof (error as { type: unknown }).type === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as WorkErrorBody;
  }
  return {
    type: "InternalError",
    message: error instanceof Error ? error.message : String(error),
    details: { retryable: false },
  };
};

const listCanvases = (
  run: OverseerRunPromise,
): Promise<ReadonlyMap<string, Canvas>> =>
  run(
    Effect.gen(function* () {
      return yield* modelCanvases;
    }),
  );

export const runCanvasHook = async <A>(
  run: <T, E>(effect: Effect.Effect<T, E, OverseerStores>, options?: { readonly signal?: AbortSignal }) => Promise<T>,
  effect: Effect.Effect<A, WorkErrorBody, OverseerStores>,
  signal: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const outcome = await run(Effect.result(effect), { signal });
  return Result.isSuccess(outcome)
    ? { ok: true }
    : { ok: false, message: outcome.failure.message };
};

export const captureTrustedWindowPng = (
  capture: () => Promise<Uint8Array | undefined>,
): (() => Promise<ApplicationCaptureResult>) =>
  async () => {
    try {
      const png = await capture();
      if (png === undefined) {
        return {
          ok: false,
          unavailable: true,
          reason: "no trusted Command Center window to observe",
        };
      }
      return { ok: true, png };
    } catch (error) {
      return {
        ok: false,
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

export const lateBoundDrive = (): Pick<ManagedTerminalDrive, "writePrompt" | "interrupt"> => ({
  writePrompt: (bindingId, text, options) => {
    const drive = managedTerminalDriveForOverseer();
    if (drive === undefined) return Promise.resolve({
      status: "refused" as const,
      reason: "not-ready" as const,
      bindingGeneration: 0,
      writesBefore: 0,
      writesAfter: 0,
      pasteWrites: 0,
      wrotePhysicalBytes: false,
    });
    return drive.writePrompt(bindingId, text, options);
  },
  interrupt: (bindingId) => {
    const drive = managedTerminalDriveForOverseer();
    if (drive === undefined) return Promise.resolve(false);
    return drive.interrupt(bindingId);
  },
});

/**
 * Immutable per-dispatch grant identity. Effect fibers can resume off the
 * originating async context, so process-global / ALS stores are not enough.
 */
export const createDispatchGrant = (
  run: <A, E>(effect: Effect.Effect<A, E, ModelService | ModelActorRefs | MachineRepository>) => Promise<A>,
  sourceInstallationId: InstallationId | undefined,
  live?: OverseerLiveExecutionConstraint,
): ((caller: OverseerCaller) => Promise<boolean>) =>
  (caller) =>
    run(admitOverseer(caller, sourceInstallationId))
      .then(() => { live?.assertCurrent(); return true; })
      .catch(() => false);

export const runOverseerProgram = <A, E>(
  run: OverseerRunPromise,
  program: Effect.Effect<A, E, OverseerServices>,
  signal: AbortSignal,
): Promise<A> => run(program, { signal });

const awaitAuthoringGatePromise = (
  evaluate: (signal: AbortSignal) => Promise<OverseerResult>,
): Effect.Effect<OverseerResult, unknown> =>
  Effect.callback<OverseerResult, unknown>((resume, signal) => {
    let flight: Promise<OverseerResult>;
    try {
      flight = Promise.resolve(evaluate(signal));
    } catch (error) {
      resume(Effect.fail(error));
      return;
    }
    void flight.then(
      (value) => resume(Effect.succeed(value)),
      (error) => resume(Effect.fail(error)),
    );
    // Keep the Effect pending until the captured Promise (including inner
    // lease / acquisition finalizers) actually settles. AbortSignal only
    // refuses later mutations; it cannot roll back work already in flight.
    return Effect.promise(() =>
      flight.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

export const composeOverseer = async (input: {
  readonly run: OverseerRunPromise;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  readonly pages?: BrowserSessionService;
  readonly sourceInstallationId?: InstallationId;
}): Promise<OverseerComposition> => {
  const chats = await input.run(Effect.gen(function* () {
    return yield* ChatServiceContext;
  }));
  const actorSeatOccupy = await input.run(Effect.gen(function* () {
    return yield* ActorSeatOccupy;
  }));
  const pagesHolder: { current: BrowserSessionService | undefined } = {
    current: input.pages,
  };
  const liveGrant = createDispatchGrant(input.run, input.sourceInstallationId);

  const commitReseatHook = async (
    payload: AgentReseatCommitInput,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    return runCanvasHook(
      input.run,
      commitAgentReseat(payload.caller, { canvas: payload.canvasName, nodeId: payload.nodeId }, payload.parts),
      signal,
    );
  };

  const applySchedulerHook = async (
    payload: SchedulerConfigureApplyInput,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    return runCanvasHook(
      input.run,
      applySchedulerConfigure(payload.caller, {
        canvas: payload.canvasName,
        nodeId: payload.nodeId,
        change: payload.change,
      }),
      signal,
    );
  };

  const native: OverseerNative = makeOverseerNativeLive({
    termPlane,
    chats,
    get pages() {
      return pagesHolder.current;
    },
    captureApplicationPage: input.captureApplicationPage,
    liveOverseerGrant: liveGrant,
    listCanvases: () => listCanvases(input.run),
    occupySeat: (spec, signal) =>
      input
        .run(actorSeatOccupy.occupy(spec), { signal })
        .then(() => true, () => false),
    managedDrive: lateBoundDrive(),
    commitAgentReseat: commitReseatHook,
    applySchedulerConfigure: applySchedulerHook,
  });

  setOverseerNativeDeleteHooks({
    prepareOverseerNodeDelete: native.prepareOverseerNodeDelete,
    finishOverseerNodeDelete: native.finishOverseerNodeDelete,
  });

  const runtime: OverseerRuntime = {
    native: (caller, request) => native.execute(caller, request),
  };

  let accepting = true;
  const overseerAuthoringLabel = mainAuthoringLabelForWorkOperation("overseer");
  if (overseerAuthoringLabel === undefined) {
    throw new Error("main authoring gate must classify WorkOpName overseer");
  }

  const executeInAuthoringGate = (
    request: OverseerRequest,
    caller: OverseerCaller,
    sourceInstallationId: InstallationId | undefined,
    signal: AbortSignal,
    live?: OverseerLiveExecutionConstraint,
  ): Promise<OverseerResult> => {
    if (!accepting) {
      return Promise.resolve({
        ok: false,
        operation: request.operation,
        error: {
          type: "RuntimeDown",
          message: "overseer composition is disposed",
        },
      });
    }
    const dispatchGrant = createDispatchGrant(input.run, sourceInstallationId, live);
    return mainAuthoringGate.run(overseerAuthoringLabel, () =>
      runOverseerProgram(
        input.run,
        executeOverseer(caller, request, {
          native: (nativeCaller, nativeRequest) =>
            makeOverseerNativeLive({
              termPlane,
              chats,
              get pages() {
                return pagesHolder.current;
              },
              captureApplicationPage: input.captureApplicationPage,
              liveOverseerGrant: dispatchGrant,
              listCanvases: () => listCanvases(input.run),
              occupySeat: async (spec, occupySignal) => {
                if (!await dispatchGrant(caller)) return false;
                const effect = actorSeatOccupy.occupy(spec);
                return input.run(live === undefined ? effect :
                  Effect.provideService(effect, OverseerLiveExecution, live), { signal: occupySignal })
                  .then(() => true, () => false);
              },
              managedDrive: lateBoundDrive(),
              commitAgentReseat: (payload, commitSignal) => {
                const effect = commitAgentReseat(
                  payload.caller,
                  { canvas: payload.canvasName, nodeId: payload.nodeId },
                  payload.parts,
                );
                return runCanvasHook(input.run, live === undefined ? effect :
                  Effect.provideService(effect, OverseerLiveExecution, live), commitSignal);
              },
              applySchedulerConfigure: (payload, commitSignal) => {
                const effect = applySchedulerConfigure(payload.caller, {
                  canvas: payload.canvasName,
                  nodeId: payload.nodeId,
                  change: payload.change,
                });
                return runCanvasHook(input.run, live === undefined ? effect :
                  Effect.provideService(effect, OverseerLiveExecution, live), commitSignal);
              },
            }).execute(nativeCaller, nativeRequest),
        }, sourceInstallationId).pipe((effect) => live === undefined ? effect :
          Effect.provideService(effect, OverseerLiveExecution, live)),
        live?.signal === undefined ? signal : AbortSignal.any([signal, live.signal]),
      ).catch((error): OverseerResult => {
        if (signal.aborted) {
          return {
            ok: false,
            operation: request.operation,
            error: { type: "RuntimeDown", message: "overseer command aborted" },
          };
        }
        return {
          ok: false,
          operation: request.operation,
          error: {
            type: "InternalError",
            message: asWorkError(error).message,
          },
        };
      }),
    );
  };

  const onOverseer = (
    request: OverseerRequest,
    caller: OverseerCaller,
    signal: AbortSignal,
    live?: OverseerLiveExecutionConstraint,
  ): Promise<OverseerResult> =>
    executeInAuthoringGate(request, caller, undefined, signal, live);

  return {
    runtime,
    native,
    onOverseer,
    bindPages: (next) => {
      pagesHolder.current = next;
    },
    dispose: () => {
      accepting = false;
      setOverseerNativeDeleteHooks(undefined);
    },
  };
};
