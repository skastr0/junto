import type { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import type { ModelService } from "../src/main/junto/model/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { asNodeId, type NodeOf } from "../src/shared/model";
import { seatParts } from "../src/shared/model/seat-parts";
import { seat } from "./support/model-nodes";
import type { OverseerCaller } from "../src/shared/overseer-control";
import { InstallationId } from "../src/shared/installation-id";
import {
  grantOverseer,
  ModelStoresLive,
  readSeeded,
  seedCanvas,
} from "./support/seed-canvas";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { StationRepository, StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { WorkLive } from "../src/main/junto/work/service";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { commitAgentReseat } from "../src/main/junto/overseer/canvas";
import {
  createDispatchGrant,
  lateBoundDrive,
  runCanvasHook,
} from "../src/main/junto/overseer/composition";


const origin: OverseerCaller = { canvasName: "ops", nodeId: "overseer" };
const targetCanvas = "factory";
const targetAgent = "peer";

const amp = (id: string, bindingId: string): NodeOf<"agent"> =>
  seat(id, { width: 260, height: 96, harness: "amp", bindingId: bindingId as NodeOf<"agent">["bindingId"] });

describe("overseer composition absence", () => {
  it("refuses writePrompt without bytes when the managed drive is unbound", async () => {
    const drive = lateBoundDrive();
    await expect(drive.writePrompt("binding", "hello")).resolves.toEqual({
      status: "refused", reason: "not-ready", bindingGeneration: 0,
      writesBefore: 0, writesAfter: 0, pasteWrites: 0, wrotePhysicalBytes: false,
    });
    await expect(drive.interrupt("binding")).resolves.toBe(false);
  });
});

describe("overseer composition canvas hook with live grant", () => {
  let stateDir = "";
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  const makeRuntime = (path: string) => {
    const contentRoot = join(stateDir, "content");
    const installOpsPath = join(stateDir, "install-ops.db");
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        CrewRepositoryLive,
        StationRepositoryLive,
        StationFleetTargetRepositoryLive,
        SettingsLive,
        makeContentServiceLive({
          root: contentRoot,
          skipInlineMediaMigration: true,
        }),
      ),
      Layer.mergeAll(
        makeStateEngineLive(path),
        makeInstallOpsLive(installOpsPath),
      ),
    );
    const canvases = Layer.provideMerge(ModelStoresLive, repositories);
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases),
      ),
    );
  };

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    stateDir = "";
  });

  it("commits reseat with origin caller and live canvasOverseerSet grant", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "junto-overseer-hook-state-"));
    runtime = makeRuntime(join(stateDir, "junto.db"));
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(settings.setStationTopology({
      role: "command-center", hostId: "local", supervisedPreferred: false,
    }));
    await runtime.runPromise(seedCanvas("ops", [amp("overseer", "bind-overseer")]));
    await runtime.runPromise(seedCanvas(targetCanvas, [amp("peer", "bind-peer")]));
    await runtime.runPromise(grantOverseer(origin.canvasName, origin.nodeId, true));

    const run = <A, E>(effect: Effect.Effect<A, E, ModelService | ModelActorRefs | StationRepository>) =>
      runtime!.runPromise(effect.pipe(Effect.delay("5 millis")) as never) as Promise<A>;
    const localGrant = createDispatchGrant(run, undefined);
    const wrongSourceGrant = createDispatchGrant(run, Schema.decodeUnknownSync(InstallationId)("wrong-installation"));
    expect(await Promise.all([localGrant(origin), wrongSourceGrant(origin)]))
      .toEqual([true, false]);

    // The launch is main's: worked out from named choices, never sent by the agent.
    const parts = seatParts({ harness: "claude", host: "local", model: "opus" });
    const result = await runtime.runPromise(
      Effect.result(commitAgentReseat(origin, { canvas: targetCanvas, nodeId: targetAgent }, parts)),
    );
    expect(result._tag).toBe("Success");
    const peer = (await runtime.runPromise(readSeeded(targetCanvas))).nodes.get(asNodeId("peer"));
    expect(peer).toMatchObject({
      kind: "agent", label: "peer", harness: "claude", bindingId: parts.bindingId,
      agentKey: parts.agentKey, launch: parts.launch, overseer: false,
    });
    expect(parts.bindingId).not.toBe("bind-peer");
    // The origin seat is untouched, and it cannot reseat itself.
    expect((await runtime.runPromise(readSeeded(origin.canvasName))).nodes.get(asNodeId("overseer")))
      .toMatchObject({ overseer: true, bindingId: "bind-overseer", harness: "amp" });
    const own = await runtime.runPromise(
      Effect.result(commitAgentReseat(origin, { nodeId: origin.nodeId }, parts)),
    );
    expect(own).toMatchObject({ _tag: "Failure", failure: { type: "AuthError" } });
  });

  it("interrupts a waiting canvas hook and drains its cleanup before returning", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "junto-overseer-hook-abort-"));
    runtime = makeRuntime(join(stateDir, "junto.db"));
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let committed = false;
    let cleaning = false;
    let settled = false;
    const controller = new AbortController();
    const pending = runCanvasHook(runtime.runPromise.bind(runtime),
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.andThen(Effect.sync(() => { committed = true; })),
        Effect.ensuring(Effect.sync(() => { cleaning = true; }).pipe(
          Effect.andThen(Deferred.await(release)),
        )),
      ), controller.signal,
    ).then(() => "completed", () => "interrupted").finally(() => { settled = true; });
    await runtime.runPromise(Deferred.await(entered));
    controller.abort();
    await vi.waitFor(() => expect(cleaning).toBe(true));
    expect(settled).toBe(false);
    expect(committed).toBe(false);
    await runtime.runPromise(Deferred.succeed(release, undefined));
    expect(await pending).toBe("interrupted");
    expect(committed).toBe(false);
  });
});
