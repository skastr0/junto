/**
 * The interface size in force (Settings, Appearance, Interface size).
 *
 * One percent value scales the whole interface together: main applies it as
 * the zoom factor of every web contents that follows it, so text, controls
 * and spacing keep their proportions. The stored preference reaches this
 * module from the settings service at boot and on every change; a window
 * follows from creation and is re-applied after each load, since a fresh
 * document starts at the factor Chromium remembers for its origin.
 */

import { DEFAULT_INTERFACE_SCALE, type InterfaceScale } from "@shared/settings";

/** The part of Electron's WebContents this module needs. */
export interface InterfaceScaleTarget {
  readonly isDestroyed: () => boolean;
  readonly setZoomFactor: (factor: number) => void;
}

let current: InterfaceScale = DEFAULT_INTERFACE_SCALE;
const targets = new Set<InterfaceScaleTarget>();

/** Apply the size in force to one target now. A destroyed target is dropped. */
export const applyInterfaceScale = (target: InterfaceScaleTarget): void => {
  if (target.isDestroyed()) {
    targets.delete(target);
    return;
  }
  target.setZoomFactor(current / 100);
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
