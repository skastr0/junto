/**
 * The browser store group (src/contract/core/browser-store.ts) over a
 * MessageChannel, the core's handlers on the real state engine and the
 * production DDL: main's touched-origin store and profile registry store
 * (core-process/main-side/browser.ts) keep their rows in the core, a
 * registry refusal keeps its code as it crosses, and a call the core left
 * without answering is asked again of the core that comes back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, ManagedRuntime, Result, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { heldForServer, serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { BrowserStoreCore, BrowserStoreRpcs } from "../src/contract/core/browser-store";
import { CoreLink } from "../src/contract/core/link";
import { BrowserStoreHandlers } from "../src/core/ops/browser";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeBrowserTouchedOriginStore } from "../src/node/browser/touched-origins";
import { makeSqlBrowserProfileStore, type BrowserProfileStateReady } from "../src/node/browser/profiles";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { coreBrowserProfileStore, coreTouchedOriginStore } = await import("../src/app/core-process/main-side/browser");

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

const AT = "2026-01-01T00:00:00.000Z";
const initial: BrowserProfileStateReady = {
  phase: "ready",
  defaultProfile: "personal",
  canvasDefaults: {},
  maxWarmSessions: 5,
  maxVisibleSurfaces: 3,
  profiles: [
    { id: "personal", createdAt: AT },
    { id: "work", createdAt: AT },
  ],
};

let dir: string;
let core: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeStateEngineLive>>, unknown>;
let mainScope: Scope.Closeable;
let ports: Array<MessagePort>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-browser-store-"));
  core = ManagedRuntime.make(makeStateEngineLive(join(dir, "junto.db")));
  mainScope = await Effect.runPromise(Scope.make());
  ports = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(mainScope, Exit.void));
  await core.dispose();
  for (const port of ports) port.close();
  await rm(dir, { recursive: true, force: true });
});

/** The core's server on its end of the link, in the core runtime's scope. */
const serve = (link: RpcPort) =>
  core.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(BrowserStoreRpcs).pipe(
        Layer.provide(BrowserStoreHandlers),
        Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(link))),
      ),
      core.scope,
    ),
  );

const clientOn = (link: RpcPort): Promise<Context.Context<BrowserStoreCore>> =>
  Effect.runPromise(Layer.buildWithScope(BrowserStoreCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, link))), mainScope));

const channel = () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return { main: linkOf(port1), core: linkOf(port2) };
};

it("keeps the touched origins in the core's rows, as main's store writes them", async () => {
  const link = channel();
  await serve(heldForServer(link.core));
  const store = coreTouchedOriginStore(await clientOn(link.main));
  await store.record({ profile: "personal", origin: "https://a.example.com" });
  await store.record({ profile: "personal", origin: "https://a.example.com" });
  await store.record({ profile: "work", origin: "https://b.example.com" });
  const rows = await core.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.promise(() => makeBrowserTouchedOriginStore(sql).list())));
  expect(rows).toEqual([
    { profile: "personal", origin: "https://a.example.com" },
    { profile: "work", origin: "https://b.example.com" },
  ]);
  await store.remove([{ profile: "personal", origin: "https://a.example.com" }]);
  await store.removeProfile("work");
  expect(await store.list()).toEqual([]);
});

it("runs the profile registry's transactions in the core, with each refusal's code kept", async () => {
  const link = channel();
  await serve(heldForServer(link.core));
  const store = coreBrowserProfileStore(await clientOn(link.main));
  const state = await Effect.runPromise(store.initialize(initial));
  expect(state.profiles.map((profile) => profile.id)).toEqual(["personal", "work"]);
  await Effect.runPromise(store.create({ id: "lab", createdAt: AT }));
  const twice = await Effect.runPromise(Effect.result(store.create({ id: "lab", createdAt: AT })));
  expect(Result.isFailure(twice) && twice.failure).toMatchObject({ _tag: "BrowserProfileError", code: "invalid" });
  await Effect.runPromise(store.touch("lab", AT));
  // The rows are the core's: a SQL store on the same database reads them.
  const read = await core.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => makeSqlBrowserProfileStore(sql).initialize(initial)),
  );
  expect(read.profiles.map((profile) => profile.id).sort()).toEqual(["lab", "personal", "work"]);
});

it("asks a starting core again instead of failing the registry", async () => {
  const link = channel();
  // The core is not serving yet: the first ask goes out and the core leaves.
  const store = coreBrowserProfileStore(await clientOn(link.main));
  const asked = Effect.runPromise(store.initialize(initial));
  await new Promise((resolve) => setTimeout(resolve, 20));
  link.main.down("the Junto core process exited with code 1");
  // The next core serves; the ask that is retried is answered by it.
  await serve(heldForServer(link.core));
  expect((await asked).profiles.map((profile) => profile.id)).toEqual(["personal", "work"]);
});
