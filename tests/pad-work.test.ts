import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import { makePadNode } from "../src/renderer/lib/node-factories";
import { asPadElementId, emptyPad, type PadPatch } from "../src/shared/pad";
import { admitWorkTarget } from "../src/main/vellum/work/authz";
import {
  inboundActorNodeIds,
  padAuthorRuleError,
} from "../src/main/vellum/work/pad-rules";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import { makeContentServiceLive } from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/vellum/settings/service";

const observedAt = "2026-08-13T12:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-pad-work");
const currentIntentSha256 = "d".repeat(64);
const authorialBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});

const upsertBox = (id: string): PadPatch => ({
  op: "upsert",
  layer: "shape",
  shape: {
    id: asPadElementId(id),
    type: "box",
    x: 10,
    y: 10,
    w: 40,
    h: 20,
    z: 0,
    text: "box",
  },
});

const upsertInk = (id: string): PadPatch => ({
  op: "upsert",
  layer: "ink",
  ink: {
    id: asPadElementId(id),
    z: 0,
    color: "#fff",
    width: 2,
    points: [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
    ],
  },
});

const pinWithMention = (id: string, mention: string): PadPatch => ({
  op: "pin.upsert",
  pin: {
    id: asPadElementId(id),
    x: 8,
    y: 8,
    mentions: [mention],
  },
});

