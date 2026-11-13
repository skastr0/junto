/**
 * React wiring for the CanvasApi (docs/canvas-gpu-architecture.md, section 19).
 * A canvas mounts the provider once; consumers read the same object the
 * module handle carries, so effects and plain modules agree.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { CanvasApi } from "../contract";
import { canvasApi } from "./canvas-api";

const CanvasApiContext = createContext<CanvasApi | undefined>(undefined);

export function CanvasApiProvider({ api, children }: { readonly api: CanvasApi; readonly children: ReactNode }) {
  return <CanvasApiContext.Provider value={api}>{children}</CanvasApiContext.Provider>;
}

/** The canvas API nearest this component, or the mounted canvas's handle. */
export const useCanvasApi = (): CanvasApi | undefined => useContext(CanvasApiContext) ?? canvasApi();
