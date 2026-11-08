/**
 * The answering end of the link's native-config channel, and the same answers
 * for this machine's own window: one path for every machine. A read answers
 * the declared keys' current values; a write is checked against this
 * machine's own catalogue and installed version, written through
 * NativeConfig, and answers the value read back. Neither waits on a person or
 * a probe: the installed version comes from the inventory cache.
 *
 * Both requests are idempotent: a read changes nothing, and a write sets a
 * value, so a repeat lands the same file, and a handler interrupted mid-write
 * leaves either the file it found or the file it set. The write itself lands
 * by rename, so a half-run leaves no partial value.
 */
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { NATIVE_SETTINGS } from "@shared/harness-domain/native-catalogue";
import { nativeValueFits, NativeSettingRefusedError } from "@shared/harness-domain/native-config";
import { NativeConfigWriteError } from "@shared/harness-domain/native-config-write";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { LinkChannelContext } from "../link/types";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "../link/contract";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { NativeConfig } from "../native-config/service";
import { LogService } from "../../node/observability/logger";
import { admitCanvasEditor, tagOf } from "./admission";
import {
  isNativeWireValue,
  NATIVE_REFUSAL_TEXT,
  NATIVE_WRITE_TEXT,
  NativeConfigLinkFailure,
  NativeConfigSettings,
  NativeConfigWritten,
  NativeConfigWriteFailed,
  NativeSettingRefused,
  type NativeSettingRead,
  type NativeWireValue,
  ReadSettings,
  WriteSetting,
} from "./native-wire";

/**
 * The native-config channel's contract: two requests, each naming the canvas
 * and one declared key or its value. It carries no events.
 */
export const NativeConfigLink = linkContract("native-config", RpcGroup.make(
  Rpc.make("ReadSettings", { payload: ReadSettings, success: NativeConfigSettings, error: NativeConfigLinkFailure }),
  Rpc.make("WriteSetting", { payload: WriteSetting, success: NativeConfigWritten, error: NativeConfigLinkFailure }),
));

const isLinkFailure = Schema.is(NativeConfigLinkFailure);

/** Every failure rebuilt from its reason and key: no path, file name, file text or value crosses. */
const asFailure = (machine: string, harness: HarnessId, key: string | undefined, operationId: string | undefined) =>
  (cause: unknown): NativeConfigLinkFailure => {
    const where = {
      machine,
      harness,
      ...(key === undefined ? {} : { key }),
      ...(operationId === undefined ? {} : { operationId }),
    };
    const named = key ?? "That setting";
    if (cause instanceof NativeSettingRefusedError)
      return new NativeSettingRefused({ ...where, reason: cause.reason, message: `${named} ${NATIVE_REFUSAL_TEXT[cause.reason]}.` });
    if (cause instanceof NativeConfigWriteError)
      return new NativeConfigWriteFailed({ ...where, reason: cause.reason, message: `${named} ${NATIVE_WRITE_TEXT[cause.reason]}.` });
    if (cause instanceof InventoryUnavailableError)
      return new InventoryUnavailableError({ machine, reason: cause.reason, message: `This machine could not read its ${harness} install (${cause.reason}).` });
    if (isLinkFailure(cause)) return cause;
    return new InventoryUnavailableError({ machine, reason: "failed", message: `This machine could not answer (${tagOf(cause)}).` });
  };

