/**
 * The Junto core in its own Electron utilityProcess (Wave 3, protect the main
 * thread). It boots the same graph the machine core boots (`startCore`), so
 * the business writer, the sockets, the link, the kernel and the mail all run
 * here and none on Electron main. It answers main's named operations over the
 * parent port and sends every published change back on the same port, in
 * order.
 *
 * Main passes what only Electron's `app` knows as one JSON argument
 * (`CoreBoot`), because this process has no `app`.
 */
import { getCompiledMachineReleaseCatalog } from "@shared/machine-release";
import { makeMachineBundleSources } from "../junto/hosts/machine-bundle-download";
import { startCore } from "../junto/core";
import { serveCore, type CoreMessage, type CorePort } from "./port";
import { forwardPublishes } from "./push";
import { useHostClient } from "./host-ops";
import "./ops/index";

export type CoreBoot = {
  readonly home: string;
  readonly build: string;
  /** Where the packaged machine bundles sit, when no release catalog is compiled in. */
  readonly bundlesRoot: string;
};

type ParentPort = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
  readonly off: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
};

const parentPortOf = (): ParentPort | undefined => (process as unknown as { parentPort?: ParentPort }).parentPort;

export const parentCorePort = (parent: ParentPort): CorePort => ({
  post: (message) => parent.postMessage(message),
  listen: (handler) => {
    const on = (event: { readonly data: unknown }) => handler(event.data as CoreMessage);
    parent.on("message", on);
    return () => parent.off("message", on);
  },
});

const main = async (parent: ParentPort): Promise<void> => {
  const boot = JSON.parse(process.argv.at(-1) ?? "{}") as CoreBoot;
  const core = await startCore({
    home: boot.home,
    build: boot.build,
    ...makeMachineBundleSources({
      home: boot.home,
      build: boot.build,
      catalog: getCompiledMachineReleaseCatalog(),
      localRoot: () => boot.bundlesRoot,
    }),
  });
  const served = serveCore(parentCorePort(parent), core.runtime);
  forwardPublishes(served.push);
  useHostClient(served.host);
  served.push("core.ready", {});
  const stop = (): void => {
    void core.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
};

const parent = parentPortOf();
if (parent !== undefined) {
  void main(parent).catch((cause: unknown) => {
    console.error("[core] Junto core failed to start in its process", cause);
    process.exit(1);
  });
}
