import { Context, Effect, Schema } from "effect";
import { join } from "node:path";
import type { CoreRuntime, MachineCoreOptions } from "../core-runtime";
import { makeCoreRuntime } from "../core-runtime";
import { MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail } from "../core-runtime";
import { makeInventoryChannel } from "./inventory/channel";
import { makeNativeConfigChannel } from "./inventory/native-channel";
import { FILES_REMOTE_ENABLED } from "@shared/features";
import { makeHeadlessFilesService } from "./files/headless-service";
import { makeFilesLinkChannel } from "./files/link";
import { makeFilesRemote } from "./files/link-client";
import { holdFilesRemote } from "./files/remote-holder";
import { FILES_REMOTE_CHANGED, SEAT_CACHE_DUE_CHANGED } from "../core-process/channels";
import { unboundYet } from "./link/unbound";
import { makeSettingsChannel } from "./settings/link-channel";
import { MachineOwnerControl } from "./hosts/machine-owner";
import { MachineLink, type MachineLinkListener } from "./link/service";
import { startOperatorControlServer, type OperatorControlServer } from "./operator-control";
import { evaluateSchemaCompatibility, probeInstalledStateSchema } from "./state/schema-version-probe";
import { quiesceServiceChildrenOnQuit } from "../services/process";
import { installCoreRunner } from "../core-runner";
import { startWorkControlServer, type WorkControlServer } from "./work/control";
import { workControlDir } from "@shared/work-control";
import { startCoreSeats } from "./term/core-seats";
import { connectCoreTerminals } from "../terminal-process/core-side";
import { bindTermIpcPlane } from "../core-process/ops/term-ipc";
import { startSeatSessions, type SeatSessions } from "./seat-sessions/start-seat-sessions";
import { wireSeatReports } from "./term/agent-state/seat-reports";
import { seatStateRuntime } from "./term/agent-state/runtime";
import { watchClaudeResumeRecovery } from "./term/drive/claude-resume-recovery";
import { terminalObserverPlane } from "./term/observer";
import { onSeatViewQuestions } from "./term/seat-views";
import { watchSeatReadiness } from "./term/onboard-nudge-interject";
import { termPlane } from "./term/plane";
import { configureTerminalRouterLayeredRunner } from "./term/router";
import { IPC_CHANNELS } from "@shared/ipc";
import { publish } from "../core-process/push";
import { bindCoreSeatSessions } from "../core-process/ops/ipc-seats";
import { AgentSignalRepository } from "./signals/repository";
import { onAgentSignalChanged } from "./signals/changes";
import { mainAuthoringGate } from "./main-authoring-gate";
import { startCanvasControlServer, type CanvasControlServer } from "./canvas-control/server";
import { composeOverseer, type OverseerComposition } from "./overseer/composition";
import { composeOverseerLive } from "./overseer/live/composition";
import type { ApplicationCaptureResult } from "./overseer/native";
import type { OverseerPages } from "./overseer/pages";
import type { PreambleEvent } from "@shared/preamble";
import { OPERATOR_COMPANION_OPS, OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope, type OperatorResponseEnvelope } from "@shared/operator-control";
import { AuthorityOwnerControl } from "./hosts/authority-owner";
import type { AgentSignal } from "@shared/agent-signals";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import type { CompanionEnvironment } from "./companion/environment";
import { makeCompanionService, setCompanionService, type CompanionService } from "./companion/service";
import { bindCompanionHost } from "./companion/runtime";
import { companionNotePreamble, wireCompanionChanges } from "./companion/wiring";

