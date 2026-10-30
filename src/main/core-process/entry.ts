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
import type { CoreRunner } from "./client";
import { forwardPublishes } from "./push";
import { host, useHostClient } from "./host-ops";
import { hostCaptureApplicationPage, hostOverseerPages } from "./ops/overseer-pages";
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
  // The port opens before the core boots: what boots may already ask main and
  // publish, and a call from main waits until the core can run it.
  let started!: (runner: CoreRunner) => void;
  const served = serveCore(parentCorePort(parent), new Promise<CoreRunner>((resolve) => { started = resolve; }));
  forwardPublishes(served.push);
  useHostClient(served.host);
  const core = await startCore({
    home: boot.home,
    build: boot.build,
    canvasControl: true,
    overseer: { captureApplicationPage: hostCaptureApplicationPage(host), pages: hostOverseerPages(host) },
    ...makeMachineBundleSources({
      home: boot.home,
      build: boot.build,
      catalog: getCompiledMachineReleaseCatalog(),
      localRoot: () => boot.bundlesRoot,
    }),
  });
  started(core.runtime);
  served.push("core.ready", {});
  const stop = (): void => {
    // Main stops the core; nothing will answer a host call still out.
    served.failHost("Electron main stopped the Junto core");
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
