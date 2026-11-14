/**
 * The page's one GPU atlas (docs/canvas-gpu-architecture.md, sections 8 and 9).
 *
 * The main canvas and the magnifier's lens draw from the same cells: text
 * runs, sprites, mark cells and media rasterize once, into one texture both
 * engines sample. Keeping the atlas for the page's life — like the device
 * keeper beside it — means toggling the canvas or reopening it never
 * re-rasterizes a cell.
 *
 * `onDirty` cannot name one engine: it broadcasts to every listener, so a
 * cell that lands while the lens is up repaints both views.
 */

import { themeMode$ } from "../../lib/theme-mode";
import { createGpuAtlas, browserRasterizers, type GpuAtlas } from "../engine/gpu-atlas";
import { pageDeviceKeeper } from "./gpu-device";

let atlas: GpuAtlas | undefined;
const dirtyListeners = new Set<() => void>();

/** The page's atlas, made on first use and kept for the page's life. */
export const pageGpuAtlas = (): GpuAtlas => {
  if (atlas !== undefined) return atlas;
  atlas = createGpuAtlas({
    ...browserRasterizers(),
    mode: themeMode$.peek(),
    onDirty: () => {
      for (const listener of [...dirtyListeners]) listener();
    },
  });
  // The keeper is the atlas's device: attach on ready, and again on every
  // new generation. attach() is a no-op for a device it already holds.
  const keeper = pageDeviceKeeper();
  const attach = (state: ReturnType<typeof keeper.state>): void => {
    if (state.kind === "ready") atlas?.attach(state.device);
  };
  attach(keeper.state());
  keeper.subscribe(attach);
  return atlas;
};

/** A landed cell changed the texture or the UVs: repaint every engine drawing from it. */
export const onGpuAtlasDirty = (listener: () => void): (() => void) => {
  dirtyListeners.add(listener);
  return () => {
    dirtyListeners.delete(listener);
  };
};

/** Tests only: drop the atlas so the next mount makes a fresh one. */
export const resetPageGpuAtlasForTest = (): void => {
  atlas?.dispose();
  atlas = undefined;
  dirtyListeners.clear();
};
