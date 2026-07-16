import type { ChassisApi, VellumApi, VellumChatApi, VellumHerdrApi } from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi & VellumChatApi & VellumHerdrApi;
  }
}

export {};
