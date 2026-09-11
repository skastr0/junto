/**
 * Production overseer composition for Command Center and Remote.
 *
 * Wires executeOverseer through the process-bind work socket and, when the
 * Station transport module is present, the CC-opened Remote session. Does not
 * own admission or dispatch routing.
 */
import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import type { InstallationId } from "@shared/installation-id";
import type {
  OverseerCaller,
  OverseerRequest,
  OverseerResult,
} from "@shared/overseer-control";
import type { WorkErrorBody } from "@shared/work-control";
import { CanvasesService } from "../canvases";
import { ChatServiceContext } from "../chat/service";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import { termPlane } from "../term/plane";
import { StationRepository } from "../station/repository";
import type { BrowserSessionService } from "../browser/sessions";
import { executeOverseer, type OverseerRuntime } from "./dispatch";
import {
  makeOverseerNativeLive,
  type ApplicationCaptureResult,
  type OverseerNative,
} from "./native";
import { managedTerminalDriveForOverseer } from "../term/managed-drive-holder";
import { mainAuthoringGate, mainAuthoringLabelForWorkOperation } from "../main-authoring-gate";

export type OverseerRunPromise = <A, E>(
  effect: Effect.Effect<A, E>,
) => Promise<A>;

export type OverseerComposition = {
  readonly runtime: OverseerRuntime;
  readonly native: OverseerNative;
  readonly onOverseer: (
    request: OverseerRequest,
    caller: OverseerCaller,
    signal: AbortSignal,
  ) => Promise<OverseerResult>;
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

const liveOverseerGrant = (
  run: OverseerRunPromise,
  caller: OverseerCaller,
): Promise<boolean> =>
  run(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const read = yield* canvases.readNodeStructure(
        caller.canvasName,
        caller.nodeId,
        "overseer.live-grant",
      );
      const ether = read?.node.ether as { readonly overseer?: unknown } | undefined;
      return ether?.overseer === true;
    }).pipe(Effect.catch(() => Effect.succeed(false))),
  );

const listCanvasDocuments = (
  run: OverseerRunPromise,
): Promise<ReadonlyArray<{ readonly name: string; readonly doc: CanvasDoc }>> =>
  run(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const live = yield* canvases.liveDocuments();
      return live.map((entry) => ({ name: entry.canvasName, doc: entry.doc }));
    }).pipe(Effect.catch(() => Effect.succeed([]))),
  );

const tryLoadStationTransport = async (): Promise<
  | {
      readonly registerStationRemoteOverseerHandler: (
        handler: (
          request: OverseerRequest,
          source: {
            readonly installationId: InstallationId;
            readonly caller: OverseerCaller;
          },
        ) => Effect.Effect<OverseerResult, unknown>,
      ) => () => void;
    }
  | undefined
> => {
  try {
    return (await import("../station/overseer-transport.ts")) as never;
  } catch {
    return undefined;
  }
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

const runWithAbort = (
  run: OverseerRunPromise,
  request: OverseerRequest,
  program: Effect.Effect<OverseerResult>,
  signal: AbortSignal,
): Promise<OverseerResult> => {
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      operation: request.operation,
      error: { type: "RuntimeDown", message: "overseer command aborted" },
    });
  }
  return new Promise((resolve) => {
    const abort = () =>
      resolve({
        ok: false,
        operation: request.operation,
        error: { type: "RuntimeDown", message: "overseer command aborted" },
      });
    signal.addEventListener("abort", abort, { once: true });
    void run(program).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        resolve({
          ok: false,
          operation: request.operation,
          error: { type: "InternalError", message: asWorkError(error).message },
        });
      },
    );
  });
};

export const composeOverseer = async (input: {
  readonly run: OverseerRunPromise;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  readonly pages?: BrowserSessionService;
  readonly registerRemoteHandler?: boolean;
  readonly remoteForward?: OverseerRuntime["forward"];
}): Promise<OverseerComposition> => {
  const chats = await input.run(ChatServiceContext);
  const actorSeatOccupy = await input.run(ActorSeatOccupy);
  const managedDrive = managedTerminalDriveForOverseer();
  const station = await tryLoadStationTransport();
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
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          hostId: "local",
          installationId: "local" as never,
          role: "unconfigured",
        }),
      ),
    ),
  );

  const native: OverseerNative = makeOverseerNativeLive({
    termPlane,
    chats,
    ...(input.pages !== undefined ? { pages: input.pages } : {}),
    captureApplicationPage: input.captureApplicationPage,
    liveOverseerGrant: (caller) => liveOverseerGrant(input.run, caller),
    listCanvasDocuments: () => listCanvasDocuments(input.run),
    actorSeatOccupy,
    ...(managedDrive !== undefined ? { managedDrive } : {}),
    stationScope: () => scope,
  });
  try {
    const canvas = await import("./canvas.ts");
    canvas.setOverseerNativeDeleteHooks?.({
      prepareOverseerNodeDelete: native.prepareOverseerNodeDelete,
      finishOverseerNodeDelete: native.finishOverseerNodeDelete,
    });
  } catch {
    // Canvas dispatcher not present in this checkout; parent integrates it.
  }

  const nativeExecute: OverseerRuntime["native"] = (caller, request) =>
    native.execute(caller, request);

  const forward: OverseerRuntime["forward"] =
    input.remoteForward ??
    ((_caller, _request) =>
      Effect.fail(
        unavailable(
          "Remote overseer forwarding requires an active Command Center Station session",
        ),
      ));

  const runtime: OverseerRuntime = { native: nativeExecute, forward };
  let accepting = true;
  const overseerAuthoringLabel = mainAuthoringLabelForWorkOperation("overseer");

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
    const run = () =>
      runWithAbort(
        input.run,
        request,
        executeOverseer(caller, request, runtime, sourceInstallationId),
        signal,
      );
    if (overseerAuthoringLabel === undefined) return run();
    return mainAuthoringGate.run(overseerAuthoringLabel, run).catch((error) => ({
      ok: false as const,
      operation: request.operation,
      error: {
        type: "RuntimeDown" as const,
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  };

  const onOverseer = (
    request: OverseerRequest,
    caller: OverseerCaller,
    signal: AbortSignal,
  ): Promise<OverseerResult> =>
    executeInAuthoringGate(request, caller, undefined, signal);

  let disposeRemote = (): void => undefined;
  if (input.registerRemoteHandler && station?.registerStationRemoteOverseerHandler) {
    disposeRemote = station.registerStationRemoteOverseerHandler((request, source) =>
      Effect.tryPromise({
        try: (signal) =>
          executeInAuthoringGate(request, source.caller, source.installationId, signal),
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
    dispose: () => {
      accepting = false;
      disposeRemote();
    },
  };
};
