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
import { licensedRendererIpc } from "../license/admission";

export const registerDemoIpcHandlers = (): void => {
  const privilegedIpc = licensedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.demoState, () => ({
    active: isDemoMode(),
    autoroll: isDemoMode() && process.env.VELLUM_DEMO_AUTOROLL === "1",
  }));

  privilegedIpc.handle(IPC_CHANNELS.demoCommand, (_event, command: DemoCommand) => {
    if (!isDemoMode()) return { ok: false, error: "demo mode off" };
    return applyDemoCommand(command);
  });

  privilegedIpc.handle(IPC_CHANNELS.demoWriteEdl, (_event, edl: DemoEdl) => {
    if (!isDemoMode()) return { ok: false, error: "demo mode off" };
    return writeDemoEdl(edl);
  });
};
