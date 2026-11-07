import { isAbsolute, join } from "node:path";
// A namespace import: this module shares a chunk the core process loads, where
// electron has no main-only exports, so no named binding may be checked at load.
import * as electron from "electron";
import type { MessagePortMain, UtilityProcess } from "electron";
import { Effect, Option, Schema } from "effect";
import type { PortedCoreMessage } from "./main-side/term-surface";
import type { CoreBoot } from "../../core/entry";
import { portPushes, type CoreMessage, type PortPushes } from "../../contract/core/port";
import { heldForServer, peersLink, type LinkedPeer, type RpcPort } from "@shared/rpc-port";

/**
 * Main's side of the core process (Wave 3). It forks `entry.ts` as an
 * Electron utilityProcess, hands it what only `app` knows, and gives main the
 * core's pushes and the links its RPC groups ride, which survive a restart: a
 * request in flight when the core stops fails, and the next request waits for
 * the new core. A core that keeps stopping is started again after 1 s,
 * doubling to 30 s. A core that has not said `core.ready` 120 s after its fork
 * is killed, so a boot that neither finishes nor exits fails its waiting
 * requests and starts again.
 */

/**
 * The entry a boot forks: the build beside main's index.js, unless an E2E
 * scenario asks for its own entry (a core that fails at boot) through
 * JUNTO_E2E_CORE_ENTRY. The override is read only in an E2E run and only as
 * an absolute path, so a product run can fork nothing but its own build.
 */
const coreEntryFor = (boot: CoreBoot): string => {
  const override = process.env.JUNTO_E2E === "1" ? process.env.JUNTO_E2E_CORE_ENTRY : undefined;
  return override !== undefined && isAbsolute(override)
    ? override
    : join(boot.app.appPath, "out", "main", "core-process.js");
};

const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const RESTART_SETTLED_MS = 60_000;
const BOOT_DEADLINE_MS = 120_000;
/**
 * How long a stopping core has to finish its own drain before main takes it
 * down. The bound is set from the core's own bounds, because a healthy drain
 * must never be killed for taking its time: an operator command in flight
 * holds owner.close() for up to REQUEST_TIMEOUT_MS = 30 s
 * (junto/operator-control/server.ts:67), work control drains in 2 s
 * (junto/work/control.ts:2606), canvas control in 5 s
 * (junto/canvas-control/server.ts:81), the terminal plane in 5 s
 * (junto/term/plane.ts:66) and the authoring gate in 5 s (junto/core.ts:186).
 * That is 47 s before the unbounded steps (link listener close, runtime
 * dispose, service children); 60 s leaves room and still ends a hung core.
 */
const STOP_DEADLINE_MS = 60_000;

/** The core did not leave within its stop bound; the quit reports this, never swallows it. */
export class CoreDidNotStop extends Schema.TaggedError<CoreDidNotStop>()("CoreDidNotStop", {
  detail: Schema.String,
}) {}

/**
 * The child's `exit`, as an effect: a stop waits on it, and drops the listener
 * if it is interrupted. `gone` answers a child that already left, so a stop
 * that signalled first never waits for an exit it missed.
 */
const exited = (child: UtilityProcess, gone: () => boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (gone()) {
      resume(Effect.void);
      return;
    }
    const onExit = (): void => resume(Effect.void);
    child.once("exit", onExit);
    return Effect.sync(() => {
      child.off("exit", onExit);
    });
  });

