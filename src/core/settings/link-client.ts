/**
 * The asking end of the link's settings channel. The machine that edits a
 * canvas asks a seat's machine for its providers or record, or sets one,
 * naming the canvas only; the typed client encodes the request with its
 * contract and decodes the answer with it, so a bad answer is one typed
 * refusal with the link still open. Nothing is queued: a machine that cannot
 * be asked answers at once with the typed reason.
 *
 * The client holds no per-call state. `peerSettingsLayer` builds one per
 * runtime; `peerSettings()` builds one per call, for the caller that has not
 * moved to the service yet.
 */
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import type { MachineSettingsResult } from "@shared/ipc";
import { isThisMachine } from "@shared/machine-name";
import type { CanvasName } from "@shared/model";
import type { MachineCacheWindows, MachineProviders, MachineRecord } from "@shared/machine-settings";
import type { OffboardRulesPatch } from "@shared/seat-offboard";
import type { NativeUsageProvider } from "@shared/usage";
import { describeCause } from "../../node/failure-encode";
import { HostsService } from "../hosts/service";
import { linkClient } from "../link/contract";
import { MachineLink, type MachineLinkError } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import {
  cacheWindowsOfWire,
  providersOfWire,
  recordOfWire,
  SettingsAnswerRefused,
  SettingsLinkFailure,
  SettingsNotFromItsMachine,
} from "./link-wire";
import { SettingsLink } from "./link-channel";

/** A decode failure as its issue kind and path; any other text through the doctrine scrub. */
const reasonOf = (cause: unknown): string => describeCause(cause).message.slice(0, 500);

