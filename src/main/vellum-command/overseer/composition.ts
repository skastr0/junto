/**
 * Production overseer composition for Command Center and Remote.
 *
 * Wires executeOverseer through the process-bind work socket and the
 * CC-opened Remote Station session. Does not own admission or dispatch routing.
 */
import { Effect, Result } from "effect";
import type { CanvasDoc, TextNode } from "@shared/canvas";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { isHarnessId } from "@shared/managed-terminal-templates";
import type {
  OverseerArgsFor,
  OverseerCaller,
  OverseerRequest,
  OverseerResult,
} from "@shared/overseer-control";
import type { InstallationId } from "@shared/station-api";
import type { WorkErrorBody } from "@shared/work-control";
import { CanvasesService } from "../canvases";
import { ChatServiceContext } from "../chat/service";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import { termPlane } from "../term/plane";
import { StationRepository } from "../station/repository";
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
import {
  makeRemoteStationOverseerDispatcher,
  registerStationRemoteOverseerHandler,
} from "../station/overseer-transport";
import type { StationControlServer } from "../station/control-server";
import type { ManagedTerminalDrive } from "../term/drive";
import type { ContentService } from "../content/service";
import type { WorkService } from "../work/service";

type OverseerServices =
  | CanvasesService
  | ChatServiceContext
  | ActorSeatOccupy
  | StationRepository
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
  ) => Promise<OverseerResult>;
  readonly bindPages: (pages: BrowserSessionService | undefined) => void;
  readonly bindStationForward: (input: {
    readonly control: Pick<StationControlServer, "overseer" | "sessionReady">;
    readonly remoteInstallationId: InstallationId;
    readonly commandCenterInstallationId: InstallationId;
  }) => void;
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

const listCanvasDocuments = (
  run: OverseerRunPromise,
): Promise<ReadonlyArray<{ readonly name: string; readonly doc: CanvasDoc }>> =>
  run(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const live = yield* canvases.liveDocuments();
      return live.map((entry) => ({ name: entry.canvasName, doc: entry.doc }));
    }),
  );

