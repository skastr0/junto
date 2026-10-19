/**
 * Operator offboard in the running app: the ports of
 * `operator-offboard.ts` bound to the canvas, the terminal plane, the
 * offboard closer, settings and the seat sessions store.
 *
 * What sets a seat's clock here is its status alone (the seat-state plane):
 * when it leaves rest and when it comes back to it. Terminal output, a typed
 * key and a repainting prompt never do.
 */
import { Effect } from "effect";
import { agentSeatStatusOf, type AgentSeatStateEvent } from "@shared/agent-seat-state";
import { isThisMachine } from "@shared/machine-name";
import { MachineRepository } from "../machines/repository";
import type { Canvas, Node } from "@shared/model";
import type { OffboardBy, OffboardRules, OffboardRulesPatch } from "@shared/seat-offboard";
import { defaultOffboardRules } from "@shared/seat-offboard";
import {
  composeOffboardAsk,
  type OffboardMode,
  type SeatAddress,
  type SeatOffboardProgress,
} from "@shared/seat-sessions";
import { offboardRules } from "@shared/settings";
import type { SeatSessionRun } from "./run";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "./repository";
import { PausePlane } from "../pause-plane";
import { SettingsService } from "../settings/service";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { operatorHold, subscribeOperatorTyped } from "../term/operator-holds";
import { termPlane } from "../term/plane";
import { sessionSizeOf } from "../term/session-size";
import { remoteSeatLaunchOf } from "../term/seats-client";
import {
  OFFBOARD_TICK_MS,
  SeatStatusClock,
  makeOperatorOffboard,
  seatCacheQuestionsChanged,
  setOperatorOffboard,
  waitsOnOperator,
  type OffboardSeat,
  type SeatClockRecord,
} from "./operator-offboard";

/** The closer, as this module uses it. */
export type OffboardCloserPort = {
  readonly isClosing: (seat: SeatAddress) => boolean;
  /** End the session from outside it: reports progress, seals, rotates. */
  readonly closeNow: (
    seat: SeatAddress,
    options: { readonly mode: OffboardMode; readonly by: OffboardBy },
  ) => Promise<void>;
  readonly asked: (seat: SeatAddress, mode: OffboardMode) => void;
  readonly current: () => ReadonlyArray<SeatOffboardProgress>;
};

export type OperatorOffboardLiveInput = {
  /** The runtime this process owns: the window's, or the windowless core's. */
  readonly run: SeatSessionRun;
  readonly closer: OffboardCloserPort;
  /** Send a prompt to a seat on the ordinary mail path. */
  readonly sendPrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName: string;
    readonly nodeId: string;
  }) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  /** Product automation is switched off (quit, maintenance): the rules rest. */
  readonly suspended: () => boolean;
  /** The seats due the auto mode's question changed. No window: no one is told. */
  readonly publishDue?: () => void;
};

/** The clock as last saved in junto.db; undefined when it never was or cannot be read. */
const readClock = (run: SeatSessionRun): Promise<SeatClockRecord | undefined> =>
  run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.offboardClock())).catch((error: unknown) => {
    console.error("[offboard] could not read the clock:", error);
    return undefined;
  });

/** Save the clock in junto.db. Best effort: the next save carries it. */
const writeClock = (run: SeatSessionRun, record: SeatClockRecord): void => {
  void run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.saveOffboardClock(record))).catch(
    (error: unknown) => console.error("[offboard] could not save the clock:", error),
  );
};

const titleOf = (node: Node): string | undefined => {
  return "label" in node ? node.label?.trim() || undefined : undefined;
};

const seatOf = async (
  run: SeatSessionRun,
  canvasName: string,
  node: Node,
  paused: boolean,
): Promise<OffboardSeat | undefined> => {
  if (node.kind !== "agent") return undefined;
  const surface = { ...node, hostId: node.host };
  const live = termPlane.host.get(surface.bindingId);
  const running = live !== undefined && live.status !== "exited";
  const sessionId = await run(
    Effect.flatMap(SeatSessionRepository, (sessions) => sessions.current(node.id, node.bindingId)),
  ).then((session) => session?.sessionId);
  const title = titleOf(node);
  const state = !running
    ? undefined
    : seatStateRuntime.isSeatIdle(surface.bindingId)
      ? ("idle" as const)
      : (() => {
          const read = seatStateRuntime.getState(surface.bindingId);
          return read === "working" || read === "attention" ? read : ("unknown" as const);
        })();
  return {
    seatId: node.id,
    canvasName,
    ...(title ? { title } : {}),
    bindingId: surface.bindingId,
    harness: surface.harness,
    local: isThisMachine(surface.hostId, await run(Effect.flatMap(MachineRepository, (machine) => machine.machineName))),
    machine: surface.hostId,
    ...(sessionId ? { sessionId } : {}),
    running,
    ...(running ? { generation: live.epoch } : {}),
    ...(state ? { state } : {}),
    paused,
    ...(running && waitsOnOperator(seatStateRuntime.snapshot(surface.bindingId)) ? { waitsOnOperator: true } : {}),
  };
};

