import type { ChatChromeChanged } from "@shared/chat-chrome";
import type { IpcMain, WebContents } from "electron";
import {
  IPC_CHANNELS,
  type ChatEvent,
  type ChatFinishNodeDeleteOutcome,
  type ChatOpenResult,
  type ChatTurnResult,
  type NodeDeleteResource,
} from "@shared/ipc";
import { ChatService } from "./service";

// Thin IPC pass-through onto ChatService. Exported as a factory, not
// self-registering: the orchestrator wires this into the app's ipcMain and
// live BrowserWindow set once, alongside the rest of src/main/junto/ipc.ts.
// This module never calls registerChatIpc itself.
export const registerChatIpc = (
  ipcMain: IpcMain,
  webContentsGetter: () => Iterable<WebContents>,
  serviceSource: ChatService | Promise<ChatService>,
): Promise<ChatService> => {
  const service = Promise.resolve(serviceSource);
  const nodeDelete = service.then((resolved) => resolved.nodeDelete);
  const broadcast = (channel: string, event: ChatEvent | ChatChromeChanged): void => {
    let recipients: ReadonlyArray<WebContents>;
    try { recipients = [...webContentsGetter()]; } catch { return; }
    for (const contents of recipients) {
      try {
        if (!contents.isDestroyed()) contents.send(channel, event);
      } catch {
        // One stale renderer cannot block its siblings or session cleanup.
      }
    }
  };
  void service.then((resolved) => {
    resolved.setEventSink((event) => broadcast(IPC_CHANNELS.chatEvent, event));
    resolved.subscribeChromeChanges((event) => broadcast(IPC_CHANNELS.chatChromeChanged, event));
  }).catch(() => {
    // Registered handlers retain service failures for their callers.
  });
  ipcMain.handle(IPC_CHANNELS.chatChrome, () => service.then((resolved) => resolved.chromeSnapshot()));

  ipcMain.handle(
    IPC_CHANNELS.chatOpen,
    (_event, agentKey: string, resumeSessionId?: string): Promise<ChatOpenResult> =>
      service.then((resolved) => resolved.chatOpen(agentKey, resumeSessionId)),
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

  ipcMain.handle(
    IPC_CHANNELS.chatBeginNodeDelete,
    (_event, resources: ReadonlyArray<NodeDeleteResource>) =>
      nodeDelete.then((resolved) => resolved.beginNodeDelete(resources)),
  );

  ipcMain.handle(
    IPC_CHANNELS.chatFinishNodeDelete,
    (_event, leaseId: string, outcome: ChatFinishNodeDeleteOutcome) =>
      nodeDelete.then((resolved) => resolved.finishNodeDelete(leaseId, outcome)),
  );

  return service;
};
