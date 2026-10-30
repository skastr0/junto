/**
 * The Automations pane's channels (plan 0.10/07). Every answer is a core
 * operation (`core-process/ops/ipc-automation.ts`), where the automation
 * store, the one write path and the content store live; every applied write
 * reaches the panes from there, the CLI's too.
 */
import type { IpcMain } from "electron";
import type {
  AutomationApplyResponse,
  AutomationCodePutResponse,
  AutomationCodeReadResponse,
  AutomationFiringsResponse,
  AutomationListResponse,
} from "@shared/automation";
import { IPC_CHANNELS } from "@shared/ipc";
import { core } from "../../core-process/main-client";

export const registerAutomationIpc = (ipcMain: Pick<IpcMain, "handle">): void => {
  ipcMain.handle(IPC_CHANNELS.automationList, (_event, canvasName: unknown, input: unknown): Promise<AutomationListResponse> =>
    core.call("ipc.automation.list", { canvasName, input }),
  );
  ipcMain.handle(IPC_CHANNELS.automationFirings, (_event, canvasName: unknown, input: unknown): Promise<AutomationFiringsResponse> =>
    core.call("ipc.automation.firings", { canvasName, input }),
  );
  ipcMain.handle(IPC_CHANNELS.automationApply, (_event, canvasName: unknown, input: unknown): Promise<AutomationApplyResponse> =>
    core.call("ipc.automation.apply", { canvasName, input }),
  );
  ipcMain.handle(IPC_CHANNELS.automationCodePut, (_event, canvasName: unknown, input: unknown): Promise<AutomationCodePutResponse> =>
    core.call("ipc.automation.codePut", { canvasName, input }),
  );
  ipcMain.handle(IPC_CHANNELS.automationCodeRead, (_event, canvasName: unknown, input: unknown): Promise<AutomationCodeReadResponse> =>
    core.call("ipc.automation.codeRead", { canvasName, input }),
  );
};
