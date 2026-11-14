/**
 * The GPU canvas's wire mode, with one owner and three reasons.
 *
 * `wireMode` decides how the wire layer draws and what the pointer can pick:
 * the loupe (Alt) shows every wire at full strength and makes them pickable, a
 * connect gesture shows the wires a drop could land on, and the focus cone
 * keeps the inspected neighborhood's wires while the rest of the field dims.
 * The reasons arrive from three places (the magnifier, the pointer machine's
 * gestures, the selection fact); this module holds them as a set and gives the
 * engine the strongest one, so one reason letting go never erases another.
 */
import { observe } from "@legendapp/state";
import { canvasSelectionFact } from "../../lib/canvas-focus";
import { state$ } from "../../lib/state";
import type { WireMode } from "../contract";

export type WireReason = "loupe" | "connecting" | "cone";

/** Strongest first: the operator's loupe, then a gesture in flight, then the cone. */
const ORDER: ReadonlyArray<WireReason> = ["loupe", "connecting", "cone"];
const MODE: Readonly<Record<WireReason, WireMode>> = {
  loupe: "loupe",
  connecting: "connecting",
  cone: "cone",
};

const held = new Set<WireReason>();
/** Each mounted canvas's writer; the mode is pushed to all of them. */
const writers = new Set<(mode: WireMode) => void>();

const changed = (): void => {
  const mode = wireModeNow();
  for (const writer of [...writers]) writer(mode);
};

/** The mode the reasons add up to, right now. */
export const wireModeNow = (): WireMode => {
  for (const reason of ORDER) if (held.has(reason)) return MODE[reason];
  return "rest";
};

/** Hold a reason; the returned release is idempotent. */
export const holdWireMode = (reason: WireReason): (() => void) => {
  if (!held.has(reason)) {
    held.add(reason);
    changed();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!held.delete(reason)) return;
    changed();
  };
};

/**
 * Own the mode for a mounted canvas: its writer hears every change, starting
 * with the mode that stands now. Returns the way to stop hearing it.
 */
export const ownWireMode = (writer: (mode: WireMode) => void): (() => void) => {
  writers.add(writer);
  writer(wireModeNow());
  return () => {
    writers.delete(writer);
  };
};

/**
 * Hold the cone while the open canvas has one to paint: a connection focus,
 * or the selected card's stoppage cone. The fact is derived exactly as the
 * engine's selection fact is (lib/canvas-focus.ts), so the mode and the dimming
 * never disagree. Returns the way to stop.
 */
export const holdConeWireMode = (): (() => void) => {
  let release: (() => void) | undefined;
  const stop = observe(() => {
    const fact = canvasSelectionFact(state$.canvasName.get());
    const cone = fact.focusMode !== undefined;
    if (cone && release === undefined) release = holdWireMode("cone");
    else if (!cone && release !== undefined) {
      release();
      release = undefined;
    }
  });
  return () => {
    stop();
    release?.();
    release = undefined;
  };
};
