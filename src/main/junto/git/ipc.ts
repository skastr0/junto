import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { GIT_LOG_LIMIT_DEFAULT } from "@shared/git";
import { readGitCommit, readGitLog, readGitReview, readGitShow, readGitStatus, readGitSummary } from "../adapters/git";

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asLimit = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : GIT_LOG_LIMIT_DEFAULT;

export const registerGitIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(IPC_CHANNELS.gitStatus, (_event, cwd: unknown) =>
    readGitStatus(asString(cwd)),
  );
  ipcMain.handle(IPC_CHANNELS.gitLog, (_event, cwd: unknown, limit: unknown) =>
    readGitLog(asString(cwd), asLimit(limit)),
  );
  ipcMain.handle(IPC_CHANNELS.gitShow, (_event, cwd: unknown, sha: unknown) =>
    readGitShow(asString(cwd), asString(sha)),
  );
  ipcMain.handle(IPC_CHANNELS.gitCommit, (_event, cwd: unknown, sha: unknown) =>
    readGitCommit(asString(cwd), asString(sha)),
  );
  ipcMain.handle(IPC_CHANNELS.gitSummary, (_event, cwd: unknown) =>
    readGitSummary(asString(cwd)),
  );
  ipcMain.handle(IPC_CHANNELS.gitReview, (_event, cwd: unknown, view: unknown) =>
    readGitReview(asString(cwd), view === "base" ? "base" : "working"),
  );
};
