import type {
  ChassisApi,
  VellumCommandApi,
  VellumCommandBrowserApi,
  VellumCommandChatApi,
  VellumCommandDemoApi,
  VellumCommandHermesIntegrationApi,
  VellumCommandHostsApi,
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
          VellumCommandBrowserApi &
          VellumCommandUsageApi &
          VellumCommandSchedulerApi &
          VellumCommandHermesIntegrationApi &
          VellumCommandHostsApi
      >;
  }
}

export {};
