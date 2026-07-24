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
import { spawnedLocalAcp } from "./helpers/acp-child";

const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };

// Service-level glue tests: activity wiring from the ACP chat plane, the
// CanvasError channel for unknown canvases, and the TTL glyph cache.
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

// wip-criteria edge p1 -> p2 puts "prism" into projectsNeedingGlyphs.
const docCache: CanvasDoc = {
  nodes: [
    { ...region },
    { id: "p1", type: "text", text: "prism", x: 10, y: 10, width: 100, height: 40, ether: { entity: { kind: "project", name: "prism" } } },
    { id: "p2", type: "text", text: "vellum", x: 10, y: 60, width: 100, height: 40, ether: { entity: { kind: "project", name: "vellum" } } },
  ],
  edges: [{ id: "e1", fromNode: "p1", toNode: "p2", ether: { criteria: { mode: "wip" } } }],
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
          ? Effect.succeed({ name, path: "", doc, revision: `${name}-r1` })
          : Effect.fail(new CanvasError({ message: `canvas "${name}" does not exist` }));
      },
      write: () => Effect.succeed({ revision: "written-r1" }),
      mutate: () => Effect.void,
      create: (name: string) => Effect.succeed({
        name,
        path: "",
        doc: { nodes: [], edges: [] },
        revision: `${name}-r1`,
      }),
      remove: (name: string) => Effect.succeed({ name }),
      ensureSeed: Effect.void,
      writeSidecar: () => Effect.succeed(""),
      start: () => {},
      subscribeChanges: () => () => {},
      liveDocuments: () => Effect.succeed([]),
    replaceLiveAuthorityFromInstall: () => Effect.void,
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
    const chat = new ChatService(spawnFn);
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
    const chat = new ChatService(spawnFn);
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
});

describe("RegionRollupService — error channel", () => {
  it("an unknown canvas name fails with CanvasError, not a fabricated rollup", async () => {
    const chat = new ChatService(noSpawn);
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
