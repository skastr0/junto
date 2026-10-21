/**
 * A seat whose machine runs another Junto build, read the way the CLI meets
 * it: the real dispatcher over the native adapter, the result through JSON,
 * then the CLI's own unwrap. Stores live in a temp folder.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { grantOverseer, ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { nameThisMachine } from "./support/name-this-machine";
import { SettingsLive } from "../src/main/junto/settings/service";
import { WorkLive } from "../src/main/junto/work/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { executeOverseer } from "../src/main/junto/overseer/dispatch";
import { makeOverseerNativeLive } from "../src/main/junto/overseer/native";
import { LinkBuildMismatch } from "../src/main/junto/link/types";
import type { TermPlane } from "../src/main/junto/term/plane";
import type { OverseerRequest } from "../src/shared/overseer-control";
import { unwrapOverseerSocketData } from "../src/cli/commands/overseer";
import { canvasOf, seat } from "./support/model-nodes";
import { NoTasksLive } from "./support/no-tasks";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const caller = { canvasName: "origin", nodeId: "boss" };
const layers = (root: string) => {
  const repositories = Layer.provideMerge(Layer.mergeAll(
    CrewRepositoryLive, WorkRepositoryLive, MachineRepositoryLive, NoTasksLive,
    SettingsLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(
    makeStateEngineLive(join(root, "state.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ));
  return Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositories));
};
const makeRuntime = (root: string) => ManagedRuntime.make(layers(root));
let root: string | undefined;
let runtime: ReturnType<typeof makeRuntime> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const agent = (id: string, host: string) =>
  ({ ...seat(id, { bindingId: `bind-${id}` as never, harness: "codex", launch: { kind: "harness", argv: ["codex"] } }), host });

/** A router whose seats on OTHER_MACHINE answer the hello of another build, or the given failure. */
const termPlane = (remote: () => never): TermPlane => ({
  router: {
    isLocalHostId: (hostId: string | undefined) => hostId === undefined || hostId === THIS_MACHINE,
    get: async (bindingId: string, hostId?: string) =>
      hostId === OTHER_MACHINE ? remote() : { bindingId, hostId, status: "running", epoch: "e1", detached: false, createdAt: 1 },
  },
}) as unknown as TermPlane;

const stale = (): never => {
  throw LinkBuildMismatch.of({ build: "old", installationId: "inst-other" as never, machineName: OTHER_MACHINE }, "new");
};

/** What the CLI decodes for one overseer request: its data, or the WireError it fails with. */
const boot = async (remote: () => never = stale) => {
  root = await mkdtemp(join(tmpdir(), "overseer-needs-update-"));
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvas("origin", [seat("boss", { label: "Boss" })]));
  await runtime.runPromise(grantOverseer(caller.canvasName, caller.nodeId, true));
  const board = canvasOf([agent("here", THIS_MACHINE), agent("there", OTHER_MACHINE)]);
  const native = makeOverseerNativeLive({
    termPlane: termPlane(remote),
    captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "no window in test" }),
    liveOverseerGrant: async () => true,
    listCanvases: async () => new Map([["factory", board]]),
    occupySeat: async () => false,
  });
  const held = runtime;
  return async (request: OverseerRequest) => {
    const result = await held.runPromise(executeOverseer(caller, request, { native: native.execute }));
    return Effect.runPromise(unwrapOverseerSocketData(JSON.parse(JSON.stringify(result))).pipe(Effect.result));
  };
};

describe("a seat whose machine runs another build, as the CLI reads it", () => {
  it.each(["agent.get", "terminal.get"] as const)("%s fails NeedsUpdate with the machine as data", async (operation) => {
    const cli = await boot();
    const read = await cli({ operation, args: { canvas: "factory", nodeId: "there" } });
    expect(read._tag).toBe("Failure");
    if (read._tag !== "Failure") return;
    expect(read.failure.type).toBe("NeedsUpdate");
    expect(read.failure.message).toBe(`Update ${OTHER_MACHINE} before connecting Junto`);
    expect(read.failure.details).toEqual({ machine: OTHER_MACHINE });
    expect((await cli({ operation, args: { canvas: "factory", nodeId: "here" } }))._tag).toBe("Success");
  });

  it("agent.list succeeds, the stale seat marked as needing an update", async () => {
    const cli = await boot();
    const read = await cli({ operation: "agent.list", args: { canvas: "factory" } });
    expect(read._tag).toBe("Success");
    if (read._tag !== "Success") return;
    const rows = (read.success as { agents: ReadonlyArray<Record<string, unknown>> }).agents;
    expect(rows.map((row) => [row.nodeId, row.live, row.machine])).toEqual([
      ["here", true, undefined],
      ["there", false, { name: OTHER_MACHINE, needsUpdate: true }],
    ]);
  });

  it("terminal.list succeeds in both forms, the stale seat marked", async () => {
    const cli = await boot();
    const whole = await cli({ operation: "terminal.list", args: { canvas: "factory" } });
    expect(whole._tag === "Success" && (whole.success as { terminals: ReadonlyArray<Record<string, unknown>> }).terminals
      .map((row) => [row.nodeId, row.machine])).toEqual([
      ["here", undefined],
      ["there", { name: OTHER_MACHINE, needsUpdate: true }],
    ]);
    const one = await cli({ operation: "terminal.list", args: { canvas: "factory", nodeId: "there" } });
    expect(one._tag === "Success" && (one.success as { terminals: unknown }).terminals).toEqual([
      expect.objectContaining({ nodeId: "there", machine: { name: OTHER_MACHINE, needsUpdate: true } }),
    ]);
  });

  it("an error's details reach the CLI as data or their JSON, never [object Object]", async () => {
    const cli = await boot();
    const read = await cli({ operation: "canvas.screenshot", args: {} });
    expect(read._tag).toBe("Failure");
    if (read._tag !== "Failure") return;
    expect(read.failure).toMatchObject({ type: "RuntimeDown", message: "no window in test", details: { hint: '{"unavailable":true}' } });
  });
});
