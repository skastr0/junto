import { randomUUID } from "node:crypto";
import { Cause, Effect, Option, Schema } from "effect";
import {
  agentSeatStatusOf, encodeAgentSeatStatus, type AgentSeatStateEvent, type AgentSeatStatusWire,
} from "@shared/agent-seat-state";
import type { BindingId } from "@shared/harness-domain";
import { CanvasName, NodeId, type NodeOf } from "@shared/model";
import type { TerminalSessionSummary } from "@shared/terminal";
import { MachineName } from "@shared/machine-control";
import { isThisMachine } from "@shared/machine-name";
import type { LinkChannelContext, LinkChannelHandler, LinkEventContext } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { ActorSeatOccupy } from "./actor-seat-occupy";
import { ensureSeatSessionId } from "./seat-session-before-start";
import { makeManagedSpawnIntent } from "./managed-spawn-plan";
import { termPlane } from "./plane";
import { runOnSeatStartTurn } from "./seat-start-turn";
import {
  ATTACH_LIMIT, makeSeatAttachments, SeatsAttach, SeatsAttachEvent, SeatsAttachRequest, SeatsAttachResponse,
  SeatsDetach, SeatsHold, SeatsInput, SeatsResize, type SeatsStreamFrame,
} from "./seat-attach";
import { addOperatorHoldSource, type OperatorHoldSource } from "./operator-holds";
import { readLocalWindow, type SeatGrid, SeatsRead, SeatsReadWindow } from "./seat-read-window";
import { deliverSeatViewFrame } from "./seat-views";
import {
  asSeatsFailure, clipText, type SeatsFailureWhere, SeatAttachLimit, SeatAttachObserveOnly, SeatAttachRefused,
  SeatAttachUnknown, SeatCanvasEditorMismatch, SeatChangedWhilePreparing, SeatEpochChanged, SeatExited,
  SeatLinkClosed, SeatMissing, SeatNotOnThisMachine, SeatOccupantChanged, SeatPeerNotPinned,
  SeatSessionUnavailable, SeatsFailure, SeatSpawnFailed, SeatStateNotFromItsMachine, SeatStatusInvalid, SeatStopping,
  SeatStopRefused,
} from "./seats-failure";
import {
  decodeSeatsLaunch, fromSeatsLaunch, SeatsLaunchState, toSeatsLaunch, type RemoteSeatLaunch, type SeatLaunchState,
} from "./seats-launch";
import { seatLaunchState } from "./seat-launch-state";
import { seatOffboardFactsOf, type SeatOffboardFacts } from "../seat-sessions/operator-offboard";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { decodeSeatsStatus, fromSeatsStatus, statusIssueAt, toSeatsStatus } from "./seats-status";
import { forgetRemoteSeatLaunches, openedRemoteSeatLaunches, rememberRemoteSeatLaunch } from "./remote-seat-launch";
import { seatStateRuntime } from "./agent-state/runtime";
import { publishRemoteSeatState } from "./remote-seat-state";
import type { LocalSessionHost } from "./local-host";

const Generation = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

export const SeatsStart = Schema.Struct({
  _tag: Schema.Literal("Start"), canvas: CanvasName, seatId: NodeId,
});
export const SeatsGet = Schema.Struct({
  _tag: Schema.Literal("Get"), canvas: CanvasName, seatId: NodeId,
});
export const SeatsActivate = Schema.Struct({
  _tag: Schema.Literal("Activate"), canvas: CanvasName, seatId: NodeId,
  generation: Generation,
});
/** Stop the seat's occupant; with a generation, only that one. */
export const SeatsStop = Schema.Struct({
  _tag: Schema.Literal("Stop"), canvas: CanvasName, seatId: NodeId,
  generation: Schema.optionalKey(Generation),
});
/** The operator viewed the seat's occupant: its finished turn is no longer unseen. */
export const SeatsViewed = Schema.Struct({
  _tag: Schema.Literal("Viewed"), canvas: CanvasName, seatId: NodeId,
  generation: Generation,
});
export const SeatsRequest = Schema.Union([SeatsStart, SeatsGet, SeatsActivate, SeatsStop, SeatsViewed, SeatsRead,
  SeatsAttach, SeatsInput, SeatsResize, SeatsDetach, SeatsHold]);
