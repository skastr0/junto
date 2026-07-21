/**
 * Typed wrappers over the demo/scripting engine's IPC surface
 * (window.vellum.demoCommand / demoWriteEdl — see src/shared/demo.ts).
 * Only live when the app was launched with `demo: true` (VELLUM_DEMO=1);
 * off-demo the channels answer inert ok:false, never touching real state.
 */
import type { Page } from "@playwright/test";
import type { DemoCommand, DemoCommandResult, DemoEdl, DemoWriteEdlResult } from "../../src/shared/demo";

export const demoCommand = (page: Page, command: DemoCommand): Promise<DemoCommandResult> =>
  page.evaluate((cmd) => {
    if (!window.vellum) throw new Error("window.vellum unavailable — preload bridge missing");
    return window.vellum.demoCommand(cmd);
  }, command);

export const demoWriteEdl = (page: Page, edl: DemoEdl): Promise<DemoWriteEdlResult> =>
  page.evaluate((entry) => {
    if (!window.vellum) throw new Error("window.vellum unavailable — preload bridge missing");
    return window.vellum.demoWriteEdl(entry);
  }, edl);

export const demoState = (page: Page): Promise<{ readonly active: boolean; readonly autoroll?: boolean }> =>
  page.evaluate(() => {
    if (!window.vellum) throw new Error("window.vellum unavailable — preload bridge missing");
    return window.vellum.demoState();
  });