export const runCanvasHook = async <A>(
  run: <T, E>(effect: Effect.Effect<T, E, CanvasesService>, options?: { readonly signal?: AbortSignal }) => Promise<T>,
  effect: Effect.Effect<A, WorkErrorBody, CanvasesService>,
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

const harnessFromNode = (node: TextNode): HarnessId | undefined => {
  const harness = node.ether?.terminal?.harness;
  return typeof harness === "string" && isHarnessId(harness) ? harness : undefined;
};

/** Origin caller plus target canvas/node — never treat the target as the caller. */
export const reseatCanvasArgs = (
  input: AgentReseatCommitInput,
): {
  readonly caller: OverseerCaller;
  readonly args: OverseerArgsFor<"agent.reseat">;
  readonly next: TextNode;
} | { readonly ok: false; readonly message: string } => {
  const harness = harnessFromNode(input.next);
  if (harness === undefined) {
    return { ok: false, message: "reseat commit requires a harness on the next agent node" };
  }
  return {
    caller: input.caller,
    args: {
      canvas: input.canvasName,
      nodeId: input.nodeId,
      harness,
    },
    next: input.next,
  };
};

export const schedulerCanvasArgs = (
  input: SchedulerConfigureApplyInput,
): {
  readonly caller: OverseerCaller;
  readonly args: OverseerArgsFor<"scheduler.configure">;
} => ({
  caller: input.caller,
  args: {
    canvas: input.canvasName,
    nodeId: input.nodeId,
    ...(input.timer !== undefined
      ? { timer: input.timer as OverseerArgsFor<"scheduler.configure">["timer"] }
      : {}),
    ...(input.watch !== undefined
      ? { watch: input.watch as OverseerArgsFor<"scheduler.configure">["watch"] }
      : {}),
  },
});

export const lateBoundDrive = (): Pick<ManagedTerminalDrive, "writePrompt" | "interrupt"> => ({
  writePrompt: (bindingId, text, options) => {
    const drive = managedTerminalDriveForOverseer();
    if (drive === undefined) return Promise.resolve(false);
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
  run: <A, E>(effect: Effect.Effect<A, E, CanvasesService | StationRepository>) => Promise<A>,
  sourceInstallationId: InstallationId | undefined,
): ((caller: OverseerCaller) => Promise<boolean>) =>
  (caller) =>
    run(admitOverseer(caller, sourceInstallationId))
      .then(() => true)
      .catch(() => false);

export const runOverseerProgram = <A, E>(
  run: OverseerRunPromise,
  program: Effect.Effect<A, E, OverseerServices>,
  signal: AbortSignal,
): Promise<A> => run(program, { signal });

export const composeOverseer = async (input: {
  readonly run: OverseerRunPromise;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  readonly pages?: BrowserSessionService;
  readonly registerRemoteHandler?: boolean;
  readonly sourceInstallationId?: InstallationId;
}): Promise<OverseerComposition> => {
  const chats = await input.run(Effect.gen(function* () {
    return yield* ChatServiceContext;
  }));
  const actorSeatOccupy = await input.run(Effect.gen(function* () {
    return yield* ActorSeatOccupy;
  }));
  const scope = await input.run(
    Effect.gen(function* () {
      const stations = yield* StationRepository;
      const installationId = yield* stations.installationId;
      const configuration = yield* stations.configuration;
      return {
        hostId: configuration?.configuration.hostId ?? "local",
        installationId,
        role: configuration?.configuration.role ?? "unconfigured",
      };
    }),
  );

  const pagesHolder: { current: BrowserSessionService | undefined } = {
    current: input.pages,
  };
  let stationForward: OverseerRuntime["forward"] | undefined;
  const liveGrant = createDispatchGrant(input.run, input.sourceInstallationId);

  const commitReseatHook = async (
    payload: AgentReseatCommitInput,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const mapped = reseatCanvasArgs(payload);
    if ("ok" in mapped) return mapped;
    return runCanvasHook(
      input.run,
      commitAgentReseat(mapped.caller, mapped.args, mapped.next),
      signal,
    );
  };

  const applySchedulerHook = async (
    payload: SchedulerConfigureApplyInput,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const mapped = schedulerCanvasArgs(payload);
    return runCanvasHook(
      input.run,
      applySchedulerConfigure(mapped.caller, mapped.args),
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
    listCanvasDocuments: () => listCanvasDocuments(input.run),
    occupySeat: (spec, signal) =>
      input
        .run(actorSeatOccupy.occupy(spec), { signal })
        .then(() => true, () => false),
    managedDrive: lateBoundDrive(),
    commitAgentReseat: commitReseatHook,
    applySchedulerConfigure: applySchedulerHook,
    stationScope: () => scope,
  });

  setOverseerNativeDeleteHooks({
    prepareOverseerNodeDelete: native.prepareOverseerNodeDelete,
    finishOverseerNodeDelete: native.finishOverseerNodeDelete,
  });

  const bindStationForward = (forwardInput: {
    readonly control: Pick<StationControlServer, "overseer" | "sessionReady">;
    readonly remoteInstallationId: InstallationId;
    readonly commandCenterInstallationId: InstallationId;
  }): void => {
    const dispatcher = makeRemoteStationOverseerDispatcher(forwardInput);
    stationForward = (caller, request) =>
      Effect.tryPromise({
        try: () => dispatcher.dispatch(request, caller),
        catch: (error): WorkErrorBody => {
          const body = asWorkError(error);
          if (body.message.includes("uncertain")) {
            return {
              type: "InternalError",
              message: body.message,
              details: { retryable: false },
            };
          }
          return unavailable(body.message);
        },
      });
  };

  const runtime: OverseerRuntime = {
    native: (caller, request) => native.execute(caller, request),
    forward: (caller, request) =>
      stationForward !== undefined
        ? stationForward(caller, request)
        : Effect.fail(
            unavailable(
              "Remote overseer forwarding requires an active Command Center Station session",
            ),
          ),
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
    const dispatchGrant = createDispatchGrant(input.run, sourceInstallationId);
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
              listCanvasDocuments: () => listCanvasDocuments(input.run),
              occupySeat: (spec, occupySignal) =>
                input
                  .run(actorSeatOccupy.occupy(spec), { signal: occupySignal })
                  .then(() => true, () => false),
              managedDrive: lateBoundDrive(),
              commitAgentReseat: commitReseatHook,
              applySchedulerConfigure: applySchedulerHook,
              stationScope: () => scope,
            }).execute(nativeCaller, nativeRequest),
          forward: runtime.forward,
        }, sourceInstallationId),
        signal,
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
  ): Promise<OverseerResult> =>
    executeInAuthoringGate(request, caller, undefined, signal);

  let disposeRemote = (): void => undefined;
  if (input.registerRemoteHandler) {
    disposeRemote = registerStationRemoteOverseerHandler((request, source) =>
      Effect.tryPromise({
        try: (signal) =>
          executeInAuthoringGate(
            request,
            source.caller,
            source.installationId,
            signal,
          ),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            operation: request.operation,
            error: {
              type: "InternalError" as const,
              message: asWorkError(error).message,
            },
          } satisfies OverseerResult),
        ),
      ),
    );
  }

  return {
    runtime,
    native,
    onOverseer,
    bindPages: (next) => {
      pagesHolder.current = next;
    },
    bindStationForward,
    dispose: () => {
      accepting = false;
      setOverseerNativeDeleteHooks(undefined);
      disposeRemote();
    },
  };
};
