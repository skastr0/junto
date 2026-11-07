/**
 * Every push on the core bus, by channel and by what it carries. The core
 * publishes here; main listens on the port and republishes on its own bus,
 * where the handlers that send to a window read them. This file is the
 * contract, and it holds no operation body, so main links no core module by
 * naming a channel.
 *
 * `CORE_PUSHES` is the whole registry. `publish` accepts a channel only if it
 * is here, with exactly that channel's payload; `relayWindowPushes` listens
 * for every one of them. So a push cannot be published without main hearing
 * it, which is what a hand-kept forward list got wrong.
 */
import { Result, Schema } from "effect";
import { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { AgentSignal } from "@shared/agent-signals";
import { CompanionDeviceRecord } from "@shared/companion-devices";
import { IPC_CHANNELS } from "@shared/ipc";
import { MailWaitingFact } from "@shared/mail-waiting";
import { MailReadChanged } from "@shared/mail-threads";
import { MachineCommandProgress } from "@shared/machine-progress";
import { ShellEnvironmentChange } from "@shared/shell-environment";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import { CanvasSchema, CanvasesChanged, Changed } from "@shared/model";
import { ObservabilityLogEntry } from "@shared/observability";
import { LiveSnapshot } from "@shared/overseer-live";
import { PreambleEventSchema } from "@shared/preamble";
import { ReferencesChangedEvent } from "@shared/references";
import { SeatOnboardingEvent } from "@shared/seat-onboarding-status";
import { SeatCredentialEvent } from "@shared/seat-credential-event";
import { SeatOffboardProgress } from "@shared/seat-sessions";
import { Settings } from "@shared/settings";
import { UsageState } from "@shared/usage";
import { ViewStateEvent } from "@shared/view-state";
import { WireTrafficEvent } from "@shared/wire-traffic";
import { SeatAwarenessEvent } from "../../shared/seat-awareness-contract";
import { FilesChanged } from "@shared/files";
import { FilesRemoteChange } from "@shared/files-link";
import type { ActorRefsChanged } from "../../core/model/actor-refs";
import { KernelSnapshot } from "./status";
import { EmptyRecord, MentionChanged, NoPayload, ResourceChanged, TermLeaseEnded } from "./push-payloads";
import type { LocalHostEvent } from "../../core/term/local-host";

/** Where the settings go on every change, provider secrets masked, once `settings.watch` started it. */
export const SETTINGS_CHANGED = "settings.changed";
/** A seat's preamble, as the core's work control server takes it, for the window to show. */
export const WORK_PREAMBLE = "work.preamble";
/** Every agent signal the core writes, for the window and the raised hands. */
export const AGENT_SIGNAL_CHANGED = "signals.changed";
/** The paired phones, after any change, for Settings. */
export const COMPANION_DEVICES = "companion.devices";
/** The live overseer's snapshot on every change, from the moment the core's server starts. */
export const LIVE_CHANGED = "live.changed";
/** A mail thread's read point moved, from any surface, once `ThreadsWatch` started it. */
export const SEAT_THREAD_READ_CHANGED = "threads.readChanged";
/** Mail held on a seat past its wait, once `ThreadsWatch` started it. */
export const MAIL_WAITING = "mail.waiting";
/** A canvas changed, with the document as it is now, or was removed; once `model.watchCanvases` started it. */
export const CANVAS_CHANGED = "model.canvasChanged";

/** What the canvas notice carries: the canvas, and the document as it is now or `undefined` once removed. */
export const CanvasChangedPush = Schema.Struct({ canvas: Schema.String, next: Schema.UndefinedOr(CanvasSchema) });
export type CanvasChangedPush = typeof CanvasChangedPush.Type;

/** A resource's rows changed, from any surface: main broadcasts it to the window. */
export const RESOURCE_CHANGED = "resource.changed";
/** A comment landed on a resource whose own rows did not change. */
export const RESOURCE_THREAD_CHANGED = "resource.threadChanged";

/** What crosses on the two notices: the window's own channel and what it carries. */
export const ResourceChangedPush = Schema.Struct({ channel: Schema.String, canvasName: Schema.String });
export type ResourceChangedPush = typeof ResourceChangedPush.Type;
export const ResourceThreadChangedPush = Schema.Struct({ ...ResourceChangedPush.fields, kind: Schema.String });
export type ResourceThreadChangedPush = typeof ResourceThreadChangedPush.Type;

/** A wire's traffic: one typed message, or a held line. Main relays it. */
export const WIRE_TRAFFIC = "wire.traffic";

/** A change to a node a window has open: the webContents id it goes to, and what changed. */
export const FILES_CHANGED = "files.changed";

export const FilesChangedPush = Schema.Struct({ subscriber: Schema.Number, event: FilesChanged });
export type FilesChangedPush = typeof FilesChangedPush.Type;

/** A change under a node opened on another machine. */
export const FILES_REMOTE_CHANGED = "files.remoteChanged";

/** A running machine command's progress, tagged with the call that asked for it. */
export const MACHINE_PROGRESS = "hosts.machineProgress";

export const MachineProgressPushed = Schema.Struct({ requestId: Schema.String, progress: MachineCommandProgress });
export type MachineProgressPushed = typeof MachineProgressPushed.Type;

/** A terminal event from the plane (output, status, exit, title), for the window holding its lease. */
export const TERM_EVENT = "term.event";
/** A linked seat's view its machine ended. */
export const TERM_LEASE_ENDED = "term.leaseEnded";
/** A seat changed state: one this machine runs, or one on another machine over the seats channel. */
export const TERM_SEAT_STATE = "term.seatState";

/** A view's surface opened or was refused, by the id main sent with it. Carried on the port, never the bus. */
export const SURFACE_OPENED = "term.surfaceOpened";

/** One log row, while a panel watches: the ring captures always, the push is for the open panel. */
export const OBSERVABILITY_LOG = "observability.log";
/** The ring was cleared: a panel drops what it holds. */
export const OBSERVABILITY_CLEARED = "observability.cleared";

export const ObservabilityCleared = Schema.Struct({ newestId: Schema.Number, total: Schema.Number, dropped: Schema.Number });
export type ObservabilityCleared = typeof ObservabilityCleared.Type;

/** A seat credential went live, was suspended or was revoked: what it was granted ends now. */
export const SEAT_CREDENTIAL_CHANGED = "seatCredential.changed";

export type SeatCredentialChanged = SeatCredentialEvent;

/** A seat's cache window changed, and the auto mode's due seats, for the window. */
export const SEAT_CACHE_DUE_CHANGED = "seatCacheDue.changed";

/** The shell environment was read again, in the core whose copy spawns. */
export const SHELL_ENVIRONMENT_CHANGED = "shellEnvironment.changed";

/**
 * The payload witness of a channel whose Schema has not landed yet: it names
 * the payload's type, is never called, and its payload crosses undecoded.
 * Every channel gets a Schema; this goes when the last one lands.
 */
const carries = <Payload>() => (payload: Payload): Payload => payload;

/**
 * Every push on the core bus, and the Schema of what it carries. A channel is
 * publishable only from here, and a publish carries exactly the payload named
 * for it. The core encodes the payload with that Schema's JSON codec, and
 * main decodes it closed where it arrives (`encodeCorePush`,
 * `decodeCorePush`), so a payload either side changed fails there, not in a
 * window.
 */
export const CORE_PUSHES = {
  [SETTINGS_CHANGED]: Settings,
  [WORK_PREAMBLE]: PreambleEventSchema,
  [AGENT_SIGNAL_CHANGED]: AgentSignal,
  [COMPANION_DEVICES]: Schema.Array(CompanionDeviceRecord),
  [LIVE_CHANGED]: LiveSnapshot,
  [SEAT_THREAD_READ_CHANGED]: MailReadChanged,
  [MAIL_WAITING]: MailWaitingFact,
  [CANVAS_CHANGED]: CanvasChangedPush,
  [RESOURCE_CHANGED]: ResourceChangedPush,
  [RESOURCE_THREAD_CHANGED]: ResourceThreadChangedPush,
  [WIRE_TRAFFIC]: WireTrafficEvent,
  [FILES_REMOTE_CHANGED]: FilesRemoteChange,
  [FILES_CHANGED]: FilesChangedPush,
  [OBSERVABILITY_LOG]: ObservabilityLogEntry,
  [SEAT_CREDENTIAL_CHANGED]: SeatCredentialEvent,
  [OBSERVABILITY_CLEARED]: ObservabilityCleared,
  [MACHINE_PROGRESS]: MachineProgressPushed,
  // Undecoded on purpose: the terminal process's frames (bf1892eb2) replace this path; pty-lead owns it.
  [TERM_EVENT]: carries<LocalHostEvent>(),
  [TERM_LEASE_ENDED]: TermLeaseEnded,
  [TERM_SEAT_STATE]: AgentSeatStateEvent,
  [SEAT_CACHE_DUE_CHANGED]: NoPayload,
  [SHELL_ENVIRONMENT_CHANGED]: ShellEnvironmentChange,
  // A backlink landed; the panes read their mentions again.
  [MENTION_IPC_CHANNELS.changed]: MentionChanged,
  // The model's own watches, each on the window's channel name (ops/ipc-watch.ts).
  [IPC_CHANNELS.modelChanged]: Changed,
  [IPC_CHANNELS.modelCanvasesChanged]: CanvasesChanged,
  // Undecoded until its Schema moves to shared: the contract may not import core values.
  [IPC_CHANNELS.modelActorRefsChanged]: carries<ActorRefsChanged>(),
  [IPC_CHANNELS.viewStateChanged]: ViewStateEvent,
  [IPC_CHANNELS.referencesChanged]: ReferencesChangedEvent,
  [IPC_CHANNELS.workMailChanged]: ResourceChanged,
  [IPC_CHANNELS.workSinkChanged]: ResourceChanged,
  [IPC_CHANNELS.seatAwarenessChanged]: SeatAwarenessEvent,
  [IPC_CHANNELS.usageChanged]: UsageState,
  [IPC_CHANNELS.kernelChanged]: KernelSnapshot,
  [IPC_CHANNELS.automationsChanged]: ResourceChanged,
  [IPC_CHANNELS.seatOffboardProgress]: SeatOffboardProgress,
  [IPC_CHANNELS.seatOnboardingChanged]: SeatOnboardingEvent,
  [IPC_CHANNELS.coreRestarted]: EmptyRecord,
  // A canvas's authority list changed (fleet/host.ts); the window reads it again.
  [IPC_CHANNELS.authorityChanged]: EmptyRecord,
} as const;

/** Every channel on the core bus. */
export type CorePushChannel = keyof typeof CORE_PUSHES;

type CorePushEntry<K extends CorePushChannel> = (typeof CORE_PUSHES)[K];

/** What one channel carries. */
export type CorePushOf<K extends CorePushChannel> = CorePushEntry<K> extends Schema.Top
  ? CorePushEntry<K>["Type"]
  : CorePushEntry<K> extends (payload: infer Payload) => unknown
    ? Payload
    : never;

/** Every channel on the core bus, for the relay to listen on. */
export const CORE_PUSH_CHANNELS = Object.keys(CORE_PUSHES) as ReadonlyArray<CorePushChannel>;

/** A payload that did not match its channel's Schema, with the channel it was for. */
export class CorePushRefused extends Schema.TaggedError<CorePushRefused>()("CorePushRefused", {
  channel: Schema.String,
  message: Schema.String,
}) {}

type CorePushCodec = {
  readonly encode: (payload: unknown) => Result.Result<unknown, CorePushRefused>;
  readonly decode: (raw: unknown) => Result.Result<unknown, CorePushRefused>;
};

const closed = { onExcessProperty: "error" } as const;

const codecOf = (channel: CorePushChannel, entry: unknown): CorePushCodec => {
  if (!Schema.isSchema(entry)) {
    const pass = (payload: unknown) => Result.succeed(payload);
    return { encode: pass, decode: pass };
  }
  const json = Schema.toCodecJson(entry as Schema.Codec<unknown, unknown>);
  const encode = Schema.encodeUnknownResult(json);
  const decode = Schema.decodeUnknownResult(json, closed);
  const refused = (error: Schema.SchemaError) => new CorePushRefused({ channel, message: error.message });
  return {
    encode: (payload) => Result.mapError(encode(payload), refused),
    decode: (raw) => Result.mapError(decode(raw), refused),
  };
};

/** Each channel's JSON codec, made once from the registry. */
const CORE_PUSH_CODECS = Object.fromEntries(
  CORE_PUSH_CHANNELS.map((channel) => [channel, codecOf(channel, CORE_PUSHES[channel])]),
) as Readonly<Record<CorePushChannel, CorePushCodec>>;

/** The core's side: a payload as it crosses the port, its keys past the Schema dropped. */
export const encodeCorePush = <K extends CorePushChannel>(
  channel: K,
  payload: CorePushOf<K>,
): Result.Result<unknown, CorePushRefused> => CORE_PUSH_CODECS[channel].encode(payload);

/** Main's side: what crossed the port, decoded closed, so an unknown key refuses it as a wrong value does. */
export const decodeCorePush = <K extends CorePushChannel>(
  channel: K,
  raw: unknown,
): Result.Result<CorePushOf<K>, CorePushRefused> =>
  CORE_PUSH_CODECS[channel].decode(raw) as Result.Result<CorePushOf<K>, CorePushRefused>;
