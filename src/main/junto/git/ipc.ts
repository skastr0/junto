import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { GIT_LOG_LIMIT_DEFAULT } from "@shared/git";
import { core } from "../../core-process/main-client";

// The reads run in the core, where a `git` spawn belongs; main keeps the
// channel and the argument shapes. `cwd` is the node's folder, validated there
// against the node, and every answer is the adapter's own result type.

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asLimit = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : GIT_LOG_LIMIT_DEFAULT;

export const registerGitIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(IPC_CHANNELS.gitStatus, (_event, cwd: unknown) =>
    core.call("git.status", { cwd: asString(cwd) }),
  );
  ipcMain.handle(IPC_CHANNELS.gitLog, (_event, cwd: unknown, limit: unknown) =>
    core.call("git.log", { cwd: asString(cwd), limit: asLimit(limit) }),
  );
  ipcMain.handle(IPC_CHANNELS.gitShow, (_event, cwd: unknown, sha: unknown) =>
    core.call("git.show", { cwd: asString(cwd), sha: asString(sha) }),
  );
  ipcMain.handle(IPC_CHANNELS.gitCommit, (_event, cwd: unknown, sha: unknown) =>
    core.call("git.commit", { cwd: asString(cwd), sha: asString(sha) }),
  );
  ipcMain.handle(IPC_CHANNELS.gitSummary, (_event, cwd: unknown) =>
    core.call("git.summary", { cwd: asString(cwd) }),
  );
  ipcMain.handle(IPC_CHANNELS.gitReview, (_event, cwd: unknown, view: unknown) =>
    core.call("git.review", { cwd: asString(cwd), view: view === "base" ? "base" : "working" }),
  );
};
