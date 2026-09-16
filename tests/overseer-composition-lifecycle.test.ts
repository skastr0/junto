import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import type { CanvasReadResult } from "../src/shared/ipc";
import { InstallationId } from "../src/shared/installation-id";
import { CommandCenterConfiguration } from "../src/shared/station-api";
import type { OverseerCaller, OverseerRequest } from "../src/shared/overseer-control";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import { CanvasesService } from "../src/main/junto/canvases";
import { ChatServiceContext, type ChatService } from "../src/main/junto/chat/service";
import { NodeDeleteService } from "../src/main/junto/chat/node-delete";
import { StationRepository } from "../src/main/junto/station/repository";
import { deriveActorSeatId } from "../src/main/junto/station/actor-seat-compiler";
import {
  dispatchRegisteredStationRemoteOverseer,
} from "../src/main/junto/station/overseer-transport";
import { ActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import {
  composeOverseer,
  type OverseerRunPromise,
} from "../src/main/junto/overseer/composition";
import { mainAuthoringGate } from "../src/main/junto/main-authoring-gate";

const local = Schema.decodeUnknownSync(InstallationId)("cc-lifecycle");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-lifecycle");
const caller: OverseerCaller = { canvasName: "factory", nodeId: "planner" };
const startRequest: OverseerRequest = {
  operation: "agent.start",
  args: { nodeId: "worker" },
};

const fixture = (): CanvasReadResult => ({
  name: "factory",
  revision: "revision",
  workRevision: "0",
  actorRefs: [
    { ...caller, seatId: deriveActorSeatId(remote, "planner-binding") },
  ],
  doc: {
    nodes: [
      {
        id: "planner",
        type: "text",
        text: "Planner",
        x: 17,
        y: -29,
        width: 300,
        height: 200,
        ether: {
          entity: { kind: "agent", name: "remote:planner" },
          host: "remote",
          overseer: true,
          terminal: { bindingId: "planner-binding", harness: "claude" },
        },
      },
      {
        id: "worker",
        type: "text",
        text: "Worker",
        x: 40,
        y: 0,
        width: 260,
        height: 96,
        ether: {
          entity: { kind: "agent", name: "local:worker" },
          host: "local",
          terminal: { bindingId: "worker-binding", harness: "claude" },
        },
      },
    ],
    edges: [],
  },
});

const makeChats = (): ChatService => {
  const chats = {
    isLive: vi.fn(() => false),
    chatClose: vi.fn(async () => ({ ok: true, clean: true })),
    admitDeleteTombstone: vi.fn(() => ({ ok: true as const })),
    releaseDeleteTombstone: vi.fn(),
    nodeDelete: undefined as unknown as NodeDeleteService,
  };
  chats.nodeDelete = new NodeDeleteService(chats as never);
  return chats as unknown as ChatService;
};

const occupySummary = (): TerminalSessionSummary => ({
  bindingId: "worker-binding",
  epoch: "e1",
  hostId: "local",
  status: "running",
  detached: true,
  createdAt: 1,
});

const holdOccupy = (mode: "succeed" | "fail") => {
  let releaseInner!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  let started = 0;
  let finished = 0;
  const occupy = vi.fn(() =>
    Effect.uninterruptible(
      Effect.promise(async () => {
        started += 1;
        await held;
        finished += 1;
        if (mode === "fail") throw new Error("occupy cleanup failed");
        return occupySummary();
      }),
    ),
  );
  return {
    occupy,
    started: () => started,
    finished: () => finished,
    releaseInner: () => releaseInner(),
  };
};

const compositions: Array<{ dispose: () => void }> = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  while (compositions.length > 0) {
    compositions.pop()?.dispose();
  }
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (runtime) await runtime.dispose();
  }
  expect(mainAuthoringGate.snapshot().activeLabels).toEqual([]);
});

const boot = async (mode: "succeed" | "fail") => {
  const read = fixture();
  const inner = holdOccupy(mode);
  const chats = makeChats();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(ChatServiceContext, chats),
      Layer.succeed(ActorSeatOccupy, ActorSeatOccupy.of({
        occupy: inner.occupy,
        occupancy: () => Effect.die(new Error("unexpected occupancy")),
      })),
      Layer.mock(StationRepository, {
        installationId: Effect.succeed(local),
        configuration: Effect.succeed({
          configuredAt: "2026-09-11T00:00:00Z",
          configuration: Schema.decodeUnknownSync(CommandCenterConfiguration)({
            role: "command-center",
            hostId: "local",
            supervisedPreferred: false,
          }),
        }),
      }),
      Layer.mock(CanvasesService, {
        liveDocuments: () => Effect.succeed([{ canvasName: read.name, doc: read.doc }]),
        read: () => Effect.succeed(read),
        start: () => undefined,
        subscribeChanges: () => () => undefined,
        announceInstalledProjection: () => undefined,
      }),
    ),
  );
  runtimes.push(runtime);
  const composition = await composeOverseer({
    run: ((effect, options) => runtime.runPromise(effect as never, options)) as OverseerRunPromise,
    captureApplicationPage: async () => ({
      ok: false,
      unavailable: true,
      reason: "lifecycle test",
    }),
    registerRemoteHandler: true,
  });
  compositions.push(composition);
  return { inner, composition };
};

const interruptStationHandler = async (mode: "succeed" | "fail") => {
  const { inner } = await boot(mode);
  const source = { installationId: remote, caller };
  const fiber = Effect.runFork(
    dispatchRegisteredStationRemoteOverseer(startRequest, source),
  );
  await vi.waitFor(() => expect(inner.started()).toBe(1));
  expect(mainAuthoringGate.snapshot().activeLabels).toContain("control.overseer");

  let interruptDone = false;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    interruptDone = true;
  });
  await Promise.resolve();
  expect(interruptDone).toBe(false);
  expect(inner.finished()).toBe(0);
  expect(mainAuthoringGate.snapshot().activeLabels).toContain("control.overseer");

  inner.releaseInner();
  await interrupted;
  expect(interruptDone).toBe(true);
  expect(inner.finished()).toBe(1);
  expect(inner.occupy).toHaveBeenCalledTimes(1);
  expect(mainAuthoringGate.snapshot().activeLabels).toEqual([]);
};

describe("overseer composition lifecycle", () => {
  it("does not settle a Station handler until inner occupy cleanup finishes", async () => {
    await interruptStationHandler("succeed");
  });

  it("does not settle a Station handler until inner occupy failure cleanup finishes", async () => {
    await interruptStationHandler("fail");
  });
});
