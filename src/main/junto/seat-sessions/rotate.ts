/**
 * Close a seat's session after it offboards, and start the next one or not.
 *
 * Called by the offboard closer the moment `junto offboard` has been
 * answered, mid-turn: the turn in flight is cut. The seat's current session ends as `offboard`, its node
 * gets a fresh session id (a new pin, or none for a harness that announces
 * its own), and the running process stops. With `wake` (the default) the
 * kernel starts the seat again under the usual rules: this installation's
 * seat only, on a playing canvas. Without it the seat rests, and whatever
 * wakes it next (mail) starts the fresh session. Nothing is sent to a fresh
 * session at spawn: it learns to run `junto onboard`, which hands it the
 * notes, from the mail that woke it or, after `--continue`, from the one
 * line the offboard closer has it told (see offboard-close.ts).
 *
 * Offboard notes are the agent's to write; rotating never writes them.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";

export type SeatRotateResult =
  | {
      readonly ok: true;
      /** The session that ended as offboard, when the seat named one. */
      readonly ended?: string;
      /** The fresh pinned id; absent when the harness announces its own. */
      readonly next?: string;
      /** False when the seat is left stopped: asked to rest, or its canvas is paused. */
      readonly woke: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** How long a stopped generation gets to exit before the seat is woken anyway. */
const EXIT_WAIT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The seat as rotation needs it, read off its canvas. */
export type RotatingSeat = {
  readonly canvasName: string;
  readonly bindingId: string;
  readonly harness: string;
  /** The session the node names now. */
  readonly sessionId?: string;
  /** This installation runs the seat. */
  readonly local: boolean;
};

/** The generation rotation took off the seat. */
export type DetachedGeneration = {
  /** Stop it now and wait for it to be gone (bounded). */
  readonly stopNow: () => Promise<void>;
};

/** What rotation touches, so the sequence is testable without the app. */
export type SeatRotatePorts = {
  readonly locate: (seatId: string, canvasName?: string) => Promise<RotatingSeat | undefined>;
  readonly endSession: (seatId: string, sessionId: string) => Promise<void>;
  readonly reopenSession: (seatId: string, sessionId: string, harness: string) => Promise<void>;
  /** Replace the node's session id (or clear it); false when the seat changed hands. */
  readonly writeSessionId: (seat: RotatingSeat, seatId: string, next: string | undefined) => Promise<boolean>;
  /**
   * Take the running generation off the seat, now. From the moment this
   * returns the seat is vacant: nothing addressed to it reaches the old
   * process, and its next generation may start. What becomes of the old
   * process is the port's to arrange (it is left to finish its turn and
   * stopped when it settles). The answer can stop it at once, for a rotation
   * that could not go through.
   */
  readonly detach: (
    seat: RotatingSeat,
    seatId: string,
    /** The session that is ending, when the seat named one. */
    endedSessionId: string | undefined,
  ) => Promise<DetachedGeneration>;
  /** Start the seat again under the kernel's wake rules. */
  readonly wake: (seat: RotatingSeat, seatId: string) => Promise<boolean>;
  readonly mintSessionId?: () => string;
};

/** The rotation sequence over its ports. */
export type SeatRotateOptions = {
  readonly canvasName?: string;
  /** Start the fresh session now (default), or leave the seat resting. */
  readonly wake?: boolean;
  /**
   * How the app takes the old generation off the seat and winds it down.
   * Without it the old process is simply stopped.
   */
  readonly detach?: SeatRotatePorts["detach"];
};

export const rotateSeatSession = async (
  seatId: string,
  ports: SeatRotatePorts,
  options: SeatRotateOptions = {},
): Promise<SeatRotateResult> => {
  const seat = await ports.locate(seatId, options.canvasName);
  if (seat === undefined) return { ok: false, reason: "no agent seat with that id is on a canvas" };
  if (!seat.local) return { ok: false, reason: "this seat runs on another installation" };
  if (!isHarnessId(seat.harness)) return { ok: false, reason: `unknown harness ${seat.harness}` };

  const ended = seat.sessionId;
  const next =
    templateFor(seat.harness).capabilityBadges.sessionId === "pin" ? (ports.mintSessionId ?? randomUUID)() : undefined;

  // The seat lets go of the old process first, before anything is awaited
  // on its behalf: from here the seat is the fresh session's.
  const old = await ports.detach(seat, seatId, ended);
  // End the session as offboard before the new id lands, so the canvas
  // recorder sees no open session to call replaced.
  if (ended) await ports.endSession(seatId, ended);
  const written = await ports.writeSessionId(seat, seatId, next).catch(() => false);
  if (!written) {
    // The seat still names the old session and nothing fresh can start on
    // it. A process left winding down beside a seat that would resume its
    // session is two owners of one session: stop it now. The session is the
    // seat's again in the history; its next wake resumes it.
    await old.stopNow().catch(() => undefined);
    if (ended) await ports.reopenSession(seatId, ended, seat.harness);
    return { ok: false, reason: "could not give the seat a fresh session on its canvas" };
  }
  const woke = options.wake === false ? false : await ports.wake(seat, seatId).catch(() => false);
  return { ok: true, ...(ended ? { ended } : {}), ...(next ? { next } : {}), woke };
};