export type CoreOptions = Omit<MachineCoreOptions, "ready"> & {
  /** The desktop core also serves canvas edits (`junto canvas`); a headless machine core does not. */
  readonly canvasControl?: boolean;
  /** The desktop core runs the overseer, asking main for the window's pixels and the browser's pages. */
  readonly overseer?: {
    readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
    readonly pages: OverseerPages;
  };
  /** The desktop core runs the live overseer, and its work control server takes the live seat's calls. */
  readonly overseerLive?: boolean;
  /** A seat's preamble as the work control server takes it, for the window. */
  readonly onPreamble?: (event: PreambleEvent) => void;
  /**
   * The desktop's operator socket. Without it the core always listens and
   * answers machine commands, as a headless machine does.
   */
  readonly operator?: {
    /** "on-demand": listen only once `ensureOperatorListening` asks (a phone paired). */
    readonly listen: "always" | "on-demand";
    /** Commands beyond the phone companion's need Junto launched for operator control. */
    readonly commands: boolean;
    /** The phone companion's answer to its ops, when this machine has one. */
    readonly companion?: (request: OperatorRequestEnvelope) => Promise<OperatorResponseEnvelope | undefined>;
  };
  /**
   * The desktop core runs the phone companion: a phone's request is answered
   * here and never waits on Electron main. Only what main alone knows comes in.
   */
  readonly companion?: {
    readonly appVersion: string;
    readonly environment: () => Promise<CompanionEnvironment>;
    /** Settings' device list changed. */
    readonly onDevicesChanged: (devices: ReadonlyArray<CompanionDeviceRecord>) => void;
    /** A signal the operator answered from the phone, for the window. */
    readonly showSignal: (signal: AgentSignal) => void;
  };
};

const operatorRefusal = (
  request: OperatorRequestEnvelope,
  type: "forbidden" | "runtime_down",
  message: string,
): OperatorResponseEnvelope => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false, error: { type, message } });

/** The installed database is newer than this build; starting would corrupt it. */
export class CoreSchemaTooNew extends Schema.TaggedError<CoreSchemaTooNew>()("CoreSchemaTooNew", {
  userVersion: Schema.Number,
  supportedVersion: Schema.Number,
  message: Schema.String,
}) {}

/** A stop that could not finish: the named part still held work, so core state was kept. */
export class CoreDidNotDrain extends Schema.TaggedError<CoreDidNotDrain>()("CoreDidNotDrain", {
  part: Schema.Literals(["owner-commands", "seat-work", "canvas-edits", "writes", "service-children"]),
  remaining: Schema.optionalKey(Schema.Number),
  message: Schema.String,
}) {}

