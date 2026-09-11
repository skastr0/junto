import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { makePadNode } from "../src/renderer/lib/node-factories";
import {
  PadPatch,
  asPadElementId,
  emptyPad,
  type PadPatch as PadPatchValue,
} from "../src/shared/pad";
import { admitWorkTarget } from "../src/main/vellum-command/work/authz";
import {
  addedPadMentions,
  inboundActorNodeIds,
  padAuthorRuleError,
} from "../src/main/vellum-command/work/pad-rules";
import { projectPadTagged } from "../src/cli/core/pad";
import { strokePath } from "../src/shared/pad-geom";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import {
  canvasAuthorityMaterialFixture,
  seedCanvasAuthority,
} from "./helpers/canvas-authority-material";

const observedAt = "2026-08-13T12:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-pad-work");
const persistFactoryDoc: CanvasDoc = {
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      text: "factory",
    },
  ],
  edges: [],
};
const persistFactoryDocuments = new Map<string, CanvasDoc>([
  ["factory", persistFactoryDoc],
]);
const currentIntentSha256 = canvasAuthorityMaterialFixture(
  "1",
  persistFactoryDocuments,
).intentSha256;
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
  parts: ReadonlyArray<Record<string, unknown>> = [
    { kind: "text", text: "note" },
  ],
): PadPatchValue =>
  decodePatch({
    op: "pin.reply",
    pinId,
    post: {
      postId,
      author,
      parts,
    },
  });