const padDoc = (wired: boolean): CanvasDoc => {
  const pad = { ...makePadNode(200, 0), id: "pad-1" };
  return {
    nodes: [
      {
        id: "agent",
        type: "text",
        x: 0,
        y: 0,
        width: 120,
        height: 48,
        text: "agent",
        ether: {
          entity: { kind: "agent", name: "local:agent" },
          terminal: {
            bindingId: "bind-agent",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      pad,
    ],
    edges: wired
      ? [{ id: "e1", fromNode: "agent", toNode: "pad-1" }]
      : [],
  };
};

describe("pad author rules", () => {
  it("refuses agent ink upsert", () => {
    expect(
      padAuthorRuleError(
        { kind: "actor", nodeId: "agent" },
        [upsertInk("k1")],
        new Set(["agent"]),
      ),
    ).toMatch(/ink/i);
  });

  it("refuses a mention that is not an inbound actor", () => {
    const doc = padDoc(true);
    expect(inboundActorNodeIds(doc, "pad-1").has("agent")).toBe(true);
    expect(
      padAuthorRuleError(
        { kind: "actor", nodeId: "agent" },
        [pinWithMention("p1", "stranger")],
        inboundActorNodeIds(doc, "pad-1"),
      ),
    ).toMatch(/mention/i);
  });

  it("admits operator ink and inbound mentions", () => {
    expect(
      padAuthorRuleError(
        { kind: "operator", label: "operator" },
        [upsertInk("k1"), pinWithMention("p1", "agent")],
        new Set(["agent"]),
      ),
    ).toBeUndefined();
  });
});

describe("pad ScopeError without edge", () => {
  it("refuses pad.read and pad.patch when the actor is not wired", () => {
    const doc = padDoc(false);
    const read = admitWorkTarget(doc, "agent", "pad-1", "pad.read");
    const patch = admitWorkTarget(doc, "agent", "pad-1", "pad.patch");
    expect(Result.isFailure(read)).toBe(true);
    expect(Result.isFailure(patch)).toBe(true);
    if (Result.isFailure(read)) {
      expect(read.failure.type).toBe("ScopeError");
    }
    if (Result.isFailure(patch)) {
      expect(patch.failure.type).toBe("ScopeError");
    }
  });
});

describe("pad persist", () => {
  const root = join(tmpdir(), `vellum-command-pad-work-${randomUUID()}`);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum-command.db")),
    ),
  );
  let repository: Context.Service.Shape<typeof WorkRepository>;
  let state: Context.Service.Shape<typeof StateEngine>;

  beforeAll(async () => {
    repository = await runtime.runPromise(WorkRepository);
    state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      state.transaction("test.seed-pad-installations", (writer) => {
        writer.run(
          `INSERT INTO station_known_installations(installation_id, registered_at) VALUES (?, ?)`,
          [cc, observedAt],
        );
        writer.run(
          `INSERT INTO station_installation(singleton, installation_id, created_at) VALUES (1, ?, ?)`,
          [cc, observedAt],
        );
        writer.run(
          `
            INSERT INTO station_configuration(
              singleton, role, host_id, agent_host_id,
              command_center_installation_id, supervised_preferred, configured_at
            ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
          `,
          [observedAt],
        );
        writer.run(
          `
            INSERT INTO canvas_generations(
              generation, created_at, cause, intent_sha256, document_count
            ) VALUES ('1', ?, 'test intent', ?, 1)
          `,
          [observedAt, currentIntentSha256],
        );
        writer.run(
          `
            INSERT INTO canvas_generation_documents(
              generation, name, body, sha256, modified_at
            ) VALUES ('1', 'factory', '{}', ?, ?)
          `,
          ["1".repeat(64), observedAt],
        );
        writer.run(`INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')`);
      }),
    );
  });

  afterAll(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("applyPadPatch writes changed rows and bumps revision", async () => {
    const sink = { canvasName: "factory", nodeId: "pad-1" };
    const empty = await runtime.runPromise(repository.readPad("factory", "pad-1"));
    expect(empty).toEqual(emptyPad());

    const created = await runtime.runPromise(
      repository.applyPadPatch({
        sink,
        basis: authorialBasis,
        patchId: "patch-1",
        patches: [upsertBox("s1")],
        author: { kind: "operator", label: "operator" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(created.value.revision).toBe(1);
    expect(created.value.shapes).toHaveLength(1);
    expect(created.record.operation).toBe("pad.patch");
    expect(created.record.item.kind).toBe("pad");

    const loaded = await runtime.runPromise(repository.readPad("factory", "pad-1"));
    expect(loaded.revision).toBe(1);
    expect(loaded.shapes[0]?.id).toBe("s1");

    const snap = await runtime.runPromise(
      repository.readSnapshot("factory", "pad-1"),
    );
    expect(snap.pad).toEqual({
      revision: 1,
      shapeCount: 1,
      unreadPinCount: 0,
    });
  });
});

describe("WorkService pad author refusals", () => {
  const root = join(tmpdir(), `vellum-command-pad-svc-${randomUUID()}`);
  const makeRuntime = () => {
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
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
      ),
    );
  };
  const runtime = makeRuntime();

  beforeAll(async () => {
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("factory", padDoc(true)));
  });

  afterAll(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("refuses agent ink and a bad mention as invalid", async () => {
    const work = await runtime.runPromise(WorkService);
    const actor = {
      kind: "actor" as const,
      seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
      nodeId: "agent",
    };
    const ink = await runtime.runPromise(work.workPadPatch("factory", "pad-1", [upsertInk("k1")], actor));
    expect(ink.ok).toBe(false);
    if (!ink.ok) {
      expect(ink.code).toBe("invalid");
      expect(ink.message).toMatch(/ink/i);
    }

    const mention = await runtime.runPromise(
      work.workPadPatch("factory", "pad-1", [pinWithMention("p1", "ghost")], actor),
    );
    expect(mention.ok).toBe(false);
    if (!mention.ok) {
      expect(mention.code).toBe("invalid");
      expect(mention.message).toMatch(/mention/i);
    }
  });

  it("applies an operator shape patch", async () => {
    const work = await runtime.runPromise(WorkService);
    const result = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [upsertBox("svc-box")],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.revision).toBeGreaterThan(0);
    expect(result.data.pad.shapes.some((shape) => shape.id === "svc-box")).toBe(
      true,
    );
    expect(result.data.digest).toContain("svc-box");

    const read = await runtime.runPromise(work.workPadRead("factory", "pad-1"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.pad.shapes.some((shape) => shape.id === "svc-box")).toBe(
      true,
    );
    expect(read.data.svg).toContain("<svg");
  });
});
