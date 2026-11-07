/**
 * The terminal process (protect the main thread): an Electron utilityProcess
 * that holds every PTY, so a PTY's reads and writes never wait on Electron
 * main's or the core's event loop. It serves the core over a port main hands
 * it (`connect`), or over its parent port when the core runs in main; it
 * outlives a core that crashes, and decides nothing about seats.
 *
 * The whole program is `TerminalServer.layer` launched once, over the live
 * `PtySpawner`, `PidEpochs` and `CoreLink`. The parent's commands arrive as
 * `ParentFrame`s through `parentEdge` — a `connect` with its generation and
 * the core's port moved beside it, then a `shutdown`.
 */
import { createRequire } from "node:module";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Result, Runtime } from "effect";
import { parentEdge } from "../contract/terminal/edge";
import {
  type TerminalLink,
  type TerminalLinkMessage,
  type TerminalParentLink,
  type TerminalParentMessage,
} from "../contract/terminal/protocol";
import { CoreLink, PidEpochs, PtySpawner, TerminalServer, type SurfacePort } from "./serve";
import type { SurfaceIn } from "../contract/terminal/surface";
import { TerminalTracing } from "./tracing";

/** Electron's MessagePortMain, as a utilityProcess is given one. */
type PortMain = {
  readonly postMessage: (message: unknown, transfer?: readonly PortMain[]) => void;
  readonly on: (event: "message" | "close", listener: (event: PortEvent) => void) => void;
  readonly off: (event: "message" | "close", listener: (event: PortEvent) => void) => void;
  readonly start: () => void;
  readonly close: () => void;
};

type PortEvent = { readonly data: unknown; readonly ports?: readonly PortMain[] };

/** A link end: a whole port, or the parent's, which has no start or close of its own. */
type LinkEnd = Pick<PortMain, "postMessage" | "on" | "off"> & Partial<Pick<PortMain, "start" | "close">>;

const surfacePort = (port: PortMain): SurfacePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: PortEvent) => handler(event.data as SurfaceIn);
    port.on("message", on);
    port.start();
    return () => port.off("message", on);
  },
  close: () => port.close(),
});

/**
 * One core's port as this process serves it: the link's frames in and out.
 * The port moved beside a `surfaceOpen` arrives in `event.ports`, and is
 * already the surface's end when the server sees it; a port that closes says
 * `down`, as every link does. The parent's port stands in as a core too; its
 * parent commands are not this link's.
 */
const corePort = (port: LinkEnd): TerminalLink<SurfacePort> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the terminal process posts no port on the link");
  },
  listen: (handler) => {
    const on = (event: PortEvent) => {
      const message = event.data;
      if (typeof message !== "object" || message === null) return;
      if ((message as { readonly kind?: unknown }).kind === "parent") return;
      const surface = event.ports?.[0];
      handler(message as TerminalLinkMessage, surface === undefined ? undefined : surfacePort(surface));
    };
    const down = () => handler({ kind: "down", reason: "the core's port closed" }, undefined);
    port.on("message", on);
    port.on("close", down);
    port.start?.();
    return () => {
      port.off("message", on);
      port.off("close", down);
    };
  },
});

const parent = (process as unknown as { parentPort?: LinkEnd }).parentPort;

/**
 * The parent's port as this process hears its commands: only `ParentFrame`s
 * are the parent's; the link's own traffic reaches the parent port through
 * `parentAsCore` when it stands in as a core.
 */
const parentLink = (port: LinkEnd): TerminalParentLink<PortMain> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the terminal process posts no connect");
  },
  listen: (handler) => {
    const on = (event: PortEvent) => {
      const message = event.data;
      if (typeof message !== "object" || message === null) return;
      if ((message as { readonly kind?: unknown }).kind !== "parent") return;
      handler(message as TerminalParentMessage, event.ports?.[0]);
    };
    port.on("message", on);
    port.start?.();
    return () => port.off("message", on);
  },
});

/**
 * The parent's side, live on `process.parentPort`: the parent may stand in as
 * the first core, and each `connect` hands a later one over with its
 * generation until `shutdown` says the process is leaving.
 */
const coreLink = Layer.succeed(CoreLink, {
  parentAsCore: parent === undefined ? undefined : corePort(parent),
  listenParent: (handler) => {
    if (parent === undefined) return () => undefined;
    const edge = parentEdge<PortMain>({
      connect: (command, port) => handler(command, corePort(port)),
      shutdown: (command) => handler(command, undefined),
    });
    return parentLink(parent).listen((message, port) => {
      if (message.kind !== "parent") return;
      const refused = edge(message.message, port);
      if (Result.isFailure(refused)) {
        console.error(`[terminal] a parent command the link refuses reached it: ${refused.failure.tag} ${refused.failure.message}`);
      }
    });
  },
});

// node-pty stays a runtime load beside the installed file (app-process-plane.ts).
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePty = require("node-pty") as typeof import("node-pty");

const spawner = Layer.succeed(PtySpawner, (command, args, options) => nodePty.spawn(command, [...args], options));

const layer = TerminalServer.layer.pipe(Layer.provideMerge(Layer.mergeAll(spawner, PidEpochs.live, coreLink, TerminalTracing)));

/** The program: serve until the parent says `shutdown`, and every PTY's hangup was decided; then leave. */
const program = Effect.gen(function* () {
  const server = yield* TerminalServer;
  yield* server.quit;
});

// runMain leaves the process to end by itself on success, and the parent
// port's listener would hold it open until main kills it at its deadline:
// the quit is done here, so the process leaves with the program's code.
NodeRuntime.runMain(Effect.scoped(Effect.provide(program, layer)), {
  teardown: (exit, onExit) =>
    Runtime.defaultTeardown(exit, (code) => {
      onExit(code);
      process.exit(code);
    }),
});
