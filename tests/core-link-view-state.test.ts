/**
 * The view-state group over the core link (src/contract/core/link.ts): main's
 * typed client and the core's one server on the two ends of a MessageChannel,
 * the store on the real state engine and the production DDL. The template
 * every core group follows: a round trip with the push after the commit, a
 * request that comes before the server listens, and a request the core left
 * without answering.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { heldForServer, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { CoreLink } from "../src/contract/core/link";
import { ViewStateCore } from "../src/contract/core/view-state";
import { CoreClientsLive } from "../src/app/core-process/clients";
import { CoreServerLive } from "../src/core/link";
import { CorePushes } from "../src/core/push";
import { makeStateEngineLive } from "../src/core/state/engine";
import { ViewStateRepositoryLive } from "../src/core/view-state/repository";

const canvas = "main";

/** One end of the channel as a link; `down` is what main's host says when a core leaves. */
const linkOf = (port: MessagePort): RpcPort & { readonly down: (reason: string) => void } => {
  const local = new Set<(message: PortMessage) => void>();
  return {
    post: (message) => port.postMessage(message),
    listen: (handler) => {
      const on = (message: PortMessage) => handler(message);
      port.on("message", on);
      local.add(handler);
      return () => {
        port.off("message", on);
        local.delete(handler);
      };
    },
    down: (reason) => {
      for (const handler of local) handler({ kind: "down", reason });
    },
  };
};

let dir: string;
let core: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof machineAt>>, unknown>;
let mainScope: Scope.Closeable;
let ports: Array<MessagePort>;
let pushes: Array<readonly [string, unknown]>;

const machineAt = (root: string) => Layer.provideMerge(ViewStateRepositoryLive, makeStateEngineLive(join(root, "junto.db")));

/** The core's server on its end of the channel, in the core runtime's scope. */
const serve = (link: RpcPort) =>
  core.runPromise(
    Layer.buildWithScope(
      CoreServerLive.pipe(
        Layer.provide([
          Layer.succeed(CoreLink, link),
          Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushes.push([channel, payload])) }),
        ]),
      ),
      core.scope,
    ),
  );

/** Main's view-state client on its end of the channel. */
const clientOn = async (link: RpcPort) =>
  Context.get(
    await Effect.runPromise(Layer.buildWithScope(CoreClientsLive.pipe(Layer.provide(Layer.succeed(CoreLink, link))), mainScope)),
    ViewStateCore,
  );

const channel = () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return { main: linkOf(port1), core: linkOf(port2) };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-core-link-"));
  core = ManagedRuntime.make(machineAt(dir));
  mainScope = await Effect.runPromise(Scope.make());
  ports = [];
  pushes = [];
  await core.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at)
          VALUES (${canvas}, 'canvas-1', 'now', 'now')`;
        yield* sql`INSERT INTO artifact_boards
          (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
          VALUES (${canvas}, 'a', 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf')`;
      }),
    ),
  );
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(mainScope, Exit.void));
  await core.dispose();
  for (const port of ports) port.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the view-state group over the core link", () => {
  it("writes a row, publishes it after the commit, and reads it back; a row for a gone node is refused", async () => {
    const link = channel();
    await serve(heldForServer(link.core));
    const viewState = await clientOn(link.main);
    const write = { area: "sidebar", canvasName: canvas, nodeId: "a", collapsed: true } as const;

    expect(await Effect.runPromise(viewState.ViewStateApply({ write }))).toEqual({ ok: true });
    expect(pushes).toEqual([[IPC_CHANNELS.viewStateChanged, write]]);
    expect((await Effect.runPromise(viewState.ViewStateSnapshot())).nodes[canvas]?.a?.sidebarCollapsed).toBe(true);

    expect(await Effect.runPromise(viewState.ViewStateApply({ write: { ...write, nodeId: "ghost" } }))).toEqual({
      ok: false,
      error: "the node this row belongs to is gone; the row was not kept",
    });
    expect(pushes).toHaveLength(1);
  });

  it("answers a request that came before the server listened", async () => {
    const link = channel();
    // The core opens its held link with its port, and serves once it booted.
    const held = heldForServer(link.core);
    const viewState = await clientOn(link.main);
    const asked = Effect.runPromise(viewState.ViewStateSnapshot());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await serve(held);
    expect((await asked).nodes).toEqual({});
  });

  it("fails a request the core left without answering, with the client's error", async () => {
    const link = channel();
    const viewState = await clientOn(link.main);
    const asked = Effect.runPromiseExit(viewState.ViewStateSnapshot());
    await new Promise((resolve) => setTimeout(resolve, 20));
    link.main.down("the Junto core process exited with code 1");
    const exit = await asked;
    expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(Option.some("RpcClientError"));
  });
});
