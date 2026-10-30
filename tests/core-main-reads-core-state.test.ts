/**
 * What main reads from the core, it asks the core for: the body links of one
 * artifact (the store is the core's) and the desktop's last notification
 * report (the companion reads it in the core). Main's copies of both were
 * empty, because the state lives in the core process.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import "../src/main/core-process/ops/companion";
import { useCoreClient } from "../src/main/core-process/main-client";
import { ARTIFACT_LINKS_IPC_CHANNELS } from "../src/shared/artifact-links-ipc-channels";
import { registerArtifactLinksIpc } from "../src/main/junto/work/artifact-links-ipc";
import {
  desktopActiveCanvas,
  desktopDoneUnread,
  noteDesktopReport,
} from "../src/main/junto/companion/desktop-report";

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];
const runtimeOf = (): ManagedRuntime.ManagedRuntime<never, never> => {
  const runtime = ManagedRuntime.make(Layer.empty);
  runtimes.push(runtime);
  return runtime;
};
afterEach(async () => {
  vi.restoreAllMocks();
  noteDesktopReport({ canvasName: "reset", subjects: [], badge: 0, prefs: {} } as never);
  for (const runtime of runtimes.splice(0)) await Effect.runPromise(Effect.promise(() => runtime.dispose()));
});

describe("main reads core state by asking the core", () => {
  it("answers a body-link read with the core's operation, not a store in main", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const link = {
      source: { nodeId: "shelf", artifactId: "01M5EVKRB1X4P80GXRGDK8V5AS" },
      title: "Plan",
      type: "document",
      line: "[[Budget]]",
      at: 1,
    };
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    useCoreClient({
      call: async (name: string, input: unknown) => {
        calls.push({ name, input });
        return [link];
      },
    } as never);
    registerArtifactLinksIpc(ipc as never);
    const raw = { canvasName: "factory", nodeId: "shelf", artifactId: "01M5EVKRB1X4P80GXRGDK8V5AS" };
    const answer = await handlers.get(ARTIFACT_LINKS_IPC_CHANNELS.list)!({}, raw);
    expect(calls).toEqual([{ name: "ipc.work.artifactLinks", input: { input: raw } }]);
    expect(answer).toEqual([link]);
  });

  it("writes the desktop's report where the companion reads it", async () => {
    const core = inProcessCore(runtimeOf() as unknown as CoreRunner);
    const report = {
      canvasName: "factory",
      subjects: [{ key: "seat", category: "done", level: "attention", canvasName: "factory", nodeId: "seat-a", seatName: "lead", text: "done" }],
      badge: 1,
      prefs: {},
    };
    await core.call("companion.desktopReport", { report } as never);
    expect(desktopActiveCanvas()).toBe("factory");
    expect(desktopDoneUnread("factory", "seat-a")).toBe(true);
    expect(desktopDoneUnread("factory", "seat-b")).toBe(false);
  });
});
