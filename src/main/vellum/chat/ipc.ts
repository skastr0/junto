import type { IpcMain, WebContents } from "electron";
import {
  IPC_CHANNELS,
  type ChatFinishNodeDeleteOutcome,
  type ChatOpenResult,
  type ChatTurnResult,
  type NodeDeleteResource,
} from "@shared/ipc";
import { NodeDeleteService } from "./node-delete";
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
  const nodeDelete = service.then((resolved) => new NodeDeleteService(resolved));
  void service.then((resolved) => {
    resolved.setEventSink((event) => {
      let recipients: ReadonlyArray<WebContents>;
      try {
        recipients = [...webContentsGetter()];
      } catch {
        return;
      }
      for (const contents of recipients) {
        try {
          if (contents.isDestroyed()) continue;
          contents.send(IPC_CHANNELS.chatEvent, event);
        } catch {
          // One stale/crashing renderer cannot block delivery to its siblings
          // or escape into the process lifecycle callback.
        }
      }
    });
  }).catch(() => {
    // Handler registration below retains the rejected service promise for
    // callers; this observer must not become an unhandled rejection.
  });

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
