/**
 * The answering end of the link's settings channel. The peer names a canvas
 * and what to read or set; this machine admits it as it admits inventory (the
 * peer is pinned, edits that canvas, and the canvas has a seat here), then
 * answers from its own settings. A write sets a value and answers the value
 * read back; nothing waits on a person or a probe.
 *
 * Every request is a read or a set, so every handler is idempotent: a repeat
 * lands the same values, and a handler interrupted mid-request leaves either
 * the values it found or the values it set, never a mix.
 */
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { isThisMachine } from "@shared/machine-name";
import { machineCacheWindowsOf, machineProvidersOf, machineRecordOf } from "@shared/machine-settings";
import type { OffboardRulesPatch } from "@shared/seat-offboard";
import type { LinkChannelContext } from "../link/types";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "../link/contract";
import { LogService } from "../../node/observability/logger";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { SettingsService } from "./service";
import {
  CacheWindowsRead,
  CacheWindowsWrite,
  LinkCacheWindows,
  LinkProviders,
  LinkRecord,
  ProvidersRead,
  ProvidersWrite,
  RecordRead,
  SettingsCanvasEditorMismatch,
  SettingsLinkFailure,
  SettingsNoSeatHere,
  SettingsNotAnswered,
  SettingsPeerNotPinned,
  StartupWrite,
  type SettingsLinkFailure as SettingsLinkFailureType,
  wireCacheWindows,
  wireProviders,
  wireRecord,
} from "./link-wire";

/**
 * The settings channel's contract: six requests, each naming the canvas and,
 * for a write, exactly the values it sets. It carries no events.
 */
export const SettingsLink = linkContract("settings", RpcGroup.make(
  Rpc.make("ProvidersRead", { payload: ProvidersRead, success: LinkProviders, error: SettingsLinkFailure }),
  Rpc.make("ProvidersWrite", { payload: ProvidersWrite, success: LinkProviders, error: SettingsLinkFailure }),
  Rpc.make("RecordRead", { payload: RecordRead, success: LinkRecord, error: SettingsLinkFailure }),
  Rpc.make("StartupWrite", { payload: StartupWrite, success: LinkRecord, error: SettingsLinkFailure }),
  Rpc.make("CacheWindowsRead", { payload: CacheWindowsRead, success: LinkCacheWindows, error: SettingsLinkFailure }),
  Rpc.make("CacheWindowsWrite", { payload: CacheWindowsWrite, success: LinkCacheWindows, error: SettingsLinkFailure }),
));

const isLinkFailure = Schema.is(SettingsLinkFailure);

/** Keep a channel failure as it is; anything else crosses with its tag only. */
const asLinkFailure = (machine: string, operationId: string | undefined, cause: unknown): SettingsLinkFailureType => {
  if (isLinkFailure(cause)) return cause;
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown";
  return new SettingsNotAnswered({
    machine,
    ...(operationId === undefined ? {} : { operationId }),
    message: `This machine could not answer (${tag.slice(0, 64)}).`,
  });
};

export const makeSettingsChannel = Effect.fn("SettingsLink.make")(function* () {
  const log = yield* LogService;
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const settings = yield* SettingsService;

  /** Identity comes from the admitted hello, never from the payload. */
  const admit = (canvasName: string, context: LinkChannelContext) => Effect.gen(function* () {
    const machine = yield* machines.machineName;
    const where = {
      machine,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    };
    const peer = yield* machines.peer(context.peer.machineName);
    if (peer?.installationId !== context.peer.installationId)
      return yield* new SettingsPeerNotPinned({ ...where, message: "The asking machine is no longer pinned." });
    if ((yield* records.canvasEditor(canvasName)) !== context.peer.installationId)
      return yield* new SettingsCanvasEditorMismatch({
        ...where,
        message: "Only the machine editing this canvas may ask for its seats' machine settings.",
      });
    const canvas = yield* model.canvas(canvasName);
    const seatHere = [...canvas.nodes.values()].some((node) => node.kind === "agent" && isThisMachine(node.host, machine));
    if (!seatHere) return yield* new SettingsNoSeatHere({ ...where, message: "This canvas has no seat on this machine." });
    return machine;
  });

  const served = <A, E, R>(tag: string, context: LinkChannelContext, work: Effect.Effect<A, E, R>) => work.pipe(
    Effect.tapCause((cause) => Effect.logError("settings failed", cause)),
    Effect.catch((cause) => machines.machineName.pipe(
      // The name the machine log already carries, when this machine's own cannot be read.
      Effect.orElseSucceed(() => log.machine()),
      Effect.flatMap((machine) => Effect.fail(asLinkFailure(machine, context.operationId, cause))),
    )),
    Effect.tap(() => Effect.logInfo("settings answered")),
    Effect.annotateLogs({
      area: "settings",
      request: tag,
      peer: context.peer.machineName,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    }),
  );

  const channel: LinkContractChannel = bindLinkChannel(SettingsLink, {
    requests: {
      ProvidersRead: (request, context) => served("ProvidersRead", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        return wireProviders(machineProvidersOf(yield* settings.get, machine));
      })),
      /** Sets the enabled sources; a repeat lands the same list. */
      ProvidersWrite: (request, context) => served("ProvidersWrite", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        yield* settings.patch({ providers: { enabledSources: [...request.enabledSources] } });
        return wireProviders(machineProvidersOf(yield* settings.get, machine));
      })),
      RecordRead: (request, context) => served("RecordRead", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        return wireRecord({ ...machineRecordOf(yield* settings.get), machine });
      })),
      /** Sets the startup preference; a repeat lands the same value. */
      StartupWrite: (request, context) => served("StartupWrite", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        yield* settings.setMachinePreferences({ supervisedPreferred: request.supervisedPreferred });
        return wireRecord({ ...machineRecordOf(yield* settings.get), machine });
      })),
      CacheWindowsRead: (request, context) => served("CacheWindowsRead", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        return wireCacheWindows(machineCacheWindowsOf(yield* settings.get, machine));
      })),
      /** Sets the named windows; a repeat lands the same values. */
      CacheWindowsWrite: (request, context) => served("CacheWindowsWrite", context, Effect.gen(function* () {
        const machine = yield* admit(request.canvas, context);
        const harness = Object.entries(request.harness ?? {}).filter(([, minutes]) => minutes !== undefined);
        const offboard: OffboardRulesPatch = {
          ...(request.cacheWindowMinutes === undefined ? {} : { cacheWindowMinutes: request.cacheWindowMinutes }),
          ...(harness.length === 0 ? {} : {
            harness: Object.fromEntries(harness.map(([id, minutes]) =>
              [id, minutes === null ? null : { cacheWindowMinutes: minutes as number }])),
          }),
          ...(request.cacheMode === undefined ? {} : { cacheMode: request.cacheMode }),
        };
        yield* settings.patch({ offboard });
        return wireCacheWindows(machineCacheWindowsOf(yield* settings.get, machine));
      })),
    },
  });
  return channel;
});
