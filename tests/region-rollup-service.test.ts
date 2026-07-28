import { EventEmitter } from "node:events";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { CanvasesService, CanvasError } from "../src/main/vellum/canvases";
import type { AcpChildLike, JsonRpcId, SpawnFn } from "../src/main/vellum/chat/acp-client";
import { ChatService } from "../src/main/vellum/chat/service";
import { HerdrPlane } from "../src/main/vellum/herdr/plane";
import type { HerdrMirrorRegistry } from "../src/main/vellum/herdr/mirrors";
import type { HerdrObservePool } from "../src/main/vellum/herdr/observe-pool";
import type { HerdrService } from "../src/main/vellum/herdr/service";
import type { HerdrStreamManager } from "../src/main/vellum/herdr/stream";
import {
  herdrAgentStatusActivity,
  makeRegionRollupLive,
  RegionRollupService,
} from "../src/main/vellum/region-rollup";
import { SnapshotsService } from "../src/main/vellum/snapshots";
import {
  actorRefsForDoc,
  claimedByNode,
} from "./helpers/actor-ref-fixtures";
import { spawnedLocalAcp } from "./helpers/acp-child";
import { taskItem } from "./helpers/task-fixtures";

const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };

// Service-level glue tests: activity wiring from the ACP chat plane and the
// CanvasError channel for unknown canvases.
// The ACP fakes mirror tests/chat-service.test.ts.

class FakeChild extends EventEmitter implements AcpChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
  };
  kill = vi.fn();
}

const lastSentId = (child: FakeChild): JsonRpcId =>
  (JSON.parse(child.written[child.written.length - 1]!) as { id: JsonRpcId }).id;

const respondOk = (child: FakeChild, id: JsonRpcId, result: unknown): void => {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const flush = async (ticks = 12): Promise<void> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

const waitForWrites = async (child: FakeChild, minLength: number): Promise<void> => {
  for (let i = 0; i < 20 && child.written.length < minLength; i++) await flush(1);
};

function fakeSpawn(): { spawnFn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return spawnedLocalAcp(child);
  };
  return { spawnFn, children };
}

async function openHappyPath(
  service: ChatService,
  children: FakeChild[],
  agentKey: string,
): Promise<FakeChild> {
  const openPromise = service.chatOpen(agentKey);
  const child = children[children.length - 1]!;
  await waitForWrites(child, 1);
  respondOk(child, lastSentId(child), { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  await waitForWrites(child, 2);
  respondOk(child, lastSentId(child), { sessionId: "sess-1", models: { availableModels: [] } });
  const result = await openPromise;
  expect(result.ok).toBe(true);
  return child;
}

// --- fixture docs -------------------------------------------------------------

const region = { id: "r", type: "group", label: "ops", x: 0, y: 0, width: 500, height: 500 } as const;

// a1 (agent "local:default") gets live chat state; a2 (agent "local:quiet")
// never opens a session; p1 is a PROJECT named "local:default" — activity is
// keyed by name but only ever applies to kind "agent".
const docActivity: CanvasDoc = {
  nodes: [
    { ...region },
    { id: "a1", type: "text", text: "MIRA", x: 10, y: 10, width: 100, height: 40, ether: { entity: { kind: "agent", name: "local:default" } } },
    { id: "a2", type: "text", text: "QUIET", x: 10, y: 60, width: 100, height: 40, ether: { entity: { kind: "agent", name: "local:quiet" } } },
    { id: "p1", type: "text", text: "name twin", x: 10, y: 110, width: 100, height: 40, ether: { entity: { kind: "project", name: "local:default" } } },
  ],
  edges: [],
};

const docStoppage: CanvasDoc = {
  nodes: [
    { ...region },
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 10,
      y: 10,
      width: 100,
      height: 40,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            claimedByNode(
              taskItem("task-1", "needs operator", "input-required"),
              "actor",
              "ops",
            ),
          ],
        },
      },
    },
    {
      id: "actor",
      type: "text",
      text: "actor",
      x: 10,
      y: 60,
      width: 100,
      height: 40,
      ether: { entity: { kind: "agent", name: "local:actor" } },
    },
  ],
  edges: [
    {
      id: "wait",
      fromNode: "tasks",
      toNode: "actor",
      ether: { criteria: { mode: "tasks" } },
    },
  ],
};

// --- stubbed planes (kernel-arming-transaction idiom) -------------------------

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });

const fakeCanvases = (docs: ReadonlyMap<string, CanvasDoc>) =>
  Layer.succeed(
    CanvasesService,
    CanvasesService.of({
      doctor: Effect.succeed(check("canvases")),
      list: Effect.succeed([]),
      read: (name: string) => {
        const doc = docs.get(name);
        return doc !== undefined
          ? Effect.succeed({
              name,
              doc,
              actorRefs: actorRefsForDoc(doc, name),
              revision: `${name}-r1`,
              workRevision: "0",
            })
          : Effect.fail(new CanvasError({ message: `canvas "${name}" does not exist` }));
      },
      readWithIntentWitness: () =>
        Effect.fail(new CanvasError({ message: "not used" })),
      write: () => Effect.succeed({ revision: "written-r1" }),
      mutate: () => Effect.void,
      create: (name: string) => Effect.succeed({
        name,
        doc: { nodes: [], edges: [] },
        actorRefs: actorRefsForDoc({ nodes: [], edges: [] }, name),
        revision: `${name}-r1`,
        workRevision: "0",
      }),
      remove: (name: string) => Effect.succeed({ name }),
      ensureSeed: Effect.void,
      writeSidecar: () => Effect.succeed(""),
      start: () => {},
      subscribeChanges: () => () => {},
      liveDocuments: () => Effect.succeed([]),
      liveAuthorityGeneration: () => Effect.succeed("0"),
      authoritySnapshot: () =>
        Effect.succeed({
          generation: "0",
          intentSha256: "a".repeat(64),
          documents: new Map(docs),
        }),
      activeIntentWitness: () =>
        Effect.succeed({
          generation: "0",
          contentSha256: "a".repeat(64),
        }),
      activeActorRefs: () => Effect.succeed([]),
    }),
  );

