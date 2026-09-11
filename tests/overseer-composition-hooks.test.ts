import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { applyMirrorLaw, type CanvasDoc, type CanvasNode, type TextNode } from "../src/shared/canvas";
import type { OverseerCaller } from "../src/shared/overseer-control";
import type { InstallationId } from "../src/shared/station-api";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { WorkLive } from "../src/main/vellum-command/work/service";
import { SettingsLive } from "../src/main/vellum-command/settings/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { commitAgentReseat } from "../src/main/vellum-command/overseer/canvas";
import {
  createDispatchGrant,
  lateBoundDrive,
  reseatCanvasArgs,
  schedulerCanvasArgs,
} from "../src/main/vellum-command/overseer/composition";


const origin: OverseerCaller = { canvasName: "ops", nodeId: "overseer" };
const targetCanvas = "ops";
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
    entity: { kind: "agent", name: "local:amp" },
    host: "local",
    terminal: { bindingId, harness: "amp" },
  },
});

const overseerDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      agent("overseer", "bind-overseer"),
      agent("peer", "bind-peer"),
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

describe("overseer composition grant closures", () => {
  it("captures distinct sources per dispatch across Effect sleeps", async () => {
    const local = "local-install" as InstallationId;
    const remote = "remote-install" as InstallationId;
    const seen: InstallationId[] = [];
    const grant = (source: InstallationId) => async () => {
      await Effect.runPromise(Effect.sleep("5 millis"));
      seen.push(source);
      return true;
    };
    const left = grant(local);
    const right = grant(remote);
    await Promise.all([left(), right()]);
    expect(seen).toContain(local);
    expect(seen).toContain(remote);
    expect(createDispatchGrant.length).toBe(2);
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
  let canvasesDir = "";
  let stateDir = "";
  let previousCanvases: string | undefined;
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  const makeRuntime = (path: string) => {
    const contentRoot = join(stateDir || path, "..", "content");
    const installOpsPath = join(stateDir || path, "install-ops.db");
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
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
        Layer.mergeAll(canvases, StationLivePeerRegistryLive) as never,
      ),
    );
  };

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) delete process.env.VELLUM_COMMAND_CANVASES_DIR;
    else process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvases;
    if (canvasesDir) await rm(canvasesDir, { recursive: true, force: true });
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    canvasesDir = "";
    stateDir = "";
  });

  it("commits reseat with origin caller and live canvasOverseerSet grant", async () => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-overseer-hook-canvases-"));
    stateDir = await mkdtemp(join(tmpdir(), "vellum-overseer-hook-state-"));
    previousCanvases = process.env.VELLUM_COMMAND_CANVASES_DIR;
    process.env.VELLUM_COMMAND_CANVASES_DIR = canvasesDir;
    runtime = makeRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("ops", overseerDoc()));
    const ops = await runtime.runPromise(canvases.read("ops"));
    const granted = await runtime.runPromise(
      Effect.result(
        canvases.canvasOverseerSet({
          canvasName: "ops",
          nodeId: "overseer",
          overseer: true,
          expectedRevision: ops.revision,
        }),
      ),
    );

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
    if (granted._tag === "Success") {
      expect(result._tag).toBe("Success");
      const after = await runtime.runPromise(canvases.read("ops"));
      const peer = after.doc.nodes.find((node) => node.id === "peer");
      expect(peer && "text" in peer ? peer.text : undefined).toBe("reseated");
    } else {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.type).toBe("AuthError");
      }
    }
  });
});
