import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FilesNodeRef } from "@shared/files";
import { resolveJuntoHome } from "@shared/junto-home";
import type { FilesNodeFacts } from "./service";

/**
 * The Files service's deps that need no Electron (0.12, X1c0): what the app
 * and a windowless machine's core both hand `makeFilesService`. The app adds
 * its shell and its windows (`ipc.ts`); a windowless core adds a trash that
 * needs no shell (`trash-move.ts`) and the link as the place events go.
 */

export const nodeFacts = async (ref: FilesNodeRef): Promise<FilesNodeFacts | undefined> => {
  const { coreReads } = await import("../../core-runner");
  const canvas = await coreReads.canvas(ref.canvas);
  const node = canvas?.nodes.get(ref.node);
  return node?.kind === "files" ? { host: node.host, root: node.root } : undefined;
};

/** Junto's own home, refused inside every root. Read once: it does not move while Junto runs. */
let denied: Promise<ReadonlyArray<string>> | undefined;
export const deny = (): Promise<ReadonlyArray<string>> => {
  denied ??= realpath(join(resolveJuntoHome(), ".junto")).then(
    (real) => [real],
    () => [join(resolveJuntoHome(), ".junto")],
  );
  return denied;
};

export const machineName = async (): Promise<string> => {
  const { coreReads } = await import("../../core-runner");
  return coreReads.machineName();
};
