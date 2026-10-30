import { hostOps } from "./host-ops";
import { TERMINAL_CONNECT } from "../terminal-process/protocol";
import type { TerminalProcessForCore } from "../terminal-process/host";
import type {} from "../terminal-process/core-side";
import type { ApplicationCaptureResult } from "../junto/overseer/native";
import type { OverseerPages } from "../junto/overseer/pages";
import type { CoreBoot } from "./entry";
import { startCoreProcess } from "./host";
import { useCoreClient } from "./main-client";
import { relayWindowPushes } from "./ops/main-index";
import { serveOverseerHost } from "./ops/overseer-pages";
import { serveCompanionClipboard } from "./ops/companion";
import { coreSurfacePlane, useCoreSurfacePlane, type PortedCoreMessage } from "./ops/term-surface";
import type { CompanionClipboard } from "../junto/companion/service";
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
  /** The system clipboard, for the phone companion's Copy link. */
  readonly clipboard: CompanionClipboard;
  /** Tests start a core over a MessageChannel instead of a utilityProcess. */
  readonly start?: (boot: CoreBoot) => PortCoreClient & { readonly stop: () => void; readonly postSurface?: (message: PortedCoreMessage, port: unknown) => boolean };
  /** The terminal process the core's plane drives: main hands the core each port to it. */
  readonly terminals?: TerminalProcessForCore;
}): CoreProcessForMain => {
  const started = (input.start ?? startCoreProcess)(input.boot);
  useCoreClient(started);
  const stopRelay = relayWindowPushes(started);
  const stopHost = serveOverseerHost({ core: started, pages: input.pages, captureApplicationPage: input.captureApplicationPage });
  const stopClipboard = serveCompanionClipboard(input.clipboard);
  // The terminal plane is the core's: each view's surface port rides to it.
  const postSurface = started.postSurface;
  if (postSurface !== undefined) {
    useCoreSurfacePlane(coreSurfacePlane({ postSurface, onPush: started.onPush, call: (name, request) => started.call(name, request) }));
  }
  // The core asks for its port to the terminal process as it boots, and is
  // handed a new one each time the terminal process starts again.
  const terminals = input.terminals;
  const giveTerminals = (): boolean =>
    terminals !== undefined && postSurface !== undefined &&
    postSurface({ kind: "push", channel: TERMINAL_CONNECT, payload: {} }, terminals.connect());
  const stopTerminalHost = hostOps({ "terminal.connect": async () => giveTerminals() });
  const stopRestart = terminals?.onRestart(() => void giveTerminals()) ?? (() => undefined);
  return {
    client: started,
    stop: () => {
      stopRestart();
      stopTerminalHost();
      useCoreSurfacePlane(undefined);
      stopClipboard();
      stopHost();
      stopRelay();
      started.stop();
    },
  };
};