const tagOf = (cause: unknown): string =>
  (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown").slice(0, 64);

const isLinkFailure = Schema.is(SettingsLinkFailure);

/** Refusals and bad answers read failed; the link's own errors read unreachable. */
const reasonFor = (cause: unknown): "unreachable" | "failed" =>
  cause instanceof SettingsAnswerRefused || cause instanceof SettingsNotFromItsMachine || isLinkFailure(cause)
    ? "failed" : "unreachable";

class NoPathToMachine extends Schema.TaggedError<NoPathToMachine>()("NoPathToMachine", { message: Schema.String }) {}

export type ProvidersChange = {
  readonly enabledSources: ReadonlyArray<NativeUsageProvider>;
};

/** What the settings client asks of, and what it answers, for every machine. */
export type PeerSettingsCalls<R> = {
  readonly providers: (machine: string, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineProviders>, never, R>;
  readonly setProviders: (machine: string, change: ProvidersChange, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineProviders>, never, R>;
  readonly record: (machine: string, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineRecord>, never, R>;
  readonly setStartup: (machine: string, supervisedPreferred: boolean, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineRecord>, never, R>;
  readonly cacheWindows: (machine: string, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineCacheWindows>, never, R>;
  readonly setCacheWindows: (machine: string, change: OffboardRulesPatch, operationId?: string) => Effect.Effect<MachineSettingsResult<MachineCacheWindows>, never, R>;
};

/** What `peerSettings()` still asks of its caller's context. */
type PeerSettingsNeeds = HostsService | MachineLink | MachineRepository | ModelRecords | ModelService;

/** What the deprecated accessor returns: the calls, over the caller's own context. */
export type PeerSettingsClient = PeerSettingsCalls<PeerSettingsNeeds>;

/** This core's one settings client: built with the services it asks through, so its calls need none. */
export class PeerSettings extends Context.Service<PeerSettings, PeerSettingsCalls<never>>()("@junto/PeerSettings") {}

export const makePeerSettings = Effect.fn("PeerSettings.make")(function* () {
  const client = yield* linkClient(SettingsLink);
  const link = yield* MachineLink;
  const hosts = yield* HostsService;
  const lookups = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();

  /** A canvas this machine edits with a seat on that machine: the only thing a request names. */
  const canvasFor = (machine: string) => Effect.gen(function* () {
    const model = yield* ModelService;
    const records = yield* ModelRecords;
    const self = yield* (yield* MachineRepository).installationId;
    for (const name of yield* model.listCanvases()) {
      if ((yield* records.canvasEditor(name)) !== self) continue;
      for (const node of (yield* model.canvas(name)).nodes.values()) {
        if (node.kind === "agent" && isThisMachine(node.host, machine)) return name;
      }
    }
    return undefined;
  }).pipe(Effect.provideContext(lookups));

  const ask = <A extends { readonly machine: string }>(
    machine: string,
    operationId: string,
    call: (canvas: CanvasName) => Effect.Effect<A, SettingsLinkFailure | MachineLinkError>,
  ) => Effect.gen(function* () {
    const canvas = yield* canvasFor(machine);
    if (canvas === undefined)
      return yield* new NoPathToMachine({
        message: `No canvas this machine edits has a seat on ${machine}, so it cannot ask ${machine} for its settings.`,
      });
    const host = yield* hosts.get(machine);
    if (host === undefined) return yield* new NoPathToMachine({ message: `${machine} is not a registered machine.` });
    yield* link.connect(host);
    const answer = yield* call(canvas).pipe(
      // A bad answer fails only this request; the link stays open.
      Effect.catchTag("LinkFrameInvalid", (refused) => Effect.fail(refused.problem !== "response" ? refused : new SettingsAnswerRefused({
        machine,
        operationId,
        message: `${machine} sent settings this machine does not accept: ${reasonOf(refused)}`,
      }))),
    );
    // The peer the link admitted is the only machine an answer may describe.
    if (answer.machine !== machine)
      return yield* new SettingsNotFromItsMachine({
        machine,
        claimed: answer.machine,
        operationId,
        message: `${machine} sent settings that name another machine.`,
      });
    return answer;
  });

  const answered = <A>(machine: string, operationId: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.map((value): MachineSettingsResult<A> => ({ ok: true, value })),
      Effect.catch((cause: unknown) => Effect.gen(function* () {
        const failure = tagOf(cause);
        const reason = reasonFor(cause);
        yield* Effect.logWarning("peer settings failed", { failure, reason }, cause);
        return {
          ok: false,
          error: {
            _tag: "MachineSettingsUnavailableError",
            machine,
            reason,
            message: reason === "unreachable" && !(cause instanceof NoPathToMachine)
              ? `${machine} could not be asked for its settings: ${reasonOf(cause)}`
              : reasonOf(cause),
            failure,
            operationId,
          },
        } satisfies MachineSettingsResult<A>;
      })),
      Effect.annotateLogs({ area: "settings", peer: machine, operationId }),
    );

  const providers = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.ProvidersRead(machine, { canvas }, { operationId })).pipe(
      Effect.map(providersOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const setProviders = (machine: string, change: ProvidersChange, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.ProvidersWrite(machine, {
      canvas,
      enabledSources: [...change.enabledSources],
    }, { operationId })).pipe(
      Effect.map(providersOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const record = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.RecordRead(machine, { canvas }, { operationId })).pipe(
      Effect.map(recordOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const setStartup = (machine: string, supervisedPreferred: boolean, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.StartupWrite(machine, { canvas, supervisedPreferred }, { operationId })).pipe(
      Effect.map(recordOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const cacheWindows = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.CacheWindowsRead(machine, { canvas }, { operationId })).pipe(
      Effect.map(cacheWindowsOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const setCacheWindows = (machine: string, change: OffboardRulesPatch, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => client.CacheWindowsWrite(machine, {
      canvas,
      ...(change.cacheWindowMinutes === undefined ? {} : { cacheWindowMinutes: change.cacheWindowMinutes }),
      ...(change.harness === undefined ? {} : {
        harness: Object.fromEntries(Object.entries(change.harness).map(([harness, over]) =>
          [harness, over === null ? null : over.cacheWindowMinutes])),
      }),
      ...(change.cacheMode === undefined ? {} : { cacheMode: change.cacheMode }),
    }, { operationId })).pipe(
      Effect.map(cacheWindowsOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  return PeerSettings.of({ providers, setProviders, record, setStartup, cacheWindows, setCacheWindows });
});

/** This core's one settings client, provided by the core runtime. */
export const peerSettingsLayer = () => Layer.effect(PeerSettings, Effect.suspend(() => makePeerSettings()));

/**
 * @deprecated Until `ops/ipc-settings.ts` yields `PeerSettings` and the core
 * runtime provides `peerSettingsLayer()`. Builds the client per call from
 * the caller's context; it holds no module state.
 */
export const peerSettings = (): PeerSettingsClient => ({
  providers: (machine, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.providers(machine, operationId)),
  setProviders: (machine, change, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.setProviders(machine, change, operationId)),
  record: (machine, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.record(machine, operationId)),
  setStartup: (machine, supervisedPreferred, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.setStartup(machine, supervisedPreferred, operationId)),
  cacheWindows: (machine, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.cacheWindows(machine, operationId)),
  setCacheWindows: (machine, change, operationId) =>
    Effect.flatMap(makePeerSettings(), (client) => client.setCacheWindows(machine, change, operationId)),
});