export const makeNativeConfigAnswers = Effect.fn("NativeConfigLink.answers")(function* () {
  const log = yield* LogService;
  const config = yield* NativeConfig;
  const machines = yield* MachineRepository;
  const catalogue = NATIVE_SETTINGS;
  const machineName = machines.machineName.pipe(Effect.orElseSucceed(() => log.machine()));

  const read = (harness: HarnessId, keys: readonly string[], operationId?: string) => Effect.gen(function* () {
    const machine = yield* machineName;
    const specs = keys.map((key) => catalogue.find((spec) => spec.harness === harness && spec.key === key));
    const undeclared = keys.find((_key, index) => specs[index] === undefined);
    if (undeclared !== undefined)
      return yield* new NativeSettingRefused({
        machine, harness, key: undeclared, reason: "undeclared",
        message: `${undeclared} ${NATIVE_REFUSAL_TEXT.undeclared}.`,
        ...(operationId === undefined ? {} : { operationId }),
      });
    const values = yield* config.read(harness, keys).pipe(Effect.mapError(asFailure(machine, harness, undefined, operationId)));
    const read: NativeSettingRead[] = [];
    for (const [index, key] of keys.entries()) {
      const value = values[key];
      if (value === undefined) continue;
      // A hand edit outside the declared setting crosses as unfit, never as its text.
      read.push(isNativeWireValue(value) && nativeValueFits(specs[index]!.value, value) ? { key, value } : { key, unfit: true });
    }
    return { _tag: "Settings", machine, harness, values: read } satisfies NativeConfigSettings;
  }).pipe(
    Effect.tap(() => Effect.logInfo("native settings read", { harness, keys })),
    Effect.tapError((failure) => Effect.logWarning("native settings read failed", { harness, keys, failure: failure._tag })),
  );

  const write = (harness: HarnessId, key: string, value: NativeWireValue, operationId?: string) => Effect.gen(function* () {
    const machine = yield* machineName;
    const fail = asFailure(machine, harness, key, operationId);
    const after = yield* config.write({ machine, harness, key, value }).pipe(Effect.mapError(fail));
    if (!isNativeWireValue(after))
      return yield* fail(new NativeConfigWriteError({ machine, harness, key, reason: "io", message: "read back outside its setting" }));
    return { _tag: "Written", machine, harness, key, value: after } satisfies NativeConfigWritten;
  }).pipe(
    // Never the value: a log names the harness, the key and the outcome.
    Effect.tap(() => Effect.logInfo("native setting written", { harness, key })),
    Effect.tapError((failure) => Effect.logWarning("native setting write failed", {
      harness, key, failure: failure._tag, ...("reason" in failure ? { reason: failure.reason } : {}),
    })),
  );

  return { read, write };
});

export type NativeConfigAnswers = Effect.Success<ReturnType<typeof makeNativeConfigAnswers>>;

export const makeNativeConfigChannel = Effect.fn("NativeConfigLink.make")(function* () {
  const log = yield* LogService;
  const services = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();
  const machines = yield* MachineRepository;
  const answers = yield* makeNativeConfigAnswers();

  /** Every failure crosses under the channel's closed schema; the link stays open. */
  const refused = <A, E, R>(context: LinkChannelContext, work: Effect.Effect<A, E, R>) => work.pipe(
    Effect.catch((cause) => machines.machineName.pipe(
      Effect.orElseSucceed(() => log.machine()),
      Effect.flatMap((machine) => Effect.fail(isLinkFailure(cause)
        ? cause
        : new InventoryUnavailableError({ machine, reason: "failed", message: `This machine could not answer (${tagOf(cause)}).` }))),
    )),
    Effect.tapError((failure) => Effect.logWarning("native-config refused", { failure: failure._tag })),
    Effect.annotateLogs({
      area: "native-config",
      peer: context.peer.machineName,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    }),
  );

  const channel: LinkContractChannel = bindLinkChannel(NativeConfigLink, {
    requests: {
      ReadSettings: (request, context) => refused(context, Effect.gen(function* () {
        const machine = yield* machines.machineName.pipe(Effect.orElseSucceed(() => log.machine()));
        yield* admitCanvasEditor(context, request.canvas, machine).pipe(
          Effect.provideContext(services),
          Effect.mapError(asFailure(machine, request.harness, undefined, context.operationId)),
        );
        return yield* answers.read(request.harness, request.keys, context.operationId);
      })),
      WriteSetting: (request, context) => refused(context, Effect.gen(function* () {
        const machine = yield* machines.machineName.pipe(Effect.orElseSucceed(() => log.machine()));
        yield* admitCanvasEditor(context, request.canvas, machine).pipe(
          Effect.provideContext(services),
          Effect.mapError(asFailure(machine, request.harness, request.key, context.operationId)),
        );
        return yield* answers.write(request.harness, request.key, request.value, context.operationId);
      })),
    },
  });
  return channel;
});