export const SeatsStarted = Schema.Struct({
  _tag: Schema.Literal("Started"), canvas: CanvasName, seatId: NodeId,
  machine: MachineName, handle: Generation, generation: Generation,
  createdAt: Schema.Number,
  status: Schema.Literals(["starting", "running"]),
});
export const SeatsVacant = Schema.Struct({
  _tag: Schema.Literal("Vacant"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  /** Get only: what the seat's next start and turn do, decided here (seats-launch.ts). */
  launch: Schema.optionalKey(SeatsLaunchState),
});
export const SeatsStopping = Schema.Struct({
  _tag: Schema.Literal("Stopping"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation,
});
/** A view landed on that generation; changed when it cleared anything. */
export const SeatsSeen = Schema.Struct({
  _tag: Schema.Literal("Seen"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation, changed: Schema.Boolean,
});
/** What a seat request (start, get, activate, stop, view) answers. */
export const SeatsSeatResponse = Schema.Union([SeatsStarted, SeatsVacant, SeatsStopping, SeatsSeen]);
export const SeatsResponse = Schema.Union([...SeatsSeatResponse.members, SeatsReadWindow, ...SeatsAttachResponse.members]);

/**
 * A seat's state, sent by the machine that runs it to the machine that edits
 * its canvas, so the seat's ring has a producer there. reason is a rule id or
 * the state's own word: free text (a hook's words, an error) stays home.
 */
export const SeatsStateEvent = Schema.Struct({
  _tag: Schema.Literal("SeatState"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  epoch: Generation,
  state: Schema.Literals(["idle", "working", "attention", "unknown", "gone"]),
  confidence: Schema.Literals(["high", "low"]),
  at: Schema.Number,
  reason: Schema.String.pipe(Schema.check(Schema.isPattern(/^(rule:[A-Za-z0-9_.:-]{1,128}|idle|working|attention|unknown|gone)$/))),
  /**
   * The seat's status (seats-status.ts). Read on arrival with its own closed
   * schema, so a status that does not read refuses its event, not the link.
   */
  status: Schema.optionalKey(Schema.Unknown),
  /** What the seat's next start and turn do (seats-launch.ts), read on arrival the same way. */
  launch: Schema.optionalKey(Schema.Unknown),
});
export type SeatsStateEvent = typeof SeatsStateEvent.Type;
export const SeatsEvent = Schema.Union([SeatsStateEvent, ...SeatsAttachEvent.members]);
const RULE_REASON = /^rule:[A-Za-z0-9_.:-]{1,128}$/;

type Handle = {
  readonly peer: LinkChannelContext["peer"];
  readonly sessionId: string;
  readonly canvas: string;
  readonly seatId: string;
  readonly bindingId: string;
  readonly generation: string;
  readonly signal: AbortSignal;
};

export type SeatsChannelOptions = {
  readonly host?: Pick<LocalSessionHost, "get" | "kill" | "attach" | "write" | "resize" | "release" | "subscribeEvents">;
  /**
   * Where an attached seat's stream lands on the editing machine: display
   * only, never seat state, a log or disk. Dropped when nothing takes it.
   */
  readonly attachStream?: (context: LinkEventContext, frame: SeatsStreamFrame) => void;
  /** This machine's seat states; the live runtime by default. */
  readonly seatStates?: {
    readonly subscribe: (listener: (event: AgentSeatStateEvent) => void) => () => void;
    readonly currentEvents: () => ReadonlyArray<AgentSeatStateEvent>;
    /** The operator viewed the seat; returns null when nothing changed. */
    readonly viewed?: (bindingId: string) => unknown;
  };
  /** Where a remote seat's state goes on arrival; the window by default. */
  readonly publishState?: (event: AgentSeatStateEvent) => void;
  /** Where what peers hold on this machine's seats is added; the live operator holds by default. */
  readonly addHoldSource?: (source: OperatorHoldSource) => () => void;
  /** The clock a peer's typing is received on. */
  readonly now?: () => number;
  readonly pin?: typeof ensureSeatSessionId;
  /** The seat's settled grid for a Read; this process's observer by default. */
  readonly grid?: SeatGrid;
  /** What one of this machine's seats answers about its next start; modelSeatLaunchState's own by default. */
  readonly launchState?: (canvas: string, seat: NodeOf<"agent">) => Promise<SeatLaunchState | undefined>;
  /** The seat's session as this machine's offboard clock reads it; it crosses with the launch state. */
  readonly offboardFacts?: (canvas: string, seat: NodeOf<"agent">) => Promise<SeatOffboardFacts | undefined>;
};

/** The peer names a seat; its own machine derives the whole launch. */
export const makeSeatsChannel = Effect.fn("SeatsLink.make")(function* (options: SeatsChannelOptions = {}) {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const occupants = yield* ActorSeatOccupy;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const host = options.host ?? termPlane.host;
  const pin = options.pin ?? ensureSeatSessionId;
  const seatStates = options.seatStates ?? seatStateRuntime;
  const publishState = options.publishState ?? publishRemoteSeatState;
  // Read in this runtime, never through the window's: the core bundle must not reach Electron.
  const sessions = yield* Effect.serviceOption(SeatSessionRepository);
  const launchState = options.launchState ?? (Option.isNone(sessions) ? async () => undefined
    : (canvas: string, seat: NodeOf<"agent">) =>
      run(seatLaunchState(canvas, seat).pipe(Effect.provideService(SeatSessionRepository, sessions.value))));
  const offboardFacts = options.offboardFacts ??
    ((canvas: string, seat: NodeOf<"agent">) => seatOffboardFactsOf({ canvasName: canvas, seatId: seat.id }));
  /** The launch state as it crosses now, or undefined when this machine cannot say. */
  const launchWire = (canvas: string, seat: NodeOf<"agent">) => Effect.promise(async () => {
    try {
      const [launch, offboard] = await Promise.all([
        launchState(canvas, seat),
        offboardFacts(canvas, seat).catch(() => undefined),
      ]);
      return launch === undefined ? undefined : toSeatsLaunch(launch, Date.now(), offboard);
    } catch {
      return undefined;
    }
  });
  const stateSubscriptions = new Map<AbortSignal, () => void>();
  const attachments = makeSeatAttachments({ host, run, ...(options.now === undefined ? {} : { now: options.now }) });
  // A peer's view held by its operator holds the seat's session here, where it is cut.
  (options.addHoldSource ?? addOperatorHoldSource)((bindingId, now) => attachments.heldBy(bindingId, now));
  const handles = new Map<string, Handle>();
  const watched = new WeakSet<AbortSignal>();
  const forget = (context: LinkEventContext): void => {
    for (const [id, handle] of handles)
      if (handle.sessionId === context.sessionId && handle.peer.installationId === context.peer.installationId)
        handles.delete(id);
  };
  const disconnected = (context: LinkEventContext, where: SeatsFailureWhere) =>
    context.signal.aborted ? Effect.fail(new SeatLinkClosed({ ...where, message: "This machine link has closed." })) : Effect.void;

  const reply = (context: LinkChannelContext, canvas: CanvasName, seat: NodeOf<"agent">,
    machine: string, live: TerminalSessionSummary) => Effect.gen(function* () {
    const where = { machine, canvas, seatId: seat.id };
    const current = host.get(seat.bindingId);
    // The first cause wins: a harness that never started answers why, whatever came after.
    const ended = current?.epoch === live.epoch ? current : live;
    if (ended.status === "exited" && ended.exitReason !== undefined) {
      const exitMessage = clipText(ended.exitMessage ?? `The seat's harness could not start (${ended.exitReason}).`);
      return yield* new SeatSpawnFailed({ ...where, bindingId: seat.bindingId, harness: seat.harness,
        epoch: ended.epoch, exitReason: ended.exitReason, exitMessage, message: exitMessage });
    }
    if (current === undefined || current.status === "missing")
      return yield* new SeatMissing({ ...where, message: "The seat's occupant is gone; its state on this machine is unknown." });
    if (current.epoch !== live.epoch)
      return yield* new SeatEpochChanged({ ...where, expectedEpoch: live.epoch, actualEpoch: current.epoch,
        message: "Another occupant took the seat before its start was acknowledged." });
    if (current.status === "exited")
      return yield* new SeatExited({ ...where, bindingId: seat.bindingId, epoch: current.epoch,
        message: "The seat's harness exited during start; its terminal shows what it printed." });
    if (current.stopping === true)
      return yield* new SeatStopping({ ...where, epoch: current.epoch,
        message: "The seat's occupant is stopping and cannot be acknowledged as started." });
    if (current.canvasName !== canvas || current.nodeId !== seat.id ||
      current.harness !== seat.harness || current.agentKey !== seat.agentKey)
      return yield* new SeatOccupantChanged({ ...where, epoch: current.epoch,
        message: "The seat's occupant is another actor than this seat names." });
    let id: string | undefined;
    for (const [key, handle] of handles) {
      if (handle.canvas !== canvas || handle.seatId !== seat.id) continue;
      if (handle.signal.aborted || handle.bindingId !== seat.bindingId || handle.generation !== live.epoch)
        handles.delete(key);
      else if (handle.peer.installationId === context.peer.installationId && handle.peer.machineName === context.peer.machineName &&
        handle.sessionId === context.sessionId) id = key;
    }
    if (!id) {
      id = randomUUID();
      handles.set(id, { peer: context.peer, sessionId: context.sessionId, signal: context.signal,
        canvas, seatId: seat.id, bindingId: seat.bindingId, generation: live.epoch });
    }
    if (!watched.has(context.signal)) {
      watched.add(context.signal);
      context.signal.addEventListener("abort", () => forget(context), { once: true });
    }
    return yield* Schema.decodeUnknownEffect(SeatsStarted)({ _tag: "Started", canvas,
      seatId: seat.id, machine, handle: id, generation: live.epoch, createdAt: current.createdAt,
      status: current.status }, { onExcessProperty: "error" });
  });

  /** The peer is pinned, edits the seat's canvas, and the seat runs here: every seat request, every frame. */
  const admitSeat = Effect.fn("SeatsLink.admit")(function* (context: LinkEventContext, where: SeatsFailureWhere) {
    yield* disconnected(context, where);
    const peer = yield* machines.peer(context.peer.machineName);
    if (peer?.installationId !== context.peer.installationId)
      return yield* new SeatPeerNotPinned({ ...where, peer: context.peer.machineName,
        message: "The sending machine is no longer pinned." });
    if ((yield* records.canvasEditor(where.canvas)) !== context.peer.installationId)
      return yield* new SeatCanvasEditorMismatch({ ...where, peer: context.peer.machineName,
        message: "Only the machine editing this canvas may start its seats." });
    const canvas = yield* model.canvas(where.canvas);
    const seat = canvas.nodes.get(where.seatId);
    if (seat?.kind !== "agent" || !isThisMachine(seat.host, where.machine))
      return yield* new SeatNotOnThisMachine({ ...where,
        ...(seat?.kind === "agent" ? { seatHost: seat.host } : {}),
        message: "This machine does not run that seat." });
    yield* disconnected(context, where);
    return { seat, seq: canvas.seq, name: where.machine };
  });

  /**
   * Attach, Input, Resize, Hold and Detach. Terminal bytes never enter a failure
   * or a log row here: Input and Hold are counted at debug, never their data.
   */
  const answerAttach = Effect.fn("SeatsLink.attach")(function* (context: LinkChannelContext,
    request: typeof SeatsAttachRequest.Type, machine: string) {
    if (request._tag === "Attach") {
      const where = { machine, canvas: request.canvas, seatId: request.seatId };
      const admitted = yield* admitSeat(context, where);
      if (attachments.count(context) >= ATTACH_LIMIT)
        return yield* new SeatAttachLimit({ ...where, limit: ATTACH_LIMIT,
          message: `This machine already holds ${ATTACH_LIMIT} views for that machine.` });
      const opened = yield* Effect.promise(() => attachments.open(context,
        { canvas: request.canvas, seatId: request.seatId, machine, bindingId: admitted.seat.bindingId }, request));
      if (!opened.ok)
        return yield* (opened.epoch !== undefined
          ? new SeatEpochChanged({ ...where, expectedEpoch: request.generation, actualEpoch: opened.epoch, message: opened.message })
          : new SeatAttachRefused({ ...where, message: clipText(opened.message) }));
      yield* Effect.logInfo("seat attach opened").pipe(Effect.annotateLogs({ mode: request.mode }));
      return { _tag: "Attached" as const, canvas: request.canvas, seatId: request.seatId, machine,
        generation: opened.attachment.generation, handle: opened.attachment.handle, mode: request.mode,
        cols: opened.cols, rows: opened.rows, status: opened.status };
    }
    const attachment = attachments.held(context, request.handle);
    if (attachment === undefined)
      return yield* new SeatAttachUnknown({ machine, message: "This machine holds no such view for that link." });
    if (request._tag === "Detach") {
      attachments.end(attachment, "released", false);
      return { _tag: "Detached" as const, handle: request.handle };
    }
    const where = { machine, canvas: attachment.canvas, seatId: attachment.seatId };
    // An observing view may be shown, but nothing is typed into it.
    if (attachment.mode === "observe" && (request._tag !== "Hold" || request.typed))
      return yield* new SeatAttachObserveOnly({ ...where, message: "An observing view cannot type into or resize the seat." });
    // Participation is checked on every frame; a view that lost it ends at once.
    yield* admitSeat(context, where).pipe(Effect.tapError(() => Effect.sync(() => attachments.end(attachment, "admission-lost"))));
    if (request._tag === "Hold") {
      yield* Effect.logDebug("seat attach hold");
      return { _tag: "Held" as const, handle: request.handle, accepted: attachments.hold(attachment, request.open, request.typed) };
    }
    if (request._tag === "Input") {
      yield* Effect.logDebug("seat attach input");
      return { _tag: "Written" as const, handle: request.handle, accepted: attachments.write(attachment, request.data) };
    }
    return { _tag: "Resized" as const, handle: request.handle,
      accepted: attachments.resize(attachment, request.cols, request.rows) };
  });

  // A canvas that changed or left this machine re-admits every live view of its peers.
  const recheckViews = () => {
    for (const attachment of attachments.list())
      void run(admitSeat(attachment.context, { machine: attachment.machine, canvas: attachment.canvas, seatId: attachment.seatId })
        .pipe(Effect.matchEffect({
          onFailure: () => Effect.sync(() => attachments.end(attachment, "admission-lost")),
          onSuccess: (admitted) => Effect.sync(() => {
            if (admitted.seat.bindingId !== attachment.bindingId) attachments.end(attachment, "admission-lost");
          }),
        })));
  };
  model.subscribeChanges(recheckViews);
  model.subscribeCanvasesChanges(recheckViews);

  const answer = Effect.fn("SeatsLink.request")(function* (context: LinkChannelContext,
    request: Exclude<typeof SeatsRequest.Type, typeof SeatsAttachRequest.Type>, machine: string, trace: { occupied: boolean } = { occupied: false }) {
    const where = { machine, canvas: request.canvas, seatId: request.seatId };
    const admit = () => admitSeat(context, where);
    const initial = yield* admit();
    if (request._tag === "Viewed") {
      const live = host.get(initial.seat.bindingId);
      if (live === undefined || live.status === "exited" || live.status === "missing")
        return { _tag: "Vacant", canvas: request.canvas, seatId: request.seatId, machine: initial.name };
      if (request.generation !== live.epoch)
        return yield* new SeatEpochChanged({ ...where, expectedEpoch: request.generation, actualEpoch: live.epoch,
          message: "The seat's occupant changed before the view reached it." });
      const changed = (seatStates.viewed?.(initial.seat.bindingId) ?? null) !== null;
      return { _tag: "Seen", canvas: request.canvas, seatId: request.seatId, machine: initial.name,
        generation: live.epoch, changed };
    }
    if (request._tag === "Read") {
      const window = yield* readLocalWindow(where, initial.seat.bindingId, host.get(initial.seat.bindingId),
        request.lines, options.grid);
      if (window === undefined) return { _tag: "Vacant", canvas: request.canvas, seatId: request.seatId, machine: initial.name };
      // The count only: the text goes to the peer and never into a log row.
      yield* Effect.logInfo("seat read").pipe(Effect.annotateLogs({ lines: window.lines }));
      return { ...window, machine: initial.name };
    }
    if (request._tag === "Stop") {
      const live = host.get(initial.seat.bindingId);
      if (live === undefined || live.status === "exited" || live.status === "missing")
        return { _tag: "Vacant", canvas: request.canvas, seatId: request.seatId, machine: initial.name };
      if (request.generation !== undefined && request.generation !== live.epoch)
        return yield* new SeatEpochChanged({ ...where, expectedEpoch: request.generation, actualEpoch: live.epoch,
          message: "The seat's occupant changed before it was asked to stop." });
      if (!host.kill(initial.seat.bindingId))
        return yield* new SeatStopRefused({ ...where, epoch: live.epoch,
          message: "This machine refused to stop the seat's occupant; it may be shutting down." });
      return { _tag: "Stopping", canvas: request.canvas, seatId: request.seatId, machine: initial.name,
        generation: live.epoch };
    }
    if (request._tag !== "Start") {
      const live = host.get(initial.seat.bindingId);
      if (live === undefined || live.status === "exited" || live.status === "missing") {
        if (request._tag === "Activate")
          return yield* new SeatMissing({ ...where, message: "This seat is vacant; activation cannot start a new occupant." });
        const launch = yield* launchWire(request.canvas, initial.seat);
        return { _tag: "Vacant", canvas: request.canvas, seatId: request.seatId, machine: initial.name,
          ...(launch === undefined ? {} : { launch }) };
      }
      if (request._tag === "Activate" && request.generation !== live.epoch)
        return yield* new SeatEpochChanged({ ...where, expectedEpoch: request.generation, actualEpoch: live.epoch,
          message: "The seat's occupant generation changed before activation." });
      return yield* reply(context, request.canvas, initial.seat, initial.name, live);
    }
    const beforeSpawn = Effect.gen(function* () {
      const current = yield* admit();
      if (current.seq !== initial.seq || current.seat.bindingId !== initial.seat.bindingId ||
        current.seat.harness !== initial.seat.harness || current.seat.agentKey !== initial.seat.agentKey)
        return yield* new SeatChangedWhilePreparing({ ...where, message: "The seat changed while its start was being prepared." });
    });
    const prepared = yield* Effect.tryPromise({
      try: () => pin({ canvasName: request.canvas, nodeId: initial.seat.id,
        bindingId: initial.seat.bindingId, harness: initial.seat.harness,
        documentLaunch: initial.seat.launch, cause: "operator",
        ...(initial.seat.launch?.cwd ? { cwd: initial.seat.launch.cwd } : {}) }),
      catch: (cause) => asSeatsFailure(where, cause),
    });
    if (!prepared.ok)
      return yield* new SeatSessionUnavailable({ ...where, reason: clipText(prepared.reason),
        message: clipText(`This seat could not start: ${prepared.reason}`) });
    yield* beforeSpawn;
    const start = occupants.occupy({
      canvasName: request.canvas, nodeId: initial.seat.id, bindingId: initial.seat.bindingId,
      hostId: initial.name, harness: initial.seat.harness, agentKey: initial.seat.agentKey,
      label: initial.seat.label, beforeSpawn,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
      spawnIntent: makeManagedSpawnIntent({ nodeId: initial.seat.id, harness: initial.seat.harness,
        agentKey: initial.seat.agentKey, documentLaunch: initial.seat.launch,
        cwd: initial.seat.launch?.cwd, sessionId: prepared.sessionId || undefined, resume: !prepared.minted }),
    });
    // From here occupy logs the start's outcome under its operation id.
    trace.occupied = true;
    const live = yield* Effect.tryPromise({
      try: () => runOnSeatStartTurn(() => run(start)),
      catch: (cause) => asSeatsFailure(where, cause),
    });
    yield* beforeSpawn;
    return yield* reply(context, request.canvas, initial.seat, initial.name, live);
  });

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode unknown here too: direct callers cannot bypass the transport decoder.
    const request = yield* Schema.decodeUnknownEffect(SeatsRequest)(raw, { onExcessProperty: "error" });
    // A failed read of this machine's own name keeps its own typed error.
    const machine = yield* machines.machineName;
    if (request._tag === "Attach" || request._tag === "Input" || request._tag === "Resize" || request._tag === "Detach"
      || request._tag === "Hold")
      return yield* answerAttach(context, request, machine).pipe(
        Effect.tapCause((cause) => request._tag === "Input" || request._tag === "Resize" || request._tag === "Hold" ? Effect.void
          : Effect.logWarning(`seat attach ${request._tag === "Attach" ? "refused" : "detach failed"}`, cause)),
        Effect.annotateLogs({ area: "seats", request: request._tag, peer: context.peer.machineName,
          ...(request._tag === "Attach" ? { seat: request.seatId, canvas: request.canvas } : {}),
          ...(context.operationId === undefined ? {} : { operationId: context.operationId }) }),
      );
    const where = { machine, canvas: request.canvas, seatId: request.seatId };
    const kind = request._tag === "Start" ? "start" : request._tag === "Stop" ? "stop"
      : request._tag === "Viewed" ? "view" : request._tag === "Read" ? "read" : "activation";
    // Every start, activation and stop is logged on this machine with its outcome.
    const trace = { occupied: false };
    const answered = answer(context, request, machine, trace).pipe(
      Effect.mapError((cause) => asSeatsFailure(where, cause)));
    // A start that reached occupy is logged there once; one refused before it is logged here.
    const logged = request._tag === "Start";
    // A read logs "seat read" itself, with its line count.
    return yield* (request._tag === "Get" ? answered : request._tag === "Read" ? answered.pipe(
      Effect.tapCause((cause) => Effect.logWarning("seat read failed", cause))) : answered.pipe(
      Effect.tap(() => logged && trace.occupied ? Effect.void : Effect.logInfo(`seat ${kind} answered`)),
      Effect.tapCause((cause) => logged && trace.occupied ? Effect.void : Effect.logError(`seat ${kind} failed`, cause)),
    )).pipe(
      Effect.annotateLogs({ area: "seats", seat: request.seatId, canvas: request.canvas, request: request._tag,
        peer: context.peer.machineName,
        ...(context.operationId === undefined ? {} : { operationId: context.operationId }) }),
    );
  });
  /** Send one of this machine's seat states to the peer, when the peer edits that seat's canvas. */
  const forwardState = Effect.fn("SeatsLink.forwardState")(function* (context: LinkEventContext, event: AgentSeatStateEvent) {
    if (context.signal.aborted) return;
    const machine = yield* machines.machineName;
    let sent = false;
    for (const name of yield* model.listCanvases()) {
      if ((yield* records.canvasEditor(name)) !== context.peer.installationId) continue;
      for (const node of (yield* model.canvas(name)).nodes.values()) {
        if (node.kind !== "agent" || node.bindingId !== event.bindingId || !isThisMachine(node.host, machine)) continue;
        const local = agentSeatStatusOf(event);
        const status = local === undefined ? undefined : toSeatsStatus(local, Date.now());
        // An exit carries none: the seat's next start is answered once it has no occupant (Get).
        const launch = event.state === "gone" ? undefined : yield* launchWire(name, node);
        const wire = yield* Schema.encodeUnknownEffect(SeatsStateEvent)({
          _tag: "SeatState", canvas: name, seatId: node.id, machine, epoch: event.epoch, state: event.state,
          confidence: event.confidence, at: event.at, reason: RULE_REASON.test(event.reason) ? event.reason : event.state,
          ...(status === undefined ? {} : { status }),
          ...(launch === undefined ? {} : { launch }),
        });
        yield* context.sendEvent("seats", wire);
        sent = true;
        yield* Effect.logInfo("seat state sent").pipe(Effect.annotateLogs({
          seat: node.id, canvas: name, epoch: event.epoch, state: event.state }));
      }
    }
    if (!sent) yield* Effect.logDebug("seat state not for this peer").pipe(Effect.annotateLogs({
      binding: event.bindingId, epoch: event.epoch, state: event.state }));
  }, (effect, context) => effect.pipe(
    Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("seat state not sent", cause)),
    Effect.ignore,
    Effect.annotateLogs({ area: "seats", peer: context.peer.machineName }),
  ));

  const opened: NonNullable<LinkChannelHandler["opened"]> = (context) => Effect.sync(() => {
    if (stateSubscriptions.has(context.signal)) return;
    openedRemoteSeatLaunches(context.peer.machineName);
    const send = (event: AgentSeatStateEvent) => { void run(forwardState(context, event)); };
    const unsubscribe = seatStates.subscribe(send);
    stateSubscriptions.set(context.signal, unsubscribe);
    context.signal.addEventListener("abort", () => {
      stateSubscriptions.get(context.signal)?.();
      stateSubscriptions.delete(context.signal);
      forgetRemoteSeatLaunches(context.peer.machineName);
    }, { once: true });
    // A window that just opened its link reads every seat's state at once.
    for (const event of seatStates.currentEvents()) send(event);
  });

  /** A seat state from the machine that runs the seat: accepted only for that machine's own seat. */
  const handleEvent: NonNullable<LinkChannelHandler["handleEvent"]> = (context, payload) => Effect.gen(function* () {
    const received = yield* Schema.decodeUnknownEffect(SeatsEvent)(payload, { onExcessProperty: "error" });
    if (received._tag === "Ack") return attachments.ack(context, received.handle, BigInt(received.upTo));
    if (received._tag !== "SeatState") {
      // Display only: never seat state, a log row or disk. No view holding it: dropped.
      (options.attachStream ?? deliverSeatViewFrame)(context, received);
      return;
    }
    const event = received;
    const where = { machine: event.machine, canvas: event.canvas, seatId: event.seatId };
    // A state about a canvas this machine does not hold is not for it: dropped, never a failure.
    if (!(yield* model.listCanvases()).includes(event.canvas)) {
      yield* Effect.logInfo("seat state for a canvas not held here, dropped").pipe(Effect.annotateLogs({
        area: "seats", canvas: event.canvas, seat: event.seatId, peer: context.peer.machineName }));
      return;
    }
    const seat = (yield* model.canvas(event.canvas)).nodes.get(event.seatId);
    // Refused and logged, never a handler failure: that would close the whole link.
    if (event.machine !== context.peer.machineName || seat?.kind !== "agent" || !isThisMachine(seat.host, event.machine)) {
      const refused = new SeatStateNotFromItsMachine({ ...where, peer: context.peer.machineName,
        message: "A seat's state came from a machine that does not run that seat." });
      yield* Effect.logWarning("seat state refused", refused).pipe(Effect.annotateLogs({
        area: "seats", canvas: event.canvas, seat: event.seatId, peer: context.peer.machineName, failure: refused._tag }));
      return;
    }
    const receivedAt = Date.now();
    let status: AgentSeatStatusWire | undefined;
    let launch: RemoteSeatLaunch | undefined;
    let reading = "status";
    try {
      if (event.status !== undefined)
        status = encodeAgentSeatStatus(fromSeatsStatus(decodeSeatsStatus(event.status), seat.bindingId as BindingId, receivedAt));
      reading = "launch";
      if (event.launch !== undefined) launch = fromSeatsLaunch(decodeSeatsLaunch(event.launch), receivedAt);
    } catch (cause) {
      // One event refused, logged with its tag; the link stays open.
      const refused = new SeatStatusInvalid({ ...where, peer: context.peer.machineName,
        message: `A seat state's ${reading} did not read: ${statusIssueAt(cause)}.` });
      yield* Effect.logWarning("seat state refused", refused).pipe(Effect.annotateLogs({
        area: "seats", canvas: event.canvas, seat: event.seatId, peer: context.peer.machineName, failure: refused._tag }));
      return;
    }
    // Before the window hears of the state, so a card asking again reads this answer.
    rememberRemoteSeatLaunch({ bindingId: seat.bindingId, machine: event.machine, epoch: event.epoch,
      gone: event.state === "gone", ...(launch === undefined ? {} : { launch }) });
    publishState({ bindingId: seat.bindingId, epoch: event.epoch, state: event.state, reason: event.reason,
      confidence: event.confidence, at: event.at, harness: seat.harness, ...(status === undefined ? {} : { status }) });
    yield* Effect.logInfo("seat state received").pipe(Effect.annotateLogs({
      area: "seats", canvas: event.canvas, seat: event.seatId, peer: context.peer.machineName,
      epoch: event.epoch, state: event.state }));
  }).pipe(Effect.withSpan("SeatsLink.state"));

  return {
    failureSchema: SeatsFailure as Schema.Codec<unknown, unknown>,
    decodeRequest: Schema.decodeUnknownSync(SeatsRequest, { onExcessProperty: "error" }),
    decodeResponse: Schema.decodeUnknownSync(SeatsResponse, { onExcessProperty: "error" }),
    decodeEvent: Schema.decodeUnknownSync(SeatsEvent, { onExcessProperty: "error" }),
    handleRequest,
    handleEvent,
    opened,
    closed: (context) => Effect.sync(() => {
      forget(context);
      attachments.closeSession(context);
      stateSubscriptions.get(context.signal)?.();
      stateSubscriptions.delete(context.signal);
    }),
  } satisfies LinkChannelHandler;
});
