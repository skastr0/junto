import type {
  ChassisApi,
  JuntoApi,
  JuntoBrowserApi,
  JuntoHostsApi,
  JuntoTerminalApi,
  JuntoUsageApi,
} from "@shared/ipc";
import type { JuntoFilesApi } from "@shared/files";
import type { CanvasPerformanceHarness } from "./lib/performance/perf-harness";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    /** Published only while JUNTO_PERF has armed the renderer perf harness. */
    readonly juntoPerf?: CanvasPerformanceHarness;
    readonly junto?: JuntoApi &
      JuntoTerminalApi &
      JuntoFilesApi &
      Partial<
          JuntoBrowserApi &
          JuntoUsageApi &
          JuntoHostsApi
      >;
  }
}

export {};
