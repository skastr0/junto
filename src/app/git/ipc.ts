import type { IpcMain } from "electron";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { GIT_LOG_LIMIT_DEFAULT } from "@shared/git";
import { GitCore } from "../../contract/core/git";
import { AppRuntime } from "../runtime";

// The reads run in the core, where a `git` spawn belongs (src/contract/core/git.ts);
// main keeps the channel and the argument shapes. `cwd` is the node's folder,
// validated there against the node, and every answer is the adapter's own
// result type.

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asLimit = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : GIT_LOG_LIMIT_DEFAULT;

export const registerGitIpc = (ipcMain: IpcMain, core: Context.Context<GitCore>): void => {
  const git = Context.get(core, GitCore);
  ipcMain.handle(IPC_CHANNELS.gitStatus, (_event, cwd: unknown) =>
    AppRuntime.runPromise(git.GitStatus({ cwd: asString(cwd) })),
  );
  ipcMain.handle(IPC_CHANNELS.gitLog, (_event, cwd: unknown, limit: unknown) =>
    AppRuntime.runPromise(git.GitLog({ cwd: asString(cwd), limit: asLimit(limit) })),
  );
  ipcMain.handle(IPC_CHANNELS.gitShow, (_event, cwd: unknown, sha: unknown) =>
    AppRuntime.runPromise(git.GitShow({ cwd: asString(cwd), sha: asString(sha) })),
  );
  ipcMain.handle(IPC_CHANNELS.gitCommit, (_event, cwd: unknown, sha: unknown) =>
    AppRuntime.runPromise(git.GitCommit({ cwd: asString(cwd), sha: asString(sha) })),
  );
  ipcMain.handle(IPC_CHANNELS.gitSummary, (_event, cwd: unknown) =>
    AppRuntime.runPromise(git.GitSummary({ cwd: asString(cwd) })),
  );
  ipcMain.handle(IPC_CHANNELS.gitReview, (_event, cwd: unknown, view: unknown) =>
    AppRuntime.runPromise(git.GitReview({ cwd: asString(cwd), view: view === "base" ? "base" : "working" })),
  );
};
