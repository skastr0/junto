/**
 * What a seat reads of the operator's texts, over the real work-control
 * socket: the app briefing and the list of references at onboard, and
 * `references.list` / `references.read` on demand. A seat's scope is the app
 * plus every region containing it, the inner name winning. Every store, home
 * and socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { PausePlane } from "../src/main/junto/pause-plane";
import { makeProcessIdentityMap } from "../src/main/junto/process-identity";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { ReferencesFollowCanvasLive } from "../src/main/junto/references/follow-canvas";
import { ModelService } from "../src/main/junto/model/service";
import { APP_REFERENCE_PLACE, type ReferencePlace } from "../src/shared/references";
import type { CanvasDoc } from "../src/shared/canvas";

const CANVAS = "factory";
let playing = true;

const PausePlaneSwitchable = Layer.succeed(PausePlane, {
  start: Effect.void,
  stateFor: () => ({ playing, everPlayed: true }),
  setPlaying: () => Effect.void,
  subscribe: () => () => {},
});

const makeRuntime = (root: string, withStore: boolean) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      ...(withStore ? [ReferencesRepositoryLive] : []),
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesOnly = Layer.provideMerge(CanvasesLive, repositoriesLive);
  // The app composes the follower beside the store; here it sits above the model the same way.
  const canvasesLive = withStore ? Layer.provideMerge(ReferencesFollowCanvasLive, canvasesOnly) : canvasesOnly;
  const workLive = Layer.provideMerge(WorkLive, Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive));
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneSwitchable));
};

const group = (id: string, label: string, x: number, y: number, width: number, height: number) => ({
  id,
  type: "group",
  x,
  y,
  width,
  height,
  label,
});

/** The seat sits in "inner", which sits in "outer". "elsewhere" holds neither. */
const doc = {
  nodes: [
    group("outer", "CLI", -100, -100, 1000, 600),
    group("inner", "Protocol", -40, -40, 400, 300),
    group("elsewhere", "Product", 2000, 2000, 300, 300),
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 40,
      width: 120,
      height: 48,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: { bindingId: "bind-agent", harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
      },
    },
  ],
  edges: [],
} as unknown as CanvasDoc;

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let token = "";

const start = async (withStore = true) => {
  runtime = makeRuntime(root, withStore);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true }),
  );
  const processMap = makeProcessIdentityMap();
  processMap.bind(process.pid, { agentKey: "local:agent" });
  server = await startWorkControlServer({
    version: "test",
    workHome: process.env.JUNTO_WORK_HOME!,
    home: root,
    processMap,
    readPeerPid: () => process.pid,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  token = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write(CANVAS, doc));
};