const pausedOn = (run: SeatSessionRun, canvasName: string): Promise<boolean> =>
  run(
    Effect.map(PausePlane, (plane) => !plane.stateFor(canvasName).playing),
  ).catch(() => false);

const cwdOf = (doc: Canvas, seatId: string): string | undefined => {
  const node = doc.nodes.get(seatId as never);
  return node?.kind === "agent" ? node.launch?.cwd?.trim() || undefined : undefined;
};

/**
 * The runtime operator offboard was started in. The rules are read and saved
 * through it; before it starts, the defaults stand and nothing is saved.
 */
let started: SeatSessionRun | undefined;

/** The rules in force, read from installation settings. */
export const readOffboardRules = (): Promise<OffboardRules> =>
  started === undefined ? Promise.resolve(defaultOffboardRules()) : started(
    Effect.flatMap(SettingsService, (settings) => settings.get).pipe(
      Effect.map((current) => offboardRules(current)),
      Effect.orElseSucceed(() => defaultOffboardRules()),
    ),
  ).catch(() => defaultOffboardRules());

const NOT_SAVED = "The offboard rules could not be saved.";

/** Change the rules. The check is done inside; a refusal is a plain sentence. */
export const patchOffboardRules = (
  patch: OffboardRulesPatch,
): Promise<
  { readonly ok: true; readonly rules: OffboardRules } | { readonly ok: false; readonly message: string }
> =>
  started === undefined ? Promise.resolve({ ok: false as const, message: NOT_SAVED }) : started(
    Effect.flatMap(SettingsService, (settings) => settings.patch({ offboard: patch })).pipe(
      Effect.match({
        onSuccess: (next) => ({ ok: true as const, rules: offboardRules(next) }),
        // A validation refusal carries the sentence to show; anything else
        // (storage) is not the operator's to read.
        onFailure: (error) => ({
          ok: false as const,
          message: error.code === "validation" && error.message ? error.message : NOT_SAVED,
        }),
      }),
    ),
  ).catch(() => ({ ok: false as const, message: NOT_SAVED }));

/**
 * Start operator offboard for this app: restore the clock, watch seats move,
 * and run the automatic rules once a minute. Returns the stop.
 */