const fakeSnapshots = Layer.succeed(
  SnapshotsService,
  SnapshotsService.of({
    doctor: Effect.succeed(check("snapshots")),
    current: Effect.succeed({ bundles: [] }),
    refresh: () => Effect.succeed({ bundles: [] }),
    start: () => {},
    subscribe: () => () => {},
  }),
);

const fakeHerdr = Layer.succeed(
  HerdrPlane,
  HerdrPlane.of({
    service: {} as HerdrService,
    mirrors: { mirrorFor: () => undefined } as unknown as HerdrMirrorRegistry,
    observePool: {} as HerdrObservePool,
    sessions: {} as never,
    streams: {} as HerdrStreamManager,
    serviceMap: { stop: () => {}, get: () => undefined, observeProcesses: () => {}, requestProbe: () => ({ health: "unknown" }) } as never,
    serveCatalog: { peekOrEmpty: () => ({ hostId: "local", entries: [] }), refresh: async () => ({ hostId: "local", entries: [] }), preferredUrl: () => undefined } as never,
    serverLifetime: "daemon-outlives-app",
    beginShutdown: () => undefined,
    drainOnQuit: async () => ({
      clean: true,
      retained: 0,
      causes: [],
      components: {},
      server: {
        clean: true,
        retained: 0,
        excluded: true,
        lifetime: "daemon-outlives-app",
        reason: "independent-daemon-never-app-owned",
      },
    }),
    isQuiescing: () => false,
    start: Effect.void,
    warm: Effect.void,
  }),
);

const makeRuntime = (
  chatService: ChatService,
  docs: ReadonlyMap<string, CanvasDoc>,
) =>
  ManagedRuntime.make(
    Layer.provide(
      makeRegionRollupLive(chatService),
      Layer.mergeAll(fakeCanvases(docs), fakeSnapshots, fakeHerdr),
    ),
  );

const rollups = (runtime: ReturnType<typeof makeRuntime>, canvasName: string) =>
  runtime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(canvasName)));

describe("RegionRollupService — activity wiring", () => {
  it("translates herdr agent_status only at the main adapter boundary", () => {
    expect(herdrAgentStatusActivity("working")).toMatchObject({ harness: "working", source: "herdr" });
    expect(herdrAgentStatusActivity("blocked").harness).toBe("blocked");
    expect(herdrAgentStatusActivity("done").harness).toBe("attention");
    expect(herdrAgentStatusActivity("other").harness).toBe("unknown");
  });

  it("isLive does not fabricate harness work", async () => {
    const { spawnFn, children } = fakeSpawn();
    const chat = new ChatService(spawnFn, (host) => host === "local");
    await openHappyPath(chat, children, "local:default");

    const runtime = makeRuntime(chat, new Map([["ops", docActivity]]));
    try {
      const [rollup] = await rollups(runtime, "ops");
      const byId = new Map(rollup?.members.map((member) => [member.nodeId, member]));
      expect(byId.get("a1")).toMatchObject({ severity: "idle", reasons: [] });
      expect(byId.get("a2")).toMatchObject({ severity: "idle", reasons: [] });
      expect(byId.get("p1")).toMatchObject({ severity: "idle", reasons: [] });
    } finally {
      await runtime.dispose();
    }
  });

  it("hasPendingPermission maps to permission:pending/attention, outranking the live session", async () => {
    const { spawnFn, children } = fakeSpawn();
    const chat = new ChatService(spawnFn, (host) => host === "local");
    const child = await openHappyPath(chat, children, "local:default");

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "session/request_permission",
        params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }] },
      })}\n`,
    );
    expect(chat.hasPendingPermission("local:default")).toBe(true);

    const runtime = makeRuntime(chat, new Map([["ops", docActivity]]));
    try {
      const [rollup] = await rollups(runtime, "ops");
      const agent = rollup?.members.find((member) => member.nodeId === "a1");
      expect(agent?.severity).toBe("attention");
      expect(agent?.reasons).toEqual(["permission:pending"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("attributes task stoppage through CanvasReadResult actorRefs", async () => {
    const chat = new ChatService(noSpawn, (host) => host === "local");
    const runtime = makeRuntime(chat, new Map([["ops", docStoppage]]));
    try {
      const [rollup] = await rollups(runtime, "ops");
      expect(
        rollup?.members.find((member) => member.nodeId === "actor"),
      ).toMatchObject({
        severity: "blocked",
        reasons: ["edge:1 need input · needs operator"],
      });
    } finally {
      await runtime.dispose();
    }
  });
});

describe("RegionRollupService — error channel", () => {
  it("an unknown canvas name fails with CanvasError, not a fabricated rollup", async () => {
    const chat = new ChatService(noSpawn, (host) => host === "local");
    const runtime = makeRuntime(chat, new Map([["ops", docActivity]]));
    try {
      const result = await runtime.runPromise(
        Effect.either(Effect.flatMap(RegionRollupService, (service) => service.rollups("missing"))),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(CanvasError);
        expect(result.left.message).toContain("missing");
      }
    } finally {
      await runtime.dispose();
    }
  });
});