beforeEach(async () => {
  playing = true;
  root = await mkdtemp(join(tmpdir(), "junto-references-seat-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (op: string, args: unknown = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const region = (regionId: string, canvasName = CANVAS): ReferencePlace => ({ kind: "region", canvasName, regionId });
const store = <A, E>(use: (repository: ReferencesRepository["Service"]) => Effect.Effect<A, E>) =>
  (runtime as ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>).runPromise(
    Effect.flatMap(ReferencesRepository, use),
  );

const seed = async () => {
  await store((r) => r.briefingWrite("# House rules\n\nCommit by explicit path.", "operator"));
  await store((r) => r.write(APP_REFERENCE_PLACE, { name: "style", description: "How we write", body: "App style." }, "operator"));
  await store((r) => r.write(APP_REFERENCE_PLACE, { name: "release", body: "Ship on green." }, "operator"));
  await store((r) => r.write(region("outer"), { name: "style", description: "CLI voice", body: "Outer style." }, "operator"));
  await store((r) => r.write(region("outer"), { name: "runbook", body: "Outer runbook." }, "operator"));
  await store((r) => r.write(region("inner"), { name: "style", body: "Inner style." }, "operator"));
  // Never in this seat's scope: a region it is not in, a region that is gone, another canvas.
  await store((r) => r.write(region("elsewhere"), { name: "plans", body: "Product plans." }, "operator"));
  await store((r) => r.write(region("deleted-region"), { name: "ghost", body: "Gone." }, "operator"));
  await store((r) => r.write(region("inner", "other"), { name: "other-canvas", body: "Other." }, "operator"));
};

describe("what a seat reads of the operator's texts", () => {
  it("onboard is unchanged when there is no briefing and no reference", async () => {
    await start();
    const { data } = await call("onboard");
    expect(data).not.toHaveProperty("briefing");
    expect(data).not.toHaveProperty("references");
    expect((await call("references.list")).data).toEqual({ references: [] });
  });

  it("onboard carries the briefing before the region, and names the references without their bodies", async () => {
    await start();
    await seed();
    const { ok, data } = await call("onboard");
    expect(ok).toBe(true);
    const keys = Object.keys(data);
    expect(keys.indexOf("briefing")).toBeGreaterThan(-1);
    expect(keys.indexOf("briefing")).toBeLessThan(keys.indexOf("region"));
    expect(data.briefing).toBe("# House rules\n\nCommit by explicit path.");
    expect(data.references).toEqual([
      { name: "release", scope: "app", read: "junto references read release" },
      { name: "style", scope: "region", region: { id: "inner", label: "Protocol" }, read: "junto references read style" },
      { name: "runbook", scope: "region", region: { id: "outer", label: "CLI" }, read: "junto references read runbook" },
    ]);
    const text = JSON.stringify(data.references);
    for (const body of ["App style.", "Outer style.", "Inner style.", "Ship on green.", "Outer runbook."]) {
      expect(text).not.toContain(body);
    }
  });

  it("lists the same scope with sizes, and reads the innermost match for a name", async () => {
    await start();
    await seed();
    const listed = await call("references.list");
    expect(listed.ok).toBe(true);
    expect(
      listed.data.references.map((reference: any) => [reference.name, reference.scope, reference.region?.id, reference.bytes]),
    ).toEqual([
      ["release", "app", undefined, 14],
      ["style", "region", "inner", 12],
      ["runbook", "region", "outer", 14],
    ]);
    for (const reference of listed.data.references) {
      expect(reference.updatedAt).toBeGreaterThan(0);
      expect(reference).not.toHaveProperty("body");
    }

    const style = await call("references.read", { name: "Style" });
    expect(style.data).toMatchObject({
      name: "style",
      scope: "region",
      region: { id: "inner", label: "Protocol" },
      body: "Inner style.",
    });
    expect(style.data).not.toHaveProperty("description");
    expect((await call("references.read", { name: "release" })).data).toMatchObject({ scope: "app", body: "Ship on green." });
    expect((await call("references.read", { name: "runbook" })).data).toMatchObject({
      scope: "region",
      region: { id: "outer", label: "CLI" },
      body: "Outer runbook.",
    });
  });

  it("refuses a name outside the seat's scope and says which names are in it", async () => {
    await start();
    await seed();
    for (const name of ["plans", "ghost", "other-canvas", "nope"]) {
      const response = await call("references.read", { name });
      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({
        type: "UnknownTarget",
        details: { target: name, hint: "in scope: release, style, runbook", next_step: expect.stringContaining("junto references list") },
      });
    }
    expect((await call("references.read", {})).error.type).toBe("InputError");
    expect((await call("references.read", { name: "style", regionId: "outer" })).error.type).toBe("InputError");
    expect((await call("references.list", { canvas: "other" })).error.type).toBe("InputError");
  });

  it("answers on a paused canvas", async () => {
    await start();
    await seed();
    playing = false;
    expect((await call("references.list")).data.references).toHaveLength(3);
    expect((await call("references.read", { name: "style" })).data.body).toBe("Inner style.");
    const onboard = await call("onboard");
    expect(onboard.data).toMatchObject({ paused: true, briefing: expect.stringContaining("House rules") });
  });

  it("follows the real model: a removed region and a removed canvas", async () => {
    await start();
    await seed();
    const model = <A, E>(use: (service: ModelService["Service"]) => Effect.Effect<A, E>) =>
      (runtime as unknown as ManagedRuntime.ManagedRuntime<ModelService, unknown>).runPromise(Effect.flatMap(ModelService, use));
    const names = async (place: ReferencePlace) => (await store((r) => r.list(place))).map((reference) => reference.name);
    const until = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 400 && !(await check()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await check()).toBe(true);
    };

    await model((service) => service.command({ _tag: "Remove", canvas: CANVAS, nodes: ["inner"], wires: [] } as never, "operator"));
    await until(async () => (await names(region("inner"))).length === 0);
    expect(await names(region("outer"))).toEqual(["runbook", "style"]);
    // The seat now gets the outer region's style, and the rows of other canvases are untouched.
    expect((await call("references.read", { name: "style" })).data).toMatchObject({ region: { id: "outer" }, body: "Outer style." });
    expect(await names(region("inner", "other"))).toEqual(["other-canvas"]);

    // A row for a region the canvas no longer has is kept until its canvas goes: nothing sweeps it.
    expect(await names(region("deleted-region"))).toEqual(["ghost"]);

    await model((service) => service.command({ _tag: "RemoveCanvas", canvas: CANVAS } as never, "operator"));
    await until(async () => (await names(region("outer"))).length === 0);
    expect(await names(region("elsewhere"))).toEqual([]);
    expect(await names(region("deleted-region"))).toEqual([]);
    expect(await names(region("inner", "other"))).toEqual(["other-canvas"]);
    expect(await names(APP_REFERENCE_PLACE)).toEqual(["release", "style"]);
    expect((await store((r) => r.briefingRead()))?.body).toContain("House rules");
  });

  it("a runtime without the store still onboards, and the reads say they are not available", async () => {
    await start(false);
    const onboard = await call("onboard");
    expect(onboard.ok).toBe(true);
    expect(onboard.data).not.toHaveProperty("briefing");
    expect((await call("references.list")).error.type).toBe("RuntimeDown");
  });
});