export const startOperatorOffboard = async (input: OperatorOffboardLiveInput): Promise<() => void> => {
  const restored = await readClock(input.run);
  started = input.run;
  const clock = new SeatStatusClock(() => Date.now(), restored);
  let rules: OffboardRules = defaultOffboardRules();
  const refreshRules = async (): Promise<void> => {
    rules = await readOffboardRules();
  };
  /** cwd per seat, noted when a seat is read, for the session-history check. */
  const cwds = new Map<string, string | undefined>();

  const documents = (): Promise<ReadonlyArray<{ readonly canvasName: string; readonly doc: Canvas }>> =>
    input.run(
      Effect.flatMap(ModelService, (model) => Effect.gen(function* () {
        const rows = [];
        for (const canvasName of yield* model.listCanvases()) rows.push({ canvasName, doc: yield* model.canvas(canvasName) });
        return rows;
      }).pipe(Effect.orElseSucceed(() => []))),
    ).catch(() => []);

  const offboard = makeOperatorOffboard(
    {
      locate: async ({ canvasName, seatId }) => {
        const found = (await documents()).find((entry) => entry.canvasName === canvasName);
        const node = found?.doc.nodes.get(seatId as never);
        if (!found || !node) return undefined;
        const seat = await seatOf(input.run, canvasName, node, await pausedOn(input.run, canvasName));
        if (seat) cwds.set(seat.bindingId, cwdOf(found.doc, seatId));
        return seat;
      },
      seats: async () => {
        const out: OffboardSeat[] = [];
        for (const { canvasName, doc } of await documents()) {
          const paused = await pausedOn(input.run, canvasName);
          for (const node of doc.nodes.values()) {
            const seat = await seatOf(input.run, canvasName, node, paused);
            if (!seat) continue;
            cwds.set(seat.bindingId, cwdOf(doc, node.id));
            out.push(seat);
          }
        }
        return out;
      },
      isClosing: (seat) => input.closer.isClosing(seat),
      closeNow: async (seat, by) => {
        const address = { seatId: seat.seatId, canvasName: seat.canvasName };
        await input.closer.closeNow(address, { mode: "rest", by });
        // The closer reports where the close ended; a failure carries its reason.
        const progress = input.closer
          .current()
          .find((entry) => entry.seatId === seat.seatId && entry.canvasName === seat.canvasName);
        return progress?.stage === "failed"
          ? { ok: false, message: progress.message ?? "" }
          : { ok: true };
      },
      ask: async (seat, mode) => {
        const sent = await input.sendPrompt({
          bindingId: seat.bindingId,
          text: composeOffboardAsk(mode),
          canvasName: seat.canvasName,
          nodeId: seat.seatId,
        });
        if (!sent.ok) return { ok: false, message: sent.error ?? "" };
        input.closer.asked({ seatId: seat.seatId, canvasName: seat.canvasName }, mode);
        return { ok: true };
      },
      // Who ended it is kept on the session's row (`junto onboard` tells the
      // next session). The session is closed either way; only the "who" can be lost.
      markEnded: (seat, sessionId, by) => {
        void input.run(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.markEnded(seat.seatId, sessionId, by))).catch(
          (error: unknown) => console.error(`[offboard] could not record who ended ${sessionId} for ${seat.seatId}:`, error),
        );
      },
      // The session's size as tokens, with its basis (term/session-size.ts): a
      // stat and a bounded read, never the whole file. Undefined when the
      // transcript cannot be located, and the session is then judged on work time alone.
      sessionSize: (seat) => {
        if (seat.sessionId === undefined) return undefined;
        const cwd = cwds.get(seat.bindingId);
        const size = sessionSizeOf({
          harness: seat.harness,
          sessionId: seat.sessionId,
          ...(cwd ? { cwd } : {}),
        });
        return size ? { tokens: size.tokens, basis: size.basis } : undefined;
      },
      rules: () => rules,
      // A window here, or a Hold from the machine editing the seat's canvas.
      held: (seat, at) => operatorHold(seat.bindingId, at),
      // A seat run elsewhere: what its own machine last said, for its row only.
      remote: async (seat) =>
        seat.machine === undefined ? undefined : (await remoteSeatLaunchOf({ bindingId: seat.bindingId, host: seat.machine }))?.offboard,
      saveClock: (record) => writeClock(input.run, record),
      // The window here, and the views of these seats on linked machines.
      dueChanged: () => {
        input.publishDue?.();
        seatCacheQuestionsChanged();
      },
      log: (message) => console.info(`[offboard] ${message}`),
    },
    clock,
  );

  // The public operation reads the rules fresh, then runs.
  setOperatorOffboard({
    ...offboard,
    run: async (runInput, by) => {
      await refreshRules();
      return offboard.run(runInput, by);
    },
    coldAtStart: async (seat, cause) => {
      await refreshRules();
      return offboard.coldAtStart(seat, cause);
    },
    answerDue: async (seat, question, answer, generation) => {
      await refreshRules();
      return offboard.answerDue(seat, question, answer, generation);
    },
    status: async (canvasName, seatIds) => {
      await refreshRules();
      return offboard.status(canvasName, seatIds);
    },
    // The card asks again when a cache window changes: answer from the new one.
    nextTurn: async (seat, launch) => {
      await refreshRules();
      return offboard.nextTurn(seat, launch);
    },
    facts: async (seat) => {
      await refreshRules();
      return offboard.facts(seat);
    },
  });

  // The status sets the clock; time in `working` is the session's work.
  const noteSeat = (event: AgentSeatStateEvent): void => {
    clock.noteState(event.bindingId, event.state);
    const status = agentSeatStatusOf(event);
    if (status !== undefined) clock.noteStatus(event.bindingId, status.snapshot);
  };
  const offState = seatStateRuntime.subscribe(noteSeat);
  // Seats already running when the rules start read where they are now.
  for (const event of seatStateRuntime.currentEvents()) noteSeat(event);
  // The operator's keys warm a seat this machine runs, from a window here or
  // a peer's view of it.
  const offTyped = subscribeOperatorTyped((bindingId) => {
    if (termPlane.host.get(bindingId) !== undefined) clock.noteTyped(bindingId);
  });

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || input.suspended()) return;
    ticking = true;
    void refreshRules()
      .then(() => offboard.tick())
      .then((result) => {
        if (result.closed > 0 || result.refused > 0) {
          console.info(
            `[offboard] automatic pass: ${String(result.closed)} closed, ${String(result.refused)} not done`,
          );
        }
      })
      .catch((error: unknown) => console.error("[offboard] automatic rules failed:", error))
      .finally(() => {
        ticking = false;
      });
  }, OFFBOARD_TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  return () => {
    clearInterval(timer);
    offState();
    offTyped();
    // Best effort: the last tick's save stands.
    writeClock(input.run, clock.record());
    setOperatorOffboard(undefined);
    if (started === input.run) started = undefined;
  };
};
