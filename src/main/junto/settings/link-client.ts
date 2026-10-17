/**
 * The asking end of the link's settings channel. The machine that edits a
 * canvas asks a seat's machine for its providers or record, or sets one,
 * naming the canvas only. The answer is decoded closed here, after the
 * request returns, so a bad answer is one typed refusal with the link still
 * open. Nothing is queued: a machine that cannot be asked answers at once
 * with the typed reason.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { MachineSettingsResult } from "@shared/ipc";
import { isThisMachine } from "@shared/machine-name";
import type { MachineProviders, MachineRecord } from "@shared/machine-settings";
import type { NativeUsageProvider } from "@shared/usage";
import { describeCause } from "../failure-encode";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import {
  decodeLinkProviders,
  decodeLinkRecord,
  providersOfWire,
  recordOfWire,
  SettingsAnswerRefused,
  SettingsLinkFailure,
  SettingsNotFromItsMachine,
} from "./link-wire";

/** A decode failure as its issue kind and path; any other text through the doctrine scrub. */
const reasonOf = (cause: unknown): string => describeCause(cause).message.slice(0, 500);

const tagOf = (cause: unknown): string =>
  (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown").slice(0, 64);

const isLinkFailure = Schema.is(SettingsLinkFailure);

/** The answering machine's own typed refusal, when the link carried one. */
const unwrap = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "detail" in cause && isLinkFailure(cause.detail) ? cause.detail : cause;

/** Refusals and bad answers read failed; the link's own errors read unreachable. */
const reasonFor = (cause: unknown): "unreachable" | "failed" =>
  cause instanceof SettingsAnswerRefused || cause instanceof SettingsNotFromItsMachine || isLinkFailure(cause)
    ? "failed" : "unreachable";

class NoPathToMachine extends Schema.TaggedError<NoPathToMachine>()("NoPathToMachine", { message: Schema.String }) {}

export type ProvidersChange = {
  readonly enabledSources?: ReadonlyArray<NativeUsageProvider>;
  readonly hermesHostSnapshots?: boolean;
};

export const makePeerSettingsClient = () => {
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
  });

  const ask = <A>(
    machine: string,
    operationId: string,
    request: (canvas: string) => Record<string, unknown>,
    decode: (payload: unknown) => A & { readonly machine: string },
  ) => Effect.gen(function* () {
    const canvas = yield* canvasFor(machine);
    if (canvas === undefined)
      return yield* new NoPathToMachine({
        message: `No canvas this machine edits has a seat on ${machine}, so it cannot ask ${machine} for its settings.`,
      });
    const host = yield* (yield* HostsService).get(machine);
    if (host === undefined) return yield* new NoPathToMachine({ message: `${machine} is not a registered machine.` });
    const link = yield* MachineLink;
    yield* link.connect(host);
    const payload = yield* link.request(machine, "settings", request(canvas), { operationId });
    const answer = yield* Effect.try({
      try: () => decode(payload),
      catch: (cause) => new SettingsAnswerRefused({
        machine,
        operationId,
        message: `${machine} sent settings this machine does not accept: ${reasonOf(cause)}`,
      }),
    });
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

  const answered = <A, R>(machine: string, operationId: string, effect: Effect.Effect<A, unknown, R>) =>
    effect.pipe(
      Effect.map((value): MachineSettingsResult<A> => ({ ok: true, value })),
      Effect.catch((raw: unknown) => Effect.gen(function* () {
        const cause = unwrap(raw);
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
    ask(machine, operationId, (canvas) => ({ _tag: "ProvidersRead", canvas }), decodeLinkProviders).pipe(
      Effect.map(providersOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const setProviders = (machine: string, change: ProvidersChange, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => ({
      _tag: "ProvidersWrite",
      canvas,
      ...(change.enabledSources === undefined ? {} : { enabledSources: [...change.enabledSources] }),
      ...(change.hermesHostSnapshots === undefined ? {} : { hermesHostSnapshots: change.hermesHostSnapshots }),
    }), decodeLinkProviders).pipe(
      Effect.map(providersOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const record = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => ({ _tag: "RecordRead", canvas }), decodeLinkRecord).pipe(
      Effect.map(recordOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  const setStartup = (machine: string, supervisedPreferred: boolean, operationId: string = randomUUID()) =>
    ask(machine, operationId, (canvas) => ({ _tag: "StartupWrite", canvas, supervisedPreferred }), decodeLinkRecord).pipe(
      Effect.map(recordOfWire),
      (effect) => answered(machine, operationId, effect),
    );

  return { providers, setProviders, record, setStartup };
};

export type PeerSettingsClient = ReturnType<typeof makePeerSettingsClient>;

let shared: PeerSettingsClient | undefined;
/** This process's settings client. */
export const peerSettings = (): PeerSettingsClient => (shared ??= makePeerSettingsClient());
