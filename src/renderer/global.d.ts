import type {
  ChassisApi,
  JuntoApi,
  JuntoBrowserApi,
  JuntoChatApi,
  JuntoDemoApi,
  JuntoHermesIntegrationApi,
  JuntoHostsApi,
  JuntoSchedulerApi,
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
      JuntoChatApi &
      JuntoTerminalApi &
      JuntoGitApi &
      JuntoDemoApi &
      Partial<
          JuntoBrowserApi &
          JuntoUsageApi &
          JuntoSchedulerApi &
          JuntoHermesIntegrationApi &
          JuntoHostsApi
      >;
  }
}

export {};
