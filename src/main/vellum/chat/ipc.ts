import type { IpcMain, WebContents } from "electron";
import { IPC_CHANNELS, type ChatOpenResult, type ChatTurnResult } from "@shared/ipc";
import { ChatService } from "./service";

// Thin IPC pass-through onto ChatService. Exported as a factory, not
// self-registering: the orchestrator wires this into the app's ipcMain and
// live BrowserWindow set once, alongside the rest of src/main/vellum/ipc.ts.
// This module never calls registerChatIpc itself.
export const registerChatIpc = (
  ipcMain: IpcMain,
  webContentsGetter: () => Iterable<WebContents>,
  serviceSource: ChatService | Promise<ChatService>,
): Promise<ChatService> => {
  const service = Promise.resolve(serviceSource);
  void service.then((resolved) => {
    resolved.setEventSink((event) => {
      for (const contents of webContentsGetter()) {
        contents.send(IPC_CHANNELS.chatEvent, event);
      }
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.chatOpen,
    (
      _event,
      agentKey: string,
      resumeSessionId?: string,
      bindPin?: { readonly canvasName: string; readonly nodeId: string },
    ): Promise<ChatOpenResult> =>
      service.then((resolved) => resolved.chatOpen(agentKey, resumeSessionId, bindPin)),
  );

  ipcMain.handle(
    IPC_CHANNELS.chatPrompt,
    (_event, agentKey: string, text: string, contextBlocks?: ReadonlyArray<string>): Promise<ChatTurnResult> =>
      service.then((resolved) => resolved.chatPrompt(agentKey, text, contextBlocks)),
  );

  ipcMain.handle(IPC_CHANNELS.chatPermission, (_event, agentKey: string, requestId: string, optionId: string) =>
    service.then((resolved) => resolved.chatPermission(agentKey, requestId, optionId)),
  );

  ipcMain.handle(IPC_CHANNELS.chatSetModel, (_event, agentKey: string, modelId: string) =>
    service.then((resolved) => resolved.chatSetModel(agentKey, modelId)),
  );

  ipcMain.handle(IPC_CHANNELS.chatClose, (_event, agentKey: string) =>
    service.then((resolved) => resolved.chatClose(agentKey)),
  );

  return service;
};
