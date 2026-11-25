/**
 * A seat whose occupant is a program of this Junto build (a template with
 * `argvSpec.nodeHost`, the live overseer host): its entry `out/main/<name>.js`,
 * built beside the core's, run on the Node Junto runs on.
 *
 * The Node is the one automation code steps run on (`machineNodeRuntime`): a
 * source run's Electron as Node, or a Node the package ships. The entry is
 * the build in the working folder, where a source run's `dist/junto` is found
 * too (`juntoCliPathPrefixes`). A packaged app holds its build inside its
 * archive and ships no Node, so there the host does not resolve and the seat
 * is refused as not installed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { machineNodeRuntime, type CodeRuntime } from "../../automation/code-runner";

/** The command a node host seat spawns: the Node, then the entry, then the seat's own argv. */
export type NodeHostLaunch = {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export const nodeHostEntry = (name: string, cwd: string = process.cwd()): string =>
  join(cwd, "out", "main", `${name}.js`);

/** The node host `name` as a command, or undefined when this machine has no Node or no build of it. */
export const nodeHostLaunch = (
  name: string,
  cwd: string = process.cwd(),
  nodeRuntime: () => CodeRuntime | undefined = machineNodeRuntime,
): NodeHostLaunch | undefined => {
  const entry = nodeHostEntry(name, cwd);
  const runtime = nodeRuntime();
  if (runtime === undefined || !existsSync(entry)) return undefined;
  return { file: runtime.command, args: [entry], env: { ...runtime.env } };
};
