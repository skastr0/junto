/**
 * The core's clients of main's host groups (`src/contract/host/`), one Layer
 * for the core runtime. The core entry builds them on its port to main; a
 * windowless core builds the same clients on `noWindowLink`, so the two cores
 * hold one type and a host call from a windowless core fails as a call no
 * main answered, naming what it asked for.
 */
import { Effect, Layer } from "effect";
import { ClipboardHost } from "../contract/host/clipboard";
import { FilesHost } from "../contract/host/files";
import { OverseerPagesHost } from "../contract/host/overseer-pages";
import { WindowHost } from "../contract/host/window";
import { HostLink } from "../contract/host/link";
import type { PortMessage, RpcPort } from "@shared/rpc-port";

export const HostClientsLive = Layer.mergeAll(ClipboardHost.layer, FilesHost.layer, OverseerPagesHost.layer, WindowHost.layer);
export type HostClients = Layer.Success<typeof HostClientsLive>;

/** What an encoded request names: its tag, read without trusting its shape. */
const requestTag = (data: unknown): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("_tag" in data) || data._tag !== "Request" || !("tag" in data)) return undefined;
  return typeof data.tag === "string" ? data.tag : undefined;
};

/**
 * A link with no main behind it: each request is answered with the port
 * saying its far end is not there, on the next microtask, as a far end that
 * left is heard after the request that met it.
 */
export const noWindowLink = (): RpcPort => {
  const handlers = new Set<(message: PortMessage) => void>();
  return {
    post: (message) => {
      if (message.kind !== "rpc") return;
      const tag = requestTag(message.data);
      if (tag === undefined) return;
      const reason = `${tag} needs the Junto app; this core runs without a window`;
      queueMicrotask(() => {
        for (const handler of handlers) handler({ kind: "down", reason });
      });
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
};

/** The windowless core's host: the same clients, on a link no main answers. */
export const HostClientsNoWindow = HostClientsLive.pipe(Layer.provide(Layer.effect(HostLink, Effect.sync(noWindowLink))));
