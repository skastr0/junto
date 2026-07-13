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
  service: ChatService = new ChatService(),
): ChatService => {
  service.setEventSink((event) => {
    for (const contents of webContentsGetter()) {
      contents.send(IPC_CHANNELS.chatEvent, event);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.chatOpen,
    (_event, agentKey: string, resumeSessionId?: string): Promise<ChatOpenResult> =>
      service.chatOpen(agentKey, resumeSessionId),
  );

  ipcMain.handle(
    IPC_CHANNELS.chatPrompt,
    (_event, agentKey: string, text: string, contextBlocks?: ReadonlyArray<string>): Promise<ChatTurnResult> =>
      service.chatPrompt(agentKey, text, contextBlocks),
  );

  ipcMain.handle(IPC_CHANNELS.chatPermission, (_event, agentKey: string, requestId: string, optionId: string) =>
    service.chatPermission(agentKey, requestId, optionId),
  );

  ipcMain.handle(IPC_CHANNELS.chatSetModel, (_event, agentKey: string, modelId: string) =>
    service.chatSetModel(agentKey, modelId),
  );

  ipcMain.handle(IPC_CHANNELS.chatClose, (_event, agentKey: string) => service.chatClose(agentKey));

  return service;
};
