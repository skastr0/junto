/**
 * Demo/scripting engine IPC surface (--vellum-demo only; inert otherwise).
 * Handlers are ALWAYS registered so the renderer's demoState probe never
 * hangs waiting on a missing channel — behavior is flag-gated, not
 * registration.
 */
import { ipcMain } from "electron";
import type { DemoCommand, DemoEdl } from "@shared/demo";
import { IPC_CHANNELS } from "@shared/ipc";
import { isDemoMode } from "./mode";
import { applyDemoCommand, writeDemoEdl } from "./service";

export const registerDemoIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.demoState, () => ({ active: isDemoMode() }));

  ipcMain.handle(IPC_CHANNELS.demoCommand, (_event, command: DemoCommand) => {
    if (!isDemoMode()) return { ok: false, error: "demo mode off" };
    return applyDemoCommand(command);
  });

  ipcMain.handle(IPC_CHANNELS.demoWriteEdl, (_event, edl: DemoEdl) => {
    if (!isDemoMode()) return { ok: false, error: "demo mode off" };
    return writeDemoEdl(edl);
  });
};
