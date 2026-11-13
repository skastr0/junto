/**
 * The CanvasApi handle (docs/canvas-gpu-architecture.md, section 19).
 *
 * One object, provided through React context and as a module handle for code
 * outside React. It replaces `useReactFlow`, `useStoreApi` and every DOM
 * lookup of `.react-flow`. The handle is registered by whichever canvas is
 * mounted and cleared only by the canvas that registered it.
 */

import type { CanvasApi } from "../contract";

let active: CanvasApi | undefined;

/** The mounted canvas's API, or undefined before one mounts and after it leaves. */
export const canvasApi = (): CanvasApi | undefined => active;

export const setCanvasApi = (api: CanvasApi | undefined): void => {
  active = api;
};

/** Clear the handle only when `api` is still the registered one. */
export const clearCanvasApi = (api: CanvasApi): void => {
  if (active === api) active = undefined;
};
