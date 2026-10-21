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
import { setOverseerNativeDeleteHooks } from "../src/main/junto/overseer/canvas";
import { makeOverseerNativeLive, workDetails } from "../src/main/junto/overseer/native";
import { LinkBuildMismatch } from "../src/main/junto/link/types";
import type { TermPlane } from "../src/main/junto/term/plane";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
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
  setOverseerNativeDeleteHooks(undefined);
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
  // Deleting a seat fails as its terminal is fenced, with whatever the remote failure says.
  nodeDelete: {
    beginNodeDelete: async () => remote(),
    finishNodeDelete: () => undefined,
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
  await runtime.runPromise(seedCanvas("origin", [seat("boss", { label: "Boss" }), agent("doomed", THIS_MACHINE)]));
  await runtime.runPromise(grantOverseer(caller.canvasName, caller.nodeId, true));
  const board = canvasOf([agent("here", THIS_MACHINE), agent("there", OTHER_MACHINE)]);
  const native = makeOverseerNativeLive({
    termPlane: termPlane(remote),
    captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "no window in test" }),
    liveOverseerGrant: async () => true,
    listCanvases: async () => new Map([["factory", board]]),
    occupySeat: async () => false,
  });
  setOverseerNativeDeleteHooks(native);
  const held = runtime;
  return async (request: OverseerRequest) => {
    const result = await held.runPromise(executeOverseer(caller, request, { native: native.execute }));
    return Effect.runPromise(unwrapOverseerSocketData(JSON.parse(JSON.stringify(result))).pipe(Effect.result));
  };
};

const SECRET = "ghp_seatsecret123";
const leaked = (failure: unknown): boolean => JSON.stringify(failure).includes(SECRET);

describe("a node delete's failure, as the seat reads it", () => {
  const deleteWith = async (hooks: Parameters<typeof setOverseerNativeDeleteHooks>[0]) => {
    const cli = await boot();
    setOverseerNativeDeleteHooks(hooks);
    return cli({ operation: "node.delete", args: { canvas: "origin", nodeIds: ["doomed"] } });
  };
  const finishOk = () => ({ ok: true as const });

  it("a prepare that answers a secret is scrubbed", async () => {
    const read = await deleteWith({
      prepareOverseerNodeDelete: async () => ({ ok: false, error: `fence failed, Authorization: Bearer ${SECRET}` }),
      finishOverseerNodeDelete: finishOk,
    });
    expect(read._tag === "Failure" && read.failure.message).toMatch(/^fence failed/);
    expect(leaked(read)).toBe(false);
  });

  it("a prepare that throws a secret is scrubbed", async () => {
    const read = await deleteWith({
      prepareOverseerNodeDelete: async () => { throw new Error(`prepare threw, Authorization: Bearer ${SECRET}`); },
      finishOverseerNodeDelete: finishOk,
    });
    expect(read._tag === "Failure" && read.failure.message).toMatch(/^prepare threw/);
    expect(leaked(read)).toBe(false);
  });

  it("a finish that answers a secret is scrubbed", async () => {
    const read = await deleteWith({
      prepareOverseerNodeDelete: async () => ({ ok: true, leaseId: "lease-1", pageStops: [] }),
      finishOverseerNodeDelete: () => ({ ok: false, error: `finish failed, Authorization: Bearer ${SECRET}` }),
    });
    expect(read._tag === "Failure" && read.failure.message).toMatch(/finish failed/);
    expect(leaked(read)).toBe(false);
  });

  it("the terminal fence scrubs a thrown secret before native passes it on", async () => {
    // The real fence; a terminal with no host asks the router for this machine's name, and that throws.
    const router = {
      isLocalHostId: () => true,
      deleteBinding: async () => true,
      thisMachineName: () => { throw new Error(`fence failed, Authorization: Bearer ${SECRET}`); },
    };
    const native = makeOverseerNativeLive({
      termPlane: { router, nodeDelete: new TerminalNodeDeleteService(router as never) } as unknown as TermPlane,
      captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "no window in test" }),
      liveOverseerGrant: async () => true,
      listCanvases: async () => new Map(),
      occupySeat: async () => false,
    });
    const prepared = await native.prepareOverseerNodeDelete([{ kind: "terminal", bindingId: "bind-doomed", hostId: " " }]);
    expect(prepared).toMatchObject({ ok: false, error: expect.stringMatching(/^fence failed/) });
    expect(leaked(prepared)).toBe(false);
  });
});

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

  it("a thrown error carrying a secret reaches the seat scrubbed", async () => {
    const cli = await boot(() => { throw new Error("link dropped, Authorization: Bearer ghp_seatsecret123"); });
    const read = await cli({ operation: "agent.get", args: { canvas: "factory", nodeId: "there" } });
    expect(read._tag).toBe("Failure");
    if (read._tag !== "Failure") return;
    expect(read.failure.type).toBe("InternalError");
    expect(read.failure.message).toMatch(/^link dropped/);
    expect(JSON.stringify(read.failure)).not.toContain("ghp_seatsecret123");
  });

  it("a node delete whose prepare throws a secret reaches the seat scrubbed", async () => {
    const cli = await boot(() => { throw new Error("fence failed, Authorization: Bearer ghp_seatsecret123"); });
    const read = await cli({ operation: "node.delete", args: { canvas: "origin", nodeIds: ["doomed"] } });
    expect(read._tag).toBe("Failure");
    if (read._tag !== "Failure") return;
    expect(read.failure.message).toMatch(/fence failed/);
    expect(JSON.stringify(read.failure)).not.toContain("ghp_seatsecret123");
  });

  it("an error's details reach the CLI as data or their JSON, never [object Object]", async () => {
    const cli = await boot();
    const read = await cli({ operation: "canvas.screenshot", args: {} });
    expect(read._tag).toBe("Failure");
    if (read._tag !== "Failure") return;
    expect(read.failure).toMatchObject({ type: "RuntimeDown", message: "no window in test", details: { hint: '{"unavailable":true}' } });
  });
});

describe("an overseer error's hint, on its way to the calling seat", () => {
  const secret = "Authorization: Bearer ghp_seatsecret123";
  // No native error sets a string or a hinted detail today; these are what a future one would send.
  it.each([
    ["a string detail", secret],
    ["a decoded hint", { hint: secret, retryable: false }],
    ["the JSON of any other detail", { unavailable: true, why: secret }],
    ["expected, never passed as data", { expected: secret }],
  ])("%s comes out scrubbed", (_, details) => {
    const scrubbed = workDetails(details);
    expect(scrubbed?.hint).toBeDefined();
    expect(JSON.stringify(scrubbed)).not.toContain("ghp_seatsecret123");
    expect(scrubbed?.expected).toBeUndefined();
  });

  it("keeps a decoded detail's other fields as data", () => {
    expect(workDetails({ machine: OTHER_MACHINE })).toEqual({ machine: OTHER_MACHINE });
    expect(workDetails({ hint: "plain", retryable: false })).toEqual({ hint: "plain", retryable: false });
  });
});
