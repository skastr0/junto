/**
 * Typed wrappers over the demo/scripting engine's EDL/state IPC surface
 * (window.vellumCommand.demoWriteEdl / demoState — see src/shared/demo.ts).
 * Only live when the app was launched with `demo: true` (VELLUM_COMMAND_DEMO=1);
 * off-demo the channels answer inert ok:false, never touching real state.
 */
import type { Page } from "@playwright/test";
import type { DemoEdl, DemoWriteEdlResult } from "../../src/shared/demo";

export const demoWriteEdl = (page: Page, edl: DemoEdl): Promise<DemoWriteEdlResult> =>
  page.evaluate((entry) => {
    if (!window.vellumCommand) throw new Error("window.vellumCommand unavailable — preload bridge missing");
    return window.vellumCommand.demoWriteEdl(entry);
  }, edl);

export const demoState = (page: Page): Promise<{ readonly active: boolean; readonly autoroll?: boolean }> =>
  page.evaluate(() => {
    if (!window.vellumCommand) throw new Error("window.vellumCommand unavailable — preload bridge missing");
    return window.vellumCommand.demoState();
  });