/** Both shells use this owner/link lifecycle; it creates no canvas. */
export const startCore = async (options: CoreOptions) => {
  const schema = evaluateSchemaCompatibility(probeInstalledStateSchema(join(options.home, ".junto", "state", "junto.db")));
  if (!schema.ok) {
    throw new CoreSchemaTooNew({
      userVersion: schema.userVersion,
      supportedVersion: schema.supportedVersion,
      message: `Update Junto: this database uses schema ${schema.userVersion}, this build supports ${schema.supportedVersion}`,
    });
  }
  let admitted = false;
  let stopping = false;
  let owner: OperatorControlServer | undefined;
  let listener: MachineLinkListener | undefined;
  let work: WorkControlServer | undefined;
  let canvas: CanvasControlServer | undefined;
  let overseer: OverseerComposition | undefined;
  let overseerLive: Awaited<ReturnType<typeof composeOverseerLive>> | undefined;
  let companion: CompanionService | undefined;
  let stopCompanion: (() => void) | undefined;
  let seatProcesses: Awaited<ReturnType<typeof startCoreSeats>> | undefined;
  let unbindTermIpcPlane: (() => void) | undefined;
  let mail: Context.Service.Shape<typeof MachineCoreMail> | undefined;
  let sessions: SeatSessions | undefined;
  let stopSeatReports: (() => void) | undefined;
  let stopSeatWatches: (() => void) | undefined;
  let releaseRunner: (() => void) | undefined;
  // An on-demand operator socket not yet asked for is not a core that is down.
  const ownerReady = (): boolean => owner === undefined ? options.operator?.listen === "on-demand" : owner.ready();
  const runtime = makeCoreRuntime({ ...options, ready: () => admitted && !stopping && ownerReady() && listener?.ready() === true });
  let ownerStart: Promise<void> | undefined;
  /** Opens the operator socket once; the desktop asks when a phone pairs. */
  let ensureOperatorListening: () => Promise<void> = () => Promise.resolve();
  let closeFlight: Promise<void> | undefined;
  /** `cause` says why this core stops; each linked machine reads it in the close frame. */
  const close = (cause?: unknown): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    stopping = true;
    admitted = false;
    owner?.beginShutdown();
    listener?.beginShutdown(cause);
    work?.beginShutdown();
    canvas?.beginShutdown();
    mail?.seats.suspend();
    bindCoreSeatSessions(undefined);
    holdFilesRemote(undefined);
    sessions?.stop();
    stopSeatReports?.();
    stopSeatWatches?.();
    seatProcesses?.beginShutdown();
    closeFlight = (async () => {
      // A socket still opening lands in `owner` first, so it closes with the rest.
      await ownerStart?.catch(() => undefined);
      if (owner !== undefined) {
        const receipt = await owner.close();
        if (!receipt.clean) throw new CoreDidNotDrain({ part: "owner-commands", message: "Owner commands did not drain; core state retained" });
      }
      if (listener !== undefined) await listener.close(cause);
      if (work !== undefined) {
        const receipt = await work.close();
        if (!receipt.clean) throw new CoreDidNotDrain({ part: "seat-work", message: "Seat work commands did not drain; core state retained" });
      }
      if (canvas !== undefined) {
        const receipt = await canvas.close();
        if (!receipt.clean) throw new CoreDidNotDrain({ part: "canvas-edits", message: "Canvas edits did not drain; core state retained" });
      }
      unbindTermIpcPlane?.();
      await seatProcesses?.close();
      overseer?.dispose();
      await overseerLive?.dispose();
      stopCompanion?.();
      // The phone's idle long poll lets go before the process ends.
      companion?.changes.close();
      const writes = await mainAuthoringGate.drain(5_000);
      if (writes.remaining.length > 0) {
        throw new CoreDidNotDrain({ part: "writes", remaining: writes.remaining.length, message: "Core writes did not drain; core state retained" });
      }
      await runtime.dispose();
      const children = await quiesceServiceChildrenOnQuit();
      if (!children.clean) throw new CoreDidNotDrain({ part: "service-children", message: "Core service children did not drain" });
      releaseRunner?.();
    })();
    return closeFlight;
  };
  try {
    releaseRunner = installCoreRunner(runtime);
    // The terminal router's SSH dials run on the core that owns the terminal plane.
    configureTerminalRouterLayeredRunner((effect) => runtime.runPromise(effect as never));
    const [actions, link, status, rows, seats, coreMail] = await runtime.runPromise(Effect.all([MachineOwnerControl, MachineLink, MachineCoreStatus, MachineCoreRows, MachineCoreSeats, MachineCoreMail]));
    mail = coreMail;
    if (options.overseer !== undefined) {
      overseer = await composeOverseer({
        run: (effect, runOptions) => runtime.runPromise(effect, runOptions),
        captureApplicationPage: options.overseer.captureApplicationPage,
        pagePort: options.overseer.pages,
      });
    }
    if (options.overseerLive === true) overseerLive = await composeOverseerLive((effect) => runtime.runPromise(effect));
    work = await startWorkControlServer({
      home: options.home, workHome: workControlDir(options.home),
      version: typeof __JUNTO_APP_VERSION__ === "string" ? __JUNTO_APP_VERSION__ : "dev",
      run: effect => runtime.runPromise(effect),
      ...(overseer === undefined ? {} : { onOverseer: overseer.onOverseer }),
      ...(overseerLive === undefined ? {} : { onOverseerLive: overseerLive.onHost, validateOverseerLive: overseerLive.validateOperation }),
      ...(options.onPreamble === undefined && options.companion === undefined ? {} : {
        onPreamble: (event: PreambleEvent) => {
          if (options.companion !== undefined) companionNotePreamble(event);
          options.onPreamble?.(event);
        },
      }),
    });
    if (options.canvasControl === true) {
      canvas = await startCanvasControlServer({ home: options.home, run: effect => runtime.runPromise(effect) });
    }
    // The core in its own process: one terminal plane, here, whose PTYs run in
    // the terminal process over a port main hands it, never in this process.
    const parent = (process as unknown as { parentPort?: Parameters<typeof connectCoreTerminals>[0] }).parentPort;
    if (parent !== undefined) await connectCoreTerminals(parent);
    seatProcesses = await startCoreSeats({ home: options.home });
    // The window's terminal ops ask this plane by name, and its events reach the window as core pushes.
    if (parent !== undefined) unbindTermIpcPlane = bindTermIpcPlane(termPlane);
    const inventory = await runtime.runPromise(makeInventoryChannel());
    const nativeConfig = await runtime.runPromise(makeNativeConfigChannel());
    const settings = await runtime.runPromise(makeSettingsChannel());
    // Always bound, off in ship: a peer with filesRemote on that finds the channel unbound closes the whole
    // link, seats and all, so with the feature off the channel is there and refuses every op denied.
    const filesHost = FILES_REMOTE_ENABLED ? makeHeadlessFilesService() : undefined;
    // This core's end of another machine's Files node: the window's router asks it by name.
    const filesRemote = FILES_REMOTE_ENABLED ? await runtime.runPromise(makeFilesRemote()) : undefined;
    holdFilesRemote(filesRemote);
    filesRemote?.onChange((change) => publish(FILES_REMOTE_CHANGED, change));
    const files = await runtime.runPromise(makeFilesLinkChannel({
      enabled: FILES_REMOTE_ENABLED,
      service: () => filesHost,
      ...(filesRemote === undefined ? {} : { onEvent: filesRemote.onEvent, onOpened: filesRemote.onOpened, onClosed: filesRemote.onClosed }),
    }));
    await runtime.runPromise(link.setChannels({ status: status.handler, rows: rows.handler, content: rows.content, seats: seats.handler, inventory, settings, "native-config": nativeConfig, files, consensus: unboundYet("consensus"), authority: unboundYet("authority") }));
    listener = await runtime.runPromise(link.listen(options.home));
    const machineDispatch = (request: OperatorRequestEnvelope) => runtime.runPromise(actions.dispatch(request));
    if (options.companion !== undefined) {
      const unbind = bindCompanionHost({ runPromise: (effect) => runtime.runPromise(effect), showSignal: options.companion.showSignal });
      const service = makeCompanionService({
        appVersion: options.companion.appVersion,
        environment: options.companion.environment,
        onDevicesChanged: options.companion.onDevicesChanged,
        onFirstDevice: () => {
          void ensureOperatorListening().catch((cause: unknown) => {
            console.error("[companion] operator control failed to start", cause);
          });
        },
      });
      companion = service;
      setCompanionService(service);
      stopCompanion = () => {
        service.close();
        service.changes.close();
        unbind();
      };
    }
    const desk = options.operator === undefined || companion === undefined ? options.operator
      : { ...options.operator, companion: options.operator.companion ?? companion.dispatch };
    const dispatch = desk === undefined ? machineDispatch : async (request: OperatorRequestEnvelope): Promise<OperatorResponseEnvelope> => {
      if (OPERATOR_COMPANION_OPS.has(request.op)) {
        return (await desk.companion?.(request)) ?? operatorRefusal(request, "runtime_down", "the phone companion is not available");
      }
      if (!desk.commands) return operatorRefusal(request, "forbidden", "operator commands need Junto launched with --junto-operator-control");
      if (request.op.startsWith("authority.")) return runtime.runPromise(Effect.flatMap(AuthorityOwnerControl, (authority) => authority.dispatch(request)));
      if (request.op.startsWith("machine.")) return machineDispatch(request);
      return operatorRefusal(request, "runtime_down", "The phone companion is not available");
    };
    ensureOperatorListening = () =>
      (ownerStart ??= (async () => {
        if (owner !== undefined || stopping) return;
        const started = await startOperatorControlServer({ home: options.home, dispatch });
        if (stopping) started.beginShutdown();
        owner = started;
      })().catch((cause: unknown) => {
        ownerStart = undefined;
        throw cause;
      }));
    if (desk?.listen !== "on-demand") await ensureOperatorListening();
    if (companion !== undefined) {
      const service = companion;
      // A paired phone needs the socket from boot; the first pairing opens it later.
      void wireCompanionChanges(service.changes)
        .then((unwire) => {
          const stop = stopCompanion;
          stopCompanion = () => {
            unwire();
            stop?.();
          };
          return service.reconcile();
        })
        .then(() => service.hasDevices())
        .then((paired) => (paired ? ensureOperatorListening() : undefined))
        .catch((cause: unknown) => {
          console.error("[companion] failed to start", cause);
        });
    }
    await runtime.runPromise(mail.boot({
      runPromise: effect => runtime.runPromise(effect),
      runFork: effect => { runtime.runFork(effect); },
    }));
    // The seats this machine runs keep their sessions here: an agent's own
    // offboard is closed, and the cut runs, with no window.
    sessions = await startSeatSessions({
      run: effect => runtime.runPromise(effect),
      onSuspend: listener => { coreMail.seats.onSuspend(listener); },
      // A window hears where each offboard stands, and when the auto mode's due seats change.
      publish: (progress) => publish(IPC_CHANNELS.seatOffboardProgress, progress),
      publishDue: () => publish(SEAT_CACHE_DUE_CHANGED, null),
    });
    bindCoreSeatSessions(sessions);
    // A seat's declared signals (blocked, escalate, feedback) ride its own
    // snapshot, as in the window, so a seat waiting on the operator is
    // exempt from the cut here too.
    stopSeatReports = wireSeatReports({
      sessions: () => termPlane.host.list(),
      session: (bindingId) => termPlane.host.get(bindingId),
      seatReported: (bindingId, report) => seatStateRuntime.seatReported(bindingId, report),
      subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
      onSignalChanged: onAgentSignalChanged,
      signalsOf: (canvasName, nodeId) =>
        runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.listSeat({ canvasName, nodeId }))),
    });
    let seatsSuspended = false;
    coreMail.seats.onSuspend(() => { seatsSuspended = true; });
    const stopResumeRecovery = watchClaudeResumeRecovery({
      suspended: () => seatsSuspended,
      subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
      subscribeSessions: (listener) => termPlane.host.subscribeEvents(listener, { replayCurrentSessions: true }),
      harnessOf: (bindingId) => seatStateRuntime.machine.getSlot(bindingId)?.harness,
      session: (bindingId) => termPlane.host.get(bindingId),
      screen: (bindingId) => terminalObserverPlane.snapshot(bindingId),
      submitRecoveryCr: (bindingId) => coreMail.seats.drive.submitRecoveryCr(bindingId),
    });
    // A seat nobody has mailed is otherwise first looked at mid-turn, where a
    // first look never says ready.
    const stopReadiness = watchSeatReadiness({
      subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
      mailReady: coreMail.seats.mailReadyNow,
    });
    // A seat on a linked machine asked the cache question on a view here, or
    // its question was settled: the window's list reads again, as it does when
    // one of this machine's own asks (seat-views.ts `questionsChanged`).
    const stopSeatViewQuestionPushes = onSeatViewQuestions(() => publish(SEAT_CACHE_DUE_CHANGED, null));
    stopSeatWatches = () => {
      stopResumeRecovery();
      stopReadiness();
      stopSeatViewQuestionPushes();
    };
    admitted = true;
    return { runtime, close, overseer, overseerLive, ensureOperatorListening, ready: () => admitted && !stopping && ownerReady() && listener!.ready() };
  } catch (cause) {
    // The start failure is the reason worth keeping; a stop that also fails is logged beside it.
    await close().catch((closeCause: unknown) => {
      console.error("[core] Junto core could not stop after a failed start", closeCause);
    });
    throw cause;
  }
};
