import type {
  ChassisApi,
  VellumCommandApi,
  VellumCommandBrowserApi,
  VellumCommandChatApi,
  VellumCommandDemoApi,
  VellumCommandHerdrApi,
  VellumCommandHermesIntegrationApi,
  VellumCommandSchedulerApi,
  VellumCommandGitApi,
  VellumCommandTerminalApi,
  VellumCommandUsageApi,
} from "@shared/ipc";
import type { CanvasPerformanceHarness } from "./lib/performance/perf-harness";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    /** Published only while VELLUM_PERF has armed the renderer perf harness. */
    readonly vellumCommandPerf?: CanvasPerformanceHarness;
    readonly vellumCommand?: VellumCommandApi &
      VellumCommandChatApi &
      VellumCommandTerminalApi &
      VellumCommandGitApi &
      VellumCommandDemoApi &
      Partial<
        VellumCommandHerdrApi &
          VellumCommandBrowserApi &
          VellumCommandUsageApi &
          VellumCommandSchedulerApi &
          VellumCommandHermesIntegrationApi
      >;
  }
}

export {};
