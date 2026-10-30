import type { ApplicationCaptureResult } from "../junto/overseer/native";
import type { OverseerPages } from "../junto/overseer/pages";
import type { CoreBoot } from "./entry";
import { startCoreProcess } from "./host";
import { useCoreClient } from "./main-client";
import { relayWindowPushes } from "./ops/main-index";
import { serveOverseerHost } from "./ops/overseer-pages";
import type { PortCoreClient } from "./port";

/**
 * Every hookup main makes to a core in its own process, in one place (Wave 3):
 * start the process, send main's calls to it, carry its window pushes onto
 * main's bus, and answer what it asks of Electron. Each boot piece that moves
 * into the core adds its main-side half here, so turning the core process on
 * is this one call.
 */
export type CoreProcessForMain = {
  readonly client: PortCoreClient;
  readonly stop: () => void;
};

export const startCoreProcessForMain = (input: {
  readonly boot: CoreBoot;
  /** The browser the overseer drives, once the browser composition bound it. */
  readonly pages: () => OverseerPages | undefined;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  /** Tests start a core over a MessageChannel instead of a utilityProcess. */
  readonly start?: (boot: CoreBoot) => PortCoreClient & { readonly stop: () => void };
}): CoreProcessForMain => {
  const started = (input.start ?? startCoreProcess)(input.boot);
  useCoreClient(started);
  const stopRelay = relayWindowPushes(started);
  const stopHost = serveOverseerHost({ core: started, pages: input.pages, captureApplicationPage: input.captureApplicationPage });
  return {
    client: started,
    stop: () => {
      stopHost();
      stopRelay();
      started.stop();
    },
  };
};
