/**
 * Operator offboard in the running app: the ports of
 * `operator-offboard.ts` bound to the canvas, the terminal plane, the
 * offboard closer, settings and disk.
 *
 * What moves a seat's clock here: any terminal output of the seat (which is
 * also what a typed key, a delivered mail or a `junto` call from the agent
 * shows up as), and any seat-state change away from idle.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { OffboardBy, OffboardRules, OffboardRulesPatch } from "@shared/seat-offboard";
import { defaultOffboardRules } from "@shared/seat-offboard";
import {
  composeOffboardAsk,
  type OffboardMode,
  type SeatAddress,
  type SeatOffboardProgress,
} from "@shared/seat-sessions";
import { offboardRules } from "@shared/settings";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { PausePlane } from "../pause-plane";
import { SettingsService } from "../settings/service";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { terminalObserverPlane } from "../term/observer";
import { termPlane } from "../term/plane";
import { defaultSeatsRoot, seatSessionNotesPath, writeEndedMarker } from "./notes-file";
import {
  OFFBOARD_TICK_MS,
  SeatMotionClock,
  makeOperatorOffboard,
  parseSeatMotionRecord,
  setOperatorOffboard,
  type OffboardSeat,
  type SeatMotionRecord,
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
  /** Where the clock is kept. Default: beside the seats' session notes. */
  readonly clockPath?: string;
};

/** `~/.junto/seats/offboard-clock.json` */
export const offboardClockPath = (): string => join(defaultSeatsRoot(), "offboard-clock.json");

const readClock = (path: string): SeatMotionRecord | undefined => {
  try {
    return existsSync(path) ? parseSeatMotionRecord(readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};

const writeClock = (path: string, record: SeatMotionRecord): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, path);
};

const titleOf = (node: CanvasNode): string | undefined => {
  const label = node.ether?.terminal?.label?.trim();
  if (label) return label;
  const first = node.type === "text" ? node.text.split("\n")[0]?.trim() : undefined;
  return first || undefined;
};

const seatOf = (
  canvasName: string,
  node: CanvasNode,
  paused: boolean,
): OffboardSeat | undefined => {
  const surface = actorDeliverySurfaceOf(node);
  if (surface?._tag !== "managedAgent") return undefined;
  const live = termPlane.host.get(surface.bindingId);
  const running = live !== undefined && live.status !== "exited";
  const sessionId = node.ether?.terminal?.sessionId?.trim();
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
    local: surface.hostId === "local",
    ...(sessionId ? { sessionId } : {}),
    running,
    ...(state ? { state } : {}),
    paused,
  };
};

const pausedOn = (canvasName: string): Promise<boolean> =>
  AppRuntime.runPromise(
    Effect.map(PausePlane, (plane) => !plane.stateFor(canvasName).playing),
  ).catch(() => false);

const cwdOf = (doc: CanvasDoc, seatId: string): string | undefined =>
  doc.nodes.find((node) => node.id === seatId)?.ether?.terminal?.launch?.cwd?.trim() || undefined;

/** The rules in force, read from installation settings. */
export const readOffboardRules = (): Promise<OffboardRules> =>
  AppRuntime.runPromise(
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
  AppRuntime.runPromise(
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
export const startOperatorOffboard = (input: OperatorOffboardLiveInput): (() => void) => {
  const clockPath = input.clockPath ?? offboardClockPath();
  const clock = new SeatMotionClock(() => Date.now(), readClock(clockPath));
  let rules: OffboardRules = defaultOffboardRules();
  const refreshRules = async (): Promise<void> => {
    rules = await readOffboardRules();
  };
  /** cwd per seat, noted when a seat is read, for the session-history check. */
  const cwds = new Map<string, string | undefined>();

  const documents = (): Promise<ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>> =>
    AppRuntime.runPromise(
      Effect.flatMap(CanvasesService, (canvases) =>
        canvases.liveDocuments().pipe(Effect.orElseSucceed(() => [])),
      ),
    ).catch(() => []);

  const offboard = makeOperatorOffboard(
    {
      locate: async ({ canvasName, seatId }) => {
        const found = (await documents()).find((entry) => entry.canvasName === canvasName);
        const node = found?.doc.nodes.find((candidate) => candidate.id === seatId);
        if (!found || !node) return undefined;
        const seat = seatOf(canvasName, node, await pausedOn(canvasName));
        if (seat) cwds.set(seat.bindingId, cwdOf(found.doc, seatId));
        return seat;
      },
      seats: async () => {
        const out: OffboardSeat[] = [];
        for (const { canvasName, doc } of await documents()) {
          const paused = await pausedOn(canvasName);
          for (const node of doc.nodes) {
            const seat = seatOf(canvasName, node, paused);
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
      markEnded: (seat, sessionId, by, at) =>
        writeEndedMarker(seatSessionNotesPath(defaultSeatsRoot(), seat.seatId, sessionId), { by, at }),
      rules: () => rules,
      saveClock: (record) => writeClock(clockPath, record),
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
    beforeWake: async (seat) => {
      await refreshRules();
      return offboard.beforeWake(seat);
    },
    status: async (canvasName, seatIds) => {
      await refreshRules();
      return offboard.status(canvasName, seatIds);
    },
  });

  // Output is movement. So is a seat leaving idle.
  const lastSeq = new Map<string, bigint>();
  const offOutput = terminalObserverPlane.subscribeGlobal((snap) => {
    if (lastSeq.get(snap.bindingId) === snap.seq) return;
    lastSeq.set(snap.bindingId, snap.seq);
    clock.note(snap.bindingId);
  });
  const offState = seatStateRuntime.subscribe((event) => {
    // Time in `working` is the session's work; any other state ends a stretch.
    clock.noteState(event.bindingId, event.state);
    if (event.state === "gone") {
      lastSeq.delete(event.bindingId);
      return;
    }
    if (event.state !== "idle") clock.note(event.bindingId);
  });

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || input.suspended()) return;
    ticking = true;
    void refreshRules()
      .then(() => offboard.tick())
      .then((result) => {
        if (result.asked > 0 || result.refused > 0) {
          console.info(
            `[offboard] idle nudge: ${String(result.asked)} asked, ${String(result.refused)} not done`,
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
    offOutput();
    offState();
    try {
      writeClock(clockPath, clock.record());
    } catch {
      // Best effort: the last tick's save stands.
    }
    setOperatorOffboard(undefined);
  };
};
