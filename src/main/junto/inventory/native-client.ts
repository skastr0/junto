/**
 * The asking end of the native-config channel. This machine's own settings
 * are answered by the same code a peer runs, without the link; another
 * machine's go over the link, naming a canvas this machine edits with a seat
 * there. The answer is decoded closed after the request returns, and must
 * answer what was asked. A write whose link closed before its answer is read
 * back once on a fresh link, so the operator learns whether it took; nothing
 * is queued.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { MachineInventoryFailure, NativeSettingFailure, NativeSettingsReadResult, NativeSettingWriteResult } from "@shared/ipc";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { HarnessId } from "@shared/managed-terminal-templates";
import { describeCause } from "../failure-encode";
import { HostsService } from "../hosts/service";
import { LinkClosed, MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { canvasWithSeatOn, tagOf } from "./admission";
import { makeNativeConfigAnswers, type NativeConfigAnswers } from "./native-channel";
import {
  MAX_NATIVE_KEYS,
  NATIVE_KEY,
  NativeConfigAnswerRefused,
  NativeConfigLinkFailure,
  NativeConfigResponse,
  NativeConfigWriteFailed,
  NativeSettingRefused,
  NativeWireValue,
} from "./native-wire";

const Key = Schema.String.pipe(Schema.check(Schema.isPattern(NATIVE_KEY)));
const ReadAsk = Schema.Struct({
  harness: HarnessId,
  keys: Schema.Array(Key).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(MAX_NATIVE_KEYS))),
});
const WriteAsk = Schema.Struct({ harness: HarnessId, key: Key, value: NativeWireValue });

/** The write's link closed before its answer, and reading it back could not confirm it took. */
export class NativeSettingUnconfirmed extends Schema.TaggedError<NativeSettingUnconfirmed>()("NativeSettingUnconfirmed", {
  machine: Schema.String,
  harness: HarnessId,
  key: Schema.String,
  operationId: Schema.String,
  message: Schema.String,
}) {}

const decodeResponse = Schema.decodeUnknownSync(NativeConfigResponse, { onExcessProperty: "error" });
const isLinkFailure = Schema.is(NativeConfigLinkFailure);

/** The answering machine's own typed refusal, when the link carried one. */
const unwrap = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "detail" in cause && isLinkFailure(cause.detail) ? cause.detail : cause;

/** A failure as the window reads it: the setting's own refusals keep their tags, the rest is unavailable. */
const asIpcFailure = (machine: string, operationId: string, raw: unknown): NativeSettingFailure => {
  const cause = unwrap(raw);
  // Not refused: the write may have taken. Its own tag, so the window can say so.
  if (cause instanceof NativeSettingUnconfirmed)
    return { _tag: "InventoryUnavailableError", machine: cause.machine, reason: "failed", message: cause.message, failure: cause._tag, operationId: cause.operationId };
  if (cause instanceof NativeSettingRefused)
    return { _tag: "NativeSettingRefusedError", harness: cause.harness, key: cause.key ?? "", reason: cause.reason, message: cause.message };
  if (cause instanceof NativeConfigWriteFailed)
    return { _tag: "NativeConfigWriteError", machine: cause.machine, harness: cause.harness, key: cause.key ?? "", reason: cause.reason, message: cause.message };
  const own = cause instanceof InventoryUnavailableError ? cause : undefined;
  const linkOwn = cause instanceof NativeConfigAnswerRefused || isLinkFailure(cause);
  const failure: MachineInventoryFailure = {
    _tag: "InventoryUnavailableError",
    machine,
    reason: own?.reason ?? (linkOwn ? "failed" : "unreachable"),
    message: (own?.message ?? (linkOwn
      ? describeCause(cause).message
      : `${machine} could not be asked for its harness settings: ${describeCause(cause).message}`)).slice(0, 1024),
    failure: tagOf(cause),
    operationId,
  };
  return failure;
};

