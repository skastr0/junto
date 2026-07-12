import type { ChassisApi, VellumApi } from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
    readonly vellum?: VellumApi;
  }
}

export {};
