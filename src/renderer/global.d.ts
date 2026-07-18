import type {
  ChassisApi,
  VellumApi,
  VellumBrowserApi,
  VellumBrowserAutomationApi,
  VellumChatApi,
  VellumDemoApi,
  VellumHerdrApi,
} from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi &
      VellumChatApi &
      VellumHerdrApi &
      VellumBrowserApi &
      VellumBrowserAutomationApi &
      VellumDemoApi;
  }
}

export {};
