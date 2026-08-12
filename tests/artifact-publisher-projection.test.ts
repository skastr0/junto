import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  readCanvasWorkProjection,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";

const root = join(
  tmpdir(),
  `vellum-command-artifact-publisher-${randomUUID()}`,
);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-12T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-artifact-publisher");
const currentIntentSha256 = "d".repeat(64);
const authorialBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});

const publisher = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
  canvasName: "factory",
  nodeId: "publisher",
};

const seedInstallations = (
  installations: ReadonlyArray<InstallationIdValue>,
  local: InstallationIdValue,
) =>
  state.transaction("test.seed-installations", (writer) => {
    for (const installation of installations) {
      writer.run(
        `
          INSERT INTO station_known_installations(
            installation_id,
            registered_at
          ) VALUES (?, ?)
        `,
        [installation, observedAt],
      );
    }
    writer.run(
      `
        INSERT INTO station_installation(
          singleton,
          installation_id,
          created_at
        ) VALUES (1, ?, ?)
      `,
      [local, observedAt],
    );
    writer.run(
      `
        INSERT INTO station_configuration(
          singleton,
          role,
          host_id,
          agent_host_id,
          command_center_installation_id,
          supervised_preferred,
          configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
      `,
      [observedAt],
    );
    writer.run(
      `
        INSERT INTO canvas_generations(
          generation,
          created_at,
          cause,
          intent_sha256,
          document_count
        ) VALUES ('1', ?, 'test intent', ?, 1)
      `,
      [observedAt, currentIntentSha256],
    );
    writer.run(
      `
        INSERT INTO canvas_generation_documents(
          generation,
          name,
          body,
          sha256,
          modified_at
        ) VALUES ('1', 'factory', '{}', ?, ?)
      `,
      ["1".repeat(64), observedAt],
    );
    writer.run(
      `
        INSERT INTO canvas_head(singleton, generation)
        VALUES (1, '1')
      `,
    );
  });

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(seedInstallations([cc], cc));
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("artifact publisher projection", () => {
  it("stamps publishedBySeatId on the projected artifact metadata", async () => {
    const sink = { canvasName: "factory", nodeId: "artifact-publisher-sink" };
    const published = await runtime.runPromise(
      repository.publishArtifact({
        sink,
        basis: authorialBasis,
        publishedBy: publisher,
        artifact: {
          artifactId: "artifact-plain",
          name: "proof",
          parts: [{ kind: "text", text: "receipt" }],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(published.value.metadata).toBeUndefined();

    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.artifacts.items).toEqual([
      {
        ...published.value,
        metadata: { publishedBySeatId: publisher.seatId },
      },
    ]);
  });

  it("keeps existing metadata keys and adds the stamp", async () => {
    const sink = { canvasName: "factory", nodeId: "artifact-metadata-sink" };
    await runtime.runPromise(
      repository.publishArtifact({
        sink,
        basis: authorialBasis,
        publishedBy: publisher,
        artifact: {
          artifactId: "artifact-with-metadata",
          name: "annotated proof",
          parts: [{ kind: "text", text: "receipt" }],
          metadata: { source: "e2e", details: "run 42" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.artifacts.items[0]?.metadata).toEqual({
      source: "e2e",
      details: "run 42",
      publishedBySeatId: publisher.seatId,
    });
  });

  it("carries the stamp on the canvas work projection (doc ether path)", async () => {
    const projected = await runtime.runPromise(
      state.read("test.read-canvas-work-projection", (reader) =>
        readCanvasWorkProjection(reader, "factory"),
      ),
    );
    const artifacts = projected.snapshots.flatMap(
      (snapshot) => snapshot.artifacts.items,
    );
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.metadata?.publishedBySeatId).toBe(publisher.seatId);
    }
  });

  it("never writes the stamp back to the durable row", async () => {
    const rows = await runtime.runPromise(
      state.read("test.read-artifact-rows", (reader) =>
        reader.all<{
          readonly artifact_id: string;
          readonly metadata_json: string | null;
        }>(
          `
            SELECT artifact_id, metadata_json
            FROM work_artifacts
            WHERE canvas_name = 'factory'
            ORDER BY artifact_id
          `,
        ),
      ),
    );
    expect(rows.map((row) => row.artifact_id)).toEqual([
      "artifact-plain",
      "artifact-with-metadata",
    ]);
    for (const row of rows) {
      expect(row.metadata_json ?? "").not.toContain("publishedBySeatId");
    }
    expect(
      rows.find((row) => row.artifact_id === "artifact-plain")?.metadata_json,
    ).toBeNull();
  });
});
