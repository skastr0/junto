/**
 * Demo/scripting engine IPC surface (--vellum-demo only; inert otherwise).
 * Handlers are ALWAYS registered so the renderer's demoState probe never
 * hangs waiting on a missing channel — behavior is flag-gated, not
 * registration.
 */
import { ipcMain } from "electron";
import type { DemoEdl } from "@shared/demo";
import { IPC_CHANNELS } from "@shared/ipc";
import { isDemoMode } from "./mode";
import { writeDemoEdl } from "./service";
import { trustedRendererIpc } from "../trusted-main-webcontents";

export const registerDemoIpcHandlers = (): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.demoState, () => ({
    active: isDemoMode(),
    autoroll: isDemoMode() && process.env.VELLUM_COMMAND_DEMO_AUTOROLL === "1",
    scenarioId: isDemoMode() ? process.env.VELLUM_COMMAND_DEMO_SCENARIO : undefined,
  }));

  privilegedIpc.handle(IPC_CHANNELS.demoWriteEdl, (_event, edl: DemoEdl) => {
    if (!isDemoMode()) return { ok: false, error: "demo mode off" };
    return writeDemoEdl(edl);
  });
};
