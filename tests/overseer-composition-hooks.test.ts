import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { applyMirrorLaw, type CanvasDoc, type CanvasNode, type TextNode } from "../src/shared/canvas";
import type { OverseerCaller } from "../src/shared/overseer-control";
import { InstallationId } from "../src/shared/station-api";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { StationRepository, StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { WorkLive } from "../src/main/vellum-command/work/service";
import { SettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { commitAgentReseat } from "../src/main/vellum-command/overseer/canvas";
import {
  createDispatchGrant,
  lateBoundDrive,
  reseatCanvasArgs,
  runCanvasHook,
  schedulerCanvasArgs,
} from "../src/main/vellum-command/overseer/composition";


const origin: OverseerCaller = { canvasName: "ops", nodeId: "overseer" };
const targetCanvas = "factory";
const targetAgent = "peer";

const agent = (id: string, bindingId: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 260,
  height: 96,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    host: "local",
    terminal: { bindingId, harness: "amp" },
  },
});

const overseerDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      agent("overseer", "bind-overseer"),
    ],
    edges: [],
  });

const nextPeer = (): TextNode => ({
  id: targetAgent,
  type: "text",
  text: "reseated",
  x: 40,
  y: 0,
  width: 260,
  height: 96,
  ether: {
    entity: { kind: "agent", name: "local:amp" },
    host: "local",
    terminal: { bindingId: "bind-peer-next", harness: "amp" },
  },
});

describe("overseer composition origin vs target", () => {
  it("maps native payload to origin caller and target canvas args", () => {
    const mapped = reseatCanvasArgs({
      caller: origin,
      canvasName: targetCanvas,
      nodeId: targetAgent,
      next: nextPeer(),
    });
    expect("ok" in mapped).toBe(false);
    if ("ok" in mapped) return;
    expect(mapped.caller).toEqual(origin);
    expect(mapped.caller.nodeId).not.toBe(targetAgent);
    expect(mapped.args).toMatchObject({
      canvas: targetCanvas,
      nodeId: targetAgent,
      harness: "amp",
    });
  });

  it("maps scheduler payload without treating the target as caller", () => {
    const mapped = schedulerCanvasArgs({
      caller: origin,
      canvasName: targetCanvas,
      nodeId: "cron-1",
      timer: { kind: "cron", expression: "0 * * * *" },
    });
    expect(mapped.caller).toEqual(origin);
    expect(mapped.args.canvas).toBe(targetCanvas);
    expect(mapped.args.nodeId).toBe("cron-1");
  });
});

describe("overseer composition absence", () => {
  it("returns false from writePrompt when the managed drive is unbound", async () => {
    const drive = lateBoundDrive();
    await expect(drive.writePrompt("binding", "hello")).resolves.toBe(false);
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
    const canvases = Layer.provideMerge(CanvasesLive, repositories);
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases, StationLivePeerRegistryLive),
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
    stateDir = await mkdtemp(join(tmpdir(), "vellum-overseer-hook-state-"));
    runtime = makeRuntime(join(stateDir, "vellum-command.db"));
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(settings.setStationTopology({
      role: "command-center", hostId: "local", supervisedPreferred: false,
    }));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("ops", overseerDoc()));
    await runtime.runPromise(canvases.write(targetCanvas, {
      nodes: [agent("peer", "bind-peer")], edges: [],
    }));
    const ops = await runtime.runPromise(canvases.read("ops"));
    await runtime.runPromise(canvases.canvasOverseerSet({
      ...origin, overseer: true, expectedRevision: ops.revision,
    }));

    const run = <A, E>(effect: Effect.Effect<A, E, CanvasesService | StationRepository>) =>
      runtime!.runPromise(effect.pipe(Effect.delay("5 millis")));
    const localGrant = createDispatchGrant(run, undefined);
    const wrongSourceGrant = createDispatchGrant(run, Schema.decodeUnknownSync(InstallationId)("wrong-installation"));
    expect(await Promise.all([localGrant(origin), wrongSourceGrant(origin)]))
      .toEqual([true, false]);

    const mapped = reseatCanvasArgs({
      caller: origin,
      canvasName: targetCanvas,
      nodeId: targetAgent,
      next: nextPeer(),
    });
    expect("ok" in mapped).toBe(false);
    if ("ok" in mapped) throw new Error(mapped.message);
    expect(mapped.caller.nodeId).toBe("overseer");
    expect(mapped.args.nodeId).toBe("peer");

    const result = await runtime.runPromise(
      Effect.result(commitAgentReseat(mapped.caller, mapped.args, mapped.next)),
    );
    expect(result._tag).toBe("Success");
    const after = await runtime.runPromise(canvases.read(targetCanvas));
    const peer = after.doc.nodes.find((node) => node.id === "peer");
    expect(peer).toMatchObject({ text: "reseated", ether: { terminal: { bindingId: "bind-peer-next" } } });
    const originAfter = await runtime.runPromise(canvases.read(origin.canvasName));
    expect(originAfter.doc.nodes[0]).toMatchObject({ id: "overseer", ether: { overseer: true, terminal: { bindingId: "bind-overseer" } } });
  });

  it("interrupts a waiting canvas hook and drains its cleanup before returning", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "vellum-overseer-hook-abort-"));
    runtime = makeRuntime(join(stateDir, "vellum-command.db"));
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
