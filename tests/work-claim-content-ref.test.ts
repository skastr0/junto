/**
 * S3 regression — claim + ContentRef media (docs/END_STATE-effect-foundation.md §S3).
 *
 * Prior bug class: empty-Context Effect.runPromise made ContentService invisible
 * on claim ticks → "content service unavailable" even when media receipts existed.
 * Guard: WorkService.workTaskClaim with ContentService + InstallOps in a warm
 * ManagedRuntime must claim a ContentRef task when receipts+files are verified.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  ContentService,
  makeContentServiceLive,
} from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeClaimContentRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "vellum-command.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  return ManagedRuntime.make(workLive as never);
};

const factoryDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      text: "worker",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: {
          bindingId: "binding-agent",
          launch: { kind: "harness", argv: ["claude"] },
          harness: "claude",
        },
        host: "local",
      },
    },
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 240,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "task" } },
    },
  ],
  edges: [{ id: "e-claim", fromNode: "agent", toNode: "tasks" }],
});

describe("S3 - WorkService claim + ContentRef media", () => {
  it("claims a ContentRef task when ContentService receipts+files are verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-s3-claim-content-"));
    roots.push(root);
    const runtime = makeClaimContentRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );

    const canvases = await runtime.runPromise(CanvasesService);
    const canvasName = "s3-claim-media";
    await runtime.runPromise(canvases.write(canvasName, factoryDoc()));

    const work = await runtime.runPromise(WorkService);
    const created = await runtime.runPromise(
      work.workTaskCreate(
        canvasName,
        "tasks",
        "inspect attached media",
        { details: "inspect attached media" },
        undefined,
        [
          {
            kind: "raw",
            bytesBase64: TINY_PNG.toString("base64"),
            mediaType: "image/png" as never, } as never,
        ],
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.message);

    // Create externalizes raw → ContentRef via ContentService (warm Context).
    const contentParts = created.data.history
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "content");
    expect(contentParts.length).toBeGreaterThanOrEqual(1);
    const mediaPart = contentParts[0]!;
    if (mediaPart.kind !== "content") throw new Error("expected content part");

    const content = await runtime.runPromise(ContentService);
    const availability = await runtime.runPromise(
      content.availability(mediaPart.ref),
    );
    expect(availability.state).toBe("verified");
    expect(availability).toMatchObject({
      verifiedSha256: mediaPart.ref.sha256,
      verifiedByteLength: mediaPart.ref.byteLength,
    });

    const read = await runtime.runPromise(canvases.read(canvasName));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "agent");
    expect(actor).toBeDefined();
    if (actor === undefined) throw new Error("missing agent actorRef");

    const claimed = await runtime.runPromise(
      work.workTaskClaim(canvasName, "tasks", created.data.id, actor),
    );

    // Regression: prior empty-Context path failed with this exact phrase.
    if (!claimed.ok) {
      expect(claimed.message).not.toMatch(/content service unavailable/i);
    }
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.message);
    expect(claimed.data.state).toBe("working");
    expect(claimed.data.claimedBy).toBe(actor.seatId);
    expect(claimed.message ?? "").not.toMatch(/content service unavailable/i);
  });

  it("rejects unverified ContentRef as content-pending, not service-unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-s3-claim-pending-"));
    roots.push(root);
    const runtime = makeClaimContentRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );

    const canvases = await runtime.runPromise(CanvasesService);
    const canvasName = "s3-claim-pending";
    await runtime.runPromise(canvases.write(canvasName, factoryDoc()));

    const work = await runtime.runPromise(WorkService);
    // Seed a task whose ContentRef was never put into the store.
    const ghostRef = {
      sha256: "a".repeat(64),
      byteLength: 4,
      mediaType: "image/png",
    } as never;
    const created = await runtime.runPromise(
      work.workTaskCreate(
        canvasName,
        "tasks",
        "ghost media",
        { details: "ghost media" },
        undefined,
        [{ kind: "content", ref: ghostRef }],
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.message);

    const read = await runtime.runPromise(canvases.read(canvasName));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "agent");
    expect(actor).toBeDefined();
    if (actor === undefined) throw new Error("missing agent actorRef");

    const claimed = await runtime.runPromise(
      work.workTaskClaim(canvasName, "tasks", created.data.id, actor),
    );
    expect(claimed.ok).toBe(false);
    if (claimed.ok) throw new Error("expected claim to fail for ghost ref");
    expect(claimed.message).not.toMatch(/content service unavailable/i);
    expect(claimed.message).toMatch(/not claim-ready \(content /i);
  });

  it("fails WorkLive layer build when ContentService is omitted (hard dep)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-s3-no-content-"));
    roots.push(root);
    // Intentionally omit ContentService + InstallOps — S2 hard yield* must not
    // soft-miss; constructing WorkService without ContentService must fail loud.
    const stateLive = makeStateEngineLive(join(root, "state", "vellum-command.db"));
    const repositoriesLive = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        StationRepositoryLive,
        StationFleetTargetRepositoryLive,
        SettingsLive,
      ),
      stateLive,
    );
    const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
    const bareWork = ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
      ) as never,
    );
    runtimes.push(bareWork);

    await expect(bareWork.runPromise(WorkService)).rejects.toThrow();
  });
});
