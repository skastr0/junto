import type {
  ChassisApi,
  VellumApi,
  VellumBrowserApi,
  VellumChatApi,
  VellumDemoApi,
  VellumHerdrApi,
  VellumSchedulerApi,
  VellumTerminalApi,
  VellumUsageApi,
} from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi &
      VellumChatApi &
      VellumTerminalApi &
      VellumDemoApi &
      Partial<
        VellumHerdrApi & VellumBrowserApi & VellumUsageApi & VellumSchedulerApi
      >;
  }
}

export {};
