import type {
  ChassisApi,
  JuntoApi,
  JuntoBrowserApi,
  JuntoDemoApi,
  JuntoHostsApi,
  JuntoGitApi,
  JuntoTerminalApi,
  JuntoUsageApi,
} from "@shared/ipc";
import type { CanvasPerformanceHarness } from "./lib/performance/perf-harness";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    /** Published only while JUNTO_PERF has armed the renderer perf harness. */
    readonly juntoPerf?: CanvasPerformanceHarness;
    readonly junto?: JuntoApi &
      JuntoTerminalApi &
      JuntoGitApi &
      JuntoDemoApi &
      Partial<
          JuntoBrowserApi &
          JuntoUsageApi &
          JuntoHostsApi
      >;
  }
}

export {};