export const startCoreProcess = (boot: CoreBoot): PortPushes & {
  /**
   * Signal the core to stop and finish when it has left. Its drain runs in its
   * own process (entry.ts answers SIGTERM with core.close() then exit); this
   * waits for that exit, bounded, and fails tagged when it does not come.
   */
  readonly stop: () => Effect.Effect<void, CoreDidNotStop>;
  /** A port transferred to the core beside its message (a surface, or a push such as pty.connect); false when no core is running. */
  readonly postSurface: (message: PortedCoreMessage, port: unknown) => boolean;
  /** The link the core's RPC groups ride (src/contract/core/link.ts): it outlives a restart, and says `down` when a core leaves. */
  readonly link: RpcPort;
  /**
   * The link main's host server answers the core on (src/contract/host/link.ts).
   * Each core joins it as it starts and leaves it as it exits, so a reply
   * reaches only the core that asked; a request that comes before the server
   * listens waits for it.
   */
  readonly hostLink: RpcPort;
} => {
  let child: UtilityProcess | undefined;
  let stopping = false;
  /** Children that have already emitted `exit`; their parent waits on nothing. */
  const gone = new WeakSet<UtilityProcess>();
  let stops = 0;
  let startedAt = 0;
  const handlers = new Set<(message: CoreMessage) => void>();
  // Between a core's exit and its restart, requests wait here for the next
  // core; after stop there is no next one, so a request fails at once.
  const held: CoreMessage[] = [];
  const pushes = portPushes({
    post: () => undefined,
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });

  // RPC's side of the port. A request made while no core runs waits for the
  // next one; one made after stop is refused at once. A core that leaves says
  // `down`, and every request it held fails.
  const down = (reason: string): void => {
    for (const handler of handlers) handler({ kind: "down", reason });
  };
  const link: RpcPort = {
    post: (message) => {
      if (stopping) throw new Error("the Junto core process has stopped");
      if (child !== undefined) return child.postMessage(message);
      held.push(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  // The host groups' side of the same port: each core numbers its clients
  // from its own start, so every core joins the peers link with its own ids.
  const peers = peersLink();
  const hostLink = heldForServer(peers.link);

  let booting: ReturnType<typeof setTimeout> | undefined;
  pushes.onPush("core.ready", () => {
    clearTimeout(booting);
    booting = undefined;
  });

  const start = (): void => {
    if (stopping) return;
    // The entry is built beside main's index.js (electron.vite.config.ts), while
    // this module lands in a chunk under out/main/chunks: resolve from boot's app root.
    const forked = electron.utilityProcess.fork(coreEntryFor(boot), [JSON.stringify(boot)], { serviceName: "Junto Core", stdio: "inherit" });
    child = forked;
    const peer: LinkedPeer = peers.join((message) => forked.postMessage(message));
    startedAt = Date.now();
    for (const message of held.splice(0)) forked.postMessage(message);
    booting = setTimeout(() => {
      if (child === forked) forked.kill();
    }, BOOT_DEADLINE_MS);
    booting.unref();
    forked.on("message", (received: CoreMessage) => {
      // A request of the core's to main's host server goes to the server alone.
      if (received.kind === "rpc") return peer.deliver(received);
      for (const handler of handlers) handler(received);
    });
    forked.once("exit", (code) => {
      gone.add(forked);
      peer.leave();
      if (child !== forked) return;
      clearTimeout(booting);
      booting = undefined;
      child = undefined;
      down(`the Junto core process exited with code ${code}`);
      if (stopping) return;
      if (Date.now() - startedAt > RESTART_SETTLED_MS) stops = 0;
      setTimeout(start, Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** stops)).unref();
      stops += 1;
    });
  };

  start();
  return {
    ...pushes,
    link,
    hostLink,
    postSurface: (message, port) => {
      if (child === undefined) return false;
      child.postMessage(message, [port as MessagePortMain]);
      return true;
    },
    stop: () => {
      stopping = true;
      held.length = 0;
      const leaving = child;
      if (leaving === undefined) {
        down("the Junto core process has stopped");
        return Effect.void;
      }
      // Signal now, not inside the effect: stop must take effect whether or
      // not the caller runs what it returns. The effect only waits for the
      // exit, which entry.ts produces after its own drain.
      leaving.kill();
      return Effect.suspend(() =>
        exited(leaving, () => gone.has(leaving)).pipe(
          Effect.timeoutOption(STOP_DEADLINE_MS),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.sync(() => leaving.kill()).pipe(
                  Effect.andThen(
                    Effect.fail(new CoreDidNotStop({
                      detail: `the Junto core process did not exit within ${STOP_DEADLINE_MS} ms of its stop; killed`,
                    })),
                  ),
                ),
            }),
          ),
        ),
      );
    },
  };
};
