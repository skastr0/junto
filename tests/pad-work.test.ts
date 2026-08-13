import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import { makePadNode } from "../src/renderer/lib/node-factories";
import {
  PadPatch,
  asPadElementId,
  emptyPad,
  type PadPatch as PadPatchValue,
} from "../src/shared/pad";
import { admitWorkTarget } from "../src/main/vellum/work/authz";
import {
  addedPadMentions,
  inboundActorNodeIds,
  padAuthorRuleError,
} from "../src/main/vellum/work/pad-rules";
import { projectPadTagged } from "../src/cli/core/pad";
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

const decodePatch = (patch: unknown): PadPatchValue =>
  Schema.decodeUnknownSync(PadPatch)(patch);

const upsertBox = (id: string): PadPatchValue => ({
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

const upsertInk = (id: string): PadPatchValue => ({
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

const pinWithMention = (id: string, mention: string): PadPatchValue => ({
  op: "pin.upsert",
  pin: {
    id: asPadElementId(id),
    x: 8,
    y: 8,
    mentions: [mention],
  },
});

const upsertImage = (id: string): PadPatchValue =>
  decodePatch({
    op: "upsert",
    layer: "image",
    image: {
      id,
      x: 0,
      y: 0,
      w: 12,
      h: 12,
      z: 0,
      ref: {
        sha256: "a".repeat(64),
        byteLength: 4,
        mediaType: "image/png",
      },
    },
  });

const pinReply = (
  pinId: string,
  postId: string,
  author: Record<string, unknown>,
): PadPatchValue =>
  decodePatch({
    op: "pin.reply",
    pinId,
    post: {
      postId,
      author,
      parts: [{ kind: "text", text: "note" }],
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

  it("refuses agent image upsert", () => {
    expect(
      padAuthorRuleError(
        { kind: "actor", nodeId: "agent" },
        [upsertImage("img1")],
        new Set(["agent"]),
      ),
    ).toMatch(/image/i);
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

  it("refuses an outbound-only seat as a mention", () => {
    const inbound = padDoc(true);
    const outbound: CanvasDoc = {
      ...inbound,
      edges: [{ id: "e-out", fromNode: "pad-1", toNode: "agent" }],
    };
    expect(inboundActorNodeIds(outbound, "pad-1").has("agent")).toBe(false);
    expect(
      padAuthorRuleError(
        { kind: "operator", label: "operator" },
        [pinWithMention("p1", "agent")],
        inboundActorNodeIds(outbound, "pad-1"),
      ),
    ).toMatch(/mention/i);
  });

  it("treats restamped pin mentions as not newly added", () => {
    const before = {
      ...emptyPad(),
      pins: [
        {
          id: asPadElementId("p1"),
          x: 1,
          y: 1,
          mentions: ["agent"],
          posts: [],
        },
      ],
    };
    expect(addedPadMentions(before, [pinWithMention("p1", "agent")])).toEqual([]);
    expect(addedPadMentions(emptyPad(), [pinWithMention("p1", "agent")])).toEqual([
      "agent",
    ]);
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

  it("applyPadPatch refuses an unwired mention at the repository mint", async () => {
    const denied = await runtime.runPromise(
      repository
        .applyPadPatch({
          sink: { canvasName: "factory", nodeId: "pad-1" },
          basis: authorialBasis,
          patchId: "patch-mention",
          patches: [pinWithMention("ghost-pin", "ghost")],
          author: { kind: "operator", label: "operator" },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(denied).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorkAuthorityError", reason: "invalid-transition" },
    });
    if (denied._tag === "Failure") {
      expect(denied.failure.message).toMatch(/mention/i);
    }
  });

  it("unreadPinCount follows the operator read cursor, not pins-with-posts", async () => {
    const sink = { canvasName: "factory", nodeId: "pad-unread" };
    const opened = await runtime.runPromise(
      repository.applyPadPatch({
        sink,
        basis: authorialBasis,
        patchId: "patch-unread-pin",
        patches: [
          {
            op: "pin.upsert",
            pin: {
              id: asPadElementId("attn"),
              x: 4,
              y: 4,
              mentions: [],
            },
          },
          pinReply("attn", "post-a", { kind: "operator", label: "operator" }),
        ],
        author: { kind: "operator", label: "operator" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(opened.value.pins[0]?.posts).toHaveLength(1);

    const unread = await runtime.runPromise(
      repository.readSnapshot("factory", "pad-unread"),
    );
    expect(unread.pad).toMatchObject({
      unreadPinCount: 1,
    });

    await runtime.runPromise(
      repository.markPadRead({
        sink,
        pinId: "attn",
        principalKey: "operator",
        lastReadPosition: 0,
        updatedAt: observedAt,
      }),
    );
    const cleared = await runtime.runPromise(
      repository.readSnapshot("factory", "pad-unread"),
    );
    expect(cleared.pad).toMatchObject({ unreadPinCount: 0 });

    await runtime.runPromise(
      repository.applyPadPatch({
        sink,
        basis: authorialBasis,
        patchId: "patch-unread-2",
        patches: [
          pinReply("attn", "post-b", { kind: "operator", label: "operator" }),
        ],
        author: { kind: "operator", label: "operator" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const again = await runtime.runPromise(
      repository.readSnapshot("factory", "pad-unread"),
    );
    expect(again.pad).toMatchObject({ unreadPinCount: 1 });
  });
});

describe("WorkService pad mark-read", () => {
  const root = join(tmpdir(), `vellum-command-pad-read-${randomUUID()}`);
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

  it("clears operator unread after workPadMarkRead", async () => {
    const work = await runtime.runPromise(WorkService);
    const opened = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [
          pinWithMention("attn", "agent"),
          pinReply("attn", "post-a", { kind: "operator", label: "operator" }),
        ],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(opened.ok).toBe(true);
    const marked = await runtime.runPromise(
      work.workPadMarkRead("factory", "pad-1", "attn", "operator"),
    );
    expect(marked.ok).toBe(true);
    const repository = await runtime.runPromise(WorkRepository);
    const snap = await runtime.runPromise(
      repository.readSnapshot("factory", "pad-1"),
    );
    expect(snap.pad).toMatchObject({ unreadPinCount: 0 });
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

    const image = await runtime.runPromise(
      work.workPadPatch("factory", "pad-1", [upsertImage("img-agent")], actor),
    );
    expect(image.ok).toBe(false);
    if (!image.ok) {
      expect(image.code).toBe("invalid");
      expect(image.message).toMatch(/image/i);
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

  it("lists tagged pins only for this process-bound seat", async () => {
    const work = await runtime.runPromise(WorkService);
    const other = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [
          {
            op: "pin.upsert",
            pin: {
              id: asPadElementId("tagged-me"),
              x: 1,
              y: 1,
              mentions: ["agent"],
            },
          },
          {
            op: "pin.upsert",
            pin: {
              id: asPadElementId("tagged-other"),
              x: 2,
              y: 2,
              mentions: [],
            },
          },
        ],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const mine = projectPadTagged(
      {
        revision: other.data.revision,
        pad: other.data.pad,
        digest: other.data.digest,
        svg: "<svg></svg>",
      },
      "agent",
    );
    expect(mine.pins.map((pin) => pin.id)).toContain("tagged-me");
    expect(mine.pins.map((pin) => pin.id)).not.toContain("tagged-other");
    expect(
      projectPadTagged(
        {
          revision: other.data.revision,
          pad: other.data.pad,
          digest: other.data.digest,
          svg: "<svg></svg>",
        },
        "nobody",
      ).pins,
    ).toEqual([]);
  });

  it("stamps pin.reply author from WorkService, not the patch body", async () => {
    const work = await runtime.runPromise(WorkService);
    const actor = {
      kind: "actor" as const,
      seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
      nodeId: "agent",
    };
    const opened = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [
          {
            op: "pin.upsert",
            pin: {
              id: asPadElementId("thread"),
              x: 2,
              y: 2,
              mentions: ["agent"],
            },
          },
        ],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(opened.ok).toBe(true);

    const forged = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [pinReply("thread", "forged-post", { kind: "operator", label: "forged" })],
        actor,
      ),
    );
    expect(forged.ok).toBe(true);
    if (!forged.ok) return;
    const post = forged.data.pad.pins
      .find((pin) => pin.id === "thread")
      ?.posts.find((item) => item.postId === "forged-post");
    expect(post?.author).toMatchObject({
      kind: "actor",
      nodeId: "agent",
      seatId: actor.seatId,
    });
    expect(post?.author.kind).not.toBe("operator");
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

  it("keeps a first-line pad title through CanvasesService.write", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    const titled = {
      ...makePadNode(40, 40),
      id: "pad-titled",
      text: "Sprint board\n9 shapes, 4 unread",
      ether: {
        entity: { kind: "pad" as const },
        pad: { revision: 9, shapeCount: 9, unreadPinCount: 4 },
      },
    };
    await runtime.runPromise(
      canvases.write("factory", {
        nodes: [...padDoc(true).nodes, titled],
        edges: padDoc(true).edges,
      }),
    );
    const read = await runtime.runPromise(canvases.read("factory"));
    const node = read.doc.nodes.find((item) => item.id === "pad-titled");
    expect(node && "text" in node ? node.text : "").toMatch(/^Sprint board\n/);
    expect(node && "text" in node ? node.text : "").not.toMatch(/^pad\n/);
  });
});
