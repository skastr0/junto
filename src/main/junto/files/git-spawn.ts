import { resolvedSpawnEnv, resolvedSpawnEnvSync } from "../adapters/exec";
import { spawnServiceChild } from "../../services/process";
import { makeNameSources, type GitRun, type NameSources } from "./sources";

/**
 * Git for the Files index, spawned by main on the process plane (every app
 * child is, so quit can end it). Its stdout goes on as raw chunks: main
 * never decodes or splits a 200k listing; the index worker does.
 */

const SOURCE = "files-index";

const spawnEnv = (): Promise<NodeJS.ProcessEnv> => resolvedSpawnEnv().catch(() => resolvedSpawnEnvSync());

export const spawnGit: GitRun = async (cwd, args, onBytes, signal, stdin) => {
  if (signal.aborted) return null;
  const child = spawnServiceChild({
    source: SOURCE,
    purpose: "files name index",
    command: "git",
    args: [...args],
    cwd,
    env: await spawnEnv(),
  });
  const abort = (): void => {
    void child.requestTermination();
  };
  signal.addEventListener("abort", abort, { once: true });
  child.io.stdout.on("data", (chunk: Buffer) => onBytes(chunk));
  child.io.stderr.resume();
  child.io.stdin.on("error", () => undefined);
  child.io.stdin.end(stdin);
  try {
    return (await child.io.exited).code;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** The sources with git spawned here: tests, and the in-process index. */
export const mainNameSources: NameSources = makeNameSources(spawnGit);