const RAW_POST_BYTES = Buffer.from("pad-raw-image");
const pinReplyRaw = (
  pinId: string,
  postId: string,
  author: Record<string, unknown>,
): PadPatchValue =>
  pinReply(pinId, postId, author, [
    {
      kind: "raw",
      bytesBase64: RAW_POST_BYTES.toString("base64"),
      mediaType: "image/png",
    },
  ]);

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

  it("admits overseer actor ink without operator impersonation", () => {
    expect(
      padAuthorRuleError(
        { kind: "actor", nodeId: "agent", seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`) },
        [upsertInk("k1"), upsertImage("img1")],
        new Set(["agent"]),
        { overseer: true },
      ),
    ).toBeUndefined();
    expect(
      padAuthorRuleError(
        { kind: "actor", nodeId: "agent" },
        [upsertInk("k1")],
        new Set(["agent"]),
      ),
    ).toMatch(/ink/i);
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
        seedCanvasAuthority(writer, {
          generation: "1",
          documents: persistFactoryDocuments,
          at: observedAt,
        });
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

  it("persists operator images as ContentRef without bytes", async () => {
    const created = await runtime.runPromise(
      repository.applyPadPatch({
        sink: { canvasName: "factory", nodeId: "pad-img" },
        basis: authorialBasis,
        patchId: "patch-img",
        patches: [upsertImage("img1")],
        author: { kind: "operator", label: "operator" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(created.value.images).toHaveLength(1);
    expect(JSON.stringify(created.value)).not.toMatch(/bytesBase64|data:image|base64,/);
    const loaded = await runtime.runPromise(repository.readPad("factory", "pad-img"));
    expect(loaded.images[0]?.ref).toEqual({
      sha256: "a".repeat(64),
      byteLength: 4,
      mediaType: "image/png",
    });
    expect(JSON.stringify(loaded)).not.toMatch(/bytesBase64|data:image|base64,/);
  });

  it("applyPadPatch refuses pin.reply raw parts so parts_json cannot store bytes", async () => {
    const sink = { canvasName: "factory", nodeId: "pad-raw-repo" };
    await runtime.runPromise(
      repository.applyPadPatch({
        sink,
        basis: authorialBasis,
        patchId: "patch-raw-pin",
        patches: [
          {
            op: "pin.upsert",
            pin: {
              id: asPadElementId("raw-pin"),
              x: 1,
              y: 1,
              mentions: [],
            },
          },
        ],
        author: { kind: "operator", label: "operator" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const denied = await runtime.runPromise(
      repository
        .applyPadPatch({
          sink,
          basis: authorialBasis,
          patchId: "patch-raw-post",
          patches: [
            pinReplyRaw("raw-pin", "raw-post", {
              kind: "operator",
              label: "operator",
            }),
          ],
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
      expect(denied.failure.message).toMatch(/bytes never live in pad JSON/i);
    }
    const loaded = await runtime.runPromise(
      repository.readPad("factory", "pad-raw-repo"),
    );
    expect(loaded.pins[0]?.posts).toEqual([]);
    expect(JSON.stringify(loaded)).not.toMatch(/bytesBase64|data:image|base64,/);
    const stored = await runtime.runPromise(
      state.read("test.read-pad-raw-post", (reader) =>
        reader.get<{ readonly parts_json: string }>(
          `SELECT parts_json FROM work_pad_posts
           WHERE canvas_name = ? AND node_id = ? AND post_id = ?`,
          [sink.canvasName, sink.nodeId, "raw-post"],
        )?.parts_json,
      ),
    );
    expect(stored).toBeUndefined();
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

  it("refuses agent image upsert", async () => {
    const work = await runtime.runPromise(WorkService);
    const actor = {
      kind: "actor" as const,
      seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
      nodeId: "agent",
    };
    const image = await runtime.runPromise(
      work.workPadPatch("factory", "pad-1", [upsertImage("img-agent")], actor),
    );
    expect(image.ok).toBe(false);
    if (!image.ok) {
      expect(image.code).toBe("invalid");
      expect(image.message).toMatch(/image/i);
    }
    const loaded = await runtime.runPromise(work.workPadRead("factory", "pad-1"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.pad.images).toEqual([]);
      expect(JSON.stringify(loaded.data.pad)).not.toMatch(/bytesBase64|data:image|base64,/);
    }
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

  it("externalizes actor pin.reply raw parts so pad JSON never stores bytes", async () => {
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
              id: asPadElementId("raw-thread"),
              x: 3,
              y: 3,
              mentions: ["agent"],
            },
          },
        ],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(opened.ok).toBe(true);

    const replied = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [
          pinReplyRaw("raw-thread", "actor-raw-post", {
            kind: "actor",
            nodeId: "agent",
          }),
        ],
        actor,
      ),
    );
    expect(replied.ok).toBe(true);
    if (!replied.ok) return;
    const post = replied.data.pad.pins
      .find((pin) => pin.id === "raw-thread")
      ?.posts.find((item) => item.postId === "actor-raw-post");
    expect(post?.parts).toHaveLength(1);
    expect(post?.parts[0]?.kind).toBe("content");
    if (post?.parts[0]?.kind === "content") {
      expect(post.parts[0].ref.byteLength).toBe(RAW_POST_BYTES.length);
      expect(post.parts[0].ref.mediaType).toBe("image/png");
    }
    expect(JSON.stringify(replied.data.pad)).not.toMatch(
      /bytesBase64|data:image|base64,/,
    );

    const state = await runtime.runPromise(StateEngine);
    const stored = await runtime.runPromise(
      state.read("test.read-actor-pad-raw-post", (reader) =>
        reader.get<{ readonly parts_json: string }>(
          `SELECT parts_json FROM work_pad_posts
           WHERE canvas_name = ? AND node_id = ? AND post_id = ?`,
          ["factory", "pad-1", "actor-raw-post"],
        )?.parts_json,
      ),
    );
    expect(stored).toBeDefined();
    expect(stored).toContain('"kind":"content"');
    expect(stored).not.toContain("bytesBase64");
    expect(stored).not.toMatch(/data:image|base64,/);
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

  it("reads a pad with a stale pinId as a plain read, not a failure", async () => {
    const work = await runtime.runPromise(WorkService);
    const read = await runtime.runPromise(
      work.workPadRead("factory", "pad-1", "pin-does-not-exist"),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.pad.revision).toBeGreaterThan(0);
    expect(read.data.lookHere).toBeUndefined();
  });

  it("persists a hostile shape fill as data and renders a safe svg", async () => {
    const work = await runtime.runPromise(WorkService);
    const fill =
      `"></rect><image href="x-invalid:" onerror="window.pwned=42"></image><rect fill="`;
    const result = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [
          decodePatch({
            op: "upsert",
            layer: "shape",
            shape: {
              id: "xss-box",
              type: "box",
              x: 0,
              y: 0,
              w: 10,
              h: 10,
              z: 0,
              fill,
            },
          }),
        ],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pad.shapes.find((shape) => shape.id === "xss-box")?.fill).toBe(
      fill,
    );

    const read = await runtime.runPromise(work.workPadRead("factory", "pad-1"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.pad.shapes.find((shape) => shape.id === "xss-box")?.fill).toBe(
      fill,
    );
    expect(read.data.svg).not.toMatch(/<(?:image|script|foreignObject)\b/i);
    expect(read.data.svg).not.toMatch(/\son(?:error|load)\s*=/i);
    expect(read.data.svg).toContain("<svg");
  });

  it("applies operator ink and shows the stroke in svg, not points in digest", async () => {
    const work = await runtime.runPromise(WorkService);
    const result = await runtime.runPromise(
      work.workPadPatch(
        "factory",
        "pad-1",
        [upsertInk("svc-ink")],
        { kind: "operator", label: "operator" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pad.inks.some((ink) => ink.id === "svc-ink")).toBe(true);
    expect(result.data.digest).toContain("svc-ink");
    expect(result.data.digest).toContain("points=2");
    expect(result.data.digest).not.toMatch(/\{"x":/);

    const read = await runtime.runPromise(work.workPadRead("factory", "pad-1"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const ink = read.data.pad.inks.find((item) => item.id === "svc-ink");
    expect(ink).toBeDefined();
    if (!ink) return;
    expect(read.data.svg).toContain(`d="${strokePath(ink.points, ink.width)}"`);
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

/**
 * The pad mention roster is answered per patch from the canvas document. It is
 * now served from a content-keyed index instead of re-decoding the whole
 * document on every stroke, so these lock the two things a cache can break:
 * it must give the same answer the canonical resolver gives, and it must
 * follow the document to a new version.
 */
describe("pad inbound-actor roster", () => {
  const root = join(tmpdir(), `vellum-command-pad-roster-${randomUUID()}`);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum-command.db")),
    ),
  );
  let repository: Context.Service.Shape<typeof WorkRepository>;
  let state: Context.Service.Shape<typeof StateEngine>;

  const node = (id: string, kind: string, type = "text") => ({
    id,
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...(type === "group" ? { label: id } : { text: `t ${id}` }),
    ether: { entity: { kind } },
  });

  /**
   * Every shape the roster has to get right in one document: a plain inbound
   * actor, a non-actor source, a seat drawn pad-first (the verb stores it
   * agent-first either way), a group carrying an actor kind, an edge from a
   * node that does not exist, and a self edge. A duplicated node id is no
   * longer representable: the relational authority keys nodes by
   * (canvas_id, node_id), so that legacy case has no head-world equivalent.
   */
  const trickyDoc = {
    nodes: [
      node("actor-in", "agent"),
      node("actor-out", "agent"),
      node("task-in", "task"),
      node("grp", "agent", "group"),
      node("pad-1", "pad"),
    ],
    edges: [
      { id: "e1", fromNode: "actor-in", toNode: "pad-1" },
      { id: "e2", fromNode: "actor-in", toNode: "pad-1" },
      { id: "e3", fromNode: "pad-1", toNode: "actor-out" },
      { id: "e4", fromNode: "task-in", toNode: "pad-1" },
      { id: "e6", fromNode: "ghost", toNode: "pad-1" },
      { id: "e7", fromNode: "pad-1", toNode: "pad-1" },
      { id: "e8", fromNode: "grp", toNode: "pad-1" },
    ],
  };

  /** Same pad, a different seat wired in — the version the index must follow. */
  const rewiredDoc = {
    nodes: [node("actor-late", "agent"), node("pad-1", "pad")],
    edges: [{ id: "r1", fromNode: "actor-late", toNode: "pad-1" }],
  };

  const decodeDoc = (doc: unknown): CanvasDoc => {
    const decoded = decodeCanvasDoc(JSON.parse(JSON.stringify(doc)));
    if (Result.isFailure(decoded)) {
      throw new Error(decoded.failure.message);
    }
    return decoded.success;
  };

  const intentByGeneration = new Map<string, string>();

  const basisFor = (
    generation: string,
  ): Schema.Schema.Type<typeof IntentFactBasis> =>
    Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
      kind: "authorial-intent",
      generation,
      contentSha256: intentByGeneration.get(generation)!,
    });

  const commitCanvas = (generation: string, doc: unknown) =>
    state.transaction(`test.commit-${generation}`, (writer) => {
      const { intentSha256 } = seedCanvasAuthority(writer, {
        generation,
        documents: new Map([["factory", decodeDoc(doc)]]),
        at: observedAt,
      });
      intentByGeneration.set(generation, intentSha256);
    });

  /** Undefined when the mention was admitted; the refusal message otherwise. */
  const mentionRefusal = async (
    generation: string,
    patchId: string,
    mention: string,
  ): Promise<string | undefined> => {
    const outcome = await runtime.runPromise(
      repository
        .applyPadPatch({
          sink: { canvasName: "factory", nodeId: "pad-1" },
          basis: basisFor(generation),
          patchId,
          patches: [pinWithMention(`pin-${patchId}`, mention)],
          author: { kind: "operator", label: "operator" },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    return outcome._tag === "Failure" ? outcome.failure.message : undefined;
  };

  beforeAll(async () => {
    repository = await runtime.runPromise(WorkRepository);
    state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      state.transaction("test.seed-roster-installations", (writer) => {
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
      }),
    );
    await runtime.runPromise(commitCanvas("1", trickyDoc));
  });

  afterAll(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("admits exactly the mentions the canonical resolver resolves", async () => {
    const decoded = decodeCanvasDoc(JSON.parse(JSON.stringify(trickyDoc)));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    const expected = inboundActorNodeIds(decoded.success, "pad-1");
    // actor-out is drawn pad-first; the verb stores it agent-first, so a seat
    // cannot be wired to a pad and stay outside its mention roster.
    expect([...expected].sort()).toEqual(["actor-in", "actor-out"]);

    const candidates = [
      "actor-in",
      "actor-out",
      "task-in",
      "grp",
      "ghost",
      "pad-1",
    ];
    const admitted: string[] = [];
    for (const candidate of candidates) {
      const refusal = await mentionRefusal("1", `tricky-${candidate}`, candidate);
      if (refusal === undefined) admitted.push(candidate);
      else expect(refusal).toMatch(/mention/i);
    }
    expect(admitted.sort()).toEqual([...expected].sort());
  });

  it("follows the canvas to a new document version", async () => {
    // Same pad node, same sink, repeated patches: whatever the roster is
    // cached under must be the document, not the sink.
    expect(await mentionRefusal("1", "before-a", "actor-in")).toBeUndefined();
    expect(await mentionRefusal("1", "before-b", "actor-late")).toMatch(/mention/i);

    await runtime.runPromise(commitCanvas("2", rewiredDoc));

    expect(await mentionRefusal("2", "after-a", "actor-late")).toBeUndefined();
    expect(await mentionRefusal("2", "after-b", "actor-in")).toMatch(/mention/i);
  });
});
