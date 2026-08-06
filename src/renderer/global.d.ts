import type {
  ChassisApi,
  VellumCommandApi,
  VellumCommandBrowserApi,
  VellumCommandChatApi,
  VellumCommandDemoApi,
  VellumCommandHerdrApi,
  VellumCommandHermesIntegrationApi,
  VellumCommandSchedulerApi,
  VellumCommandTerminalApi,
  VellumCommandUsageApi,
} from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellumCommand?: VellumCommandApi &
      VellumCommandChatApi &
      VellumCommandTerminalApi &
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
