import type { ChassisApi } from "@shared/ipc";

declare global {
  interface Window {
    readonly chassis?: ChassisApi;
  }
}

export {};
