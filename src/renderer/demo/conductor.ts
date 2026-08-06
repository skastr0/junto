import { observable } from "@legendapp/state";
import type { DemoCommand, DemoEdl, DemoEdlEntry, DemoOp, DemoScenario } from "@shared/demo";
import { beatMs } from "@shared/demo";
import { EMPTY_DOC } from "../lib/state";
import { loadDoc } from "../lib/mutations";
import { executeBeat } from "./ops";

// Demo/scripting engine only. ONE conductor owns musical time: it schedules
// a scenario's beats against performance.now() with a drift-corrected
// setTimeout chain (each target recomputed from t0, never accumulated from
// the previous callback's delay) and logs an EDL entry per executed op.

export const demo$ = observable({
  running: false,
  /** Count of beats executed so far this take. */
  beat: 0,
  total: 0,
});

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const commandTag = (command: DemoCommand): string => {
  switch (command.kind) {
    case "ensure-pane":
      return `ensure-pane:${command.pane.host}:${command.pane.paneId}`;
    case "set-status":
      return `set-status:${command.paneId}:${command.status}`;
    case "reset-host":
      return `reset-host:${command.host}`;
  }
};

const opTag = (op: DemoOp): string => {
  switch (op.kind) {
    case "add-nodes":
      return `add-nodes:${op.nodes.length}`;
    case "add-edges":
      return `add-edges:${op.edges.length}`;
    case "remove-nodes":
      return `remove-nodes:${op.ids.length}`;
    case "flag":
      return `flag:${op.flag}:${op.on ? "on" : "off"}:${op.nodeIds.length}`;
    case "select":
      return `select:${op.nodeIds.length}`;
    case "herdr":
      return `herdr:${commandTag(op.command)}`;
    case "camera-fit":
      return `camera-fit:${op.nodeIds ? op.nodeIds.length : "all"}`;
    case "camera-center":
      return `camera-center:${op.x},${op.y}`;
    case "sfx":
      return `sfx:${op.id}`;
    case "hud":
      return `hud:${op.show ? "on" : "off"}`;
    case "tween-nodes":
      return `tween-nodes:${op.moves.length}`;
    case "alert-cycle":
      return "alert-cycle";
    case "open-terminal":
      return `open-terminal:${op.nodeId}`;
    case "close-terminal":
      return "close-terminal";
    case "page-open":
      return `page-open:${op.nodeId}`;
  }
};

const resetHost = (host: string): Promise<unknown> =>
  window.vellumCommand?.demoCommand({ kind: "reset-host", host }).catch(() => undefined) ??
  Promise.resolve(undefined);

const runTake = async (scenario: DemoScenario): Promise<void> => {
  loadDoc(EMPTY_DOC);
  await Promise.allSettled([resetHost("local"), resetHost("remote-a")]);
  // stopTake() may have fired while the resets were in flight — don't start
  // the clock on a take that was already cancelled.
  if (!demo$.running.peek()) return;

  const sorted = [...scenario.beats].sort((a, b) => a.at - b.at);
  const endAt = (sorted[sorted.length - 1]?.at ?? 0) + 2;
  const bpmMs = beatMs(scenario.bpm);
  const t0 = performance.now();
  const startedAtEpochMs = Date.now();
  const entries: DemoEdlEntry[] = [];

  const finish = (): void => {
    pendingTimer = null;
    demo$.running.set(false);
    const edl: DemoEdl = { scenarioId: scenario.id, bpm: scenario.bpm, startedAtEpochMs, entries };
    void window.vellumCommand?.demoWriteEdl(edl).catch(() => undefined);
  };

  const scheduleAt = (targetBeat: number, action: () => void): void => {
    const delay = Math.max(0, t0 + targetBeat * bpmMs - performance.now());
    pendingTimer = setTimeout(action, delay);
  };

  const runBeat = (index: number): void => {
    if (index >= sorted.length) {
      scheduleAt(endAt, finish);
      return;
    }
    const beat = sorted[index];
    scheduleAt(beat.at, () => {
      const actualMs = performance.now() - t0;
      const plannedMs = beat.at * bpmMs;
      executeBeat(scenario, beat);
      for (const op of beat.ops) {
        entries.push({ beat: beat.at, plannedMs, actualMs, op: opTag(op) });
      }
      demo$.beat.set(index + 1);
      runBeat(index + 1);
    });
  };

  runBeat(0);
};

/** Start a take. Noop if one is already running. */
export const startTake = (scenario: DemoScenario): void => {
  if (demo$.running.peek()) return;
  demo$.running.set(true);
  demo$.beat.set(0);
  demo$.total.set(scenario.beats.length);
  void runTake(scenario);
};

/** Abort the running take. No EDL is written on abort. */
export const stopTake = (): void => {
  if (!demo$.running.peek()) return;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  demo$.running.set(false);
};
