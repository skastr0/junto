/**
 * The answering end of the link's settings channel. The peer names a canvas
 * and what to read or set; this machine admits it as it admits inventory (the
 * peer is pinned, edits that canvas, and the canvas has a seat here), then
 * answers from its own settings. A write sets a value and answers the value
 * read back; nothing waits on a person or a probe.
 */
import { Effect, Schema } from "effect";
import { isThisMachine } from "@shared/machine-name";
import { machineProvidersOf, machineRecordOf } from "@shared/machine-settings";
import type { LinkChannelHandler } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { SettingsService } from "./service";
import {
  decodeLinkSettingsRequest,
  SettingsCanvasEditorMismatch,
  SettingsLinkFailure,
  SettingsNoSeatHere,
  SettingsNotAnswered,
  SettingsPeerNotPinned,
  type LinkSettingsRequest,
  type SettingsLinkFailure as SettingsLinkFailureType,
  wireProviders,
  wireRecord,
} from "./link-wire";

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

const noEvents = (): never => {
  throw new Error("the settings channel carries no events");
};

export const makeSettingsChannel = Effect.fn("SettingsLink.make")(function* () {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const settings = yield* SettingsService;

  const answer = (request: LinkSettingsRequest, machine: string) => Effect.gen(function* () {
    switch (request._tag) {
      case "ProvidersRead":
        return wireProviders(machineProvidersOf(yield* settings.get, machine));
      case "ProvidersWrite": {
        const providers = {
          ...(request.enabledSources === undefined ? {} : { enabledSources: [...request.enabledSources] }),
          ...(request.hermesHostSnapshots === undefined ? {} : { hermesHostSnapshots: request.hermesHostSnapshots }),
        };
        yield* settings.patch({ providers });
        return wireProviders(machineProvidersOf(yield* settings.get, machine));
      }
      case "RecordRead":
        return wireRecord({ ...machineRecordOf(yield* settings.get), machine });
      case "StartupWrite":
        yield* settings.setMachinePreferences({ supervisedPreferred: request.supervisedPreferred });
        return wireRecord({ ...machineRecordOf(yield* settings.get), machine });
    }
  });

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode here too: direct callers cannot bypass the transport decoder.
    const request = yield* Effect.try(() => decodeLinkSettingsRequest(raw));
    const machine = yield* machines.machineName;
    const where = {
      machine,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    };
    // Identity comes from the admitted hello, never from the payload.
    const peer = yield* machines.peer(context.peer.machineName);
    if (peer?.installationId !== context.peer.installationId)
      return yield* new SettingsPeerNotPinned({ ...where, message: "The asking machine is no longer pinned." });
    if ((yield* records.canvasEditor(request.canvas)) !== context.peer.installationId)
      return yield* new SettingsCanvasEditorMismatch({
        ...where,
        message: "Only the machine editing this canvas may ask for its seats' machine settings.",
      });
    const canvas = yield* model.canvas(request.canvas);
    const seatHere = [...canvas.nodes.values()].some((node) => node.kind === "agent" && isThisMachine(node.host, machine));
    if (!seatHere) return yield* new SettingsNoSeatHere({ ...where, message: "This canvas has no seat on this machine." });
    const answered = yield* answer(request, machine);
    yield* Effect.logInfo("settings answered", { request: request._tag });
    return answered;
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("settings failed", cause)),
    Effect.catch((cause) => machines.machineName.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((machine) => Effect.fail(asLinkFailure(machine, context.operationId, cause))),
    )),
    Effect.annotateLogs({
      area: "settings",
      peer: context.peer.machineName,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    }),
  );

  const handler: LinkChannelHandler = {
    failureSchema: SettingsLinkFailure as Schema.Codec<unknown, unknown>,
    decodeRequest: decodeLinkSettingsRequest,
    // A response that throws here would close the whole link as frame-invalid,
    // so the requester decodes the answer itself, with the link open.
    decodeResponse: (payload) => payload,
    decodeEvent: noEvents,
    handleRequest,
  };
  return handler;
});
