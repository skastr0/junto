/**
 * `junto artifact show` lists body backlinks through the live ports (plan
 * 0.11, 02, L5): the real artifact store and `work_artifact_links`, so a
 * miswired port, which reads as an empty list, fails here.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { ArtifactOp } from "../src/shared/artifact";
import type { ArtifactShowResult } from "../src/shared/artifact-control";
import { artifactLink } from "../src/shared/artifact-link";
import { ARTIFACTS_ENABLED } from "../src/shared/features";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import { mintItemId, mintOpId, type ResourceCommand } from "../src/shared/resource-command";
import type { ItemId } from "../src/shared/work-ids";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { handleArtifactOp, liveArtifactPorts } from "../src/main/junto/work/artifact-control";

const recorder = Layer.effect(
  RulingRecorder,
  Effect.map(SqlClient.SqlClient, (sql) =>
    RulingRecorder.of({
      record: (input) =>
        writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    })),
);

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | ContentService | SqlClient.SqlClient, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-show-linked-from-"));
  const content = makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provide(ArtifactRepositoryLive, recorder), content).pipe(
      Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db")))),
    ),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const CANVAS = "factory";
const SHELF = asNodeId("artifacts-shelf");
const AWAY = asNodeId("artifacts-away");
const SEAT = asNodeId("agent-a");

const at = (id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}, width = 50, height = 50) =>
  ({ id: asNodeId(id), kind, x, y, width, height, z: 0, ...extra }) as unknown as Node;

// The seat and SHELF share a region; AWAY sits in another.
const topology = {
  name: CANVAS,
  nodes: new Map([
    at("region-here", "region", 0, 0, { label: "Here" }, 500, 500),
    at(SEAT, "agent", 20, 20, { label: "cli-lead", agentKey: "a" }),
    at(SHELF, "artifacts", 200, 20, { label: "Shelf" }),
    at("region-away", "region", 1000, 0, { label: "Away" }, 500, 500),
    at(AWAY, "artifacts", 1100, 20, { label: "Away" }),
  ].map((node) => [node.id, node])),
  wires: new Map(),
} as unknown as Canvas;

const create = async (title: string, markdown: string, nodeId = SHELF): Promise<ItemId> => {
  const id = mintItemId();
  const command: ResourceCommand<ArtifactOp> = {
    opId: mintOpId(),
    canvasName: CANVAS,
    actor: { kind: "operator" },
    target: { kind: "artifact", nodeId, itemId: id },
    basis: null,
    after: [],
    op: { op: "create", title, body: { type: "document", markdown } },
  };
  const outcome = await runtime.runPromise(
    Effect.flatMap(ArtifactRepository, (repo) => repo.submit("mini" as InstallationId, command, { inReach: () => true })),
  );
  expect(outcome).toMatchObject({ kind: "applied" });
  return id;
};

describe.runIf(ARTIFACTS_ENABLED)("junto artifact show, linked from bodies", () => {
  it("lists the artifacts in reach whose body links it, through the live store", async () => {
    const plan = await create("Launch plan", "the plan");
    const ref = { kind: "artifact", nodeId: SHELF, artifactId: plan } as const;
    const notes = await create("Notes", `intro\nsee ${artifactLink(ref, "Launch plan", CANVAS)} soon`);
    await create("Elsewhere", `also ${artifactLink(ref, "Launch plan", CANVAS)}`, AWAY);

    const shown = await runtime.runPromise(
      handleArtifactOp("artifact.show", { artifact: plan }, {
        canvas: topology,
        canvasName: CANVAS,
        actor: { kind: "seat", seatId: ActorSeatId.make(`seat_${"a".repeat(64)}`), nodeId: SEAT },
      }, liveArtifactPorts) as Effect.Effect<ArtifactShowResult, unknown>,
    );
    expect(shown.linkedFrom.bodies.map((body) => [body.source.artifactId, body.title])).toEqual([[notes, "Notes"]]);
    expect(shown.linkedFrom.bodies[0]!.line).toContain("see ");
  });

  it("still lists a link written before the artifact moved, judged where it is now (0.11.1, 10)", async () => {
    const plan = await create("Launch plan", "the plan", AWAY);
    const notes = await create("Notes", `see ${artifactLink({ kind: "artifact", nodeId: AWAY, artifactId: plan }, "Launch plan", CANVAS)}`);
    const moved = await runtime.runPromise(
      Effect.flatMap(ArtifactRepository, (repo) =>
        repo.submit("mini" as InstallationId, {
          opId: mintOpId(),
          canvasName: CANVAS,
          actor: { kind: "operator" },
          target: { kind: "artifact", nodeId: AWAY, itemId: plan },
          basis: null,
          after: [],
          op: { op: "move", to: SHELF },
        }, { inReach: () => true })),
    );
    expect(moved).toMatchObject({ kind: "applied" });
    const shown = await runtime.runPromise(
      handleArtifactOp("artifact.show", { artifact: plan }, {
        canvas: topology,
        canvasName: CANVAS,
        actor: { kind: "seat", seatId: ActorSeatId.make(`seat_${"a".repeat(64)}`), nodeId: SEAT },
      }, liveArtifactPorts) as Effect.Effect<ArtifactShowResult, unknown>,
    );
    expect(shown.linkedFrom.bodies.map((body) => body.source.artifactId)).toEqual([notes]);
  });
});
