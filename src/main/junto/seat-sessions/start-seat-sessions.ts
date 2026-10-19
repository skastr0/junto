/**
 * Seat sessions on this machine, with a window or without: the reseat
 * recorder, post-spawn session capture, the drain, the offboard closer with
 * its continuation ledger, and operator offboard (the cut and its clock).
 *
 * A seat lives on one machine, which keeps its sessions. So the window and
 * the windowless core both start this, each over the runtime it owns; what
 * only a window has (showing progress to its renderers) comes in as a port.
 * Without it, an agent's `junto offboard` on a windowless machine saved its
 * notes and nothing ended the session, and no cut ever ran there.
 */
import { homedir } from "node:os";
import { Effect } from "effect";
import { asNodeId } from "@shared/model";
import type { SeatAddress, SeatOffboardProgress } from "@shared/seat-sessions";
import { ModelService } from "../model/service";
import { closingFence } from "../term/closing-fence";
import { injectionSupervisor } from "../term/injection-supervisor";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { termPlane } from "../term/plane";
import { SeatSessionCapture, discoversSessionAfterSpawn } from "../term/seat-session-capture";
import { setSeatSessionLookup } from "../work/control";
import { appendSeatPrompt } from "../work/seat-prompt";
import { ContinuationLedger, continuationStoreIn, rotateOwing } from "./continuation-pending";
import { composeSeatDrain, type SeatDrain } from "./drain-seat";
import { SeatOffboardCloser } from "./offboard-close";
import { startOperatorOffboard, type OperatorOffboardLiveInput } from "./operator-offboard-live";
import { SeatSessionRepository } from "./repository";
import { offboardAndRotate, stopSeatProcess } from "./rotate";
import type { SeatSessionRun } from "./run";
import { noteReportedSession, startSeatSessionRecorder, subscribeSeatOffboard } from "./service";

export type ManagedSeat = {
  readonly bindingId: string;
  readonly local: boolean;
  readonly sessionId?: string;
};

/** The seat at this address, its binding and the session it names now. */
export const managedSeatOn =
  (run: SeatSessionRun) =>
  ({ canvasName, seatId }: SeatAddress): Promise<ManagedSeat | undefined> =>
    run(
      Effect.gen(function* () {
        const model = yield* ModelService;
        const read = yield* Effect.result(model.canvas(canvasName));
        if (read._tag === "Failure") return undefined;
        const node = read.success.nodes.get(asNodeId(seatId));
        if (node?.kind !== "agent") return undefined;
        const sessions = yield* SeatSessionRepository;
        const sessionId = (yield* sessions.current(node.id, node.bindingId))?.sessionId;
        return {
          bindingId: node.bindingId,
          local: termPlane.router.isLocalHostId(node.host),
          ...(sessionId ? { sessionId } : {}),
        };
      }),
    );

export type SeatSessionsInput = {
  readonly run: SeatSessionRun;
  /** Called once when product automation stops (quit, maintenance). */
  readonly onSuspend: (listener: () => void) => void;
  /** Prompt mail to a seat. By default Junto's own mail path in `run`. */
  readonly sendPrompt?: OperatorOffboardLiveInput["sendPrompt"];
  /** Where a seat's offboard stands, for whoever shows it. No window: no one. */
  readonly publish?: (progress: SeatOffboardProgress) => void;
  /** The seats due the auto mode's question, for whoever shows it. No window: no one. */
  readonly publishDue?: OperatorOffboardLiveInput["publishDue"];
};

export type SeatSessions = {
  readonly closer: SeatOffboardCloser;
  readonly drain: SeatDrain;
  readonly seatOn: (address: SeatAddress) => Promise<ManagedSeat | undefined>;
  readonly stop: () => void;
};

const log = (message: string): void => console.info(`[offboard] ${message}`);

