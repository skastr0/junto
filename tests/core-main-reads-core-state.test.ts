/**
 * What main reads from the core, it asks the core for: the body links of one
 * artifact (the store is the core's) and the desktop's last notification
 * report (the companion reads it in the core). Main's copies of both were
 * empty, because the state lives in the core process.
 */
import type { IpcMainInvokeEvent } from "electron";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HostClientsNoWindow } from "../src/core/host-clients";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionRpcs } from "../src/contract/core/companion";
import { WorkCore, WorkRpcs } from "../src/contract/core/work";
import { CompanionHandlers } from "../src/core/ops/companion";
import { ARTIFACT_LINKS_IPC_CHANNELS } from "../src/shared/artifact-links-ipc-channels";
import type { ArtifactLinksInput } from "../src/shared/artifact-links-ipc";
import type { LinkedFromBody } from "../src/shared/artifact-links";
import type { NotifyReport } from "../src/shared/desktop-notifications";
import { ItemId, NodeId } from "../src/shared/wire/ids";
import { Level } from "../src/shared/wire/urgency";
import {
  desktopActiveCanvas,
  desktopDoneUnread,
  noteDesktopReport,
} from "../src/core/companion/desktop-report";

// Main's registrar runs each call on the app runtime, which needs Electron; here a call runs on its own.
vi.mock("../src/app/runtime", async () => {
  const { Effect: Run } = await import("effect");
  return { AppRuntime: { runPromise: <A, E>(effect: Effect.Effect<A, E>) => Run.runPromise(effect) } };
});

const { registerArtifactLinksIpc } = await import("../src/app/work/artifact-links-ipc");

const PREFS = { enabled: true, blocked: true, needsYou: true, done: true, failed: true, badge: true, bounce: true };

/** A listener as Electron's `ipcMain.handle` takes it. */
type Listener = (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown;
/** Electron's event, which the registrar under test never reads. */
const event = {} as IpcMainInvokeEvent;

const scopes: Array<Scope.Closeable> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  noteDesktopReport({ canvasName: "reset", subjects: [], badge: 0, prefs: PREFS });
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

const scoped = async () => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  return scope;
};

describe("main reads core state by asking the core", () => {
  it("answers a body-link read with the core's work group, not a store in main", async () => {
    const handlers = new Map<string, Listener>();
    const ipc = {
      handle: (channel: string, listener: Listener): void => {
        handlers.set(channel, listener);
      },
    };
    const link: LinkedFromBody = {
      source: { nodeId: NodeId.make("shelf"), artifactId: ItemId.make("01M5EVKRB1X4P80GXRGDK8V5AS") },
      title: "Plan",
      type: "document",
      line: "[[Budget]]",
      at: 1,
    };
    const asked: Array<ArtifactLinksInput> = [];
    const unasked = () => Effect.die("main asked the work core for something else");
    const scope = await scoped();
    const served = await Effect.runPromise(
      Layer.buildWithScope(
        WorkRpcs.toLayer({
          WorkItem: unasked,
          WorkAttention: unasked,
          WorkMailPage: unasked,
          WorkSeatRecentOps: unasked,
          WorkArtifactLinks: (input) =>
            Effect.sync(() => {
              asked.push(input);
              return [link];
            }),
        }),
        scope,
      ),
    );
    const work = await Effect.runPromise(
      RpcTest.makeClient(WorkRpcs).pipe(Effect.provideContext(served), Effect.provideService(Scope.Scope, scope)),
    );
    registerArtifactLinksIpc(ipc, Context.make(WorkCore, work));

    const raw = { canvasName: "factory", nodeId: "shelf", artifactId: "01M5EVKRB1X4P80GXRGDK8V5AS" };
    const answer = await handlers.get(ARTIFACT_LINKS_IPC_CHANNELS.list)?.(event, raw);
    expect(asked).toEqual([raw]);
    expect(answer).toEqual([link]);
    // What the renderer sends is decoded closed at main's edge: an extra key never reaches the core.
    await expect(handlers.get(ARTIFACT_LINKS_IPC_CHANNELS.list)?.(event, { ...raw, extra: true })).rejects.toBeDefined();
    expect(asked).toHaveLength(1);
  });

  it("writes the desktop's report where the companion reads it", async () => {
    const scope = await scoped();
    const served = await Effect.runPromise(Layer.buildWithScope(CompanionHandlers.pipe(Layer.provide(HostClientsNoWindow)), scope));
    const companion = await Effect.runPromise(
      RpcTest.makeClient(CompanionRpcs).pipe(Effect.provideContext(served), Effect.provideService(Scope.Scope, scope)),
    );
    const report: NotifyReport = {
      canvasName: "factory",
      subjects: [
        { key: "seat", category: "done", level: Level.done, canvasName: "factory", nodeId: "seat-a", seatName: "lead", text: "done" },
      ],
      badge: 1,
      prefs: PREFS,
    };
    await Effect.runPromise(companion.CompanionDesktopReport({ report }));
    expect(desktopActiveCanvas()).toBe("factory");
    expect(desktopDoneUnread("factory", "seat-a")).toBe(true);
    expect(desktopDoneUnread("factory", "seat-b")).toBe(false);
  });
});
