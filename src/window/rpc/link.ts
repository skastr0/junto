/**
 * The page's end of its link to main (src/contract/window/link.ts). The page
 * listens for the port first, then asks the preload for it, so the port
 * cannot arrive before anyone listens. Requests posted before it arrives
 * wait and go in the order they were posted.
 *
 * A page without the preload's bridge (a gallery, a test's stand-in) has no
 * link: each request fails at once, as its post is refused.
 */
import { IPC_CHANNELS } from "@shared/ipc";
import type { PortMessage, RpcPortMessage, RpcPort } from "@shared/rpc-port";
import { perfStage } from "@shared/perf-stages";

type LinkBridge = { readonly openWindowLink?: () => void } | undefined;

export const pageLink = (bridge: LinkBridge, page: Window): RpcPort => {
  const handlers = new Set<(message: PortMessage) => void>();
  const deliver = (message: PortMessage): void => {
    if (message.kind === "rpcReply") {
      const data = message.data as { readonly requestId?: unknown; readonly _tag?: unknown };
      perfStage("renderer", "rpc-reply-arrived", {
        id: typeof data.requestId === "string" || typeof data.requestId === "number" ? data.requestId : undefined,
        op: typeof data._tag === "string" ? data._tag : undefined,
      });
    }
    for (const handler of handlers) handler(message);
  };
  const waiting: Array<RpcPortMessage> = [];
  let port: MessagePort | undefined;

  const arrived = (event: MessageEvent): void => {
    if (event.source !== page) return;
    const data = event.data as { readonly type?: unknown } | null;
    const moved = event.ports[0];
    if (data?.type !== IPC_CHANNELS.windowLink || moved === undefined) return;
    page.removeEventListener("message", arrived);
    port = moved;
    port.addEventListener("message", (message: MessageEvent) => deliver(message.data as PortMessage));
    port.start();
    for (const message of waiting.splice(0)) port.postMessage(message);
  };

  if (bridge?.openWindowLink === undefined) {
    return {
      // A refused post fails its request with the client's error (rpc-port.ts clientProtocol).
      post: () => {
        throw new Error("this page has no link to main: the preload bridge is not available");
      },
      listen: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
  }
  page.addEventListener("message", arrived);
  bridge.openWindowLink();
  return {
    post: (message) => {
      if (message.kind === "rpc") {
        const data = message.data as { readonly tag?: unknown; readonly id?: unknown };
        perfStage("renderer", "invoke-sent", {
          op: typeof data.tag === "string" ? data.tag : undefined,
          id: typeof data.id === "string" || typeof data.id === "number" ? data.id : undefined,
        });
      }
      if (port === undefined) waiting.push(message);
      else port.postMessage(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
};