/**
 * Stop the process on a seat and wait for it to be gone (bounded). Stopping
 * goes through the router, the same owned-session stop the operator's
 * terminal uses; rotation only ever reaches a local seat.
 */
export const stopSeatProcess = async (bindingId: string): Promise<void> => {
  const { termPlane } = await import("../term/plane");
  if (termPlane.host.get(bindingId) === undefined) return;
  await termPlane.router.kill(bindingId);
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline && termPlane.host.get(bindingId)?.status !== "exited") {
    await sleep(50);
  }
};

/** Rotate one seat (its canvas node id) in the running app. */
export const offboardAndRotate = async (
  seatId: string,
  options: SeatRotateOptions = {},
): Promise<SeatRotateResult> => {
  // Imported at call time: this module is reached from app composition, and
  // the runtime graph imports the terminal plane and canvases in turn.
  const [{ AppRuntime }, { CanvasesService }, { StationRepository }, { SeatSessionRepository }, { mainAuthoringGate }] =
    await Promise.all([
      import("../../runtime"),
      import("../canvases"),
      import("../station/repository"),
      import("./repository"),
      import("../main-authoring-gate"),
    ]);
  const [{ termPlane }, { forgetAutoRestartSpend }, { KernelService }] = await Promise.all([
    import("../term/plane"),
    import("../term/ensure-managed-seat"),
    import("../kernel/service"),
  ]);

  return rotateSeatSession(
    seatId,
    {
      locate: (id, canvasName) =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const canvases = yield* CanvasesService;
            const documents = yield* canvases.liveDocuments().pipe(Effect.orElseSucceed(() => []));
            for (const { canvasName: name, doc } of documents) {
              if (canvasName !== undefined && name !== canvasName) continue;
              const node = doc.nodes.find((candidate) => candidate.id === id);
              const surface = node === undefined ? undefined : actorDeliverySurfaceOf(node);
              if (node === undefined || surface?._tag !== "managedAgent") continue;
              const stations = yield* StationRepository;
              const configuration = yield* stations.configuration.pipe(Effect.orElseSucceed(() => undefined));
              const sessionId = node.ether?.terminal?.sessionId?.trim();
              return {
                canvasName: name,
                bindingId: surface.bindingId,
                harness: surface.harness,
                ...(sessionId ? { sessionId } : {}),
                local:
                  configuration?.configuration.role === "command-center" &&
                  configuration.configuration.hostId === surface.hostId,
              } satisfies RotatingSeat;
            }
            return undefined;
          }),
        ),
      endSession: (id, sessionId) =>
        AppRuntime.runPromise(
          Effect.flatMap(SeatSessionRepository, (sessions) => sessions.end(id, "offboard", sessionId)).pipe(
            Effect.ignore,
          ),
        ),
      reopenSession: (id, sessionId, harness) =>
        AppRuntime.runPromise(
          Effect.flatMap(SeatSessionRepository, (sessions) => sessions.record({ seatId: id, sessionId, harness })).pipe(
            Effect.ignore,
          ),
        ),
      writeSessionId: (seat, id, next) =>
        mainAuthoringGate.run("seat-sessions.rotate", () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const canvases = yield* CanvasesService;
              let changed = false;
              yield* canvases.mutate(seat.canvasName, (doc: CanvasDoc) => ({
                ...doc,
                nodes: doc.nodes.map((candidate) => {
                  const terminal = candidate.ether?.terminal;
                  // The seat changed hands since it was read: leave it alone.
                  if (candidate.id !== id || terminal?.bindingId !== seat.bindingId) return candidate;
                  changed = true;
                  const { sessionId: _previous, ...rest } = terminal;
                  return {
                    ...candidate,
                    ether: { ...candidate.ether, terminal: next ? { ...rest, sessionId: next } : rest },
                  };
                }),
              }));
              return changed;
            }),
          ),
        ),
      detach: async (seat, id, endedSessionId) => {
        // A rotation is deliberate, not a crash: it spends none of the seat's
        // automatic restarts, now or at the wake that follows a rest.
        forgetAutoRestartSpend(seat.bindingId);
        if (options.detach !== undefined) return options.detach(seat, id, endedSessionId);
        // No one to wind the old process down: stop it, and let it exit
        // before the wake, which refuses while a process is still dying.
        await stopSeatProcess(seat.bindingId);
        return { stopNow: () => stopSeatProcess(seat.bindingId) };
      },
      wake: (seat, id) => {
        forgetAutoRestartSpend(seat.bindingId);
        return AppRuntime.runPromise(
          Effect.flatMap(KernelService, (kernel) => Effect.promise(() => kernel.wakeManagedSeat(seat.canvasName, id))),
        );
      },
    },
    options,
  );
};
