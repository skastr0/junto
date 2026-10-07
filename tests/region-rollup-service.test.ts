import { EventEmitter } from "node:events";
import { Effect, Result, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Canvas } from "../src/shared/model";
import { canvasOf, note, region, seat } from "./support/model-nodes";
import { ModelService } from "../src/main/junto/model/service";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelNotFound } from "../src/main/junto/model/records";
import { WorkRepository } from "../src/main/junto/work/repository";
import type { AcpChildLike, JsonRpcId, SpawnFn } from "../src/main/junto/chat/acp-client";
import { ChatService } from "../src/main/junto/chat/service";
import {
  makeRegionRollupLive,
  RegionRollupService,
} from "../src/main/junto/region-rollup";
import { SnapshotsService } from "../src/main/junto/snapshots";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import { spawnedLocalAcp } from "./helpers/acp-child";
import {
  canvasAuthorityMaterialFixture,
} from "./helpers/canvas-authority-material";

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

// --- fixture canvas -----------------------------------------------------------

// a1 (agent "local:default") gets live chat state; a2 (agent "local:quiet")
// never opens a session; p1 is a plain note beside them, which no agent's
// activity ever reaches.
const at = (y: number) => ({ x: 10, y, width: 100, height: 40 });
const opsActivity = canvasOf([
  region("r", { x: 0, y: 0, width: 500, height: 500 }, { label: "ops" }),
  seat("a1", { ...at(10), label: "PROFILE-13", agentKey: "local:default", harness: "hermes" }),
  seat("a2", { ...at(60), label: "QUIET", agentKey: "local:quiet", harness: "hermes" }),
  note("p1", "name twin", at(110)),
]);

// --- stubbed planes (kernel-arming-transaction idiom) -------------------------

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });

const fakeCanvases = (canvases: ReadonlyMap<string, Canvas>) => Layer.mergeAll(
  Layer.succeed(ModelService, { canvas: (name: string) => {
    const held = canvases.get(name);
    return held ? Effect.succeed(held) : Effect.fail(new ModelNotFound({ what: "canvas", id: name }));
  } } as unknown as ModelService["Service"]),
  Layer.succeed(ModelActorRefs, { read: (name: string) => Effect.succeed(
    [...(canvases.get(name)?.nodes.values() ?? [])]
      .filter((node) => node.kind === "agent")
      .map((node) => actorRefFixture(node.id, name)),
  ) } as unknown as ModelActorRefs["Service"]),
  // No canvas here holds work.
  Layer.succeed(WorkRepository, { attentionItems: () => Effect.succeed([]) } as unknown as Parameters<typeof WorkRepository.of>[0]),
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


const makeRuntime = (
  chatService: ChatService,
  canvases: ReadonlyMap<string, Canvas>,
) =>
  ManagedRuntime.make(
    Layer.provide(
      makeRegionRollupLive(chatService),
      Layer.mergeAll(fakeCanvases(canvases), fakeSnapshots),
    ),
  );

const rollups = (runtime: ReturnType<typeof makeRuntime>, canvasName: string) =>
  runtime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(canvasName)));

describe("RegionRollupService — activity wiring", () => {

  it("isLive does not fabricate harness work", async () => {
    const { spawnFn, children } = fakeSpawn();
    const chat = new ChatService(spawnFn, (host) => host === "local");
    await openHappyPath(chat, children, "local:default");

    const runtime = makeRuntime(chat, new Map([["ops", opsActivity]]));
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

    const runtime = makeRuntime(chat, new Map([["ops", opsActivity]]));
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
    const chat = new ChatService(noSpawn, (host) => host === "local");
    const runtime = makeRuntime(chat, new Map([["ops", opsActivity]]));
    try {
      const result = await runtime.runPromise(
        Effect.result(Effect.flatMap(RegionRollupService, (service) => service.rollups("missing"))),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ModelNotFound);
        expect(result.failure).toMatchObject({ what: "canvas", id: "missing" });
      }
    } finally {
      await runtime.dispose();
    }
  });
});
