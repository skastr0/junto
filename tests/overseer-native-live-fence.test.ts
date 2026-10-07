import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { canvasOf, seat } from "./support/model-nodes";
import { makeOverseerNativeLive } from "../src/main/junto/overseer/native";
import { ManagedTerminalDrive } from "../src/main/junto/term/drive";
import type { TermPlane } from "../src/main/junto/term/plane";
import type { ChatService } from "../src/main/junto/chat/service";

const factory = canvasOf([
  seat("worker", { label: "Worker", width: 240, height: 120, harness: "codex", bindingId: "worker-binding" as never }),
]);

describe("Live native mutation fences", () => {
  it("does not submit a stale prompt after correction during clipboard admission", async () => {
    let enterClipboard!: () => void;
    let releaseClipboard!: () => void;
    const entered = new Promise<void>((resolve) => { enterClipboard = resolve; });
    const clipboard = new Promise<void>((resolve) => { releaseClipboard = resolve; });
    const writes: string[] = [];
    const drive = new ManagedTerminalDrive({
      isSeatIdle: () => true,
      write: (_bindingId, bytes) => { writes.push(bytes); return true; },
      assertClipboardSafe: async () => { enterClipboard(); await clipboard; return true; },
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });
    const native = makeOverseerNativeLive({
      termPlane: { router: { isLocalHostId: () => true } } as unknown as TermPlane,
      chats: {} as ChatService,
      captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "not used" }),
      liveOverseerGrant: async () => true,
      listCanvases: async () => new Map([["factory", factory]]),
      occupySeat: async () => false,
      managedDrive: drive,
    });
    const fiber = Effect.runFork(native.executeResult(
      { canvasName: "factory", nodeId: "controller" },
      { operation: "agent.prompt", args: { nodeId: "worker", text: "obsolete request" } },
    ));
    await entered;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    // Allow interruption to reach the retained native flight before admitting
    // clipboard use. The target worker remains alive throughout this test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseClipboard();
    await interrupted;
    expect(writes).toEqual([]);
  });
});
