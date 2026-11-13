/**
 * The seam between the two canvases (docs/canvas-gpu-architecture.md,
 * section 21). The operator's experimental toggle picks one, live; the camera
 * is handed across. With no WebGPU adapter the old canvas is mounted and the
 * reason is said once. Deleted, with the old canvas, at milestone 7.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useFeatureOn } from "../../lib/experimental-features";
import { state$ } from "../../lib/state";
import { GpuCanvas } from "./GpuCanvas";

type Props = {
  /** Today's canvas, mounted when the switch is off or the GPU cannot run. */
  readonly legacy: ReactNode;
};

let unavailableSaid = false;

export function CanvasHost({ legacy }: Props) {
  const on = useFeatureOn("gpuCanvas");
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);
  const onUnavailable = useCallback((reason: string) => {
    setUnavailable(reason);
    if (unavailableSaid) return;
    unavailableSaid = true;
    state$.error.set(`GPU canvas is on, but it cannot run here, so the current canvas is shown. ${reason}`);
  }, []);
  if (!on || unavailable !== undefined) return <>{legacy}</>;
  return <GpuCanvas onUnavailable={onUnavailable} />;
}