export const startSeatSessions = async (input: SeatSessionsInput): Promise<SeatSessions> => {
  const { run } = input;
  const seatOn = managedSeatOn(run);
  let suspended = false;

  // Each session id a seat is given joins its history, so onboard can hand
  // the next session what came before and where it is.
  const stopRecorder = await run(startSeatSessionRecorder((effect) => void run(effect)));

  // Post-spawn session capture for harnesses that mint an id and never
  // print it (Muse, fx). Home is read lazily so a test seam can move it.
  const capture = new SeatSessionCapture(() => homedir());
  // junto offboard in the first turn of a fresh session: the id may be on
  // disk before the seat's next state boundary reads it. Look then.
  setSeatSessionLookup((bindingId) => capture.attempt(bindingId));

  // What a previous run still owed: a seat rotated on a paused canvas
  // that had not started when Junto quit.
  injectionSupervisor.setContinuationLog(log);
  const continuationLedger = new ContinuationLedger(injectionSupervisor, continuationStoreIn(run));
  const owedContinuations = await continuationLedger.restore();
  if (owedContinuations > 0) log(`${owedContinuations} seat(s) still owed their continuation line`);
  // Onboarding status follows the harness session: it is kept on the
  // session's row, so a resumed session reads it back and a fresh one starts
  // without it. A seat whose session id is not known yet cannot be recorded;
  // the supervisor asks again at the next completed turn.
  /**
   * The binding's current harness session. "unreadable": cannot be told yet
   * (the terminal is not bound to its seat, or the canvas cannot be read, as
   * right after a start). null: the seat is known and its session has no id.
   */
  const sessionOfBinding = async (
    bindingId: string,
  ): Promise<{ readonly seatId: string; readonly sessionId: string } | null | "unreadable"> => {
    const live = termPlane.host.get(bindingId);
    if (!live?.canvasName || !live.nodeId) return "unreadable";
    const seat = await seatOn({ canvasName: live.canvasName, seatId: live.nodeId });
    if (seat === undefined || seat.bindingId !== bindingId) return "unreadable";
    return seat.sessionId ? { seatId: live.nodeId, sessionId: seat.sessionId } : null;
  };
  injectionSupervisor.setOnboardedRecord({
    load: async (bindingId) => {
      const session = await sessionOfBinding(bindingId);
      if (session === "unreadable") return undefined;
      if (session === null) return false;
      return run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.onboarded(session.seatId, session.sessionId)));
    },
    save: async (bindingId) => {
      const session = await sessionOfBinding(bindingId);
      if (session === null || session === "unreadable") return false;
      await run(Effect.flatMap(SeatSessionRepository, (sessions) =>
        sessions.markOnboarded(session.seatId, session.sessionId, Date.now())));
      return true;
    },
  });
  // An offboarded session is not killed: its process is detached from
  // the seat and left to finish its turn, read but never written to, then
  // stopped when it settles (or at the cap). What a previous run left
  // winding down ended when that run did.
  void run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.closeOpenDrains(Date.now()))).then(
    (closed) => {
      if (closed > 0) log(`${closed} offboarded session(s) ended when Junto last quit`);
    },
    (error: unknown) => console.error("[offboard] could not close the last run's draining sessions:", error),
  );
  const drain = composeSeatDrain({
    host: termPlane.host,
    isIdle: (drainKey) => seatStateRuntime.isSeatIdle(drainKey),
    subscribeDrainState: (listener) => seatStateRuntime.subscribeDrain((event) => listener(event.bindingId)),
    stopSeat: stopSeatProcess,
    record: {
      begin: (seatId, sessionId, at) =>
        run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.beginDrain(seatId, sessionId, at))),
      end: (seatId, sessionId, how, at) =>
        run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.endDrain(seatId, sessionId, how, at))),
      cancel: (seatId, sessionId) =>
        run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.cancelDrain(seatId, sessionId))),
    },
    log,
  });
  const closer = new SeatOffboardCloser({
    close: async (address, wake) => {
      // Name the generation that offboarded before it is replaced: the
      // fresh one may be up by the time the rotation returns.
      const seat = wake ? await seatOn(address) : undefined;
      const rotate = () =>
        offboardAndRotate(address.seatId, run, { canvasName: address.canvasName, wake, detach: drain.detach });
      if (seat === undefined) return rotate();
      // Owed before the old process is touched: owed any later, the
      // fresh session can be typed into and nudged before its line.
      return rotateOwing({
        ledger: continuationLedger,
        seatId: address.seatId,
        bindingId: seat.bindingId,
        offboarded: injectionSupervisor.generationOf(seat.bindingId),
        rotate,
      });
    },
    // The line was owed when the close began (above); the supervisor
    // types it when the fresh session can take it, and the ledger keeps
    // what is owed across a restart. That is the only way in: a seat
    // started any other way opens to an empty composer and is told nothing.
    kickoff: async () => true,
    // The close failed before the process was stopped: the session goes
    // on, so it may be typed into again.
    release: (address) => {
      void seatOn(address).then((seat) => closingFence.release(seat?.bindingId));
    },
    // A close from outside the session (operator, overseer, a rule): the
    // same fence an agent's own offboard raises where it is answered.
    seal: async (address) => {
      const seat = await seatOn(address);
      if (seat === undefined) return;
      closingFence.seal(seat.bindingId);
      injectionSupervisor.noteOffboardSaved(seat.bindingId);
    },
    publish: input.publish ?? (() => {}),
    onOffboard: subscribeSeatOffboard,
    log,
  });
  closer.start();
  // Operator offboard: the buttons, the overseer command and the automatic
  // rules, all through the closer just started. It restores the motionless
  // clock from junto.db and looks once a minute.
  const stopOperatorOffboard = await startOperatorOffboard({
    run,
    closer,
    sendPrompt:
      input.sendPrompt ??
      (({ bindingId, text, canvasName, nodeId }) => appendSeatPrompt(run, { bindingId, text, canvasName, nodeId })),
    suspended: () => suspended,
    ...(input.publishDue ? { publishDue: input.publishDue } : {}),
  });

  const offHost = termPlane.host.subscribeEvents(
    (payload) => {
      if (payload.type !== "session" || payload.status !== "running") return;
      const bindingId = payload.bindingId;
      const harness = seatStateRuntime.machine.getSlot(bindingId)?.harness;
      if (!harness || !discoversSessionAfterSpawn(harness)) return;
      // Watch from the spawn itself: capture matches on workspace AND a
      // start time, so a seat cannot claim the session of the seat that
      // started just before it in the same directory.
      const live = termPlane.host.get(bindingId);
      capture.watch({
        bindingId,
        harness,
        canvasName: live?.canvasName ?? "",
        nodeId: live?.nodeId ?? "",
        cwd: live?.cwd ?? "",
        spawnedAtMs: Date.now(),
        // A session still winding down on this seat is never the fresh one's.
        excludeSessionIds: drain.drainingSessionIds(live?.nodeId ?? ""),
      });
    },
    { replayCurrentSessions: true },
  );
  const offState = seatStateRuntime.subscribe((event) => {
    // Muse and fx mint their session id without printing it, so the seat
    // watches for it on its own boundaries and stores it once. Without
    // that, a cold wake starts a NEW session instead of resuming this one.
    void capture.attempt(event.bindingId).then((sessionId: string | undefined) => {
      if (sessionId) console.info(`[term] captured session ${sessionId} for ${event.bindingId}`);
    });
    if (event.state === "gone") capture.forget(event.bindingId);
  });
  // A harness that names where its session lives supplies it under the
  // harness contract; the session's row keeps it when the contract admits it.
  const offReports = seatStateRuntime.machine.subscribeSessionReports((report) => {
    void run(noteReportedSession(report)).catch((error: unknown) =>
      console.error("[seat-sessions] could not keep a reported session location:", error));
  });

  input.onSuspend(() => {
    suspended = true;
    closer.stop();
    drain.quit();
  });

  return {
    closer,
    drain,
    seatOn,
    stop: () => {
      suspended = true;
      offHost();
      offState();
      offReports();
      stopOperatorOffboard();
      closer.stop();
      drain.dispose();
      stopRecorder();
    },
  };
};
