/**
 * The interface size in force (Settings, Appearance, Interface size).
 *
 * One percent value scales the whole interface together: main applies it as
 * the zoom factor of every web contents that follows it, so text, controls
 * and spacing keep their proportions. The stored preference reaches this
 * module from the settings service at boot and on every change; a window
 * follows from creation and is re-applied after each load, since a fresh
 * document starts at the factor Chromium remembers for its origin.
 *
 * A size is held back while the window is too narrow to show it: the top
 * bar, which holds the way into Settings, must stay inside the window, or a
 * size chosen in a wide window could not be undone in a narrow one.
 */

import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALES, type InterfaceScale } from "@shared/settings";

/** The narrowest the interface is drawn, in its own pixels: the top bar fits from here up. */
export const INTERFACE_MIN_WIDTH = 640;

/** The part of a window this module needs. */
export interface InterfaceScaleTarget {
  readonly isDestroyed: () => boolean;
  readonly setZoomFactor: (factor: number) => void;
  /** The window's content width in screen pixels. Absent: the size is applied as chosen. */
  readonly contentWidth?: () => number;
}

let current: InterfaceScale = DEFAULT_INTERFACE_SCALE;
const targets = new Set<InterfaceScaleTarget>();
const applied = new WeakMap<InterfaceScaleTarget, number>();

/**
 * The size a window of `contentWidth` shows for a chosen size: the chosen
 * one when it fits, else the largest listed size that does. Never below
 * standard, and a size at or under standard is always shown as chosen.
 */
export const shownInterfaceScale = (chosen: InterfaceScale, contentWidth: number | undefined): InterfaceScale => {
  if (contentWidth === undefined || chosen <= DEFAULT_INTERFACE_SCALE) return chosen;
  const fits = INTERFACE_SCALES.filter(
    (scale) => scale <= chosen && (scale <= DEFAULT_INTERFACE_SCALE || contentWidth / (scale / 100) >= INTERFACE_MIN_WIDTH),
  );
  return fits[fits.length - 1] ?? DEFAULT_INTERFACE_SCALE;
};

const factorFor = (target: InterfaceScaleTarget): number => shownInterfaceScale(current, target.contentWidth?.()) / 100;

/** Apply the size in force to one target now. A destroyed target is dropped. */
export const applyInterfaceScale = (target: InterfaceScaleTarget): void => {
  if (target.isDestroyed()) {
    targets.delete(target);
    return;
  }
  const factor = factorFor(target);
  applied.set(target, factor);
  target.setZoomFactor(factor);
};

/** After the window changed width: apply again only when the size it can show changed. */
export const refitInterfaceScale = (target: InterfaceScaleTarget): void => {
  if (target.isDestroyed() || applied.get(target) !== factorFor(target)) applyInterfaceScale(target);
};

export const currentInterfaceScale = (): InterfaceScale => current;

/** Record the operator's stored size and apply it to every follower. */
export const setInterfaceScale = (next: InterfaceScale): void => {
  if (next === current) return;
  current = next;
  for (const target of [...targets]) applyInterfaceScale(target);
};

/** Keep `target` at the size in force until the returned function is called. */
export const followInterfaceScale = (target: InterfaceScaleTarget): (() => void) => {
  targets.add(target);
  applyInterfaceScale(target);
  return () => {
    targets.delete(target);
  };
};
