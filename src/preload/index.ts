import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type ChassisApi } from "@shared/ipc";

const api: ChassisApi = {
  doctor: () => ipcRenderer.invoke(IPC_CHANNELS.doctor),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectFolder),
  readDirectory: (path) => ipcRenderer.invoke(IPC_CHANNELS.readDirectory, path),
  probeCodex: () => ipcRenderer.invoke(IPC_CHANNELS.probeCodex),
  prismDryRun: () => ipcRenderer.invoke(IPC_CHANNELS.prismDryRun),
};

contextBridge.exposeInMainWorld("chassis", api);
