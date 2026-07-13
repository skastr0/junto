import type { ChassisApi, VellumApi, VellumChatApi } from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi & VellumChatApi;
  }
}

export {};
