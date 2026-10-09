import { InstallationId } from "../src/shared/installation-id";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";
import { asNodeId, type Node } from "../src/shared/model";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";

// Keep the public writer's app-runtime boundary while executing its actual
// Effect against a disposable, fully composed canvas authority store.
const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
import { writeSeatSessionId } from "../src/main/junto/term/seat-session-id";

const SESSION = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
const OTHER_SESSION = "1787761862883-1787761862883720000-97d25f70d04d6c5e";

/** One seat, named `agent`, on the session the test gives it. */
const agentDoc = (
  bindingId: string,
  options: { readonly harness?: "fx" | "muse"; readonly host?: string; readonly seatId?: string } = {},
): ReadonlyArray<Node> => [
  seat(options.seatId ?? bindingId, {
    width: 240,
    height: 120,
    label: "Agent",
    agentKey: `command:${bindingId}`,
    host: options.host ?? "command",
    bindingId: bindingId as never,
    harness: (options.harness ?? "fx") as never,
    launch: { kind: "harness", argv: [options.harness ?? "fx"] },
  }),
];

const makeRuntime = (root: string) => ManagedRuntime.make(Layer.provideMerge(
  Layer.provide(ModelService.layer, ModelDependents.empty),
  Layer.provideMerge(
    Layer.mergeAll(makeSeatSessionRepositoryLive(join(root, "seats")), makeMachineRepositoryLive({ defaultName: () => "command" })),
    makeStateEngineLive(join(root, "state.db")),
  ),
));

let runtime: ReturnType<typeof makeRuntime> | undefined;
let root: string | undefined;

const fixture = async () => {
  root = await mkdtemp(join(tmpdir(), "vc-session-ownership-"));
  const live = runtime = makeRuntime(root);
  app.runPromise.mockImplementation((effect) => live.runPromise(effect));
  await live.runPromise(Effect.flatMap(MachineRepository, machine => machine.configureName("command")));
  return {
    runtime: live,
    write: (name: string, nodes: ReadonlyArray<Node>) => live.runPromise(seedCanvas(name, nodes)),
    sessionId: async (name: string) => {
      const held = [...(await live.runPromise(readSeeded(name))).nodes.values()].find(node => node.kind === "agent");
      return held?.kind === "agent" ? (await live.runPromise(Effect.flatMap(SeatSessionRepository, repo => repo.current(held.id, held.bindingId))))?.sessionId : undefined;
    },
  };
};

const capture = (canvasName: string, bindingId: string, sessionId = SESSION, harness = "fx", isCurrent = () => true) =>
  writeSeatSessionId({ canvasName, nodeId: bindingId, sessionId, onlyIfAbsent: true, capture: { bindingId, harness, isCurrent } });

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  app.runPromise.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("captured session persistence ownership", () => {
  it("rejects a session already owned on another canvas after the original writer completed", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b", { host: "command" }));
    expect(await capture("first", "a")).toEqual({ ok: true });

    expect(await capture("second", "b")).toMatchObject({ ok: false, reason: expect.stringContaining("another seat") });
    expect(await f.sessionId("first")).toBe(SESSION);
    expect(await f.sessionId("second")).toBeUndefined();
  });

  it("atomically permits only one of two concurrent cross-canvas claims", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b"));

    const results = await Promise.all([capture("first", "a"), capture("second", "b")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const ids = [await f.sessionId("first"), await f.sessionId("second")];
    expect(ids.filter((id) => id === SESSION)).toHaveLength(1);
  });

  it("accepts distinct sessions and does not collide identical text from another harness", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b"));
    await f.write("muse", agentDoc("c", { harness: "muse" }));

    expect(await capture("first", "a")).toEqual({ ok: true });
    expect(await capture("second", "b", OTHER_SESSION)).toEqual({ ok: true });
    expect(await capture("muse", "c", SESSION, "muse")).toEqual({ ok: true });
    expect(await f.sessionId("second")).toBe(OTHER_SESSION);
    expect(await f.sessionId("muse")).toBe(SESSION);
  });

  it("does not collide a session on another installation or capture its projected seat", async () => {
    const f = await fixture();
    await f.runtime.runPromise(Effect.flatMap(MachineRepository, machine => machine.pinPeer({ machineName: "mini", installationId: Schema.decodeUnknownSync(InstallationId)("remote-install") })));
    await f.write("remote", agentDoc("remote-seat", { host: "mini" }));
    await f.write("local", agentDoc("local-seat"));

    expect(await capture("local", "local-seat")).toEqual({ ok: true });
    expect(await capture("remote", "remote-seat", OTHER_SESSION)).toMatchObject({ ok: false, reason: expect.stringContaining("another installation") });
    expect(await f.sessionId("remote")).toBeUndefined();
  });

  it("updates the same seat's cross-canvas aliases together", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("shared"));
    await f.write("second", agentDoc("shared", { host: "command" }));

    expect(await capture("first", "shared")).toEqual({ ok: true });
    expect(await f.sessionId("first")).toBe(SESSION);
    expect(await f.sessionId("second")).toBe(SESSION);
  });

  it("refuses stale generations, changed bindings, changed harnesses and existing named sessions", async () => {
    const f = await fixture();
    await f.write("seat", agentDoc("a"));
    expect(await capture("seat", "a", SESSION, "fx", () => false)).toMatchObject({ ok: false });
    expect(await capture("seat", "replaced")).toMatchObject({ ok: false });
    expect(await capture("seat", "a", SESSION, "muse")).toMatchObject({ ok: false });
    expect(await f.sessionId("seat")).toBeUndefined();

    expect(await capture("seat", "a")).toEqual({ ok: true });
    expect(await capture("seat", "a", OTHER_SESSION)).toMatchObject({ ok: false });
    expect(await f.sessionId("seat")).toBe(SESSION);
  });

  it("retains the non-capture writer used by provisioned harnesses", async () => {
    const f = await fixture();
    await f.write("seat", agentDoc("a"));
    expect(await writeSeatSessionId({ canvasName: "seat", nodeId: "a", bindingId: "a", harness: "fx", sessionId: SESSION })).toEqual({ ok: true });
    expect(await writeSeatSessionId({ canvasName: "seat", nodeId: "a", bindingId: "a", harness: "fx", sessionId: OTHER_SESSION })).toEqual({ ok: true });
    expect(await f.sessionId("seat")).toBe(OTHER_SESSION);
  });
});