export const makeNativeConfigClient = (answers: NativeConfigAnswers) => {
  const ownName = Effect.flatMap(MachineRepository, (machines) => machines.machineName);

  const ask = (machine: string, operationId: string, payload: Record<string, unknown>) => Effect.gen(function* () {
    const canvas = yield* canvasWithSeatOn(machine);
    if (canvas === undefined)
      return yield* new InventoryUnavailableError({
        machine,
        reason: "unreachable",
        message: `No canvas this machine edits has a seat on ${machine}, so it cannot ask ${machine} for its harness settings.`,
      });
    const host = yield* (yield* HostsService).get(machine);
    if (host === undefined)
      return yield* new InventoryUnavailableError({ machine, reason: "unreachable", message: `${machine} is not a registered machine.` });
    const link = yield* MachineLink;
    yield* link.connect(host);
    const answer = yield* link.request(machine, "native-config", { ...payload, canvas }, { operationId });
    return yield* Effect.try({
      try: () => decodeResponse(answer),
      catch: (cause) => new NativeConfigAnswerRefused({
        machine, operationId, message: `${machine} sent a settings answer this machine does not accept: ${describeCause(cause).message}`,
      }),
    });
  });

  /** The answer must be about the machine, harness and keys asked for. */
  const answered = (machine: string, operationId: string, ok: boolean) =>
    ok ? Effect.void : Effect.fail(new NativeConfigAnswerRefused({ machine, operationId, message: `${machine} answered another question than the one asked.` }));

  const readOver = (machine: string, operationId: string, harness: HarnessId, keys: readonly string[]) => Effect.gen(function* () {
    const response = yield* ask(machine, operationId, { _tag: "ReadSettings", harness, keys });
    yield* answered(machine, operationId, response._tag === "Settings" && response.machine === machine && response.harness === harness
      && response.values.every((row) => keys.includes(row.key)));
    return response._tag === "Settings" ? response.values : [];
  });

  const readSettings = (input: { readonly machine: string; readonly harness: string; readonly keys: readonly string[] }, operationId: string = randomUUID()) =>
    Effect.gen(function* () {
      const asked = yield* Schema.decodeUnknownEffect(ReadAsk)({ harness: input.harness, keys: input.keys }, { onExcessProperty: "error" });
      const own = yield* ownName;
      const values = own === input.machine
        ? (yield* answers.read(asked.harness, asked.keys, operationId)).values
        : yield* readOver(input.machine, operationId, asked.harness, asked.keys);
      const result: NativeSettingsReadResult = {
        ok: true,
        values: Object.fromEntries(values.flatMap((row) => "value" in row ? [[row.key, row.value]] : [])),
        unfit: values.flatMap((row) => "unfit" in row ? [row.key] : []),
      };
      return result;
    }).pipe(
      Effect.catch((cause: unknown) => Effect.succeed<NativeSettingsReadResult>({ ok: false, error: asIpcFailure(input.machine, operationId, cause) })),
      Effect.annotateLogs({ area: "native-config", peer: input.machine, operationId }),
    );

  const writeSetting = (input: { readonly machine: string; readonly harness: string; readonly key: string; readonly value: unknown }, operationId: string = randomUUID()) =>
    Effect.gen(function* () {
      const asked = yield* Schema.decodeUnknownEffect(WriteAsk)({ harness: input.harness, key: input.key, value: input.value }, { onExcessProperty: "error" });
      const own = yield* ownName;
      if (own === input.machine) return (yield* answers.write(asked.harness, asked.key, asked.value, operationId)).value;
      const over = ask(input.machine, operationId, { _tag: "WriteSetting", ...asked }).pipe(
        Effect.tap((response) => answered(input.machine, operationId, response._tag === "Written" && response.machine === input.machine
          && response.harness === asked.harness && response.key === asked.key)),
        Effect.map((response) => response._tag === "Written" ? response.value : asked.value),
      );
      return yield* over.pipe(
        // The link closed before the answer: the write may have taken. Read it back once.
        Effect.catchIf((cause): cause is LinkClosed => cause instanceof LinkClosed, () => Effect.gen(function* () {
          yield* Effect.logWarning("native setting write lost its link; reading it back", { harness: asked.harness, key: asked.key });
          const values = yield* readOver(input.machine, operationId, asked.harness, [asked.key]).pipe(Effect.orElseSucceed(() => []));
          const row = values.find((entry) => entry.key === asked.key);
          if (row !== undefined && "value" in row && row.value === asked.value) return row.value;
          // Not refused: the machine may have written it before the link closed.
          yield* Effect.logWarning("native setting write unconfirmed", { harness: asked.harness, key: asked.key });
          return yield* new NativeSettingUnconfirmed({
            machine: input.machine, harness: asked.harness, key: asked.key, operationId,
            message: `${asked.key} on ${input.machine} may not have taken: the link closed before the answer. Read it again.`,
          });
        })),
      );
    }).pipe(
      Effect.map((value): NativeSettingWriteResult => ({ ok: true, value })),
      Effect.catch((cause: unknown) => Effect.succeed<NativeSettingWriteResult>({ ok: false, error: asIpcFailure(input.machine, operationId, cause) })),
      Effect.annotateLogs({ area: "native-config", peer: input.machine, operationId }),
    );

  return { readSettings, writeSetting };
};

export type NativeConfigClient = ReturnType<typeof makeNativeConfigClient>;

/** This process's client: one path for this machine and every linked one. */
export const nativeConfigClient = Effect.map(makeNativeConfigAnswers(), makeNativeConfigClient);
