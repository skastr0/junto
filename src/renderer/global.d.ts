import type {
  ChassisApi,
  VellumApi,
  VellumBrowserApi,
  VellumChatApi,
  VellumDemoApi,
  VellumHerdrApi,
  VellumTerminalApi,
} from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi &
      VellumChatApi &
      VellumHerdrApi &
      VellumBrowserApi &
      VellumTerminalApi &
      VellumDemoApi;
  }
}

export {};
